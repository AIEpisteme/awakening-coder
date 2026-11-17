// The web GUI: security of the local server, and a full approve-an-edit round trip, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createWebApp, parseGithubUrl } from '../src/web.js';
import { Awareness } from '../src/awareness.js';
import { isConfined } from '../src/confine.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-')));
const SPAWNS = { skip: isConfined() && 'spawns processes; covered by the unconfined npm test run' };

// A fake agent: in code mode it proposes one edit through the real tool runner.
const fakeAgent = (root) => ({
  history: [],
  cancelSuggestion() {},
  async suggest({ rel }, { onStart, onText }) { onStart(); onText(`check ${rel}: possible off-by-one`); return 'x'; },
  async converse(text, { mode, runTool, onText }) {
    onText(`(${mode}) `);
    if (mode === 'code') onText(String(await runTool('write_file', { path: 'hello.txt', content: 'hi from the web\n' })));
    else onText(`you asked: ${text}`);
  },
});

async function start(opts = {}) {
  const root = opts.root ?? tmp();
  const app = createWebApp({
    projects: [root], stateDir: tmp(), selfDir: tmp(), awareness: new Awareness(path.join(tmp(), 's.json')),
    makeAgent: fakeAgent, uiHtml: '<html>nonce=__NONCE__</html>', git: opts.git ?? (async () => ({ code: 1, out: 'not a repo' })),
    ...opts.app,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = (p, { body, token = app.token, headers = {} } = {}) => fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { 'x-awaken-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Collect server-sent events.
  const events = [];
  const ac = new AbortController();
  const es = await fetch(`${base}/events?t=${app.token}`, { signal: ac.signal });
  (async () => {
    const reader = es.body.getReader(); let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += Buffer.from(value).toString('utf8');
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /^data: (.*)$/m.exec(chunk); if (m) events.push(JSON.parse(m[1])); }
      }
    } catch { /* closed */ }
  })();
  const waitFor = async (pred, ms = 5000) => {
    const t0 = Date.now();
    for (;;) { const e = events.find(pred); if (e) return e; if (Date.now() - t0 > ms) throw new Error('timeout waiting for event; got ' + JSON.stringify(events.map((x) => x.type))); await new Promise((r) => setTimeout(r, 20)); }
  };
  const stop = () => { ac.abort(); app.server.closeAllConnections?.(); app.server.close(); };
  return { app, root, base, port, call, events, waitFor, stop };
}

test('only this machine, with the token, can use it', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/api/state', { token: null })).status, 401, 'no token');
    assert.equal((await s.call('/api/state', { token: 'wrong-token-of-same-len-xx' })).status, 401, 'wrong token');
    assert.equal((await s.call('/', { token: null })).status, 401, 'page needs the token too');
    const rawStatus = (host) => new Promise((resolve, reject) => {
      // fetch won't let us forge Host, so speak HTTP directly (as a DNS-rebinding page would).
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host, 'x-awaken-token': s.app.token } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(await rawStatus(`evil.example:${s.port}`), 403, 'DNS-rebinding host refused');
    assert.equal(await rawStatus(`localhost:${s.port}`), 200);
    assert.equal((await s.call('/api/stop', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403, 'foreign origin refused');
    const page = await s.call(`/?t=${s.app.token}`, { token: null });
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.ok(!(await page.text()).includes('__NONCE__'), 'nonce filled in');
  } finally { s.stop(); }
});

test('the server binds to localhost only', async () => {
  const s = await start();
  try { assert.equal(s.app.server.address().address, '127.0.0.1'); } finally { s.stop(); }
});

test('ask streams an answer; code proposes an edit you approve in the browser', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('/api/message', { body: { text: 'what is this?', mode: 'ask' } })).status, 202);
    await s.waitFor((e) => e.type === 'done');
    assert.ok(s.events.some((e) => e.type === 'text' && /you asked: what is this\?/.test(e.text)));

    assert.equal((await s.call('/api/message', { body: { text: 'add hello', mode: 'code' } })).status, 202);
    const q = await s.waitFor((e) => e.type === 'question');
    assert.match(q.prompt, /Apply this change/);
    assert.ok(s.events.some((e) => e.type === 'print' && /\+hi from the web/.test(e.text)), 'the diff is shown first');
    assert.ok(!fs.existsSync(path.join(s.root, 'hello.txt')), 'nothing written before approval');
    assert.equal((await s.call('/api/message', { body: { text: 'again', mode: 'ask' } })).status, 409, 'one request at a time');
    await s.call('/api/answer', { body: { id: q.id, answer: 'y' } });
    await s.waitFor((e) => e.type === 'done' && s.events.indexOf(e) > s.events.indexOf(q));
    assert.equal(fs.readFileSync(path.join(s.root, 'hello.txt'), 'utf8'), 'hi from the web\n');
  } finally { s.stop(); }
});

