// Docker Sandboxes as the command sandbox when the OS has none (e.g. Windows). Uses a stand-in `sbx`
// that behaves like the real CLI (ls -q / create shell / exec -w), so this runs anywhere without Docker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { probeDockerSandbox, prepareDockerSandbox, workdirCandidates, sandboxNameFor, findSbx } from '../src/docker-sandbox.js';
import { probeCommandSandbox, wrapShell, describeSandbox } from '../src/sandbox.js';
import { runShell } from '../src/tools.js';
import { isConfined } from '../src/confine.js';

const SPAWNS = { skip: (isConfined() || process.platform === 'win32') && 'spawns a stand-in sbx shell script' };
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-')));

function fakeSbx({ failLs = '', rejectRo = false } = {}) {
  const bin = tmp(), state = tmp();
  fs.writeFileSync(path.join(bin, 'sbx'), `#!/bin/sh
STATE="${state}"
echo "$*" >> "$STATE/calls"
case "$1" in
  ls) ${failLs ? `echo "${failLs}" >&2; exit 1` : 'cat "$STATE/names" 2>/dev/null; exit 0'} ;;
  create) shift 2; NAME=""; while [ $# -gt 0 ]; do case "$1" in --name) NAME="$2"; shift 2;; --no-progress) shift;; *:ro) ${rejectRo ? 'echo "invalid mount" >&2; exit 2' : 'shift'};; *) shift;; esac; done
          echo "$NAME" >> "$STATE/names"; exit 0 ;;
  exec) shift; DIR=""; if [ "$1" = "-w" ]; then DIR="$2"; shift 2; fi
        grep -qx "$1" "$STATE/names" || { echo "no such sandbox" >&2; exit 125; }
        shift; [ -n "$DIR" ] && cd "$DIR"; exec "$@" ;;
esac
exit 1
`, { mode: 0o755 });
  const calls = () => (fs.existsSync(path.join(state, 'calls')) ? fs.readFileSync(path.join(state, 'calls'), 'utf8') : '');
  return { bin, env: { PATH: bin }, calls };
}

const gitRepo = () => { const r = tmp(); spawnSync('git', ['init', '-q'], { cwd: r }); return r; };

test('no OS sandbox: it starts a Docker Sandbox for the project at session start', SPAWNS, () => {
  const sbx = fakeSbx(), root = gitRepo(), logs = [];
  const res = probeCommandSandbox({ root, log: (m) => logs.push(m), probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: sbx.env }) });
  assert.equal(res.os.kind, 'sbx');
  const prep = res.os.prepared[root];
  assert.equal(prep.name, sandboxNameFor(root));
  assert.equal(prep.workdir, root, 'project visible at the same path inside the VM');
  assert.ok(prep.gitProtected, 'git hooks and config mounted read-only');
  assert.match(sbx.calls(), new RegExp(`create shell --name ${prep.name} --no-progress ${root} ${root}/.git/hooks:ro ${root}/.git/config:ro`));
  assert.match(logs.join('\n'), /Starting a Docker Sandbox/);
  assert.ok(!fs.readdirSync(root).some((f) => f.startsWith('.awaken-sbx-')), 'probe marker cleaned up');
  const text = describeSandbox({ environment: {}, self: { active: true }, os: res.os, allowNet: false });
  assert.match(text, /Docker Sandbox microVM/);
  assert.match(text, /git hooks and config mounted read-only/);
});

