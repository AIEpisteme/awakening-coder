// Self-evolution: it can write a new version of its own code — but never in place.
//
//   1. copy its own source into a sandbox
//   2. the coder edits the COPY and runs the copy's tests
//   3. a guardian re-runs the CURRENT version's tests against the copy
//      (the evolving agent never sees or edits these — they are copied in afterwards)
//   4. the human reviews the diff and approves, or nothing happens
//   5. the old version is backed up; /rollback restores it
//
// Any change takes effect only after a restart, so a running process never rewrites itself.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { unifiedDiff } from './diff.js';
import { scrubbedEnv } from './tools.js';

export const EVOLVABLE = ['src', 'test', 'package.json', 'README.md'];

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const exists = (p) => fs.access(p).then(() => true, () => false);

export async function prepareSandbox(selfRoot, home) {
  const dir = path.join(home, 'evolutions', stamp());
  await fs.mkdir(dir, { recursive: true });
  for (const item of EVOLVABLE) {
    const from = path.join(selfRoot, item);
    if (await exists(from)) await fs.cp(from, path.join(dir, item), { recursive: true });
  }
  // Let the copy import its dependencies without being able to write to them (writes into node_modules are refused).
  const nm = path.join(selfRoot, 'node_modules');
  if (await exists(nm)) await fs.symlink(nm, path.join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return dir;
}

// A fresh, isolated test run: no secrets, and no inherited NODE_TEST_* context (which would make
// the child report to a parent runner instead of failing with a non-zero exit code).
function cleanTestEnv(home) {
  const env = Object.fromEntries(Object.entries(scrubbedEnv()).filter(([k]) => !k.startsWith('NODE_TEST')));
  return { ...env, AWAKENING_HOME: home };
}

function runNodeTests(cwd, files, home) {
  return new Promise((resolve) => {
    if (!files.length) return resolve({ ok: false, out: 'No test files found.' });
    const child = spawn(process.execPath, ['--test', ...files], {
      cwd, env: cleanTestEnv(home), timeout: 180_000, killSignal: 'SIGKILL',
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ ok: false, out: out + e.message }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.slice(-20_000) }));
  });
}

const testFiles = async (dir) => (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.test.js')).sort();

/** Run the copy's own tests, then the CURRENT version's tests against the copy. */
export async function runGuardian(selfRoot, sandbox) {
  const scratchHome = path.join(sandbox, '.guardian-home');
  await fs.mkdir(scratchHome, { recursive: true });
  const own = await runNodeTests(sandbox, (await testFiles(path.join(sandbox, 'test'))).map((f) => path.join('test', f)), scratchHome);

  // Fresh copy of today's tests, placed beside src/ so their '../src/…' imports hit the evolved code.
  const gdir = path.join(sandbox, 'guardian');
  await fs.rm(gdir, { recursive: true, force: true });
  await fs.mkdir(gdir);
  const current = await testFiles(path.join(selfRoot, 'test'));
  for (const f of current) await fs.copyFile(path.join(selfRoot, 'test', f), path.join(gdir, f));
  const guardian = await runNodeTests(sandbox, current.map((f) => path.join('guardian', f)), scratchHome);

  return { own, guardian, ok: own.ok && guardian.ok };
}

async function walkFiles(base, rel) {
  const abs = path.join(base, rel);
  let st;
  try { st = await fs.stat(abs); } catch { return []; }
  if (st.isFile()) return [rel];
  const out = [];
  for (const e of await fs.readdir(abs)) out.push(...(await walkFiles(base, path.join(rel, e))));
  return out;
}

/** Files that differ between the live version and the sandbox (after === null means deleted). */
export async function diffTrees(selfRoot, sandbox) {
  const rels = new Set();
  for (const item of EVOLVABLE) {
    (await walkFiles(selfRoot, item)).forEach((r) => rels.add(r));
    (await walkFiles(sandbox, item)).forEach((r) => rels.add(r));
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