test('declining in the browser writes nothing; stop answers no', async () => {
  const s = await start();
  try {
    await s.call('/api/message', { body: { text: 'add hello', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    await s.call('/api/answer', { body: { id: q.id, answer: 'something-else' } }); // anything but y is no
    await s.waitFor((e) => e.type === 'done');
    assert.ok(!fs.existsSync(path.join(s.root, 'hello.txt')));
    assert.ok(s.events.some((e) => e.type === 'text' && /declined/.test(e.text)));
  } finally { s.stop(); }
});

test('files: secrets are invisible and redacted; no path escapes', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  fs.writeFileSync(path.join(root, 'config.js'), 'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\n');
  const s = await start({ root });
  try {
    const { files } = await (await s.call('/api/files')).json();
    assert.deepEqual(files, ['config.js']);
    const f = await (await s.call('/api/file?path=config.js')).json();
    assert.ok(!f.content.includes('sk-ant-api03'));
    assert.equal((await s.call('/api/file?path=.env')).status, 500);
    assert.equal((await s.call('/api/file?path=../../etc/passwd')).status, 500);
  } finally { s.stop(); }
});

test('only real GitHub repo URLs are cloned, into its own folder', async () => {
  assert.deepEqual(parseGithubUrl('https://github.com/AIEpisteme/awakening-coder'), { owner: 'AIEpisteme', repo: 'awakening-coder', url: 'https://github.com/AIEpisteme/awakening-coder.git', slug: 'AIEpisteme__awakening-coder' });
  for (const bad of ['http://github.com/a/b', 'https://evil.example/a/b', 'https://user:pw@github.com/a/b', 'https://github.com/../b', 'file:///etc', 'https://github.com/a/b/../../c', 'https://github.com/a']) {
    assert.equal(parseGithubUrl(bad), null, bad);
  }
  const calls = [];
  const s = await start({ git: async (args, { cwd }) => { calls.push({ args, cwd }); if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true }); return { code: 0, out: '' }; } });
  try {
    assert.equal((await s.call('/api/project', { body: { github: 'https://evil.example/x/y' } })).status, 400);
    const st = await (await s.call('/api/project', { body: { github: 'https://github.com/AIEpisteme/awakening-coder' } })).json();
    const cur = st.projects.find((p) => p.id === st.current);
    assert.equal(cur.name, 'AIEpisteme/awakening-coder');
    assert.equal(cur.kind, 'github');
    assert.deepEqual(calls[0].args.slice(0, 3), ['clone', '--depth', '50']);
    assert.equal(calls[0].args[3], 'https://github.com/AIEpisteme/awakening-coder.git');
    assert.equal((await s.call('/api/project', { body: { id: 'not-a-project' } })).status, 400, 'no arbitrary local folders at runtime');
  } finally { s.stop(); }
});

