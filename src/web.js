#!/usr/bin/env node
// awakening-coder in the browser: talk to it and let it code on a local folder or a GitHub repo.
//
//   node src/web.js [project-folder ...] [--port 7357] [--open]
//
// Same agent, same rails as the terminal: every edit is a diff you approve, commands follow the
// shell policy, secrets are redacted, and the process confines itself. The server listens on
// 127.0.0.1 only and every request needs the random token printed at startup (it is in the URL
// it prints), plus a matching Host/Origin, so other sites and other users can't drive it.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { listFiles, resolveInside, makeToolRunner } from './tools.js';
import { redactSecrets, containsSecret, isSecretPath } from './security.js';
import { unifiedDiff, changedLineCount } from './diff.js';
import { Proactive } from './proactive.js';
import { CostMeter, formatUsd } from './cost.js';
import { MODELS, EFFORTS, DEFAULT_EFFORT, resolveModel, resolveEffort, modelLabel, effortLabel } from './models.js';

const MAX_BODY = 1_000_000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const strip = (s) => String(s ?? '').replace(ANSI, '');

/** https://github.com/owner/repo[.git] only — no other hosts, no credentials in the URL. */
export function parseGithubUrl(url) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? '').trim());
  if (!m || m[1].startsWith('.') || m[2].startsWith('.')) return null;
  return { owner: m[1], repo: m[2], url: `https://github.com/${m[1]}/${m[2]}.git`, slug: `${m[1]}__${m[2]}` };
}

