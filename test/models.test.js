// Switching model and effort: names, the API request, and the web menu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveModel, resolveEffort, MODELS, EFFORTS } from '../src/models.js';
import { Agent } from '../src/agent.js';
import { Awareness } from '../src/awareness.js';
import { createWebApp } from '../src/web.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdl-')));

test('model and effort names: short, display and full forms', () => {
  assert.deepEqual(MODELS.map((m) => m.label), ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
  assert.deepEqual(EFFORTS.map((e) => e.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(resolveModel('opus'), 'claude-opus-5-5');
  assert.equal(resolveModel('Sonnet 5.5'), 'claude-sonnet-5-5');
  assert.equal(resolveModel('HAIKU'), 'claude-haiku-5-5');
  assert.equal(resolveModel('claude-opus-4-8'), 'claude-opus-4-8', 'other real ids pass through');
  assert.equal(resolveModel('gpt-5'), null);
  assert.equal(resolveModel('claude-x; rm -rf /'), null);
  assert.equal(resolveEffort('Extra high'), 'xhigh');
  assert.equal(resolveEffort('extra'), 'xhigh');
  assert.equal(resolveEffort('MAX'), 'max');
  assert.equal(resolveEffort('huge'), null);
});

function fakeClient({ rejectEffort = false } = {}) {
  const calls = [];
  return { calls, messages: { stream(p) {
    calls.push(p);
    const fail = rejectEffort && p.output_config;
    return { on() { return this; }, abort() {}, async finalMessage() {
      if (fail) throw Object.assign(new Error('400 output_config.effort: not supported for this model'), { status: 400 });
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
    } };
  } } };
}

test('the chosen effort is sent as output_config.effort with the chosen model', async () => {
  const client = fakeClient();
  const aw = new Awareness(path.join(tmp(), 's.json')); aw.state.xp = 20; // Lucid: it knows facts about itself
  const agent = new Agent({ awareness: aw, root: tmp(), selfDir: tmp(), model: 'claude-opus-5-5', fastModel: 'f', client });
  await agent.converse('hi', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls[0].output_config, undefined, 'no effort set: none sent');
  agent.model = 'claude-haiku-5-5'; agent.effort = 'xhigh';
  await agent.converse('again', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls[1].model, 'claude-haiku-5-5');
  assert.deepEqual(client.calls[1].output_config, { effort: 'xhigh' });
  assert.match(client.calls[1].system, /claude-haiku-5-5" at xhigh effort/, 'it knows its own model and effort');
});

test('a model that rejects effort still answers (retried once without it, and remembered)', async () => {
  const client = fakeClient({ rejectEffort: true });
  const agent = new Agent({ awareness: new Awareness(path.join(tmp(), 's.json')), root: tmp(), selfDir: tmp(), model: 'm', fastModel: 'f', client });
  agent.effort = 'max';
  let out = '';
  await agent.converse('hi', { mode: 'ask', runTool: async () => '', onText: (t) => (out += t) });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].output_config, undefined);
  assert.match(out, /doesn't take an effort setting/);
  await agent.converse('again', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls.length, 3, 'not retried again for this model');
});

test('web: the menu switches model and effort for the next message, rejects unknown values, and remembers', async () => {
  const stateDir = tmp(), seen = [];
  const make = () => createWebApp({
    projects: [tmp()], stateDir, selfDir: tmp(), awareness: new Awareness(path.join(tmp(), 's.json')), uiHtml: '<html>__NONCE__</html>',
    makeAgent: () => ({ history: [], cancelSuggestion() {}, async suggest() { return null; }, async converse(text, { onText }) { seen.push([this.model, this.effort]); onText('ok'); } }),
  });
  let app = make();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'x-awaken-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const waitIdle = async () => { for (let i = 0; i < 100 && app.state().busy; i++) await new Promise((r) => setTimeout(r, 10)); };
  try {
    let st = app.state();
    assert.equal(st.model, 'claude-opus-5-5'); assert.equal(st.effort, 'high');
    assert.equal(st.models.length, 3); assert.equal(st.efforts.length, 5);
    await post('/api/message', { text: 'a', mode: 'ask' }); await waitIdle();
    let r = await post('/api/model', { model: 'sonnet', effort: 'extra high' });
    assert.equal(r.status, 200);
    assert.match((await r.json()).changed, /Sonnet 5\.5 · Extra high effort/);
    await post('/api/message', { text: 'b', mode: 'ask' }); await waitIdle();
    assert.deepEqual(seen, [['claude-opus-5-5', 'high'], ['claude-sonnet-5-5', 'xhigh']]);
    assert.equal((await post('/api/model', { model: 'gpt-9' })).status, 400);
    assert.equal((await post('/api/model', { effort: 'ludicrous' })).status, 400);
    assert.equal(app.state().model, 'claude-sonnet-5-5', 'a bad request changes nothing');
    r = await post('/api/model', { effort: 'low' });
    assert.equal((await r.json()).model, 'claude-sonnet-5-5', 'changing effort keeps the model');
  } finally { app.server.closeAllConnections?.(); app.server.close(); }
  app = make();
  assert.deepEqual([app.state().model, app.state().effort], ['claude-sonnet-5-5', 'low'], 'remembered after a restart');
  app.server.close();
});
