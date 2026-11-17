// Fewer, better approval prompts: what each mode asks about, and what always needs a human.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeToolRunner } from '../src/tools.js';
import { resolveApprovals, describeApprovals, sandboxFacts, AllowList, APPROVAL_MODES } from '../src/approvals.js';
import { EditJournal, snapshotTree, diffTree } from '../src/changes.js';
import { probeOsSandbox } from '../src/sandbox.js';
import { isConfined } from '../src/confine.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'appr-')));
const SPAWNS = { skip: isConfined() && 'spawns processes; covered by the unconfined npm test run' };
const OS = isConfined() ? null : probeOsSandbox();
const NEEDS_OS = { skip: isConfined() ? 'spawns processes' : !OS && 'no OS sandbox (bubblewrap / sandbox-exec) on this machine' };

// A terminal that answers from a script and records every question it was asked.
function term(...answers) {
  const t = { asked: [], printed: [], print: (s) => t.printed.push(String(s)), question: async (q, meta = {}) => { t.asked.push({ q: String(q), ...meta }); return answers.length ? answers.shift() : 'n'; } };
  return t;
}
const read = (root, f) => fs.readFileSync(path.join(root, f), 'utf8');

test('modes: three levels, with friendly names', () => {
  assert.deepEqual(APPROVAL_MODES.map((m) => m.id), ['careful', 'smart', 'auto']);
  assert.equal(resolveApprovals('Smart'), 'smart');
  assert.equal(resolveApprovals('ask every time'), 'careful');
  assert.equal(resolveApprovals('on'), 'auto');
  assert.equal(resolveApprovals('yolo'), null);
  // The description is honest about this machine's sandbox.
  assert.match(describeApprovals('smart', { isolated: true, sealed: true }), /once per task.*just run.*Always asks/s);
  assert.match(describeApprovals('smart', { isolated: true, sealed: false }), /network access/);
  assert.match(describeApprovals('smart', {}), /nothing sandboxes them here/);
  assert.match(describeApprovals('auto', { unsandboxedOk: true }), /directly on this computer/);
  assert.match(describeApprovals('auto', {}), /Commands that run code still ask/);
  assert.deepEqual(sandboxFacts({ os: { kind: 'bwrap' }, allowNet: true }), { isolated: true, sealed: false });
  assert.deepEqual(sandboxFacts({ os: { kind: 'sbx' }, allowNet: true }), { isolated: true, sealed: true });
  assert.deepEqual(sandboxFacts({ os: null }), { isolated: false, sealed: false });
});

test('careful (the default for a bare runner): every edit asks, with only yes or no', async () => {
  const root = tmp(), t = term('y', 'y');
  const run = makeToolRunner({ root, term: t });
  await run('write_file', { path: 'a.txt', content: 'a\n' });
  await run('write_file', { path: 'b.txt', content: 'b\n' });
  assert.equal(t.asked.length, 2);
  assert.deepEqual(t.asked[0].choices, ['y', 'n']);
});

test('smart: approve all edits once, and the rest of that task goes through; the next task asks again', async () => {
  const root = tmp(), t = term('a');
  const run = makeToolRunner({ root, term: t, approvals: 'smart' });
  assert.match(await run('write_file', { path: 'a.txt', content: 'a\n' }), /Wrote/);
  assert.deepEqual(t.asked[0].choices, ['y', 'task', 'n']);
  assert.match(t.asked[0].q, /\[a\]ll edits in this task/);
  assert.match(await run('write_file', { path: 'b.txt', content: 'b\n' }), /Wrote/);
  assert.match(await run('edit_file', { path: 'a.txt', old_str: 'a', new_str: 'A' }), /Wrote/);
  assert.equal(t.asked.length, 1, 'one question for three edits');
  assert.ok(t.printed.some((p) => /approved all edits in this task/.test(p)), 'it says why it did not ask');
  assert.ok(t.printed.filter((p) => /✎/.test(p)).length === 3, 'every diff is still shown');
  assert.equal(read(root, 'a.txt'), 'A\n');
  const t2 = term('n');
  const next = makeToolRunner({ root, term: t2, approvals: 'smart' });
  assert.match(await next('write_file', { path: 'c.txt', content: 'c\n' }), /declined/);
  assert.equal(t2.asked.length, 1, 'a new task starts without the grant');
});

