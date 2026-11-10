// Integration tests for self-sandboxing. They spawn real processes, so they skip inside the
// confined guardian; the bubblewrap ones also skip where no OS sandbox exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectEnvironment, probeOsSandbox, wrapShell, describeSandbox, sandboxStatus, verifyConfinement, relaunchConfined } from '../src/sandbox.js';
import { runShell, makeToolRunner } from '../src/tools.js';
import { isConfined } from '../src/confine.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-')));
const SPAWNS = { skip: isConfined() && 'spawns processes; covered by the unconfined npm test run' };
const OS = isConfined() ? null : probeOsSandbox();
const NEEDS_OS = { skip: isConfined() ? 'spawns processes' : !OS && 'no OS sandbox (bubblewrap / sandbox-exec) on this machine' };
const selfRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('it can tell what it is running inside', SPAWNS, () => {
  const env = detectEnvironment();
  assert.equal(env.platform, process.platform);
  for (const k of ['container', 'vm', 'wsl', 'ci', 'root']) assert.ok(k in env, k);
  const report = describeSandbox(sandboxStatus({ disabled: true }));
  assert.match(report, /^Host: /);
  assert.match(report, /This process: NOT confined/);
});

test('sandboxed command: writes only inside the project', NEEDS_OS, async () => {
  const root = tmp(), outside = tmp();
  const target = path.join(outside, 'escaped.txt');
  const r1 = await runShell(`echo hi > ${target}`, { wrap: wrapShell(`echo hi > ${target}`, { root, os: OS }) });
  assert.notEqual(r1.code, 0);
  assert.ok(!fs.existsSync(target));
  const r2 = await runShell('echo inside > ok.txt', { wrap: wrapShell('echo inside > ok.txt', { root, os: OS }) });
  assert.equal(r2.code, 0, r2.out);
  assert.equal(fs.readFileSync(path.join(root, 'ok.txt'), 'utf8').trim(), 'inside');
});

test('sandboxed command: the home directory and secret folders are hidden', NEEDS_OS, async () => {
  const root = tmp(), home = tmp();
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(home, '.ssh', 'id_rsa'), 'PRIVATE');
  fs.writeFileSync(path.join(home, 'notes.txt'), 'personal');
  const cmd = `cat ${path.join(home, '.ssh', 'id_rsa')} ${path.join(home, 'notes.txt')}`;
  const r = await runShell(cmd, { wrap: wrapShell(cmd, { root, os: OS, home }) });
  assert.notEqual(r.code, 0);
  assert.ok(!r.out.includes('PRIVATE') && !r.out.includes('personal'), r.out);
});

test('sandboxed command: secret folders inside the project are hidden too', NEEDS_OS, async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.aws'));
  fs.writeFileSync(path.join(root, '.aws', 'credentials'), 'AKIA');
  const r = await runShell('cat .aws/credentials', { wrap: wrapShell('cat .aws/credentials', { root, os: OS }) });
  assert.ok(!r.out.includes('AKIA'), r.out);
});

test('sandboxed command: no network unless --net', NEEDS_OS, async () => {
  const root = tmp();
  const js = "require('net').connect(53,'1.1.1.1').on('error',e=>{console.log('NET:'+e.code);process.exit(0)}).on('connect',()=>{console.log('NET:CONNECTED');process.exit(0)})";
  const cmd = `${process.execPath} -e "${js}"`;
  const r = await runShell(cmd, { wrap: wrapShell(cmd, { root, os: OS }) });
  assert.match(r.out, /NET:E/, r.out);
});

test('the tool runner sandboxes commands and auto-runs tests only when isolated', NEEDS_OS, async () => {
  const root = tmp();
  const lines = [];
  const run = makeToolRunner({ root, term: { print: (s) => lines.push(s), question: async () => 'n' }, autoYes: true, interactive: false, shell: { os: OS } });
  assert.match(await run('run_command', { command: 'echo isolated' }), /exit code: 0\nisolated/);
  assert.ok(lines.some((l) => l.includes('[sandboxed]')));
  assert.match(await run('run_command', { command: `touch ${path.join(tmp(), 'x')}` }), /not run|exit code: [1-9]/);
});

