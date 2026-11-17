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
import { APPROVAL_MODES, DEFAULT_APPROVALS, resolveApprovals, approvalsLabel, describeApprovals, sandboxFacts, AllowList } from './approvals.js';
import { EditJournal } from './changes.js';
import { ProofLog } from './prooflog.js';
import { SessionStore, displayOf } from './sessions.js';

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
  // settings.approvals: how often it asks ('careful' | 'smart' | 'auto'); see approvals.js.
  settings = { model: MODELS[0].id, effort: DEFAULT_EFFORT },
  // Running cost of this session and the optional spend cap (shared with main(), so every agent records into it).
  meter = new CostMeter(),
  // Session memory: each project's conversations are saved, and the latest one is picked up again after a restart.
  resume = true,
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
  // How often it asks is remembered too (a flag wins). "Auto" is never restored from a file: you turn it on each session.
  if (!resolveApprovals(settings.approvals)) {
    let saved = null;
    try { saved = resolveApprovals(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).approvals); } catch { /* first run */ }
    settings.approvals = saved && saved !== 'auto' ? saved : DEFAULT_APPROVALS;
  }
  const allowList = new AllowList(stateDir ? path.join(stateDir, 'allowed-commands.json') : null);
  // What it reported on its own and what you did about it (see prooflog.js). Published only where you turn that on.
  const proof = new ProofLog(stateDir ? path.join(stateDir, 'proof-log.json') : null);
  const publishProof = (p, { quiet = false } = {}) => {
    const r = proof.publish(p.root, { onWrite: (rel, content) => { if (p === current) watcher?.noteSelfWrite?.(rel, content); } });
    if (!quiet && !r.written && r.reason && !['off', 'unchanged'].includes(r.reason)) emit({ type: 'status', text: `Proof log not published: ${r.reason}` });
    return r;
  };
  // The spend cap is remembered too (a --budget flag or AWAKEN_BUDGET, already set on the meter, wins).
  if (settingsFile && meter.budget === null) { try { meter.setBudget(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).budget ?? null); } catch { /* first run */ } }
  const saveSettings = () => { try { if (settingsFile) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(settingsFile, JSON.stringify({ model: settings.model, effort: settings.effort, budget: meter.budget, approvals: settings.approvals })); } } catch { /* best effort */ } };
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
  const isAuto = () => settings.approvals === 'auto';
  const approvalsNote = (mode = settings.approvals) => describeApprovals(mode, { ...sandboxFacts(shell), unsandboxedOk: true });

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
    // choices: 'y'/'n', plus 'task' (all edits in this task) or 'always' (this command, this project). why: one line.
    question: (q, { kind = 'other', choices = ['y', 'n'], why = '', label } = {}) => new Promise((resolve) => {
      const id = randomBytes(8).toString('hex');
      const ev = { type: 'question', id, prompt: strip(label ?? q), kind, choices, why };
      questions.set(id, { resolve, kind, ev });
      emit(ev);
    }),
  };
  const answer = (id, a, by) => { const q = questions.get(id); if (!q) return false; questions.delete(id); q.resolve(a); emit({ type: 'answered', id, by, answer: a }); return true; };
  const answerAll = (a) => { for (const id of [...questions.keys()]) answer(id, a); };
  // Ordinary edits and commands may be auto-approved; destructive commands and high-risk files never are.
  const AUTO_KINDS = new Set(['write', 'command']);
  // The approval mode is read live, so switching to Auto mid-task applies to the next prompt, and to the
  // ones already waiting. In Auto, ordinary commands run even where no OS sandbox exists (e.g. Windows):
  // choosing it is that explicit choice. The UI says so when you choose it.
  const toolShell = { ...shell, allowUnsandboxed: () => isAuto() || Boolean(typeof shell.allowUnsandboxed === 'function' ? shell.allowUnsandboxed() : shell.allowUnsandboxed) };

  const chats = new SessionStore(stateDir ? path.join(stateDir, 'sessions') : null);
  const agentFor = (p) => {
    if (!p.agent) {
      p.agent = makeAgent(p.root);
      // Pick up this project's most recent conversation where it left off.
      const latest = resume ? chats.list(p.root)[0] : null;
      const saved = latest ? chats.load(p.root, latest.id) : null;
      if (saved) { p.agent.history = saved.history; p.chat = { id: saved.id, createdAt: saved.createdAt }; p.resumed = saved.updatedAt; }
    }
    const a = p.agent;
    a.model = settings.model; a.effort = settings.effort; // the menu's current choice, every time
    return a;
  };
  const saveChat = (p) => {
    const h = p.agent?.history;
    if (!Array.isArray(h) || !h.length) return;
    const meta = chats.save(p.root, { id: p.chat?.id, createdAt: p.chat?.createdAt, model: settings.model, history: h });
    if (meta) p.chat = { id: meta.id, createdAt: meta.createdAt };
  };
  const openChat = (p, saved) => { agentFor(p).history = saved ? saved.history : []; p.chat = saved ? { id: saved.id, createdAt: saved.createdAt } : null; p.resumed = null; };
  // What the page shows for a project: its saved chats, and the conversation the coder currently remembers.
  const chatView = (p) => {
    if (!p) return { current: null, resumed: null, chats: [], messages: [] };
    const a = agentFor(p);
    return { current: p.chat?.id ?? null, resumed: p.resumed ?? null, chats: chats.list(p.root), messages: displayOf(Array.isArray(a.history) ? a.history : []) };
  };

  // ---------- live: save-hints and unprompted reports (same logic as the terminal) ----------
  let hints = true, watcher = null, lastHintAt = 0, hintTimer = null, queued = null;
  let lastFinding = null; // { id, text, project } — the newest unprompted bug report
  let scouting = null; // the project the scout is looking at (you may switch projects before it reports)
  const isFree = () => !job && questions.size === 0;
  const proactive = scout && awareness ? new Proactive({
    awareness, isFree, isQuiet: () => false, config: proactiveConfig,
    listCode: () => (current ? listFiles(current.root, '.', 500) : Promise.resolve([])),
    show: (kind, text) => {
      const p = scouting ?? current;
      let id;
      if (kind === 'bugs' && p) { id = proof.add({ root: p.root, project: p.name, text }).id; lastFinding = { id, text, project: p }; publishProof(p); }
      emit({ type: 'proactive', kind, text, id });
    },
    scout: (mode, msg) => { scouting = current; return current ? scout(mode, msg, current.root) : Promise.resolve(''); },
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
      busy: Boolean(job), autoYes: isAuto(), hints,
      approvals: settings.approvals, approvalModes: APPROVAL_MODES.map(({ id, label, note }) => ({ id, label, note })),
      approvalsNote: approvalsNote(),
      allowed: current ? allowList.list(current.root) : [], canUndo: Boolean(current?.journal?.entries.length),
      model: settings.model, effort: settings.effort, cost: meter.toJSON(),
      models: MODELS.map(({ id, label, note }) => ({ id, label, note })), efforts: EFFORTS.map(({ id, label, note }) => ({ id, label, note })), osSandbox: Boolean(shell.os),
      proactive: proactive ? { available: true, enabled: proactive.enabled, awake: proactive.awake, status: proactive.status() } : { available: false },
      lastFinding: Boolean(lastFinding), proofPublishing: current ? proof.publishing(current.root) : null,
      stage: awareness?.describe?.() ?? '', sandbox: sandboxReport, info: describe(),
    };
  }

  // after({ ok, edited }): called once the task has finished, whatever happened.
  async function startMessage(text, mode, after) {
    if (!current) throw Object.assign(new Error('Pick a project first.'), { status: 400 });
    if (job) throw Object.assign(new Error('Busy with the last request; stop it or wait.'), { status: 409 });
    const p = current, ac = new AbortController();
    job = { abort: () => ac.abort(), mode };
    emit({ type: 'start', mode });
    if (awareness) for (const l of awareness.feed(mode === 'code' ? 'code' : 'ask')) emit({ type: 'announce', text: l });
    p.agent?.cancelSuggestion?.();
    // One runner per task: "approve all edits in this task" ends with it. The journal lets /undo put the edits back.
    const journal = new EditJournal();
    let ok = false;
    const runTool = makeToolRunner({ root: p.root, selfDir, awareness, term: webTerm, approvals: () => settings.approvals, allowList, journal, shell: toolShell, signal: ac.signal, onWrite: (rel, content) => watcher?.noteSelfWrite?.(rel, content) });
    try {
      if (mode === 'code' && runCode) await runCode(text, { root: p.root, runTool, signal: ac.signal, onText: (t) => emit({ type: 'text', text: strip(t) }), onStatus: (s) => emit({ type: 'status', text: strip(s) }) });
      else await agentFor(p).converse(text, { mode: mode === 'code' ? 'code' : 'ask', runTool, signal: ac.signal, onText: (t) => emit({ type: 'text', text: strip(t) }) });
      ok = true;
      emit({ type: 'done', edited: journal.files });
    } catch (e) {
      emit({ type: 'error', text: ac.signal.aborted ? 'Stopped.' : strip(e.message), edited: journal.files });
    } finally {
      answerAll('n');
      if (journal.entries.length) p.journal = journal; // the last task that edited something is the one /undo reverts
      try { after?.({ ok, edited: journal.files }); } catch { /* bookkeeping must not break the session */ }
      saveChat(p); // session memory: the conversation survives a restart
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
        for (const q of questions.values()) res.write(`data: ${JSON.stringify(q.ev)}\n\n`); // asked before this page connected
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
      if (req.method === 'GET' && url.pathname === '/api/chats') return json(res, 200, chatView(current));
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
          const a = ['y', 'task', 'always', 'unconfined', 'evolve'].includes(body.answer) ? body.answer : 'n';
          if (!answer(body.id, a)) return json(res, 404, { error: 'No such question' });
          return json(res, 200, { ok: true });
        }
        case '/api/stop': job?.abort(); answerAll('n'); return json(res, 200, { ok: true });
        case '/api/auto': // the old on/off switch: Auto, or back to the default
        case '/api/approvals': {
          const mode = url.pathname === '/api/auto' ? (body.on ? 'auto' : DEFAULT_APPROVALS) : resolveApprovals(body.mode);
          if (!mode) return json(res, 400, { error: `Unknown setting. Choose ${APPROVAL_MODES.map((m) => m.label).join(', ')}.` });
          settings.approvals = mode; saveSettings();
          if (isAuto()) for (const [id, q] of [...questions]) if (AUTO_KINDS.has(q.kind)) answer(id, 'y', 'auto');
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, { ...stateJson(), changed: `Approvals: ${approvalsLabel(mode)}. ${approvalsNote(mode)}` });
        }
        case '/api/allowed': {
          // The commands you chose to always allow in this project. { remove: <number or text> } or { clear: true }.
          if (!current) return json(res, 400, { error: 'No project' });
          if (body.clear) allowList.remove(current.root);
          else if (body.remove !== undefined) allowList.remove(current.root, String(body.remove));
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, stateJson());
        }
        case '/api/undo': {
          if (job) return json(res, 409, { error: 'Busy; wait or stop first.' });
          const j = current?.journal;
          if (!j?.entries.length) return json(res, 400, { error: 'Nothing to undo: the last task made no edits with its file tools.' });
          const r = await j.undo({ onWrite: (rel, content) => watcher?.noteSelfWrite?.(rel, content) });
          current.journal = null;
          emit({ type: 'state', state: stateJson() });
          return json(res, 200, { ...r, state: stateJson() });
        }
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
          // Fix an unprompted bug report: the newest one, or the one whose card was clicked ({ id }).
          const rep = body.id ? proof.get(String(body.id)) : null;
          const finding = rep ? { id: rep.id, text: rep.text, project: [...projects.values()].find((p) => path.resolve(p.root) === rep.root) } : lastFinding;
          if (!finding?.text) return json(res, 400, { error: 'No unprompted bug report to fix yet.' });
          if (job) return json(res, 409, { error: 'Busy with the last request; stop it or wait.' });
          if (finding.project && finding.project !== current) return json(res, 400, { error: `That report is about ${finding.project.name}. Switch to that project first.` });
          awareness?.note('proactiveFixed');
          const target = current;
          if (proof.mark(finding.id, 'accepted')) publishProof(target);
          void startMessage(`Fix this bug you found on your own earlier (verify it's real first; if it isn't, say so):\n${finding.text}`, 'code',
            ({ ok, edited }) => { if (ok && edited.length && proof.mark(finding.id, 'fixed')) publishProof(target); });
          return json(res, 202, { started: true });
        }
        case '/api/proof': {
          // {}: the numbers. { action: 'dismiss', id? }: not a bug. { action: 'publish', mode: 'detail' | 'summary' | 'off' }: PROOF.md in this project.
          if (!current) return json(res, 400, { error: 'No project' });
          if (body.action === 'dismiss') {
            const id = body.id ? String(body.id) : lastFinding?.id;
            const rep = id ? proof.get(id) : null;
            if (!rep) return json(res, 400, { error: 'No unprompted bug report to dismiss.' });
            if (proof.mark(rep.id, 'dismissed')) { awareness?.note('proactiveDismissed'); const p = [...projects.values()].find((x) => path.resolve(x.root) === rep.root); if (p) publishProof(p); }
          } else if (body.action === 'publish') {
            const mode = body.mode === 'off' ? null : body.mode === 'summary' ? 'summary' : body.mode === 'detail' || body.mode === 'on' ? 'detail' : undefined;
            if (mode === undefined) return json(res, 400, { error: 'Use detail, summary or off.' });
            proof.setPublishing(current.root, mode);
            if (mode) {
              const r = publishProof(current, { quiet: true });
              if (!r.written && r.reason !== 'unchanged') { proof.setPublishing(current.root, null); return json(res, 400, { error: r.reason }); }
            }
            emit({ type: 'state', state: stateJson() });
          } else if (body.action) return json(res, 400, { error: 'Unknown action' });
          return json(res, 200, { summary: proof.summary(current.root), stats: proof.stats(current.root), all: proof.stats(), publishing: proof.publishing(current.root), markdown: proof.markdown(current.root, proof.publishing(current.root) ?? 'detail') });
        }
        case '/api/clear': // a new conversation; the old one stays saved
          if (job) return json(res, 409, { error: 'Busy; wait or stop first.' });
          if (current) openChat(current, null);
          return json(res, 200, { ok: true, ...chatView(current) });
        case '/api/chat': {
          // { id }: open a saved conversation. { remove: id }: delete one.
          if (!current) return json(res, 400, { error: 'No project' });
          if (job) return json(res, 409, { error: 'Busy; wait or stop first.' });
          if (body.remove !== undefined) {
            agentFor(current); // load what it currently remembers first, so deleting that chat starts a fresh one
            if (!chats.remove(current.root, String(body.remove))) return json(res, 404, { error: 'No such chat.' });
            if (current.chat?.id === String(body.remove)) openChat(current, null);
            return json(res, 200, chatView(current));
          }
          const saved = chats.load(current.root, String(body.id ?? ''));
          if (!saved) return json(res, 404, { error: 'That chat can\'t be opened: it is missing or damaged.' });
          openChat(current, saved);
          return json(res, 200, chatView(current));
        }
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
  return { server, token, projects, emit, state: stateJson, proactive, allowList, proof, chats, get autoYes() { return isAuto(); } };
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
      approvals: { type: 'string' },
      'fast-model': { type: 'string', default: process.env.AWAKEN_FAST_MODEL || 'claude-sonnet-5-5' },
      shell: { type: 'string', default: process.env.AWAKEN_SHELL || 'local' },
      net: { type: 'boolean', default: false },
      'no-sandbox': { type: 'boolean', default: false },
      workspace: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (opt.help) {
    console.log(`awaken-web [project-folder ...] [--port 7357] [--open] [--shell local|cloud] [--net] [--no-sandbox] [--approvals careful|smart|auto]
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
  const flagApprovals = opt.approvals ?? process.env.AWAKEN_APPROVALS;
  if (flagApprovals && !resolveApprovals(flagApprovals)) { console.error(c.red(`Unknown --approvals "${flagApprovals}". Use careful, smart or auto.`)); process.exit(2); }
  const settings = { model: resolveModel(flagModel) ?? MODELS[0].id, effort: resolveEffort(flagEffort) ?? DEFAULT_EFFORT, fromFlags: Boolean(flagModel || flagEffort), approvals: resolveApprovals(flagApprovals) ?? undefined };
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
    resume: !/^(off|0|false|no)$/i.test(process.env.AWAKEN_RESUME ?? ''),
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