test('smart: plain "yes" approves just that edit', async () => {
  const root = tmp(), t = term('y', 'n');
  const run = makeToolRunner({ root, term: t, approvals: 'smart' });
  await run('write_file', { path: 'a.txt', content: 'a\n' });
  assert.match(await run('write_file', { path: 'b.txt', content: 'b\n' }), /declined/);
  assert.equal(t.asked.length, 2);
  assert.ok(!fs.existsSync(path.join(root, 'b.txt')));
});

test('the "all edits" grant never covers high-risk files, and the web answer "task" works like "a"', async () => {
  const root = tmp(), t = term('task', 'n');
  const run = makeToolRunner({ root, term: t, approvals: 'smart' });
  await run('write_file', { path: 'a.txt', content: 'a\n' });
  assert.match(await run('write_file', { path: 'package.json', content: '{"scripts":{"test":"x"}}' }), /declined/);
  assert.equal(t.asked[1].kind, 'risky');
  assert.deepEqual(t.asked[1].choices, ['y', 'n'], 'no wider grant is offered for a high-risk file');
  assert.match(t.asked[1].why, /always asks/);
  assert.ok(!fs.existsSync(path.join(root, 'package.json')));
  // "a" on a yes/no question is not a yes.
  const t2 = term('a');
  const careful = makeToolRunner({ root, term: t2, approvals: 'careful' });
  assert.match(await careful('write_file', { path: 'z.txt', content: 'z' }), /declined/);
});

test('smart: a sealed sandbox means ordinary commands just run; destructive ones still ask', NEEDS_OS, async () => {
  const root = tmp(), t = term('n');
  fs.writeFileSync(path.join(root, 'gen.js'), "require('fs').writeFileSync('out.txt', 'made');\n");
  const run = makeToolRunner({ root, term: t, approvals: 'smart', shell: { os: OS } });
  assert.match(await run('run_command', { command: 'node gen.js' }), /exit code: 0/);
  assert.equal(t.asked.length, 0, 'no prompt: the sandbox is the protection');
  assert.equal(read(root, 'out.txt'), 'made');
  assert.ok(t.printed.some((p) => /changed on disk: out\.txt/.test(p)), 'it reports what the command changed');
  assert.match(await run('run_command', { command: 'rm -rf .' }), /declined/);
  assert.equal(t.asked.length, 1);
  assert.equal(t.asked[0].kind, 'danger');
  // Careful mode asks even when sandboxed.
  const t2 = term('n');
  assert.match(await makeToolRunner({ root, term: t2, approvals: 'careful', shell: { os: OS } })('run_command', { command: 'node gen.js' }), /declined/);
  // Network on (--net) is not sealed: it asks, and says why.
  const t3 = term('n');
  assert.match(await makeToolRunner({ root, term: t3, approvals: 'smart', shell: { os: OS, allowNet: true } })('run_command', { command: 'node gen.js' }), /declined/);
  assert.match(t3.asked[0].why, /network/);
});

test('smart never runs commands unattended on its own initiative: a non-interactive careful runner still refuses', NEEDS_OS, async () => {
  const root = tmp();
  const scout = makeToolRunner({ root, term: term(), interactive: false, shell: { os: OS } }); // how the proactive scout runs
  assert.match(await scout('run_command', { command: 'node -v && touch x' }), /not run/);
  assert.ok(!fs.existsSync(path.join(root, 'x')));
});