/** Run git for the developer's own actions (clone, commit, push): their normal environment and credentials. */
export function runGit(args, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (e) => resolve({ code: -1, out: e.message }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Build the web app. Everything with side effects is injected so tests can run it offline:
 *   makeAgent(root) → Agent-like with converse(); runCode(text, ctx) optional (cloud shell);
 *   git(args, opts) → { code, out }.
 */
export function createWebApp({
  projects: initialProjects, stateDir, selfDir, awareness, makeAgent, runCode = null, git = runGit,
  shell = {}, sandboxReport = '', token = randomBytes(18).toString('base64url'), uiHtml, describe = () => '',
  // Live features (like the terminal): watch(root, onChange) → { close, noteSelfWrite }; scout(mode, msg, root) → text.
  watch = null, scout = null, hintCooldownMs = 15_000, proactiveConfig = {},
  // Model and effort, switchable from the menu (shared with main(), so scouts and the cloud shell follow it).
  settings = { model: MODELS[0].id, effort: DEFAULT_EFFORT },
  // Running cost of this session and the optional spend cap (shared with main(), so every agent records into it).
  meter = new CostMeter(),
}) {
  // Remember the last choice across restarts (unless main() was given one on the command line).
  const settingsFile = stateDir ? path.join(stateDir, 'web-settings.json') : null;
  if (settingsFile && !settings.fromFlags) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      if (resolveModel(saved.model)) settings.model = resolveModel(saved.model);
      if (resolveEffort(saved.effort)) settings.effort = resolveEffort(saved.effort);
    } catch { /* first run */ }
  }
  // The spend cap is remembered too (a --budget flag or AWAKEN_BUDGET, already set on the meter, wins).
  if (settingsFile && meter.budget === null) { try { meter.setBudget(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).budget ?? null); } catch { /* first run */ } }
  const saveSettings = () => { try { if (settingsFile) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ model: settings.model, effort: settings.effort, budget: meter.budget })); } } catch { /* best effort */ } };
  const projects = new Map(); // id -> { id, name, root, kind }
  const addProject = (root, name, kind = 'local') => {
    const id = Buffer.from(root).toString('base64url').slice(-24);
    if (!projects.has(id)) projects.set(id, { id, name: name ?? path.basename(root), root, kind, agent: null });
    return projects.get(id);
  };
  for (const p of initialProjects) addProject(p, undefined, 'local');
  let current = [...projects.values()][0] ?? null;

  const clients = new Set();
  const questions = new Map();
  let job = null; // { abort, kind }
  let autoYes = false;

  let costTimer = null, warned = false;
  meter.onChange = () => {
    if (meter.nearBudget && !warned) { warned = true; emit({ type: 'status', text: `Heads-up: ${meter.short()} of your spend cap used.` }); }
    if (!meter.nearBudget && !meter.overBudget) warned = false;
    costTimer ??= setTimeout(() => { costTimer = null; emit({ type: 'cost', cost: meter.toJSON() }); }, 250);
    costTimer.unref?.();
  };
  const emit = (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(line); };
  const webTerm = {
    print: (s) => emit({ type: 'print', text: strip(s) }),
    question: (q, { kind = 'other' } = {}) => new Promise((resolve) => {
      const id = randomBytes(8).toString('hex');
      questions.set(id, { resolve, kind });
      emit({ type: 'question', id, prompt: strip(q), kind });
    }),
  };
  const answer = (id, a, by) => { const q = questions.get(id); if (!q) return false; questions.delete(id); q.resolve(a); emit({ type: 'answered', id, by }); return true; };
  const answerAll = (a) => { for (const id of [...questions.keys()]) answer(id, a); };
  // Ordinary edits and commands may be auto-approved; destructive commands and high-risk files never are.
  const AUTO_KINDS = new Set(['write', 'command']);
  // Auto-approve is read live, so switching it on mid-task applies to the next prompt, and to the
  // ones already waiting. With it on, ordinary commands run even where no OS sandbox exists
  // (e.g. Windows): ticking the box is that explicit choice. The UI says so when you tick it.
  const toolShell = { ...shell, allowUnsandboxed: () => autoYes || Boolean(typeof shell.allowUnsandboxed === 'function' ? shell.allowUnsandboxed() : shell.allowUnsandboxed) };

  const agentFor = (p) => {
    const a = (p.agent ??= makeAgent(p.root));
    a.model = settings.model; a.effort = settings.effort; // the menu's current choice, every time
    return a;
  };

  // ---------- live: save-hints and unprompted reports (same logic as the terminal) ----------
  let hints = true, watcher = null, lastHintAt = 0, hintTimer = null, queued = null, lastFinding = null;
  const isFree = () => !job && questions.size === 0;
  const proactive = scout && awareness ? new Proactive({
    awareness, isFree, isQuiet: () => false, config: proactiveConfig,
    listCode: () => (current ? listFiles(current.root, '.', 500) : Promise.resolve([])),
    show: (kind, text) => { if (kind === 'bugs') lastFinding = text; emit({ type: 'proactive', kind, text }); },
    scout: (mode, msg) => (current ? scout(mode, msg, current.root) : Promise.resolve('')),
  }) : null;

  async function hint(change) {
    const diff = unifiedDiff(change.prev, change.content);
    if (!diff || changedLineCount(diff) === 0 || !current) return;
    lastHintAt = Date.now();
    const id = randomBytes(6).toString('hex');
    try {
      const out = await agentFor(current).suggest({ rel: change.rel, diff, content: change.content }, {
        onStart: () => emit({ type: 'hint', id, rel: change.rel, label: awareness?.genre?.title ?? awareness?.stage?.name ?? '' }),
        onText: (t) => emit({ type: 'hint-text', id, text: strip(t) }),
      });
      if (out !== null) { emit({ type: 'hint-end', id }); awareness?.hinted(change.rel); } else awareness?.note('hintsSilent');
    } catch (e) { awareness?.note('errors', `hint: ${e.message}`); emit({ type: 'status', text: `hint failed: ${strip(e.message)}` }); }
  }

  function onSave(change) {
    awareness?.savedAfter(change.rel);
    if (awareness) for (const l of awareness.feed('save', change.rel)) emit({ type: 'announce', text: l });
    emit({ type: 'saved', rel: change.rel });
    proactive?.onSave(change.rel);
    if (!hints || job || questions.size) return;
    const wait = lastHintAt + hintCooldownMs - Date.now();
    if (wait <= 0) return void hint(change);
    queued = change; // coalesce saves during the cooldown
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { const ch = queued; queued = null; if (ch && hints && !job) hint(ch); }, wait);
    hintTimer.unref?.();
  }

  async function watchCurrent() {
    try { watcher?.close(); } catch { /* already closed */ }
    watcher = null;
    if (!watch || !current) return;
    try { watcher = await watch(current.root, onSave); } catch (e) { emit({ type: 'status', text: `Can't watch this folder for saves: ${strip(e.message)}` }); }
    proactive?.dirty.clear();
    void proactive?.onStart();
  }

  function stateJson() {
    return {
      projects: [...projects.values()].map(({ id, name, root, kind }) => ({ id, name, root, kind })),
      current: current?.id ?? null,
      busy: Boolean(job), autoYes, hints,
      model: settings.model, effort: settings.effort, cost: meter.toJSON(),
      models: MODELS.map(({ id, label, note }) => ({ id, label, note })), efforts: EFFORTS.map(({ id, label, note }) => ({ id, label, note })), osSandbox: Boolean(shell.os),
      proactive: proactive ? { available: true, enabled: proactive.enabled, awake: proactive.awake, status: proactive.status() } : { available: false },
      lastFinding: Boolean(lastFinding),
      stage: awareness?.describe?.() ?? '', sandbox: sandboxReport, info: describe(),
    };
  }

  async function startMessage(text, mode) {
    if (!current) throw Object.assign(new Error('Pick a project first.'), { status: 400 });
    if (job) throw Object.assign(new Error('Busy with the last request; stop it or wait.'), { status: 409 });
    const p = current, ac = new AbortController();
    job = { abort: () => ac.abort(), mode };
    emit({ type: 'start', mode });
    if (awareness) for (const l of awareness.feed(mode === 'code' ? 'code' : 'ask')) emit({ type: 'announce', text: l });
    p.agent?.cancelSuggestion?.();
    const runTool = makeToolRunner({ root: p.root, selfDir, awareness, term: webTerm, autoYes: () => autoYes, shell: toolShell, signal: ac.signal, onWrite: (rel, content) => watcher?.noteSelfWrite?.(rel, content) });
    try {
      if (mode === 'code' && runCode) await runCode(text, { root: p.root, runTool, signal: ac.signal, onText: (t) => emit({ type: 'text', text: strip(t) }), onStatus: (s) => emit({ type: 'status', text: strip(s) }) });
      else await agentFor(p).converse(text, { mode: mode === 'code' ? 'code' : 'ask', runTool, signal: ac.signal, onText: (t) => emit({ type: 'text', text: strip(t) }) });
      emit({ type: 'done' });
    } catch (e) {
      emit({ type: 'error', text: ac.signal.aborted ? 'Stopped.' : strip(e.message) });
    } finally {
      answerAll('n');
      job = null;
      emit({ type: 'state', state: stateJson() });
    }
  }

  async function cloneGithub(url) {
    const gh = parseGithubUrl(url);
    if (!gh) throw Object.assign(new Error('Use a GitHub URL like https://github.com/owner/repo'), { status: 400 });
    const dest = path.join(stateDir, 'repos', gh.slug);
    if (!fs.existsSync(path.join(dest, '.git'))) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      emit({ type: 'status', text: `cloning ${gh.owner}/${gh.repo}…` });
      const r = await git(['clone', '--depth', '50', gh.url, dest], { cwd: path.dirname(dest) });
      if (r.code !== 0) throw Object.assign(new Error(`git clone failed: ${strip(r.out).trim().split('\n').slice(-3).join(' ')}`), { status: 502 });
    }
    current = addProject(dest, `${gh.owner}/${gh.repo}`, 'github');
    await watchCurrent();
    return current;
  }

  async function gitInfo(p) {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], { cwd: p.root, timeoutMs: 15_000 });
    if (inside.code !== 0) return { isRepo: false };
    const [branch, status, diff, remote] = await Promise.all([
      git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: p.root }),
      git(['status', '--porcelain'], { cwd: p.root }),
      git(['diff', 'HEAD', '--no-color', '--', '.'], { cwd: p.root }),
      git(['remote', 'get-url', 'origin'], { cwd: p.root }),
    ]);
    return { isRepo: true, branch: branch.out.trim(), status: status.out, diff: redactSecrets(diff.out).slice(0, 200_000), remote: remote.code === 0 ? remote.out.trim().replace(/\/\/[^@/]+@/, '//') : null };
  }

  async function commit(p, message) {
    const msg = String(message ?? '').trim();
    if (!msg) throw Object.assign(new Error('Write a commit message.'), { status: 400 });
    const add = await git(['add', '-A'], { cwd: p.root });
    if (add.code !== 0) throw Object.assign(new Error(strip(add.out)), { status: 500 });
    // Never commit secrets: refuse secret files and inline keys, and unstage so nothing is half-done.
    const staged = (await git(['diff', '--cached', '--name-only'], { cwd: p.root })).out.split('\n').filter(Boolean);
    const secretFiles = staged.filter(isSecretPath);
    const diff = (await git(['diff', '--cached', '--no-color'], { cwd: p.root })).out;
    if (secretFiles.length || containsSecret(diff)) {
      await git(['reset', '-q'], { cwd: p.root });
      throw Object.assign(new Error(secretFiles.length ? `Refusing to commit secret files: ${secretFiles.join(', ')}. Add them to .gitignore.` : 'Refusing to commit: the changes contain what looks like a key or password. Remove it first.'), { status: 400 });
    }
    if (!staged.length) throw Object.assign(new Error('Nothing to commit.'), { status: 400 });
    const r = await git(['commit', '-q', '-m', msg], { cwd: p.root });
    if (r.code !== 0) throw Object.assign(new Error(strip(r.out).trim()), { status: 500 });
    return { committed: staged.length };
  }

  async function push(p) {
    const r = await git(['push', '-u', 'origin', 'HEAD'], { cwd: p.root, timeoutMs: 120_000 });
    if (r.code !== 0) throw Object.assign(new Error(`git push failed: ${strip(r.out).trim().split('\n').slice(-3).join(' ')}`), { status: 502 });
    return { pushed: true, out: strip(r.out).trim().split('\n').slice(-3).join('\n') };
  }

  // ---------- HTTP ----------
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
  });

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const url = new URL(req.url, 'http://x');
    // DNS-rebinding guard: only our own host names.
    const host = String(req.headers.host ?? '');
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return json(res, 403, { error: 'Bad host' });
    const tok = req.headers['x-awaken-token'] ?? url.searchParams.get('t');
    const authed = tok && safeEqual(tok, token);

    if (req.method === 'GET' && url.pathname === '/') {
      if (!authed) { res.writeHead(401, { 'content-type': 'text/plain' }); return res.end('Open the URL printed in the terminal (it includes the access token).'); }
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      return res.end(uiHtml.replaceAll('__NONCE__', nonce));
    }
    if (!authed) return json(res, 401, { error: 'Missing or wrong token' });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, 403, { error: 'Bad origin' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'JSON only' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'state', state: stateJson() })}\n\n`);
        for (const [id] of questions) res.write(`data: ${JSON.stringify({ type: 'question', id, prompt: 'A question is waiting (asked before you connected): answer it to continue.' })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, stateJson());
      if (req.method === 'GET' && url.pathname === '/api/files') {
        if (!current) return json(res, 200, { files: [] });
        return json(res, 200, { files: await listFiles(current.root, '.', 2000) });
      }
      if (req.method === 'GET' && url.pathname === '/api/file') {
        if (!current) return json(res, 400, { error: 'No project' });
        const abs = resolveInside(current.root, url.searchParams.get('path'));
        const st = fs.statSync(abs);
        if (st.size > 400_000) return json(res, 200, { path: url.searchParams.get('path'), content: `(${st.size} bytes — too large to show)` });
        return json(res, 200, { path: url.searchParams.get('path'), content: redactSecrets(fs.readFileSync(abs, 'utf8')) });
      }
      if (req.method === 'GET' && url.pathname === '/api/git') return json(res, 200, current ? await gitInfo(current) : { isRepo: false });

      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });
      const body = await readBody(req);
      switch (url.pathname) {
        case '/api/project': {
          if (job) return json(res, 409, { error: 'Busy; wait or stop first.' });
          if (body.github) await cloneGithub(body.github);
          else {
            const p = projects.get(body.id);
            if (!p) return json(res, 400, { error: 'Unknown project. Local folders must be given when starting the web app (they set the sandbox).' });
            if (current !== p) { current = p; await watchCurrent(); }
          }
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, stateJson());
        }
        case '/api/message': {
          const text = String(body.text ?? '').trim();
          if (!text) return json(res, 400, { error: 'Empty message' });
          if (job) return json(res, 409, { error: 'Busy with the last request; stop it or wait.' });
          if (!current) return json(res, 400, { error: 'Pick a project first.' });
          void startMessage(text, body.mode === 'code' ? 'code' : 'ask');
          return json(res, 202, { started: true });
        }
        case '/api/answer': {
          const a = body.answer === 'y' ? 'y' : body.answer === 'unconfined' || body.answer === 'evolve' ? body.answer : 'n';
          if (!answer(body.id, a)) return json(res, 404, { error: 'No such question' });
          return json(res, 200, { ok: true });
        }
        case '/api/stop': job?.abort(); answerAll('n'); return json(res, 200, { ok: true });
        case '/api/auto': autoYes = Boolean(body.on); if (autoYes) for (const [id, q] of [...questions]) if (AUTO_KINDS.has(q.kind)) answer(id, 'y', 'auto'); emit({ type: 'state', state: stateJson() }); return json(res, 200, stateJson());
        case '/api/model': {
          // Takes effect from the next message (a running task keeps the model it started with).
          const model = body.model === undefined ? settings.model : resolveModel(body.model);
          const effort = body.effort === undefined ? settings.effort : resolveEffort(body.effort);
          if (!model) return json(res, 400, { error: `Unknown model. Choose ${MODELS.map((m) => m.label).join(', ')}.` });
          if (!effort) return json(res, 400, { error: `Unknown effort. Choose ${EFFORTS.map((e) => e.label).join(', ')}.` });
          settings.model = model; settings.effort = effort; saveSettings();
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, { ...stateJson(), changed: `${modelLabel(model)} · ${effortLabel(effort)} effort` });
        }
        case '/api/budget': {
          // { usd: 5 } sets the cap for this and later sessions; { usd: null } or "off" removes it.
          const raw = body.usd;
          const off = raw === null || raw === undefined || /^(off|none|0)?$/i.test(String(raw).trim());
          if (!off && !(Number(String(raw).replace(/^\$/, '')) > 0)) return json(res, 400, { error: 'Give a dollar amount, like 5 or 0.50, or "off".' });
          meter.setBudget(off ? null : raw); saveSettings();
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, { ...stateJson(), changed: meter.budget === null ? 'Spend cap off.' : `Spend cap set to ${formatUsd(meter.budget)} per session (${formatUsd(meter.total)} used so far).` });
        }
        case '/api/cost': return json(res, 200, { ...stateJson(), report: meter.report(modelLabel) });
        case '/api/hints': hints = Boolean(body.on); emit({ type: 'state', state: stateJson() }); return json(res, 200, stateJson());
        case '/api/proactive': {
          if (!proactive) return json(res, 400, { error: 'Proactive mode is not available in this session.' });
          if (body.action === 'now') {
            if (!proactive.awake) return json(res, 400, { error: `It looks on its own from the Lucid stage. ${awareness.describe()}` });
            void (async () => {
              const found = await proactive.bugSweep({ manual: true });
              const ideas = await proactive.ideas('idle', { manual: true });
              if (!found && !ideas) emit({ type: 'status', text: 'Nothing worth interrupting you for right now.' });
            })();
            return json(res, 202, { started: true });
          }
          if (body.action === 'done') {
            void proactive.ideas('done', { manual: true }).then((r) => { if (!r) emit({ type: 'status', text: 'No new ideas I haven\'t already given you.' }); });
            return json(res, 202, { started: true });
          }
          proactive.enabled = Boolean(body.on);
          if (!proactive.enabled) proactive.stop();
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, stateJson());
        }
        case '/api/fix': {
          if (!lastFinding) return json(res, 400, { error: 'No unprompted bug report to fix yet.' });
          if (job) return json(res, 409, { error: 'Busy with the last request; stop it or wait.' });
          awareness?.note('proactiveFixed');
          void startMessage(`Fix this bug you found on your own earlier (verify it's real first; if it isn't, say so):\n${lastFinding}`, 'code');
          return json(res, 202, { started: true });
        }
        case '/api/clear': if (current?.agent) current.agent.history = []; return json(res, 200, { ok: true });
        case '/api/commit': if (!current) return json(res, 400, { error: 'No project' }); return json(res, 200, await commit(current, body.message));
        case '/api/push': if (!current) return json(res, 400, { error: 'No project' }); return json(res, 200, await push(current));
        default: return json(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      return json(res, e.status ?? 500, { error: strip(e.message) });
    }
  });

  server.on('listening', () => { void watchCurrent(); });
  server.on('close', () => { try { watcher?.close(); } catch { /* closed */ } proactive?.stop(); clearTimeout(hintTimer); });
  return { server, token, projects, emit, state: stateJson, proactive, get autoYes() { return autoYes; } };
}