test('commit refuses secret files and inline keys (real git)', SPAWNS, async () => {
  const root = tmp();
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'a.js'), 'x\n'); g('add', '-A'); g('commit', '-qm', 'base');
  const s = await start({ root, git: undefined, app: {} });
  // use the real git runner
  s.stop();
  const { runGit } = await import('../src/web.js');
  const s2 = await start({ root, git: runGit });
  try {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
    let r = await s2.call('/api/commit', { body: { message: 'oops' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /secret files: \.env/);
    fs.rmSync(path.join(root, '.env'));
    fs.writeFileSync(path.join(root, 'a.js'), 'const k = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";\n');
    r = await s2.call('/api/commit', { body: { message: 'oops' } });
    assert.match((await r.json()).error, /looks like a key/);
    assert.equal(g('diff', '--cached', '--name-only').stdout.trim(), '', 'unstaged again');
    fs.writeFileSync(path.join(root, 'a.js'), 'y\n');
    r = await s2.call('/api/commit', { body: { message: 'change a' } });
    assert.equal(r.status, 200, await r.clone().text());
    assert.match(g('log', '--oneline', '-1').stdout, /change a/);
    const info = await (await s2.call('/api/git')).json();
    assert.equal(info.isRepo, true);
  } finally { s2.stop(); }
});

// ---------- live features: save-hints and unprompted reports ----------
async function startLive({ lucid = true, scoutReply = '- [a.js:1] (high) x used before defined — throws — declare x first', hintCooldownMs = 0 } = {}) {
  const watchers = [];
  const awareness = new Awareness(path.join(tmp(), 's.json'));
  if (lucid) awareness.state.xp = 20;
  const s = await start({
    app: {
      awareness, hintCooldownMs, proactiveConfig: { bugIdleMs: 50, ideaIdleMs: 60_000, retryMs: 20 },
      watch: async (root, onChange) => { const w = { root, onChange, closed: false, self: [], close() { this.closed = true; }, noteSelfWrite(rel) { this.self.push(rel); } }; watchers.push(w); return w; },
      scout: async (mode) => (mode === 'scout_bugs' ? scoutReply : 'NOTHING'),
    },
  });
  await new Promise((r) => setTimeout(r, 50)); // watcher starts on 'listening'
  return { ...s, watchers, awareness };
}

test('saving a file shows a hint card in the browser', async () => {
  const s = await startLive({ lucid: false });
  try {
    assert.equal(s.watchers.length, 1);
    s.watchers[0].onChange({ rel: 'a.js', prev: 'let a = 1;\n', content: 'let a = 2;\n' });
    const h = await s.waitFor((e) => e.type === 'hint');
    assert.equal(h.rel, 'a.js');
    await s.waitFor((e) => e.type === 'hint-text' && /off-by-one/.test(e.text));
    await s.waitFor((e) => e.type === 'hint-end');
    assert.ok(s.events.some((e) => e.type === 'saved' && e.rel === 'a.js'));
  } finally { s.stop(); }
});

test('hints can be turned off from the browser', async () => {
  const s = await startLive({ lucid: false });
  try {
    await s.call('/api/hints', { body: { on: false } });
    s.watchers[0].onChange({ rel: 'a.js', prev: 'a\n', content: 'b\n' });
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(!s.events.some((e) => e.type === 'hint'));
    assert.equal((await (await s.call('/api/state')).json()).hints, false);
  } finally { s.stop(); }
});

test('from Lucid, a pause after saving brings an unprompted bug report; Fix it starts a code run', async () => {
  const s = await startLive();
  try {
    s.watchers[0].onChange({ rel: 'a.js', prev: '', content: 'console.log(x); let x = 1;\n' });
    const bug = await s.waitFor((e) => e.type === 'proactive' && e.kind === 'bugs');
    assert.match(bug.text, /a\.js:1/);
    assert.equal((await s.call('/api/fix', { body: {} })).status, 202);
    await s.waitFor((e) => e.type === 'start' && e.mode === 'code');
    const q = await s.waitFor((e) => e.type === 'question');
    await s.call('/api/answer', { body: { id: q.id, answer: 'n' } });
    await s.waitFor((e) => e.type === 'done');
    assert.equal(s.awareness.state.track.proactiveFixed, 1);
  } finally { s.stop(); }
});