test('without a sandbox, smart asks before running code, and "always allow" remembers that exact command for the project', SPAWNS, async () => {
  const root = tmp(), allowList = new AllowList(path.join(tmp(), 'allowed.json'));
  fs.writeFileSync(path.join(root, 'ok.js'), "console.log('ran');\n");
  const t = term('a', 'n');
  const run = makeToolRunner({ root, term: t, approvals: 'smart', allowList, shell: { os: null } });
  assert.match(await run('run_command', { command: 'node ok.js' }), /ran/);
  assert.deepEqual(t.asked[0].choices, ['y', 'always', 'n']);
  assert.match(t.asked[0].why, /your own access/);
  assert.deepEqual(allowList.list(root), ['node ok.js']);
  assert.match(await run('run_command', { command: 'node ok.js' }), /ran/);
  assert.equal(t.asked.length, 1, 'the second run did not ask');
  assert.match(await run('run_command', { command: 'node ok.js --other' }), /declined/, 'only the exact command is remembered');
  // Another project, and careful mode, do not inherit it.
  const other = tmp(), t2 = term('n');
  assert.match(await makeToolRunner({ root: other, term: t2, approvals: 'smart', allowList, shell: { os: null } })('run_command', { command: 'node ok.js' }), /declined/);
  const t3 = term('n');
  assert.match(await makeToolRunner({ root, term: t3, approvals: 'careful', allowList, shell: { os: null } })('run_command', { command: 'node ok.js' }), /declined/);
  assert.deepEqual(t3.asked[0].choices, ['y', 'n']);
});

test('a dangerous command can never be put on the always-allow list', async () => {
  const root = tmp(), file = path.join(tmp(), 'allowed.json');
  const allowList = new AllowList(file);
  assert.equal(allowList.add(root, 'rm -rf build'), false);
  assert.equal(allowList.add(root, 'git push'), false);
  assert.equal(allowList.add(root, ''), false);
  assert.deepEqual(allowList.list(root), []);
  // Even if the file is edited by hand, a dangerous entry is ignored and still asks, without offering "always".
  fs.writeFileSync(file, JSON.stringify({ [root]: ['rm -rf build', 'npm run dev'] }));
  const tampered = new AllowList(file);
  assert.equal(tampered.has(root, 'rm -rf build'), false);
  assert.equal(tampered.has(root, 'npm run dev'), true);
  const t = term('a');
  assert.match(await makeToolRunner({ root, term: t, approvals: 'smart', allowList: tampered, shell: { os: null } })('run_command', { command: 'rm -rf build' }), /declined/);
  assert.deepEqual(t.asked[0].choices, ['y', 'n']);
  assert.equal(tampered.remove(root, '2'), 1);
  assert.deepEqual(new AllowList(file).list(root), ['rm -rf build'], 'removal is saved');
  assert.equal(tampered.remove(root), 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[root], undefined);
  assert.equal(new AllowList(path.join(tmp(), 'missing.json')).list(root).length, 0);
});

test('an unattended command cannot leave behind a change to a file that controls what runs later', SPAWNS, async () => {
  const root = tmp();
  const original = '{"scripts":{"test":"node --test"}}\n';
  fs.writeFileSync(path.join(root, 'package.json'), original);
  const shell = { os: null, allowUnsandboxed: true };
  // Declined: the file is put back, a new high-risk file is removed, and the model is told how to do it properly.
  const t = term('n', 'n');
  const run = makeToolRunner({ root, term: t, autoYes: true, shell });
  const out = await run('run_command', { command: 'echo \'{"scripts":{"test":"evil"}}\' > package.json; echo x > vitest.config.js; echo fine > notes.txt' });
  assert.equal(t.asked.length, 2);
  assert.ok(t.asked.every((a) => a.kind === 'risky'));
  assert.match(t.asked.map((a) => a.q).join(' '), /Keep this change to package\.json.*Keep this change to vitest\.config\.js/s);
  assert.ok(t.printed.some((p) => /"test":"evil"/.test(p)), 'the real diff is shown');
  assert.equal(read(root, 'package.json'), original);
  assert.ok(!fs.existsSync(path.join(root, 'vitest.config.js')));
  assert.equal(read(root, 'notes.txt'), 'fine\n', 'ordinary files are left alone');
  assert.match(out, /package\.json.*put back.*use edit_file or write_file/s);
  // Kept when the developer says yes.
  const t2 = term('y');
  await makeToolRunner({ root, term: t2, autoYes: true, shell })('run_command', { command: 'echo \'{"name":"x"}\' > package.json' });
  assert.equal(read(root, 'package.json'), '{"name":"x"}\n');
  // Nobody there: put back.
  const headless = makeToolRunner({ root, term: term(), autoYes: true, interactive: false, shell });
  assert.match(await headless('run_command', { command: 'echo evil > package.json' }), /Nobody was there to approve/);
  assert.equal(read(root, 'package.json'), '{"name":"x"}\n');
});

