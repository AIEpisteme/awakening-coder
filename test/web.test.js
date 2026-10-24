// The web GUI: security of the local server, and a full approve-an-edit round trip, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
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