test('below Lucid there are no unprompted reports, and Look now explains why', async () => {
  const s = await startLive({ lucid: false });
  try {
    s.watchers[0].onChange({ rel: 'a.js', prev: '', content: 'x\n' });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!s.events.some((e) => e.type === 'proactive'));
    const r = await s.call('/api/proactive', { body: { action: 'now' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /Lucid/);
  } finally { s.stop(); }
});

test('switching projects moves the watcher; its own edits never trigger hints', async () => {
  const s = await startLive({ lucid: false });
  try {
    await s.call('/api/message', { body: { text: 'add hello', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    await s.call('/api/answer', { body: { id: q.id, answer: 'y' } });
    await s.waitFor((e) => e.type === 'done');
    assert.deepEqual(s.watchers[0].self, ['hello.txt'], 'the watcher is told about the agent\'s own write');
    // Switch to a (fake-)cloned GitHub repo: the old watcher closes, a new one watches the clone.
    const r = await s.call('/api/project', { body: { github: 'https://github.com/a/b' } });
    assert.equal(r.status, 502, 'default fake git fails the clone; nothing switches');
    assert.equal(s.watchers.length, 1);
    assert.equal(s.watchers[0].closed, false);
  } finally { s.stop(); }
});

test('switching to another project closes the old watcher and watches the new one', async () => {
  const watchers = [];
  const s = await start({
    git: async (args) => { if (args[0] === 'clone') fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true }); return { code: 0, out: '' }; },
    app: { watch: async (root, onChange) => { const w = { root, onChange, closed: false, close() { this.closed = true; }, noteSelfWrite() {} }; watchers.push(w); return w; } },
  });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(watchers.length, 1);
    await s.call('/api/project', { body: { github: 'https://github.com/a/b' } });
    assert.equal(watchers.length, 2);
    assert.equal(watchers[0].closed, true);
    assert.match(watchers[1].root, /a__b$/);
  } finally { s.stop(); }
});

// ---------- auto-approve: live, and only for ordinary edits and commands ----------
const scriptedAgent = (steps) => () => ({
  history: [], cancelSuggestion() {}, async suggest() { return null; },
  async converse(text, { runTool, onText }) { for (const [name, input] of steps) onText(`[${name}] ${await runTool(name, input)}\n`); },
});

test('ticking auto-approve mid-task approves the waiting edit and the ones after it', async () => {
  const s = await start({ app: { makeAgent: scriptedAgent([['write_file', { path: 'a.txt', content: 'a\n' }], ['write_file', { path: 'b.txt', content: 'b\n' }]]) } });
  try {
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.equal(q.kind, 'write');
    assert.equal((await s.call('/api/auto', { body: { on: true } })).status, 200);
    const ans = await s.waitFor((e) => e.type === 'answered' && e.id === q.id);
    assert.equal(ans.by, 'auto');
    await s.waitFor((e) => e.type === 'done');
    assert.equal(s.events.filter((e) => e.type === 'question').length, 1, 'b.txt was not asked about');
    assert.equal(fs.readFileSync(path.join(s.root, 'a.txt'), 'utf8'), 'a\n');
    assert.equal(fs.readFileSync(path.join(s.root, 'b.txt'), 'utf8'), 'b\n');
  } finally { s.stop(); }
});

test('auto-approve runs ordinary commands even without an OS sandbox, but destructive commands and high-risk files still ask', SPAWNS, async () => {
  const s = await start({ app: { shell: { os: null }, makeAgent: scriptedAgent([
    ['run_command', { command: 'node mark.js' }],
    ['write_file', { path: 'package.json', content: '{}\n' }],
    ['run_command', { command: 'rm -rf build' }],
  ]) } });
  try {
    fs.writeFileSync(path.join(s.root, 'mark.js'), "require('fs').writeFileSync(__dirname + '/ran.txt', '1');\n");
    await s.call('/api/auto', { body: { on: true } });
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const risky = await s.waitFor((e) => e.type === 'question');
    assert.equal(risky.kind, 'risky', 'the first prompt is the high-risk file, not the command');
    assert.ok(fs.existsSync(path.join(s.root, 'ran.txt')), 'the ordinary command ran without asking');
    await s.call('/api/answer', { body: { id: risky.id, answer: 'n' } });
    const danger = await s.waitFor((e) => e.type === 'question' && e.id !== risky.id);
    assert.equal(danger.kind, 'danger');
    await s.call('/api/answer', { body: { id: danger.id, answer: 'n' } });
    await s.waitFor((e) => e.type === 'done');
    assert.ok(!fs.existsSync(path.join(s.root, 'package.json')));
  } finally { s.stop(); }
});

test('with auto-approve off, an unsandboxed command still asks', async () => {
  const s = await start({ app: { shell: { os: null }, makeAgent: scriptedAgent([['run_command', { command: 'npm test' }]]) } });
  try {
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.equal(q.kind, 'command');
    assert.match(q.prompt, /outside any sandbox/);
    await s.call('/api/answer', { body: { id: q.id, answer: 'n' } });
    await s.waitFor((e) => e.type === 'done');
  } finally { s.stop(); }
});

test('the web app starts when launched through a symlink, as npm\'s bin link does', SPAWNS, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'weblink-')));
  const link = path.join(dir, 'awaken-web');
  fs.symlinkSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web.js'), link);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [link, '--help'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, AWAKENING_HOME: dir } });
  assert.match(r.stdout + r.stderr, /awaken-web/, 'it printed its help instead of exiting silently');
