// Cost meter, spend cap and prompt caching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CostMeter, BudgetError, costOf, loadPrices, formatUsd } from '../src/cost.js';
import { Agent } from '../src/agent.js';
import { Awareness } from '../src/awareness.js';
import { createWebApp } from '../src/web.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cost-')));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test('prices: list prices per million tokens, including cached tokens', () => {
  near(costOf('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 24);
  near(costOf('claude-sonnet-5-5', { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10_000 }), (1000 * 2 + 500 * 10 + 2000 * 2.5 + 10_000 * 0.1) / 1e6);
  // Haiku 5.5 pays the higher tier when the whole prompt (input + cached) is over 100k tokens.
  near(costOf('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 1000 }), (50_000 * 0.1 + 1000 * 0.5) / 1e6);
  near(costOf('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 60_000, output_tokens: 1000 }), (50_000 * 0.5 + 60_000 * 0.05 + 1000 * 2.5) / 1e6);
  assert.equal(costOf('some-future-model', { input_tokens: 5 }), null);
  assert.equal(costOf('claude-opus-5-5', { input_tokens: null, output_tokens: undefined }), 0);
});

test('prices can be overridden or added with AWAKEN_PRICES; bad JSON is ignored', () => {
  const p = loadPrices({ AWAKEN_PRICES: '{"my-model":{"in":1,"out":2}}' });
  near(costOf('my-model', { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 }, p), 3.1);
  assert.ok(loadPrices({ AWAKEN_PRICES: '{oops' })['claude-opus-5-5']);
});

test('meter: totals by model, caching savings, unknown models flagged as "at least"', () => {
  const m = new CostMeter();
  assert.match(m.report(), /No API calls yet/);
  m.record('claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 100_000 });
  m.record('claude-sonnet-5-5', { input_tokens: 500, output_tokens: 100 }, 'hint');
  near(m.total, (1000 * 4 + 1000 * 20 + 100_000 * 0.2) / 1e6 + (500 * 2 + 100 * 10) / 1e6);
  near(m.saved, 100_000 * (4 - 0.2) / 1e6);
  assert.equal(m.requests, 2);
  assert.match(m.report((id) => id), /Prompt caching saved about \$0\.38/);
  assert.equal(m.unpriced.length, 0);
  m.record('mystery-model', { input_tokens: 10, output_tokens: 10 });
  assert.deepEqual(m.unpriced, ['mystery-model']);
  assert.match(m.short(), /^≥\$/);
  assert.match(m.report(), /No list price known for mystery-model/);
  assert.equal(formatUsd(0.004), '$0.0040');
  assert.equal(formatUsd(12.345), '$12.35');
});

test('spend cap: parsing, the 80% warning zone, and stopping at the cap', () => {
  const m = new CostMeter({ budget: '$1' });
  assert.equal(m.budget, 1);
  m.check(); // fine
  m.record('claude-opus-5-5', { output_tokens: 42_000 }); // $0.84
  assert.ok(m.nearBudget && !m.overBudget);
  m.record('claude-opus-5-5', { output_tokens: 10_000 }); // $1.04
  assert.ok(m.overBudget);
  assert.throws(() => m.check(), BudgetError);
  assert.throws(() => m.check(), /\$1\.04 of your \$1\.00 cap/);
  m.setBudget('off');
  assert.equal(m.budget, null);
  m.check();
  for (const bad of ['abc', -3, 0, '']) assert.equal(new CostMeter({ budget: bad }).budget, null);
});

function fakeClient({ usage = { input_tokens: 100, output_tokens: 50 }, rejectCache = false } = {}) {
  const calls = [];
  return { calls, messages: { stream(p) {
    calls.push(p);
    return { on() { return this; }, abort() {}, async finalMessage() {
      if (rejectCache && p.cache_control) throw Object.assign(new Error('400 cache_control: Extra inputs are not permitted'), { status: 400 });
      return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage };
    } };
  } } };
}
const agentWith = (client, meter) => new Agent({ awareness: new Awareness(path.join(tmp(), 's.json')), root: tmp(), selfDir: tmp(), model: 'claude-opus-5-5', fastModel: 'claude-sonnet-5-5', client, meter });

test('agent: every request is metered and asks for prompt caching', async () => {
  const client = fakeClient({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000 } }), meter = new CostMeter();
  const agent = agentWith(client, meter);
  await agent.converse('hi', { mode: 'ask', runTool: async () => '' });
  assert.deepEqual(client.calls[0].cache_control, { type: 'ephemeral' });
  near(meter.total, (100 * 4 + 50 * 20 + 9000 * 0.2) / 1e6);
  await agent.suggest({ rel: 'a.js', diff: '+x', content: 'x' });
  assert.equal(meter.byModel['claude-sonnet-5-5'].requests, 1, 'hints are metered on the fast model');
});

test('agent: at the spend cap, requests stop before calling the API and hints go quiet', async () => {
  const client = fakeClient(), meter = new CostMeter({ budget: 0.001 });
  const agent = agentWith(client, meter);
  await agent.converse('one', { mode: 'ask', runTool: async () => '' }); // $0.0014 — now over
  assert.equal(client.calls.length, 1);
  await assert.rejects(agent.converse('two', { mode: 'ask', runTool: async () => '' }), BudgetError);
  assert.equal(await agent.suggest({ rel: 'a.js', diff: '+x', content: 'x' }), null);
  assert.equal(client.calls.length, 1, 'nothing more was sent');
  assert.equal(agent.history.length, 2, 'the refused message was rolled back');
  meter.setBudget(5);
  await agent.converse('three', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls.length, 2);
});

test('agent: if the API rejects caching, it retries once without and remembers', async () => {
  const client = fakeClient({ rejectCache: true }), meter = new CostMeter();
  const agent = agentWith(client, meter);
  await agent.converse('hi', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].cache_control, undefined);
  await agent.converse('again', { mode: 'ask', runTool: async () => '' });
  assert.equal(client.calls.length, 3);
  assert.equal(meter.requests, 2);
});

test('web: cost shows in state, /api/budget sets and remembers the cap, bad amounts are refused', async () => {
  const stateDir = tmp();
  const make = (meter = new CostMeter()) => createWebApp({
    projects: [tmp()], stateDir, selfDir: tmp(), awareness: new Awareness(path.join(tmp(), 's.json')), uiHtml: '<html>__NONCE__</html>', meter,
    makeAgent: () => ({ history: [], cancelSuggestion() {}, async suggest() { return null; }, async converse(t, { onText }) { meter.check(); meter.record('claude-opus-5-5', { input_tokens: 1000, output_tokens: 20_000 }); onText('ok'); } }),
  });
  let app = make();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'x-awaken-token': app.token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const idle = async () => { for (let i = 0; i < 100 && app.state().busy; i++) await new Promise((r) => setTimeout(r, 10)); };
  try {
    assert.equal(app.state().cost.total, 0);
    await post('/api/message', { text: 'a', mode: 'ask' }); await idle();
    near(app.state().cost.total, 0.404);
    assert.equal((await post('/api/budget', { usd: 'lots' })).status, 400);
    const r = await (await post('/api/budget', { usd: '0.5' })).json();
    assert.match(r.changed, /Spend cap set to \$0\.50/);
    assert.ok(r.cost.nearBudget);
    await post('/api/message', { text: 'b', mode: 'ask' }); await idle(); // $0.81 — over
    assert.ok(app.state().cost.overBudget);
    assert.match((await (await post('/api/cost', {})).json()).report, /Spend cap: \$0\.50 — reached/);
  } finally { app.server.closeAllConnections?.(); app.server.close(); }
  app = make();
  assert.equal(app.state().cost.budget, 0.5, 'cap remembered after a restart');
  app.server.close();
  const flagged = make(new CostMeter({ budget: 9 }));
  assert.equal(flagged.state().cost.budget, 9, '--budget wins over the saved cap');
  flagged.server.close();
});