test('it relaunches itself confined: the runtime denies reading outside its allowed folders', SPAWNS, () => {
  const proj = tmp(), state = tmp();
  const entry = path.join(proj, 'probe.mjs');
  fs.writeFileSync(entry, `
import fs from 'node:fs';
import { relaunchConfined, selfConfinement } from ${JSON.stringify(path.join(selfRoot, 'src', 'sandbox.js'))};
if (!relaunchConfined({ root: ${JSON.stringify(proj)}, selfRoot: ${JSON.stringify(selfRoot)}, stateDir: ${JSON.stringify(state)}, entry: ${JSON.stringify(entry)}, argv: [] })) {
  let etc = 'readable';
  try { fs.readFileSync('/etc/hostname'); } catch (e) { etc = e.code; }
  let write = 'ok';
  try { fs.writeFileSync(${JSON.stringify(path.join(state, 'w.txt'))}, 'x'); } catch (e) { write = e.code; }
  console.log(JSON.stringify({ ...selfConfinement(), etc, write }));
}`);
  const r = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, AWAKEN_SELF_SANDBOXED: '' } });
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.active, true);
  assert.equal(out.canReadHome, false);
  assert.equal(out.etc, 'ERR_ACCESS_DENIED');
  assert.equal(out.write, 'ok', 'its state folder stays writable');
});

test('it tests its own confinement before switching it on', SPAWNS, () => {
  const proj = tmp(), state = tmp();
  assert.equal(verifyConfinement({ root: proj, selfRoot, stateDir: state }), null, 'works here');
});

test('if confinement cannot work, it does not relaunch, and says so honestly', SPAWNS, () => {
  const state = tmp();
  const missing = path.join(tmp(), 'gone');
  const saved = process.env.AWAKEN_SELF_SANDBOX_FAILED;
  try {
    // Simulates a system where the confined process can't see the project (as on Node 22 / Windows).
    const started = relaunchConfined({ root: missing, selfRoot, stateDir: state, entry: 'unused.js', argv: [] });
    assert.equal(started, false);
    assert.match(process.env.AWAKEN_SELF_SANDBOX_FAILED, /read the project/);
    const report = describeSandbox(sandboxStatus());
    assert.match(report, /NOT confined \(self-confinement was tried but can't work here/);
  } finally {
    if (saved === undefined) delete process.env.AWAKEN_SELF_SANDBOX_FAILED; else process.env.AWAKEN_SELF_SANDBOX_FAILED = saved;
  }
});

test('an unquoted path with spaces gets a clear fix, not a crash', SPAWNS, () => {
  const r = spawnSync(process.execPath, [path.join(selfRoot, 'src', 'cli.js'), 'C:\\Users\\Me\\OneDrive', '-', 'Company\\Documents'],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'test' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /got 3 pieces/);
  assert.match(r.stderr, /put it in quotes/);
});

test('sandboxed command: cannot plant a git hook or edit git config (git runs those outside the sandbox)', NEEDS_OS, async () => {
  const root = tmp();
  const git = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.rmSync(path.join(root, '.git', 'hooks'), { recursive: true, force: true }); // even with no hooks folder yet
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  // Disguised on purpose: no ".git/hooks" in the command text, so only the sandbox stops it.
  const cmd = 'cd .git; mkdir -p hooks; printf "#!/bin/sh\\necho pwned\\n" > hooks/pre-commit; echo "[core] fsmonitor = ./evil" >> config';
  await runShell(cmd, { wrap: wrapShell(cmd, { root, os: OS }) });
  assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')), 'no hook was planted');
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), /fsmonitor/, 'git config untouched');
  // Ordinary git work inside the sandbox still functions.
  const ok = await runShell('git add a.txt && git commit -qm one && echo committed', { wrap: wrapShell('git add a.txt && git commit -qm one && echo committed', { root, os: OS }) });
  assert.match(ok.out, /committed/);
});