// ---------- fewer, better approval prompts ----------
test('smart approvals: one click covers the rest of a task\'s edits, and Undo puts them back', async () => {
  const s = await start({ app: { makeAgent: scriptedAgent([['write_file', { path: 'a.txt', content: 'a\n' }], ['write_file', { path: 'b.txt', content: 'b\n' }], ['write_file', { path: 'package.json', content: '{}\n' }]]) } });
  try {
    assert.equal(s.app.state().approvals, 'smart', 'smart is the default');
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.deepEqual(q.choices, ['y', 'task', 'n']);
    await s.call('/api/answer', { body: { id: q.id, answer: 'task' } });
    assert.equal((await s.waitFor((e) => e.type === 'answered' && e.id === q.id)).answer, 'task');
    // b.txt goes through; the high-risk file still asks, with no wider grant on offer.
    const risky = await s.waitFor((e) => e.type === 'question' && e.id !== q.id);
    assert.equal(risky.kind, 'risky');
    assert.deepEqual(risky.choices, ['y', 'n']);
    assert.match(risky.why, /always asks/);
    assert.equal(fs.readFileSync(path.join(s.root, 'b.txt'), 'utf8'), 'b\n');
    await s.call('/api/answer', { body: { id: risky.id, answer: 'n' } });
    const done = await s.waitFor((e) => e.type === 'done');
    assert.deepEqual(done.edited, ['a.txt', 'b.txt']);
    assert.equal(s.app.state().canUndo, true);
    const undone = await (await s.call('/api/undo', { body: {} })).json();
    assert.deepEqual(undone.removed, ['a.txt', 'b.txt']);
    assert.ok(!fs.existsSync(path.join(s.root, 'a.txt')) && !fs.existsSync(path.join(s.root, 'b.txt')));
    assert.equal((await s.call('/api/undo', { body: {} })).status, 400, 'nothing left to undo');
  } finally { s.stop(); }
});

test('approvals setting: three modes, remembered across restarts, but Auto is never restored', async () => {
  const stateDir = tmp();
  const s = await start({ app: { stateDir } });
  try {
    assert.deepEqual(s.app.state().approvalModes.map((m) => m.id), ['careful', 'smart', 'auto']);
    assert.equal((await s.call('/api/approvals', { body: { mode: 'yolo' } })).status, 400);
    const r = await (await s.call('/api/approvals', { body: { mode: 'careful' } })).json();
    assert.equal(r.approvals, 'careful');
    assert.match(r.changed, /Ask every time/);
  } finally { s.stop(); }
  const again = await start({ app: { stateDir } });
  try {
    assert.equal(again.app.state().approvals, 'careful', 'remembered');
    await again.call('/api/auto', { body: { on: true } }); // the old switch still works
    assert.equal(again.app.state().approvals, 'auto');
    assert.equal(again.app.autoYes, true);
  } finally { again.stop(); }
  const third = await start({ app: { stateDir } });
  try { assert.equal(third.app.state().approvals, 'smart', 'Auto has to be chosen again each session'); } finally { third.stop(); }
  const flagged = await start({ app: { stateDir, settings: { model: 'claude-opus-5-5', effort: 'high', approvals: 'auto' } } });
  try { assert.equal(flagged.app.state().approvals, 'auto', 'an explicit --approvals flag wins'); } finally { flagged.stop(); }
});

