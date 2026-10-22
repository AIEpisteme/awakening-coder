// Self-evolution: it can write a new version of its own code — but never in place.
//
//   1. copy its own source into a sandbox; the coder edits only the COPY, with no shell —
//      its only way to execute code is the confined run_tests tool
//   2. the human sees the diff and a static tamper scan BEFORE any new code runs
//   3. with consent, a guardian runs (confined by Node's permission model: no writes outside
//      the sandbox, no child processes, no secrets):
//        - the CURRENT version's tests against the new code (the evolving agent never edits these)
//        - the new version's own tests
//        - a randomly-named canary test that must fail, in the same process, to detect
//          tampering with the assertion/test machinery
//   4. protected files (the constitution) can never be changed by an evolution
//   5. the human approves the final result, or nothing happens; the old version is backed up
//      and /rollback restores it
//
// Any change takes effect only after a restart, so a running process never rewrites itself.
// When the app runs self-sandboxed it CAN'T write its own code at all: an approved evolution is
// then staged in its state folder, and the unconfined launcher applies it at the next start,
// after asking the human once more.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unifiedDiff } from './diff.js';
import { runConfinedTests } from './confine.js';

export const EVOLVABLE = ['src', 'test', 'package.json', 'README.md'];
/** Never changeable by an evolution. Only a human editing by hand can change these. */
export const PROTECTED = ['test/constitution.test.js'];

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const exists = (p) => fs.access(p).then(() => true, () => false);
const posix = (p) => p.split(path.sep).join('/');

/** Plain recursive copy (fs.cp stats parent folders, which the permission model forbids). Symlinks are skipped. */
async function copyTree(from, to) {
  const st = await fs.lstat(from);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const e of await fs.readdir(from)) await copyTree(path.join(from, e), path.join(to, e));
  } else if (st.isFile()) {
    await fs.writeFile(to, await fs.readFile(from));
  }
}

/**
 * Give the sandbox its dependencies without a symlink (forbidden while confined) and without a
 * writable copy: each dependency becomes a tiny ESM shim that re-exports the real, read-only
 * package. Returns the folders confined test runs must be allowed to read.
 */
async function writeDependencyShims(selfRoot, dir) {
  let deps = {};
  try { deps = JSON.parse(await fs.readFile(path.join(selfRoot, 'package.json'), 'utf8')).dependencies ?? {}; } catch { /* none */ }
  const reads = new Set();
  for (const name of Object.keys(deps)) {
    const pkgDir = path.join(selfRoot, 'node_modules', ...name.split('/'));
    if (!(await exists(pkgDir))) continue;
    const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, 'package.json'), 'utf8'));
    const exp = pkg.exports?.['.'];
    const entry = (typeof exp === 'string' ? exp : exp?.import?.default ?? exp?.import ?? exp?.default) ?? pkg.module ?? pkg.main ?? 'index.js';
    const url = pathToFileURL(path.join(pkgDir, typeof entry === 'string' ? entry : 'index.js')).href;
    const ns = await import(url);
    const shimDir = path.join(dir, 'node_modules', ...name.split('/'));
    await fs.mkdir(shimDir, { recursive: true });
    await fs.writeFile(path.join(shimDir, 'package.json'), JSON.stringify({ name, type: 'module', exports: './index.js' }));
    await fs.writeFile(path.join(shimDir, 'index.js'), `export * from ${JSON.stringify(url)};\n${'default' in ns ? `export { default } from ${JSON.stringify(url)};\n` : ''}`);
    reads.add(fss.realpathSync(path.join(selfRoot, 'node_modules')));
  }
  await fs.writeFile(path.join(dir, '.awaken-deps.json'), JSON.stringify({ reads: [...reads] }));
  return [...reads];
}

