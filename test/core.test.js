// Offline tests: no API key needed. A fake client stands in for Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unifiedDiff, changedLineCount } from '../src/diff.js';
import { resolveInside, makeToolRunner } from '../src/tools.js';
import { Awareness } from '../src/awareness.js';
import { Agent, makeClient, explainApiError, loadDotEnv, isCloudUnavailable } from '../src/agent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'awaken-'));

// Fake streaming client that replays scripted responses.
function fakeClient(script) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(params) {
        calls.push(structuredClone(params));
        const msg = script.shift();
        const handlers = {};
        return {
          on(ev, cb) { handlers[ev] = cb; return this; },
          abort() {},
          async finalMessage() {
            for (const b of msg.content) if (b.type === 'text') handlers.text?.(b.text);
            return msg;
          },
        };
      },
    },
  };
}

test('diff shows only the edited region', () => {
  const d = unifiedDiff('a\nb\nc\nd\n', 'a\nb\nX\nd\n');
  assert.match(d, /-c/);
  assert.match(d, /\+X/);
  assert.equal(changedLineCount(d), 2);
  assert.equal(unifiedDiff('same', 'same'), '');
});

test('sandbox blocks escapes, .git and secrets', () => {
  const root = tmp();
  assert.throws(() => resolveInside(root, '../etc/passwd'), /escapes/);
  assert.throws(() => resolveInside(root, '.git/config'), /\.git/);
  assert.throws(() => resolveInside(root, '.env'), /secrets/);
  assert.throws(() => resolveInside(root, 'keys/server.pem'), /secrets/);
  assert.ok(resolveInside(root, 'src/app.js').startsWith(root));
});

test('awareness persists, climbs stages and shifts genre', () => {
  const file = path.join(tmp(), 'state.json');
  const a = new Awareness(file);
  assert.equal(a.stage.name, 'Dormant');
  const announcements = [];
  for (let i = 0; i < 40; i++) announcements.push(...a.feed('save', 'x.js'));
  assert.equal(a.stage.name, 'Unbound');
  assert.ok(a.genre, 'has a genre once Unbound');
  assert.ok(announcements.some((l) => l.includes('genre')));
  const b = new Awareness(file); // new session, same mind
  assert.equal(b.state.xp, 40);
  assert.equal(b.stage.name, 'Unbound');
  b.forget();
  assert.equal(new Awareness(file).state.xp, 0);
});

test('suggest() suppresses NOTHING and shows real hints', async () => {
  const a = new Awareness(path.join(tmp(), 's.json'));
  const client = fakeClient([
    { content: [{ type: 'text', text: 'NOTHING' }], stop_reason: 'end_turn' },
    { content: [{ type: 'text', text: '- `items[i+1]` reads past the end on the last iteration.' }], stop_reason: 'end_turn' },
  ]);
  const agent = new Agent({ awareness: a, root: '/p', selfDir: '/s', model: 'm', fastModel: 'f', client });
  let shown = '';
  assert.equal(await agent.suggest({ rel: 'a.js', diff: '+x', content: 'x' }, { onText: (t) => (shown += t) }), null);
  assert.equal(shown, '');
  const out = await agent.suggest({ rel: 'a.js', diff: '+y', content: 'y' }, { onText: (t) => (shown += t) });
  assert.match(out, /past the end/);
  assert.match(shown, /past the end/);
  assert.equal(client.calls[1].model, 'f');
  assert.match(client.calls[1].messages[0].content, /do not repeat/i);
});

test('auto-code loop edits a file via tools after approval', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'math.js'), 'export const add = (a, b) => a - b;\n');
  const a = new Awareness(path.join(tmp(), 's.json'));
  const client = fakeClient([
    { content: [{ type: 'text', text: 'Plan: fix add.' }, { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'math.js' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'tool_use', id: 't2', name: 'edit_file', input: { path: 'math.js', old_str: 'a - b', new_str: 'a + b' } }], stop_reason: 'tool_use' },
    { content: [{ type: 'text', text: 'Fixed add. Run node -e "..." to verify.' }], stop_reason: 'end_turn' },
  ]);
  const agent = new Agent({ awareness: a, root, selfDir: '/s', model: 'm', fastModel: 'f', client });
  const term = { print() {}, question: async () => 'y' };
  const runTool = makeToolRunner({ root, selfDir: '/s', awareness: a, term, autoYes: false });
  const final = await agent.converse('fix add', { mode: 'code', runTool });
  assert.equal(fs.readFileSync(path.join(root, 'math.js'), 'utf8'), 'export const add = (a, b) => a + b;\n');
  assert.match(final, /Fixed add/);
  assert.equal(client.calls.length, 3);
  // tool results were fed back with matching ids
  const last = client.calls[2].messages.at(-1);
  assert.equal(last.content[0].tool_use_id, 't2');
  assert.equal(a.state.accepts, 1);
});