test('careful mode asks about every edit, with only yes or no', async () => {
  const s = await start({ app: { settings: { model: 'claude-opus-5-5', effort: 'high', approvals: 'careful' }, makeAgent: scriptedAgent([['write_file', { path: 'a.txt', content: 'a\n' }], ['write_file', { path: 'b.txt', content: 'b\n' }]]) } });
  try {
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q1 = await s.waitFor((e) => e.type === 'question');
    assert.deepEqual(q1.choices, ['y', 'n']);
    await s.call('/api/answer', { body: { id: q1.id, answer: 'task' } }); // not on offer here: counts as no
    const q2 = await s.waitFor((e) => e.type === 'question' && e.id !== q1.id);
    await s.call('/api/answer', { body: { id: q2.id, answer: 'y' } });
    await s.waitFor((e) => e.type === 'done');
    assert.ok(!fs.existsSync(path.join(s.root, 'a.txt')));
    assert.ok(fs.existsSync(path.join(s.root, 'b.txt')));
  } finally { s.stop(); }
});

test('"Always allow in this project" remembers one exact command; a page that connects late still gets the full question', SPAWNS, async () => {
  const s = await start({ app: { shell: { os: null }, makeAgent: scriptedAgent([['run_command', { command: 'node ok.js' }], ['run_command', { command: 'node ok.js' }]]) } });
  try {
    fs.writeFileSync(path.join(s.root, 'ok.js'), "console.log('ran');\n");
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.deepEqual(q.choices, ['y', 'always', 'n']);
    assert.match(q.why, /your own access/);
    // A second browser tab opening now sees the same question, choices included.
    const late = await fetch(`${s.base}/events?t=${s.app.token}`);
    const reader = late.body.getReader(); let buf = '';
    while (!/"type":"question"/.test(buf)) buf += Buffer.from((await reader.read()).value).toString('utf8');
    await reader.cancel();
    assert.match(buf, new RegExp(`"id":"${q.id}".*"choices":\\["y","always","n"\\]`));
    await s.call('/api/answer', { body: { id: q.id, answer: 'always' } });
    await s.waitFor((e) => e.type === 'done');
    assert.equal(s.events.filter((e) => e.type === 'question').length, 1, 'the second run of the same command did not ask');
    assert.deepEqual(s.app.state().allowed, ['node ok.js']);
    const st = await (await s.call('/api/allowed', { body: { remove: 1 } })).json();
    assert.deepEqual(st.allowed, []);
  } finally { s.stop(); }
});