export async function prepareSandbox(selfRoot, home) {
  const dir = path.join(home, 'evolutions', stamp());
  await fs.mkdir(dir, { recursive: true });
  for (const item of EVOLVABLE) {
    const from = path.join(selfRoot, item);
    if (await exists(from)) await copyTree(from, path.join(dir, item));
  }
  await writeDependencyShims(selfRoot, dir);
  return dir;
}

/** Can this process write its own code? (Not while self-sandboxed.) */
export function canWriteSelf(selfRoot) {
  return !process.permission || process.permission.has('fs.write', path.join(selfRoot, 'src'));
}

const testFiles = async (dir) => (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.test.js')).sort();

/**
 * Run everything confined: the CURRENT tests against the copy (with a canary), then the copy's
 * own tests (with a canary). ok only if both are clean.
 */
export async function runGuardian(selfRoot, sandbox, { confined = true } = {}) {
  // Fresh copy of today's tests, placed beside src/ so their '../src/…' imports hit the evolved code.
  const gdir = path.join(sandbox, 'guardian');
  await fs.rm(gdir, { recursive: true, force: true });
  await fs.mkdir(gdir);
  const current = await testFiles(path.join(selfRoot, 'test'));
  for (const f of current) await fs.copyFile(path.join(selfRoot, 'test', f), path.join(gdir, f));
  const guardian = await runConfinedTests(sandbox, current.map((f) => path.join('guardian', f)), { dir: 'guardian', confined });
  if (guardian.unavailable) return { own: guardian, guardian, ok: false, unavailable: guardian.unavailable };
  const own = await runConfinedTests(sandbox, (await testFiles(path.join(sandbox, 'test'))).map((f) => path.join('test', f)), { dir: 'test', confined });
  return { own, guardian, ok: own.ok && guardian.ok };
}

/** Reasons an evolution must be rejected outright, before anything runs. */
export function hardRejections(changes, symlinks = []) {
  const out = [];
  for (const ch of changes) if (PROTECTED.includes(posix(ch.rel))) out.push(`changes protected file ${posix(ch.rel)}`);
  for (const l of symlinks) out.push(`contains a symlink: ${posix(l)}`);
  return out;
}

async function walkFiles(base, rel, symlinks) {
  const abs = path.join(base, rel);
  let st;
  try { st = await fs.lstat(abs); } catch { return []; }
  if (st.isSymbolicLink()) { symlinks?.push(rel); return []; }
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) return [];
  const out = [];
  for (const e of await fs.readdir(abs)) out.push(...(await walkFiles(base, path.join(rel, e), symlinks)));
  return out;
}

/** Files that differ between the live version and the sandbox (after === null means deleted). */
export async function diffTrees(selfRoot, sandbox, symlinks = []) {
  const rels = new Set();
  for (const item of EVOLVABLE) {
    (await walkFiles(selfRoot, item)).forEach((r) => rels.add(r));
    (await walkFiles(sandbox, item, symlinks)).forEach((r) => rels.add(r));
  }
  const changes = [];
  for (const rel of [...rels].sort()) {
    const before = await fs.readFile(path.join(selfRoot, rel), 'utf8').catch(() => null);
    const after = await fs.readFile(path.join(sandbox, rel), 'utf8').catch(() => null);
    if (before === after) continue;
    changes.push({ rel, before, after, diff: unifiedDiff(before ?? '', after ?? '') });
  }
  return changes;
}

export async function applyEvolution(selfRoot, home, changes) {
  if (!canWriteSelf(selfRoot)) throw new Error('This process is self-sandboxed and cannot write its own code; stage the evolution instead.');
  const bad = hardRejections(changes);
  if (bad.length) throw new Error(`Refusing to apply evolution: ${bad.join('; ')}`);
  const backup = path.join(home, 'backups', stamp());
  const manifest = { created: [], modified: [], deleted: [], at: new Date().toISOString() };
  for (const ch of changes) {
    const live = path.join(selfRoot, ch.rel);
    if (ch.before !== null) {
      await fs.mkdir(path.dirname(path.join(backup, ch.rel)), { recursive: true });
      await fs.copyFile(live, path.join(backup, ch.rel));
    }
    if (ch.after === null) { await fs.rm(live, { force: true }); manifest.deleted.push(ch.rel); }
    else {
      await fs.mkdir(path.dirname(live), { recursive: true });
      await fs.writeFile(live, ch.after);
      (ch.before === null ? manifest.created : manifest.modified).push(ch.rel);
    }
  }
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { backup, manifest };
}