test('commands run inside the project sandbox; a second session reuses it; other projects get their own', SPAWNS, async () => {
  const sbx = fakeSbx(), root = gitRepo();
  const { os: sb } = probeCommandSandbox({ root, probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: sbx.env }) });
  const r = await runShell('pwd; echo hi > made.txt', { cwd: root, wrap: wrapShell('pwd; echo hi > made.txt', { root, os: sb }) });
  assert.equal(r.code, 0);
  assert.match(sbx.calls(), new RegExp(`exec -w ${root} ${sandboxNameFor(root)} sh -c pwd; echo hi > made.txt`));
  assert.equal(fs.readFileSync(path.join(root, 'made.txt'), 'utf8'), 'hi\n');
  const again = probeCommandSandbox({ root, probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: sbx.env }) });
  assert.equal(sbx.calls().split('\n').filter((l) => l.startsWith('create')).length, 1, 'reused, not re-created');
  assert.equal(again.os.kind, 'sbx');
  const other = gitRepo(); // e.g. a GitHub repo opened later in the web app
  const r2 = await runShell('echo ok', { cwd: other, wrap: wrapShell('echo ok', { root: other, os: sb }) });
  assert.equal(r2.code, 0);
  assert.match(sbx.calls(), new RegExp(`create shell --name ${sandboxNameFor(other)}`));
});

test('if sbx rejects read-only git mounts, it still isolates (and says git is not protected)', SPAWNS, () => {
  const sbx = fakeSbx({ rejectRo: true }), root = gitRepo();
  const res = probeCommandSandbox({ root, probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: sbx.env }) });
  assert.equal(res.os.kind, 'sbx');
  assert.equal(res.os.prepared[root].gitProtected, false);
  assert.doesNotMatch(describeSandbox({ environment: {}, self: { active: true }, os: res.os }), /git hooks/);
});

test('when Docker Sandboxes is missing, not signed in, or turned off, it says why and stays honest', SPAWNS, () => {
  const root = tmp();
  const none = probeCommandSandbox({ root, probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: { PATH: tmp() }, platform: 'win32' }) });
  assert.equal(none.os, null);
  assert.match(none.dockerReason, /winget install -h Docker\.sbx/);
  const sbx = fakeSbx({ failLs: 'error: not signed in' });
  const out = probeCommandSandbox({ root, probeOs: () => null, probeDocker: () => probeDockerSandbox({ env: sbx.env }) });
  assert.equal(out.os, null);
  assert.match(out.dockerReason, /not ready: error: not signed in/);
  const text = describeSandbox({ environment: {}, self: { active: true }, os: null, dockerReason: out.dockerReason });
  assert.match(text, /NOT isolated .*tried Docker Sandboxes/);
  const off = probeDockerSandbox({ env: { ...fakeSbx().env, AWAKEN_DOCKER_SANDBOX: 'off' } });
  assert.match(off.reason, /turned off/);
});

test('an OS sandbox (bubblewrap / sandbox-exec) is preferred; Docker is not touched', () => {
  const res = probeCommandSandbox({ root: tmp(), probeOs: () => ({ kind: 'bwrap', path: '/usr/bin/bwrap' }), probeDocker: () => { throw new Error('should not be called'); } });
  assert.equal(res.os.kind, 'bwrap');
});

test('a sandbox that cannot be created fails closed: commands are refused, not run unsandboxed', SPAWNS, () => {
  const sbx = fakeSbx(), root = tmp();
  const sb = { kind: 'sbx', path: path.join(sbx.bin, 'sbx'), prepared: {} };
  fs.chmodSync(sb.path, 0o644); // broken sbx
  assert.throws(() => wrapShell('echo x', { root, os: sb }));
});

test('Windows project paths: candidate locations inside the Linux VM', () => {
  const c = workdirCandidates('C:\\Users\\Dev_User\\OneDrive - Company\\proj');
  assert.equal(c[0], 'C:\\Users\\Dev_User\\OneDrive - Company\\proj');
  for (const want of ['C:/Users/Dev_User/OneDrive - Company/proj', '/c/Users/Dev_User/OneDrive - Company/proj', '/mnt/c/Users/Dev_User/OneDrive - Company/proj']) assert.ok(c.includes(want), want);
  assert.match(sandboxNameFor('C:\\x'), /^awaken-[0-9a-f]{12}$/);
  const bin = tmp(); fs.writeFileSync(path.join(bin, 'sbx.exe'), '');
  assert.equal(findSbx({ env: { PATH: bin, PATHEXT: '.COM;.EXE' }, platform: 'win32' }), path.join(bin, 'sbx.exe'));
});
