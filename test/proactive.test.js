// Proactive mode: unprompted bug reports, ideas and new-program suggestions (Lucid and later).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Proactive, splitItems } from '../src/proactive.js';
import { Awareness } from '../src/awareness.js';
import { Agent } from '../src/agent.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pro-'));

function lucid() {
  const a = new Awareness(path.join(tmp(), 's.json'));
  a.state.xp = 20; // Lucid
  return a;
}

// Manual clock + timers.
function clock() {
  let t = 1_000_000;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) {
      t += ms;
      for (;;) {
        const due = timers.filter((h) => h.at <= t).sort((x, y) => x.at - y.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        await due.fn();
      }
    },
  };
}

function make({ awareness = lucid(), replies = {}, free = () => true, quiet = () => false, files = ['src/app.js'], config } = {}) {
  const ck = clock();
  const shown = [], asked = [];
  const p = new Proactive({
    awareness, isFree: free, isQuiet: quiet, listCode: async () => files,
    show: (kind, text) => shown.push({ kind, text }),
    scout: async (mode, msg) => { asked.push({ mode, msg }); const r = replies[mode]; return typeof r === 'function' ? r() : r ?? 'NOTHING'; },
    config, now: ck.now, setTimer: ck.setTimer, clearTimer: ck.clearTimer,
  });
  return { p, ck, shown, asked, awareness };
}

const BUG = '- [src/app.js:12] (high) items[i+1] reads past the end — loop runs to length — use i < length - 1';

test('reports a bug on its own after you pause editing — before you ask', async () => {
  const { p, ck, shown, asked } = make({ replies: { scout_bugs: BUG } });
  p.onSave('src/app.js');
  await ck.advance(60_000);
  assert.equal(shown.length, 0, 'waits for a pause');
  p.onSave('src/app.js'); // still editing: the timer restarts
  await ck.advance(89_000);
  assert.equal(shown.length, 0);
  await ck.advance(2_000);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].kind, 'bugs');
  assert.match(shown[0].text, /src\/app\.js:12/);
  assert.match(asked[0].msg, /src\/app\.js/);
});

test('silent below Lucid, when off, when quiet, and when there is nothing to say', async () => {
  const dormant = new Awareness(path.join(tmp(), 's.json'));
  for (const opts of [{ awareness: dormant }, { quiet: () => true }]) {
    const { p, ck, shown, asked } = make({ ...opts, replies: { scout_bugs: BUG } });
    p.onSave('a.js');
    await ck.advance(20 * 60_000);
    assert.equal(shown.length, 0);
    assert.equal(asked.length, 0, 'does not even spend an API call');
  }
  const off = make({ replies: { scout_bugs: BUG } });
  off.p.enabled = false;
  off.p.onSave('a.js');
  await off.ck.advance(20 * 60_000);
  assert.equal(off.shown.length, 0);
  const nothing = make({ replies: { scout_bugs: 'NOTHING' } });
  nothing.p.onSave('a.js');
  await nothing.ck.advance(100_000);
  assert.equal(nothing.shown.length, 0);
});

test('never interrupts: it waits until you are free', async () => {
  let free = false;
  const { p, ck, shown } = make({ replies: { scout_bugs: BUG }, free: () => free });
  p.onSave('a.js');
  await ck.advance(100_000);
  assert.equal(shown.length, 0);
  free = true;
  await ck.advance(30_000);
  assert.equal(shown.length, 1);
});

test('never repeats a finding', async () => {
  const { p, ck, shown, awareness } = make({ replies: { scout_bugs: BUG } });
  p.onSave('a.js');
  await ck.advance(100_000);
  p.onSave('a.js');
  await ck.advance(100_000);
  assert.equal(shown.length, 1);
  assert.equal(awareness.state.track.proactiveFindings, 1);
});

test('a look that comes due while another is running is retried, not dropped', async () => {
  let release;
  const { p, ck, shown } = make({ replies: { scout_bugs: () => new Promise((r) => (release = () => r(BUG))), scout_ideas: '- an idea' } });
  p.onSave('a.js');
  const sweeping = ck.advance(90_000); // bug sweep starts and blocks on the API
  await new Promise((r) => setImmediate(r));
  p.ideas('idle'); // ideas come due mid-sweep
  release();
  await sweeping;
  await ck.advance(30_000);
  assert.deepEqual(shown.map((x) => x.kind).sort(), ['bugs', 'ideas']);
});