// ======================================================================
// Entry point
// ======================================================================
async function main() {
  const { c } = await import('./ui.js');
  const { Awareness, homeDir } = await import('./awareness.js');
  const { Agent, makeClient, loadDotEnv, explainApiError } = await import('./agent.js');
  const { relaunchConfined, sandboxStatus, describeSandbox } = await import('./sandbox.js');
  const { runCloudTask } = await import('./cloud.js');

  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const selfRoot = path.join(selfDir, '..');
  loadDotEnv(path.join(homeDir(), '.env')); // npm installs keep the key here; a checkout's own .env wins
  loadDotEnv(path.join(selfRoot, '.env'));

  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: process.env.AWAKEN_WEB_PORT || '7357' },
      open: { type: 'boolean', default: false },
      model: { type: 'string' },
      effort: { type: 'string' },
      budget: { type: 'string' },
      'fast-model': { type: 'string', default: process.env.AWAKEN_FAST_MODEL || 'claude-sonnet-5-5' },
      shell: { type: 'string', default: process.env.AWAKEN_SHELL || 'local' },
      net: { type: 'boolean', default: false },
      'no-sandbox': { type: 'boolean', default: false },
      workspace: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (opt.help) {
    console.log(`awaken-web [project-folder ...] [--port 7357] [--open] [--shell local|cloud] [--net] [--no-sandbox]
  Opens a browser UI to talk to awakening-coder and let it code on these folders, or on a GitHub repo
  you paste in the UI (cloned into ${path.join(homeDir(), 'repos')}). Listens on 127.0.0.1 only.`);
    process.exit(0);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) { console.error(c.red('No API key. Set ANTHROPIC_API_KEY in your environment, or put ANTHROPIC_API_KEY=sk-ant-... in ' + path.join(homeDir(), '.env'))); process.exit(1); }
  const roots = (positionals.length ? positionals : [process.cwd()]).map((p) => path.resolve(p));
  for (const r of roots) { let ok = false; try { ok = fs.statSync(r).isDirectory(); } catch { /* missing */ } if (!ok) { console.error(c.red(`Not a folder: ${r}`)); process.exit(1); } }
  const stateDir = homeDir();
  fs.mkdirSync(path.join(stateDir, 'repos'), { recursive: true });

  // Confine itself to these folders + its state folder (GitHub clones live there).
  if (!opt['no-sandbox'] && relaunchConfined({ root: roots[0], extraRoots: roots.slice(1), selfRoot, stateDir, entry: fileURLToPath(import.meta.url), argv: process.argv.slice(2) })) {
    await new Promise(() => {});
  }
  const sandbox = sandboxStatus({ allowNet: opt.net, disabled: opt['no-sandbox'], root: roots[0] });
  const shell = { os: sandbox.os, allowNet: opt.net };
  const sandboxReport = describeSandbox(sandbox);

  const awareness = new Awareness();
  awareness.startSession();
  const client = makeClient({ workspaceId: opt.workspace ?? process.env.ANTHROPIC_WORKSPACE_ID });
  // --model / --effort (or AWAKEN_MODEL / AWAKEN_EFFORT) win over the last choice saved from the menu.
  const flagModel = opt.model ?? process.env.AWAKEN_MODEL, flagEffort = opt.effort ?? process.env.AWAKEN_EFFORT;
  const settings = { model: resolveModel(flagModel) ?? MODELS[0].id, effort: resolveEffort(flagEffort) ?? DEFAULT_EFFORT, fromFlags: Boolean(flagModel || flagEffort) };
  if (flagModel && !resolveModel(flagModel)) { console.error(c.red(`Unknown model "${flagModel}". Use opus, sonnet, haiku or a full claude-… id.`)); process.exit(2); }
  if (flagEffort && !resolveEffort(flagEffort)) { console.error(c.red(`Unknown effort "${flagEffort}". Use low, medium, high, xhigh or max.`)); process.exit(2); }
  const flagBudget = opt.budget ?? process.env.AWAKEN_BUDGET;
  const meter = new CostMeter({ budget: flagBudget ?? null });
  if (flagBudget && !/^(off|none|0)$/i.test(flagBudget) && meter.budget === null) { console.error(c.red(`Bad --budget "${flagBudget}". Use a dollar amount, like 5 or 0.50.`)); process.exit(2); }
  const makeAgent = (root) => new Agent({ awareness, root, selfDir, model: settings.model, fastModel: opt['fast-model'], client, sandboxReport, meter, isTrusted: (h) => awareness.notesTrusted(root, h) });
  const runCode = opt.shell === 'cloud'
    ? (text, { root, runTool, signal, onText, onStatus }) => runCloudTask(client, {
        root, task: text, model: settings.model, net: opt.net, state: awareness.state, saveState: () => awareness.save(),
        stageNote: `Voice: ${awareness.stage.voice}`, onText, onStatus, signal, meter,
        applyChange: (rel, content) => runTool('write_file', { path: rel, content }).catch((e) => `Not applied (${rel}): ${e.message}`),
      })
    : null;

  const { startWatcher } = await import('./watcher.js');
  const noProactive = /^(off|0|false|no)$/i.test(process.env.AWAKEN_PROACTIVE ?? '');
  const scoutAgents = new Map();
  const scout = noProactive ? null : async (mode, message, root) => {
    if (!scoutAgents.has(root)) { const a = makeAgent(root); a.scoutCanRun = Boolean(shell.os); scoutAgents.set(root, a); }
    if (meter.overBudget) return ''; // unprompted looks never spend past the cap
    const a = scoutAgents.get(root);
    a.model = settings.model; a.effort = settings.effort;
    let text = '';
    const runTool = makeToolRunner({ root, selfDir, awareness, term: { print() {}, question: async () => 'n' }, interactive: false, shell });
    try { await a.converse(message, { mode, runTool, onText: (t) => (text += t), maxTurns: 15 }); }
    catch (e) { awareness.note('errors', `proactive: ${e.message}`); return ''; }
    finally { a.history = []; }
    return text;
  };
  const num = (v) => (v && Number(v) > 0 ? Number(v) : undefined);
  const proactiveConfig = Object.fromEntries(Object.entries({ bugIdleMs: num(process.env.AWAKEN_PROACTIVE_BUG_MS), ideaIdleMs: num(process.env.AWAKEN_PROACTIVE_IDEA_MS), maxPerHour: num(process.env.AWAKEN_PROACTIVE_PER_HOUR) }).filter(([, v]) => v));
  const app = createWebApp({
    watch: (root, onChange) => startWatcher(root, onChange), scout, proactiveConfig,
    hintCooldownMs: (num(process.env.AWAKEN_HINT_COOLDOWN_S) ?? 15) * 1000,
    projects: roots, stateDir, selfDir, awareness, makeAgent, runCode, shell, sandboxReport, settings, meter,
    uiHtml: fs.readFileSync(path.join(selfDir, 'web-ui.html'), 'utf8'),
    describe: () => `model ${modelLabel(settings.model)} · ${effortLabel(settings.effort)} effort · hints on ${opt['fast-model']} · /code runs ${opt.shell === 'cloud' ? "in Claude's cloud sandbox" : 'here'}`,
  });
  app.server.on('error', (e) => { console.error(c.red(`Could not start the web server: ${e.message}${e.code === 'EADDRINUSE' ? ` (port ${opt.port} is taken; try --port 7358)` : ''}`)); process.exit(1); });
  app.server.listen(Number(opt.port) || 0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${app.server.address().port}/?t=${app.token}`;
    console.log(`awakening-coder web · ${awareness.describe()}\n  ${c.bold(url)}\n  ${c.dim('Open that URL (it includes your private access token). Ctrl+C to stop.')}`);
    if (opt.open) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
  });
  process.on('SIGINT', () => { awareness.save(); process.exit(0); });
  process.on('unhandledRejection', (e) => console.error(c.red(`error: ${e?.message ?? e}`) + (explainApiError(e) ? '\n' + explainApiError(e) : '')));
}

// Run when started directly, including through npm's bin link (a symlink on macOS and Linux).
const startedDirectly = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (process.argv[1] && startedDirectly()) main();