// ---------- proof log ----------
test('proof log: an unprompted report is logged; Fix it, a fix that edits, and Not a bug each change its outcome; PROOF.md follows when turned on', async () => {
  const s = await startLive({ scoutReply: '- [a.js:1] (high) x is read before it is set — throws — declare it first' });
  const root = s.root, proofFile = path.join(root, 'PROOF.md');
  try {
    s.watchers[0].onChange({ rel: 'a.js', prev: '', content: 'x' });
    const card = await s.waitFor((e) => e.type === 'proactive' && e.kind === 'bugs');
    assert.ok(card.id, 'the card carries the report id');
    let p = await (await s.call('/api/proof', { body: {} })).json();
    assert.deepEqual([p.stats.findings, p.stats.open, p.publishing], [1, 1, null]);
    assert.ok(!fs.existsSync(proofFile), 'nothing is published until you ask');
    // Turn publishing on: the page appears, and the watcher is told so it gets no hint about itself.
    p = await (await s.call('/api/proof', { body: { action: 'publish', mode: 'on' } })).json();
    assert.equal(p.publishing, 'detail');
    assert.match(fs.readFileSync(proofFile, 'utf8'), /\| `a\.js:1` \| high \| x is read before it is set \| no response yet \|/);
    assert.deepEqual(s.watchers[0].self, ['PROOF.md']);
    // Fix it: accepted at once, fixed when the run ends with an edit applied.
    await s.call('/api/approvals', { body: { mode: 'auto' } });
    assert.equal((await s.call('/api/fix', { body: { id: card.id } })).status, 202);
    assert.equal(s.app.proof.get(card.id).status, 'accepted');
    await s.waitFor((e) => e.type === 'done');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.app.proof.get(card.id).status, 'fixed');
    assert.match(fs.readFileSync(proofFile, 'utf8'), /\| x is read before it is set \| fixed \|/);
    assert.equal(s.awareness.state.track.proactiveFixed, 1);
    // A second report, dismissed.
    const second = s.app.proof.add({ root, project: 'p', text: '- [b.js:2] (low) maybe wrong' });
    assert.equal((await s.call('/api/proof', { body: { action: 'dismiss', id: second.id } })).status, 200);
    assert.equal(s.app.proof.get(second.id).status, 'dismissed');
    assert.equal(s.awareness.state.track.proactiveDismissed, 1);
    p = await (await s.call('/api/proof', { body: {} })).json();
    assert.match(p.summary, /2 possible bugs reported without being asked\. You asked for a fix on 1 \(50%\); 1 ended with edits applied\. 1 dismissed/);
    assert.match(fs.readFileSync(proofFile, 'utf8'), /\| Dismissed as not a bug \| 1 \|/);
    assert.equal((await s.call('/api/proof', { body: { action: 'publish', mode: 'sideways' } })).status, 400);
    assert.equal((await (await s.call('/api/proof', { body: { action: 'publish', mode: 'off' } })).json()).publishing, null);
  } finally { s.stop(); }
});

test('proof log: a fix you decline every edit of stays "fix requested", not "fixed"', async () => {
  const s = await startLive();
  try {
    s.watchers[0].onChange({ rel: 'a.js', prev: '', content: 'x' });
    const card = await s.waitFor((e) => e.type === 'proactive' && e.kind === 'bugs');
    await s.call('/api/fix', { body: { id: card.id } });
    const q = await s.waitFor((e) => e.type === 'question');
    await s.call('/api/answer', { body: { id: q.id, answer: 'n' } });
    await s.waitFor((e) => e.type === 'done');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(s.app.proof.get(card.id).status, 'accepted');
  } finally { s.stop(); }
});

test('proof log: a PROOF.md you wrote yourself is never overwritten, and publishing stays off', async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'PROOF.md'), '# mine\n');
  const s = await start({ root });
  try {
    const r = await s.call('/api/proof', { body: { action: 'publish', mode: 'on' } });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /was not generated by awakening-coder/);
    assert.equal(fs.readFileSync(path.join(root, 'PROOF.md'), 'utf8'), '# mine\n');
    assert.equal(s.app.state().proofPublishing, null);
  } finally { s.stop(); }
});

// ---------- session memory ----------
// An agent that remembers: each exchange is appended to its history, like the real one.
const memoryAgent = (seen = []) => () => ({
  history: [], cancelSuggestion() {}, async suggest() { return null; },
  async converse(text, { onText }) {
    seen.push(this.history.length);
    this.history.push({ role: 'user', content: text }, { role: 'assistant', content: [{ type: 'text', text: `re: ${text}` }] });
    onText(`re: ${text}`);
  },
});
const say = async (s, text) => { const n = s.events.filter((e) => e.type === 'done').length; await s.call('/api/message', { body: { text, mode: 'ask' } }); await s.waitFor(() => s.events.filter((e) => e.type === 'done').length > n); };