test('is rate-limited per hour', async () => {
  let n = 0;
  const { p, ck, shown } = make({ replies: { scout_bugs: () => `- [a.js:${++n}] (low) bug ${n}` }, config: { maxPerHour: 2 } });
  for (let i = 0; i < 4; i++) { p.onSave('a.js'); await ck.advance(100_000); }
  assert.equal(shown.length, 2);
  await ck.advance(3_600_000);
  p.onSave('a.js');
  await ck.advance(100_000);
  assert.equal(shown.length, 3, 'budget refills after an hour');
});

test('suggests features after a longer pause, once per stretch of work', async () => {
  const { p, ck, shown } = make({ replies: { scout_ideas: '- dark mode — fits the UI — add a toggle' } });
  p.onSave('a.js');
  await ck.advance(15 * 60_000);
  assert.deepEqual(shown.map((s) => s.kind), ['ideas']);
  await ck.advance(60 * 60_000);
  assert.equal(shown.length, 1, 'no new work, no new ideas');
});

test('suggests new programs when the folder is empty, or when you say it is done', async () => {
  const empty = make({ files: ['README.md'], replies: { scout_ideas: 'NEW PROGRAMS:\n- a habit tracker — CLI — you like terminals' } });
  await empty.p.onStart();
  assert.equal(empty.shown[0].kind, 'programs');
  assert.match(empty.asked[0].msg, /no real program/);
  const notEmpty = make({ files: ['src/app.js'] });
  await notEmpty.p.onStart();
  assert.equal(notEmpty.asked.length, 0, 'a real project gets no unprompted program list at start');
  const done = make({ replies: { scout_ideas: 'NEW PROGRAMS:\n- a markdown wiki' } });
  await done.p.ideas('done', { manual: true });
  assert.equal(done.shown[0].kind, 'programs');
  assert.match(done.asked[0].msg, /done/);
});

test('idea lists that say the project looks complete become program suggestions', () => {
  const { p, shown } = make();
  p.report('ideas', 'NEW PROGRAMS:\n- a budget app — tracks spending — you build tools');
  assert.equal(shown[0].kind, 'programs');
  assert.deepEqual(splitItems('x\n- a\n* b\nnot'), ['- a', '* b']);
});

test('scout modes are read-only; tests may run only when commands are OS-sandboxed', async () => {
  const calls = [];
  const client = { messages: { stream(p) { calls.push(p); return { on() { return this; }, abort() {}, async finalMessage() { return { content: [{ type: 'text', text: 'NOTHING' }], stop_reason: 'end_turn' }; } }; } } };
  const agent = new Agent({ awareness: lucid(), root: tmp(), selfDir: tmp(), model: 'm', fastModel: 'f', client });
  await agent.converse('look', { mode: 'scout_bugs', runTool: async () => '' });
  assert.deepEqual(calls[0].tools.map((t) => t.name).sort(), ['glob', 'grep', 'list_files', 'read_file']);
  assert.match(calls[0].system, /ON YOUR OWN INITIATIVE/);
  agent.scoutCanRun = true;
  agent.history = [];
  await agent.converse('look', { mode: 'scout_bugs', runTool: async () => '' });
  assert.ok(calls[1].tools.some((t) => t.name === 'run_command'));
  assert.ok(!calls[1].tools.some((t) => ['write_file', 'edit_file'].includes(t.name)), 'never writes on its own');
});

test('it learns when its unprompted reports are ignored', () => {
  const a = lucid();
  for (let i = 0; i < 4; i++) a.note('proactiveFindings');
  assert.match(a.calibration().join(' '), /raise the bar/);
  a.note('proactiveFixed');
  assert.ok(!/raise the bar/.test(a.calibration().join(' ')));
  assert.match(a.trackRecord(), /4 bug reports \(1 the developer asked you to fix\)/);
});