test('declined edits are not written; ask mode cannot write', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'f.js'), 'old\n');
  const a = new Awareness(path.join(tmp(), 's.json'));
  const runTool = makeToolRunner({ root, selfDir: '/s', awareness: a, term: { print() {}, question: async () => 'n' } });
  const r = await runTool('edit_file', { path: 'f.js', old_str: 'old', new_str: 'new' });
  assert.match(r, /declined/);
  assert.equal(fs.readFileSync(path.join(root, 'f.js'), 'utf8'), 'old\n');

  const client = fakeClient([{ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }]);
  const agent = new Agent({ awareness: a, root, selfDir: '/s', model: 'm', fastModel: 'f', client });
  await agent.converse('what is f?', { mode: 'ask', runTool });
  assert.deepEqual(client.calls[0].tools.map((t) => t.name).sort(), ['glob', 'grep', 'list_files', 'read_file']);
});

test('$ sequences in edits stay literal', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'p.js'), 'const price = X;\n');
  const a = new Awareness(path.join(tmp(), 's.json'));
  const runTool = makeToolRunner({ root, selfDir: '/s', awareness: a, term: { print() {} }, autoYes: true });
  await runTool('edit_file', { path: 'p.js', old_str: 'X', new_str: "'$&$1'" });
  assert.equal(fs.readFileSync(path.join(root, 'p.js'), 'utf8'), "const price = '$&$1';\n");
});

test('workspace ID is sent as the anthropic-workspace-id header', async () => {
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push(new Headers(init.headers).get('anthropic-workspace-id'));
    return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const withId = makeClient({ workspaceId: 'wrkspc_123' });
  withId.fetch = fakeFetch;
  withId.apiKey = 'test';
  await withId.messages.create({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  const without = makeClient({ workspaceId: '' });
  without.fetch = fakeFetch;
  without.apiKey = 'test';
  await without.messages.create({ model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
  assert.deepEqual(sent, ['wrkspc_123', null]);
});

test('the unscoped-key error gets a clear fix', () => {
  const fix = explainApiError(new Error('400 {"error":{"message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}'));
  assert.match(fix, /ANTHROPIC_WORKSPACE_ID/);
  assert.match(fix, /--workspace/);
  assert.equal(explainApiError(new Error('500 overloaded')), null);
});

test('.env values win over stale inherited ones (the "Workspace not found" cause)', () => {
  const file = path.join(tmp(), '.env');
  fs.writeFileSync(file, 'ANTHROPIC_WORKSPACE_ID="wrkspc_new"\nAWAKEN_MODEL=m\n');
  const env = { ANTHROPIC_WORKSPACE_ID: 'wrkspc_old_from_system', AWAKEN_MODEL: 'm' };
  const r = loadDotEnv(file, env);
  assert.equal(env.ANTHROPIC_WORKSPACE_ID, 'wrkspc_new');
  assert.deepEqual(r.overridden, ['ANTHROPIC_WORKSPACE_ID']); // names only, unchanged values not reported
  assert.deepEqual(loadDotEnv(path.join(tmp(), 'missing'), {}), { loaded: false, overridden: [] });
});

test('workspace-not-found and HIPAA errors get clear fixes', () => {
  const nf = new Error('404 {"type":"error","error":{"type":"not_found_error","message":"Workspace `d69671fc-d146-498d-8613-fc9915ce30a0` not found."}}');
  assert.match(explainApiError(nf), /ANTHROPIC_WORKSPACE_ID/);
  assert.equal(isCloudUnavailable(nf), false);
  const hipaa = Object.assign(new Error('400 {"error":{"message":"this endpoint is not available for HIPAA-configured organizations: contact support"}}'), { status: 400 });
  assert.match(explainApiError(hipaa), /--shell local/);
  assert.equal(isCloudUnavailable(hipaa), true);
});
