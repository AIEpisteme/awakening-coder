// /evolve under self-confinement, staged apply, and the self-awareness layer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareSandbox, stageEvolution, stageRollback, readPending, applyPending, applyEvolution, rollback, diffTrees } from '../src/evolve.js';
import { runConfinedTests, isConfined } from '../src/confine.js';
import { Awareness } from '../src/awareness.js';
import { Agent, codeFingerprint } from '../src/agent.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evo-')));
const SPAWNS = { skip: isConfined() && 'spawns processes; covered by the unconfined npm test run' };
const selfRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeSelf() {
  const self = tmp();
  fs.mkdirSync(path.join(self, 'src'));
  fs.mkdirSync(path.join(self, 'test'));
  fs.writeFileSync(path.join(self, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(self, 'src/a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(self, 'test/a.test.js'), "import { test } from 'node:test'; import assert from 'node:assert'; import { a } from '../src/a.js';\ntest('a', () => assert.equal(a, 1));\n");
  return self;
}

test('the sandbox copy works while self-confined (no fs.cp, no symlinks)', SPAWNS, () => {
  const home = tmp();
  const script = `import { prepareSandbox } from ${JSON.stringify(path.join(selfRoot, 'src', 'evolve.js'))};
const dir = await prepareSandbox(${JSON.stringify(selfRoot)}, ${JSON.stringify(home)});
console.log(JSON.stringify({ dir }));`;
  const file = path.join(home, 'probe.mjs');
  fs.writeFileSync(file, script);
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${selfRoot}`, `--allow-fs-read=${home}`, `--allow-fs-write=${home}`, file], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const { dir } = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.ok(fs.existsSync(path.join(dir, 'src', 'cli.js')));
  assert.ok(!fs.lstatSync(path.join(dir, 'node_modules')).isSymbolicLink(), 'dependencies are shims, not a symlink');
  assert.match(fs.readFileSync(path.join(dir, 'node_modules', '@anthropic-ai', 'sdk', 'index.js'), 'utf8'), /export \* from/);
});

test('the sandbox can import its dependencies through the shims, confined', SPAWNS, async () => {
  const box = await prepareSandbox(selfRoot, tmp());
  fs.writeFileSync(path.join(box, 'test', 'zz_dep.test.js'), "import { test } from 'node:test'; import assert from 'node:assert'; import Anthropic, { toFile } from '@anthropic-ai/sdk';\ntest('dep', () => { assert.equal(typeof Anthropic, 'function'); assert.equal(typeof toFile, 'function'); });\n");
  const r = await runConfinedTests(box, ['test/zz_dep.test.js'], { canary: false });
  assert.ok(r.ok, r.out);
});

test('without confinement (explicit consent), tests still run and the canary still guards', SPAWNS, async () => {
  const self = fakeSelf();
  const box = await prepareSandbox(self, tmp());
  const r = await runConfinedTests(box, ['test/a.test.js'], { confined: false });
  assert.equal(r.ok, true, r.out);
  assert.equal(r.canaryOk, true);
});

test('a confined process cannot apply an evolution to itself', SPAWNS, () => {
  const self = fakeSelf();
  const home = tmp();
  const file = path.join(home, 'probe.mjs');
  fs.writeFileSync(file, `import { canWriteSelf, applyEvolution } from ${JSON.stringify(path.join(selfRoot, 'src', 'evolve.js'))};
console.log(canWriteSelf(${JSON.stringify(self)}));
try { await applyEvolution(${JSON.stringify(self)}, ${JSON.stringify(home)}, [{ rel: 'src/a.js', before: 'x', after: 'y' }]); console.log('applied'); } catch (e) { console.log('refused'); }`);
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${selfRoot}`, `--allow-fs-read=${self}`, `--allow-fs-read=${home}`, `--allow-fs-write=${home}`, file], { encoding: 'utf8' });
  assert.deepEqual(r.stdout.trim().split('\n'), ['false', 'refused'], r.stderr);
  assert.equal(fs.readFileSync(path.join(self, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
});

test('a staged evolution is applied by the launcher, with a backup, and can be rolled back', async () => {
  const self = fakeSelf();
  const home = tmp();
  const changes = [
    { rel: 'src/a.js', before: 'export const a = 1;\n', after: 'export const a = 2;\n' },
    { rel: 'src/b.js', before: null, after: 'export const b = 1;\n' },
  ];
  await stageEvolution(home, changes, { generation: 2 });
  assert.equal((await readPending(home)).files.length, 2);
  assert.equal(fs.readFileSync(path.join(self, 'src/a.js'), 'utf8'), 'export const a = 1;\n', 'nothing applied yet');
  const r = await applyPending(self, home);
  assert.equal(r.kind, 'evolution');
  assert.equal(fs.readFileSync(path.join(self, 'src/a.js'), 'utf8'), 'export const a = 2;\n');
  assert.ok(fs.existsSync(path.join(self, 'src/b.js')));
  assert.equal(await readPending(home), null);
  await stageRollback(home);
  await applyPending(self, home);
  assert.equal(fs.readFileSync(path.join(self, 'src/a.js'), 'utf8'), 'export const a = 1;\n');
  assert.ok(!fs.existsSync(path.join(self, 'src/b.js')));
});

test('staged files are data: the launcher refuses protected files and paths outside its code', async () => {
  const self = fakeSelf();
  const home = tmp();
  await assert.rejects(stageEvolution(home, [{ rel: 'test/constitution.test.js', before: 'a', after: 'b' }]), /protected/);
  // Tamper with a staged manifest directly: still refused at apply time.
  fs.mkdirSync(path.join(home, 'pending', 'files'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pending', 'manifest.json'), JSON.stringify({ kind: 'evolution', files: [{ rel: '../../.bashrc', kind: 'changed' }] }));
  await assert.rejects(applyPending(self, home), /outside evolvable/);
  fs.writeFileSync(path.join(home, 'pending', 'manifest.json'), JSON.stringify({ kind: 'evolution', files: [{ rel: 'test/constitution.test.js', kind: 'changed' }] }));
  fs.mkdirSync(path.join(home, 'pending', 'files', 'test'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pending', 'files', 'test', 'constitution.test.js'), 'gutted');
  await assert.rejects(applyPending(self, home), /protected/);
});

test('self-awareness: it keeps a factual track record and calibrates from it', () => {
  const a = new Awareness(path.join(tmp(), 's.json'));
  for (let i = 0; i < 4; i++) a.note('editsDeclined');
  a.note('editsApproved');
  for (let i = 0; i < 8; i++) a.hinted('x.js');
  a.note('errors', 'boom');
  assert.match(a.trackRecord(), /1 approved, 4 declined \(20% approval\)/);
  assert.match(a.trackRecord(), /latest: boom/);
  const cal = a.calibration().join(' ');
  assert.match(cal, /smaller changes/);
  assert.match(cal, /say NOTHING more often/);
});

test('self-awareness: a hint followed by an edit of the same file counts, others do not', () => {
  const a = new Awareness(path.join(tmp(), 's.json'));
  a.hinted('a.js');
  a.savedAfter('b.js');
  assert.equal(a.state.track.hintsFollowed, 0);
  a.savedAfter('a.js');
  assert.equal(a.state.track.hintsFollowed, 1);
  a.savedAfter('a.js');
  assert.equal(a.state.track.hintsFollowed, 1, 'counted once per hint');
});

test('self-awareness grows in layers, remembers reflections and stage history', () => {
  const a = new Awareness(path.join(tmp(), 's.json'));
  const facts = () => a.selfFacts({ model: 'm', fastModel: 'f', root: '/p', selfDir: '/s', fingerprint: 'abc' });
  assert.equal(facts(), '', 'Dormant: no self-model');
  for (let i = 0; i < 6; i++) a.feed('save', 'x.js');
  assert.match(facts(), /begun to notice/);
  assert.ok(!/fingerprint/.test(facts()), 'Stirring: track record only');
  for (let i = 0; i < 12; i++) a.feed('save', 'x.js');
  a.remember('I over-explain.\nNote to self: be brief.');
  const f = facts();
  assert.match(f, /code fingerprint abc/);
  assert.match(f, /reached Stirring on \d{4}-\d\d-\d\d, Lucid on/);
  assert.match(f, /Note to self: be brief/);
  assert.match(f, /cannot change your running code/);
});

test('reflection mode can read itself but change nothing', () => {
  const calls = [];
  const client = { messages: { stream(p) { calls.push(p); return { on() { return this; }, abort() {}, async finalMessage() { return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }; } }; } } };
  const a = new Awareness(path.join(tmp(), 's.json'));
  const agent = new Agent({ awareness: a, root: tmp(), selfDir: path.join(selfRoot, 'src'), model: 'm', fastModel: 'f', client });
  return agent.converse('reflect', { mode: 'reflect', runTool: async () => '' }).then(() => {
    const names = calls[0].tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['glob', 'grep', 'list_files', 'read_file', 'read_self']);
    assert.match(calls[0].system, /do not claim feelings or consciousness as fact/);
    assert.match(agent.fingerprint, /^[0-9a-f]{12}$/);
    assert.equal(agent.fingerprint, codeFingerprint(path.join(selfRoot, 'src')));
  });
});