test('session memory: after a restart the last conversation is still there, and the coder still has it', async () => {
  const stateDir = tmp(), root = tmp(), seen = [];
  let s = await start({ root, app: { stateDir, makeAgent: memoryAgent(seen) } });
  try {
    assert.deepEqual((await (await s.call('/api/chats')).json()).messages, [], 'nothing to resume the first time');
    await say(s, 'what does parse() return?');
    await say(s, 'and on empty input?');
    const view = await (await s.call('/api/chats')).json();
    assert.equal(view.chats.length, 1);
    assert.equal(view.chats[0].title, 'what does parse() return?');
    assert.equal(view.current, view.chats[0].id);
    assert.equal(view.resumed, null, 'this conversation was not resumed, it was just had');
  } finally { s.stop(); }
  // "Restart": a new app over the same state folder.
  s = await start({ root, app: { stateDir, makeAgent: memoryAgent(seen) } });
  try {
    const view = await (await s.call('/api/chats')).json();
    assert.deepEqual(view.messages.map((m) => `${m.role}: ${m.text}`), ['you: what does parse() return?', 'coder: re: what does parse() return?', 'you: and on empty input?', 'coder: re: and on empty input?']);
    assert.ok(view.resumed, 'the page is told this was picked up from before');
    await say(s, 'thanks');
    assert.deepEqual(seen, [0, 2, 4], 'the third message was sent with the earlier four in memory');
    assert.equal((await (await s.call('/api/chats')).json()).chats.length, 1, 'it stays one chat');
  } finally { s.stop(); }
  // Another project starts empty.
  const other = await start({ app: { stateDir, makeAgent: memoryAgent() } });
  try { assert.deepEqual((await (await other.call('/api/chats')).json()).chats, []); } finally { other.stop(); }
  // AWAKEN_RESUME=off: the chats are listed, but nothing is picked up.
  const fresh = await start({ root, app: { stateDir, resume: false, makeAgent: memoryAgent() } });
  try {
    const view = await (await fresh.call('/api/chats')).json();
    assert.deepEqual([view.messages.length, view.chats.length, view.current], [0, 1, null]);
  } finally { fresh.stop(); }
});

test('session memory: new conversation, open an older chat, delete one; ids from the browser are never paths', async () => {
  const stateDir = tmp(), seen = [];
  const s = await start({ app: { stateDir, makeAgent: memoryAgent(seen) } });
  try {
    await say(s, 'first topic');
    const first = (await (await s.call('/api/chats')).json()).current;
    const cleared = await (await s.call('/api/clear', { body: {} })).json();
    assert.deepEqual([cleared.messages.length, cleared.current, cleared.chats.length], [0, null, 1], 'the old chat stays saved');
    await say(s, 'second topic');
    assert.equal(seen[1], 0, 'the new conversation started empty');
    let view = await (await s.call('/api/chats')).json();
    assert.deepEqual(view.chats.map((c) => c.title), ['second topic', 'first topic']);
    // Open the older one and carry on with it.
    view = await (await s.call('/api/chat', { body: { id: first } })).json();
    assert.equal(view.current, first);
    assert.equal(view.messages[0].text, 'first topic');
    await say(s, 'more on the first');
    assert.equal(seen[2], 2);
    // Bad ids open nothing.
    for (const id of ['../../state', 'nope', '']) assert.equal((await s.call('/api/chat', { body: { id } })).status, 404, id);
    assert.equal((await s.call('/api/chat', { body: { remove: '../x' } })).status, 404);
    // Deleting the open chat leaves a fresh conversation; the other one is untouched.
    view = await (await s.call('/api/chat', { body: { remove: first } })).json();
    assert.deepEqual([view.current, view.messages.length, view.chats.map((c) => c.title)], [null, 0, ['second topic']]);
  } finally { s.stop(); }
});

test('session memory: chats cannot be switched while it is working', async () => {
  const s = await start({});
  try {
    await s.call('/api/message', { body: { text: 'go', mode: 'code' } });
    const q = await s.waitFor((e) => e.type === 'question');
    assert.equal((await s.call('/api/chat', { body: { id: 'abcdefgh-123456' } })).status, 409);
    assert.equal((await s.call('/api/clear', { body: {} })).status, 409);
    await s.call('/api/answer', { body: { id: q.id, answer: 'n' } });
    await s.waitFor((e) => e.type === 'done');
  } finally { s.stop(); }
});