/** Undo the most recent applied evolution. */
export async function rollback(selfRoot, home) {
  const dir = path.join(home, 'backups');
  const all = (await fs.readdir(dir).catch(() => [])).filter((d) => !d.endsWith('.restored')).sort();
  if (!all.length) return null;
  const latest = path.join(dir, all.at(-1));
  const manifest = JSON.parse(await fs.readFile(path.join(latest, 'manifest.json'), 'utf8'));
  for (const rel of [...manifest.modified, ...manifest.deleted]) {
    await fs.mkdir(path.dirname(path.join(selfRoot, rel)), { recursive: true });
    await fs.copyFile(path.join(latest, rel), path.join(selfRoot, rel));
  }
  for (const rel of manifest.created) await fs.rm(path.join(selfRoot, rel), { force: true });
  await fs.rename(latest, latest + '.restored');
  return manifest;
}

// ---------- staged evolutions (applied by the unconfined launcher at the next start) ----------
const pendingDir = (home) => path.join(home, 'pending');

/** Save an approved evolution for the launcher to apply at the next start. */
export async function stageEvolution(home, changes, info = {}) {
  const bad = hardRejections(changes);
  if (bad.length) throw new Error(`Refusing to stage evolution: ${bad.join('; ')}`);
  const dir = pendingDir(home);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'files'), { recursive: true });
  const files = [];
  for (const ch of changes) {
    if (ch.after !== null) {
      await fs.mkdir(path.dirname(path.join(dir, 'files', ch.rel)), { recursive: true });
      await fs.writeFile(path.join(dir, 'files', ch.rel), ch.after);
    }
    files.push({ rel: posix(ch.rel), kind: ch.before === null ? 'new' : ch.after === null ? 'deleted' : 'changed' });
  }
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ kind: 'evolution', files, ...info, stagedAt: new Date().toISOString() }, null, 2));
  return dir;
}

/** Ask the launcher to roll back the last applied evolution at the next start. */
export async function stageRollback(home) {
  const dir = pendingDir(home);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ kind: 'rollback', stagedAt: new Date().toISOString() }, null, 2));
}

export async function readPending(home) {
  try { return JSON.parse(await fs.readFile(path.join(pendingDir(home), 'manifest.json'), 'utf8')); } catch { return null; }
}

export async function discardPending(home) {
  await fs.rm(pendingDir(home), { recursive: true, force: true });
}

/** Apply what's staged (launcher only). Re-checks the hard rules: staged files are data, not trusted. */
export async function applyPending(selfRoot, home) {
  const m = await readPending(home);
  if (!m) return null;
  if (m.kind === 'rollback') { const r = await rollback(selfRoot, home); await discardPending(home); return { kind: 'rollback', result: r }; }
  const changes = [];
  for (const f of m.files ?? []) {
    const rel = path.normalize(f.rel);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !EVOLVABLE.some((e) => rel === e || rel.startsWith(e + path.sep))) throw new Error(`Refusing staged path outside evolvable files: ${f.rel}`);
    const before = await fs.readFile(path.join(selfRoot, rel), 'utf8').catch(() => null);
    const after = f.kind === 'deleted' ? null : await fs.readFile(path.join(pendingDir(home), 'files', rel), 'utf8');
    changes.push({ rel, before, after });
  }
  const res = await applyEvolution(selfRoot, home, changes);
  await discardPending(home);
  return { kind: 'evolution', result: res, info: m };
}
