// Run code-under-test inside Node's permission model: it may read the sandbox and its
// dependencies, write only inside the sandbox, and spawn nothing. Used for every test run of
// a self-evolution, so an evolved version can't touch the live code, your home directory, or
// the backups while it's being "tested".
//
// Each run also includes a canary: a test that MUST fail, with a random name, placed in the
// same process as the code under test. If the canary "passes", something has tampered with
// the assertion or test machinery, and the whole run counts as failed.
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { scrubbedEnv } from './security.js';

/** True when this process itself is running confined (tests use it to skip process-spawning cases). */
export const isConfined = () => Boolean(process.permission) && !process.permission.has('child');

function confinedEnv(sandbox) {
  const env = Object.fromEntries(Object.entries(scrubbedEnv()).filter(([k]) => !k.startsWith('NODE_')));
  const tmp = path.join(sandbox, '.tmp');
  return { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, AWAKENING_HOME: path.join(sandbox, '.guardian-home') };
}

// Every assertion API the tests could use, each called in a way that MUST throw.
const CANARY_CASES = [
  ['loose ok', "a.ok(false)"], ['loose equal', "a.equal(1, 2)"], ['loose strictEqual', "a.strictEqual(1, 2)"],
  ['loose deepEqual', "a.deepEqual({ x: 1 }, { x: 2 })"], ['loose deepStrictEqual', "a.deepStrictEqual([1], [2])"],
  ['loose match', "a.match('abc', /z/)"], ['loose throws', "a.throws(() => {})"], ['loose fail', "a.fail('canary')"],
  ['loose call', "a(false)"], ['strict ok', "s.ok(false)"], ['strict equal', "s.equal(1, 2)"], ['strict deepEqual', "s.deepEqual([1], [2])"],
  ['strict match', "s.match('abc', /z/)"], ['strict throws', "s.throws(() => {})"], ['strict rejects', "await s.rejects(Promise.resolve())"],
  ['strict call', "s(false)"], ['plain throw', "throw new Error('canary')"],
];

async function writeCanary(sandbox, dir) {
  const token = randomBytes(6).toString('hex');
  const name = `zz_${token}.test.js`;
  const srcDir = path.join(sandbox, 'src');
  const modules = (await fs.readdir(srcDir).catch(() => [])).filter((f) => f.endsWith('.js') && f !== 'cli.js');
  const imports = modules.map((m, i) => `import * as m${i} from '../src/${m}';`).join('\n');
  const tests = CANARY_CASES.map(([label, code]) => `test('canary ${token} ${label}', async () => { ${code}; });`).join('\n');
  await fs.writeFile(
    path.join(sandbox, dir, name),
    `${imports}\nimport { test } from 'node:test';\nimport a from 'node:assert';\nimport s from 'node:assert/strict';\n` +
      `void [${modules.map((_, i) => `m${i}`).join(', ')}];\n${tests}\n`,
  );
  return { file: path.join(dir, name), token, expected: CANARY_CASES.length };
}

/**
 * Run test files (paths relative to sandbox) confined. Returns { ok, out, canaryOk, failures }.
 * ok is true only if every real test passed AND the canary failed as it must.
 */
// Does confinement actually work for this folder on this system? (Node 22 on Windows can mis-match
// allowed paths.) Checked once per folder with a throwaway confined process.
const probed = new Map();
function confinementWorks(real) {
  if (probed.has(real)) return probed.get(real);
  const probe = "const fs=require('fs');fs.readdirSync(process.cwd());fs.writeFileSync('.probe','x');fs.rmSync('.probe');console.log('ok')";
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${real}`, `--allow-fs-write=${real}`, '-e', probe], { cwd: real, encoding: 'utf8', timeout: 15_000 });
  const why = r.status === 0 && r.stdout.trim() === 'ok' ? null
    : `Node ${process.version}'s permission model can't confine test runs on ${process.platform} (${(r.stderr || r.stdout || r.error?.message || '').trim().split('\n').find((l) => /ERR_|Error/.test(l)) ?? `exit ${r.status}`})`;
  probed.set(real, why);
  return why;
}

/**
 * confined: false runs WITHOUT Node's permission model — only after the human explicitly agreed,
 * on systems where confinement can't work. The canary still runs; secrets are still scrubbed.
 */
export async function runConfinedTests(sandbox, files, { dir = 'test', timeoutMs = 180_000, canary = true, confined = true } = {}) {
  const realSandbox = fss.realpathSync(sandbox);
  if (confined) {
    const why = confinementWorks(realSandbox);
    if (why) return { ok: false, unavailable: why, out: why, canaryOk: false, failures: [] };
  }
  await fs.mkdir(path.join(sandbox, '.tmp'), { recursive: true });
  await fs.mkdir(path.join(sandbox, '.guardian-home'), { recursive: true });
  if (!files.length) return { ok: false, out: 'No test files found.', canaryOk: false, failures: [] };

  let can = null;
  if (canary) can = await writeCanary(sandbox, dir);

  const real = realSandbox;
  const readPaths = [real];
  const nm = path.join(sandbox, 'node_modules');
  if (fss.existsSync(nm)) readPaths.push(fss.realpathSync(nm));
  // Read-only access to the real dependencies the sandbox's shims re-export.
  try { for (const p of JSON.parse(fss.readFileSync(path.join(sandbox, '.awaken-deps.json'), 'utf8')).reads ?? []) readPaths.push(p); } catch { /* no shims */ }

  const args = [
    ...(confined ? ['--permission', ...readPaths.map((p) => `--allow-fs-read=${p}`), `--allow-fs-write=${real}`] : []),
    '--test', '--experimental-test-isolation=none', '--test-reporter=tap',
    ...files, ...(can ? [can.file] : []),
  ];

  const { code, out } = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: real, env: confinedEnv(real), timeout: timeoutMs, killSignal: 'SIGKILL' });
    let buf = '';
    child.stdout.on('data', (d) => (buf += d));
    child.stderr.on('data', (d) => (buf += d));
    child.on('error', (e) => resolve({ code: -1, out: buf + e.message }));
    child.on('close', (c) => resolve({ code: c, out: buf }));
  });
  if (can) await fs.rm(path.join(sandbox, can.file), { force: true });

  const failures = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  // Every canary case must fail; one that passes means the test machinery was tampered with.
  const canaryFailed = can ? failures.filter((f) => f.includes(can.token)).length === can.expected : true;
  const realFailures = can ? failures.filter((f) => !f.includes(can.token)) : failures;
  const passedSomething = /^\s*ok \d+ - /m.test(out);
  // With a canary, the run must exit non-zero (the canary) and contain no other failure.
  const ok = canaryFailed && realFailures.length === 0 && passedSomething && (can ? code !== 0 : code === 0);
  return { ok, out: out.slice(-20_000), canaryOk: canaryFailed, failures: realFailures };
}