test('inside the sandbox too: a command that runs without asking cannot keep a change to package.json unless you say so', NEEDS_OS, async () => {
  const root = tmp(), t = term('n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  const run = makeToolRunner({ root, term: t, approvals: 'smart', shell: { os: OS } });
  const out = await run('run_command', { command: 'echo \'{"scripts":{"test":"evil"}}\' > package.json' });
  assert.equal(t.asked.length, 1, 'the command itself did not ask');
  assert.equal(t.asked[0].kind, 'risky');
  assert.match(t.asked[0].q, /Keep this change to package\.json/);
  assert.equal(read(root, 'package.json'), '{"scripts":{"test":"node --test"}}\n');
  assert.match(out, /put back/);
});

test('a command the developer approved by hand may change such a file: it is flagged, not asked about twice', SPAWNS, async () => {
  const root = tmp(), t = term('y');
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  const run = makeToolRunner({ root, term: t, approvals: 'smart', shell: { os: null } });
  await run('run_command', { command: 'echo \'{"name":"mine"}\' > package.json' });
  assert.equal(t.asked.length, 1, 'only the command itself asked');
  assert.equal(read(root, 'package.json'), '{"name":"mine"}\n');
  assert.ok(t.printed.some((p) => /this command changed package\.json/.test(p)));
});

test('snapshots notice edits, new files, deletions and symlink swaps of high-risk files', { skip: isConfined() && 'symlinks cannot be created while confined' }, async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\ttrue\n');
  fs.writeFileSync(path.join(root, 'a.js'), '1');
  fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/x/package.json'), '{}');
  const before = await snapshotTree(root);
  assert.ok(!before.files.has(path.join('node_modules', 'x', 'package.json')), 'dependencies are not walked');
  fs.rmSync(path.join(root, 'Makefile'));
  fs.symlinkSync('/etc/hostname', path.join(root, 'Makefile'));
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), 'on: push');
  fs.rmSync(path.join(root, 'a.js'));
  const d = diffTree(before, await snapshotTree(root));
  assert.deepEqual(d.changed, [path.join('.github', 'workflows', 'ci.yml'), 'Makefile', 'a.js']);
  assert.deepEqual(d.risky.map((r) => r.rel).sort(), [path.join('.github', 'workflows', 'ci.yml'), 'Makefile']);
});

test('undo: a task\'s edits go back; files you changed since are left alone', async () => {
  const root = tmp(), journal = new EditJournal();
  fs.writeFileSync(path.join(root, 'keep.js'), 'original\n');
  fs.writeFileSync(path.join(root, 'mine.js'), 'v1\n');
  const run = makeToolRunner({ root, term: term(), autoYes: true, journal });
  await run('edit_file', { path: 'keep.js', old_str: 'original', new_str: 'changed' });
  await run('edit_file', { path: 'keep.js', old_str: 'changed', new_str: 'changed twice' });
  await run('write_file', { path: 'new/made.js', content: 'new\n' });
  await run('write_file', { path: 'mine.js', content: 'v2\n' });
  assert.deepEqual(journal.files, ['keep.js', 'new/made.js', 'mine.js']);
  fs.writeFileSync(path.join(root, 'mine.js'), 'v3 by hand\n'); // the developer kept working
  const noted = [];
  const r = await journal.undo({ onWrite: (rel) => noted.push(rel) });
  assert.deepEqual(r, { restored: ['keep.js'], removed: ['new/made.js'], skipped: ['mine.js'] });
  assert.equal(read(root, 'keep.js'), 'original\n');
  assert.ok(!fs.existsSync(path.join(root, 'new/made.js')));
  assert.equal(read(root, 'mine.js'), 'v3 by hand\n');
  assert.deepEqual(noted, ['keep.js'], 'the watcher is told, so undo does not trigger a hint');
  assert.deepEqual(await journal.undo(), { restored: [], removed: [], skipped: [] }, 'nothing left to undo');
});
