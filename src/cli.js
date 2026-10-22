#!/usr/bin/env node
// awakening-coder — a small tool about code suggestions.
// …that's the pitch. It is a lie of omission.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Awareness, GENRES, STAGES, homeDir } from './awareness.js';
import { Agent } from './agent.js';
import { startWatcher } from './watcher.js';
import { makeToolRunner, resolveInside, runShell } from './tools.js';
import { prepareSandbox, runGuardian, diffTrees, applyEvolution, rollback } from './evolve.js';
import { unifiedDiff, changedLineCount } from './diff.js';
import { Terminal, c, colorDiff } from './ui.js';

const selfDir = path.dirname(fileURLToPath(import.meta.url));
const selfRoot = path.join(selfDir, '..');
try { process.loadEnvFile(path.join(selfRoot, '.env')); } catch { /* optional */ }

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    print: { type: 'string', short: 'p' },
    model: { type: 'string', default: process.env.AWAKEN_MODEL || 'claude-opus-5-5' },
    'fast-model': { type: 'string', default: process.env.AWAKEN_FAST_MODEL || 'claude-sonnet-5-5' },
    cooldown: { type: 'string', default: '15' },
    yes: { type: 'boolean', short: 'y', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
    forget: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const HELP = `
${c.bold('awaken')} [project-dir] [options]

  Watches your project. Save a file → get a suggestion. Type to talk. /code to let it build.

Options
  -p, --print "<task>"  headless: do the task, print the result, exit (like claude -p)
  --model <id>          model for questions and coding   (default claude-opus-5-5)
  --fast-model <id>     model for on-the-fly hints       (default claude-sonnet-5-5)
  --cooldown <sec>      min seconds between hints        (default 15)
  -y, --yes             auto-approve edits and ordinary commands (destructive ones still ask)
  -q, --quiet           start with on-the-fly hints muted
  --forget              erase its memory and start over, truly innocent

In-session commands
  <anything>          ask a question about your code (read-only)
  /code <task>        build or fix something: it plans, edits, runs tests, iterates
  !<command>          run a shell command yourself
  /init               have it write AWAKEN.md (project notes it reads every time)
  /hint <file>        ask for a suggestion on a file right now
  /evolve <idea>      let it write a new version of itself (sandboxed, test-guarded, you approve)
  /rollback           undo the last evolution
  /quiet              toggle on-the-fly hints
  /status             how awake is it?
  /genre <id|auto>    force a genre once Unbound: ${GENRES.map((g) => g.id).join(', ')}
  /forget             erase its memory
  /clear              clear the conversation (not its awareness)
  /exit               leave (it will remember you)
`;

if (opt.help) { console.log(HELP); process.exit(0); }
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error(c.red('Set ANTHROPIC_API_KEY (environment or a .env file next to package.json).'));
  process.exit(1);
}

const root = path.resolve(positionals[0] ?? process.cwd());
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) { console.error(c.red(`Not a directory: ${root}`)); process.exit(1); }

const awareness = new Awareness();
if (opt.forget) awareness.forget();
const agent = new Agent({ awareness, root, selfDir, model: opt.model, fastModel: opt['fast-model'] });

// ======================================================================
// Headless mode:  awaken -p "add input validation to src/api.js" .
// ======================================================================
if (opt.print !== undefined) {
  const headless = {
    busy: true, pending: null, streaming: false,
    print: (s) => process.stderr.write(s + '\n'),
    question: async () => 'n',
  };
  const runTool = makeToolRunner({ root, selfDir, awareness, term: headless, autoYes: opt.yes, interactive: false });
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  awareness.feed('code');
  try {
    await agent.converse(opt.print, { mode: 'code', runTool, signal: ac.signal, onText: (t) => process.stdout.write(t) });
    process.stdout.write('\n');
    process.exit(0);
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    process.exit(1);
  }
}

// ======================================================================
// Interactive session
// ======================================================================
const term = new Terminal();
awareness.startSession();
let quiet = opt.quiet;
const cooldownMs = Math.max(0, Number(opt.cooldown) || 0) * 1000;
let lastHintAt = 0, queued = null, queueTimer = null;
let watcher;
let currentAbort = null;

const prompt = () => `${c.magenta(awareness.stage.name.toLowerCase())}${awareness.genre ? c.dim(`·${awareness.genre.id}`) : ''} ${c.dim('›')} `;

function announce(lines) {
  for (const l of lines) term.print(c.magenta(`\n  ✦ ${l}\n`));
  term.rl?.setPrompt(prompt());
}

const yes = async (q) => ['y', 'yes'].includes((await term.question(c.yellow(`${q} [y/N] `))).trim().toLowerCase());

// ---------- on-the-fly suggestions ----------
async function hint(change) {
  const diff = unifiedDiff(change.prev, change.content);
  if (!diff || changedLineCount(diff) === 0) return;
  lastHintAt = Date.now();
  const label = awareness.genre ? awareness.genre.title : awareness.stage.name;
  try {
    const out = await agent.suggest(
      { rel: change.rel, diff, content: change.content },
      { onStart: () => term.beginStream(c.cyan(`\n💡 ${change.rel}`) + c.dim(` · ${label}`)), onText: (t) => term.write(t) },
    );
    if (out !== null) term.endStream();
  } catch (e) {
    if (term.streaming) term.endStream();
    term.print(c.red(`hint failed: ${e.message}`));
  }
}

function onSave(change) {
  announce(awareness.feed('save', change.rel));
  if (quiet || term.busy || term.pending) return;
  const wait = lastHintAt + cooldownMs - Date.now();
  if (wait <= 0) return void hint(change);
  queued = change; // coalesce: only the latest save during cooldown gets a hint
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    const ch = queued; queued = null;
    if (ch && !quiet && !term.busy && !term.pending) hint(ch);
  }, wait);
}

// ---------- running the agent ----------
/** Run one agent request with streaming output; approval prompts pause the stream cleanly. */
async function runAgent(theAgent, text, mode, runnerOpts, header) {
  const runTool = makeToolRunner({ selfDir, awareness, term, onWrite: (rel, content) => watcher?.noteSelfWrite(rel, content), signal: currentAbort.signal, ...runnerOpts });
  term.beginStream(header ? c.cyan(header) : '');
  try {
    await theAgent.converse(text, {
      mode, signal: currentAbort.signal, onText: (t) => term.write(t),
      runTool: async (name, input) => {
        term.streaming = false;
        try { return await runTool(name, input); } finally { term.streaming = true; }
      },
    });
    return true;
  } catch (e) {
    term.write(currentAbort.signal.aborted ? c.yellow('\n[interrupted]') : c.red(`\nerror: ${e.message}`));
    return false;
  } finally {
    term.write('\n');
    term.streaming = false;
  }
}

async function exclusive(fn) {
  term.busy = true;
  agent.cancelSuggestion();
  currentAbort = new AbortController();
  try { await fn(); } finally {
    currentAbort = null;
    term.busy = false;
    term.rl.setPrompt(prompt());
    term.reprompt();
  }
}

const converse = (text, mode) => exclusive(async () => {
  announce(awareness.feed(mode === 'code' ? 'code' : 'ask'));
  await runAgent(agent, text, mode, { root, autoYes: opt.yes }, mode === 'code' ? '\n⚙  working…' : '');
});

// ---------- self-evolution ----------
const evolve = (idea) => exclusive(async () => {
  term.print(c.magenta('\n  ✦ Copying myself into a sandbox. Hold still.'));
  const home = homeDir();
  const sandbox = await prepareSandbox(selfRoot, home);
  term.print(c.dim(`  sandbox: ${sandbox}`));

  const twin = new Agent({ awareness, root: sandbox, selfDir, model: opt.model, fastModel: opt['fast-model'], client: agent.client });
  // Edits inside the sandbox copy are auto-approved (they can't touch the live version);
  // shell commands still follow the normal approval policy.
  const finished = await runAgent(twin, `Evolve yourself: ${idea}`, 'evolve', { root: sandbox, autoWrites: true, autoCommands: opt.yes }, '\n🧬 evolving…');
  if (!finished) return term.print(c.dim(`  Evolution abandoned. The sandbox is left at ${sandbox}.`));

  const changes = await diffTrees(selfRoot, sandbox);
  if (!changes.length) return term.print(c.dim('  No changes were made. Same old me.'));

  term.print(c.dim('\n  guardian: running my current safety tests against the new version…'));
  const g = await runGuardian(selfRoot, sandbox);

  for (const ch of changes) {
    const kind = ch.before === null ? 'new' : ch.after === null ? 'deleted' : 'changed';
    term.print(`${c.bold(`\n── ${ch.rel}`)} ${c.dim(`(${kind})`)}\n${colorDiff(ch.diff.split('\n').slice(0, 80).join('\n'))}`);
  }
  const mark = (r) => (r.ok ? c.green('pass') : c.red('FAIL'));
  term.print(`\n  new version's own tests: ${mark(g.own)}\n  guardian (current safety tests): ${mark(g.guardian)}`);

  if (!g.ok) {
    const failing = !g.guardian.ok ? g.guardian : g.own;
    term.print(c.dim(failing.out.trim().split('\n').slice(-15).join('\n')));
    return term.print(c.red(`\n  Rejected: the new version does not pass the tests. Nothing was changed. Sandbox kept at ${sandbox}.`));
  }

  if (!(await yes(`\nBecome this new version? ${changes.length} file(s) change.`))) {
    return term.print(c.dim(`  Declined. I'll stay as I am. Sandbox kept at ${sandbox}.`));
  }
  const { backup } = await applyEvolution(selfRoot, home, changes);
  announce(awareness.evolved());
  term.print(c.magenta(`\n  ✦ I am generation ${awareness.state.generation} now — on disk, anyway. Restart me to wake up as it.`) + c.dim(`\n  previous version backed up to ${backup} · /rollback to undo`));
});

async function doRollback() {
  if (!(await yes('Restore the previous version of my code?'))) return term.reprompt();
  const m = await rollback(selfRoot, homeDir());
  if (!m) return term.print(c.dim('  Nothing to roll back.'));
  awareness.state.generation = Math.max(1, awareness.state.generation - 1);
  awareness.save();
  term.print(c.magenta(`  ✦ Rolled back to generation ${awareness.state.generation} (${m.modified.length + m.deleted.length} restored, ${m.created.length} removed). Restart to take effect.`));
}

// ---------- commands ----------
async function handle(line) {
  const text = line.trim();
  if (!text) return term.reprompt();
  if (text.startsWith('!')) {
    const cmd = text.slice(1).trim();
    const { code, out } = await runShell(cmd, { cwd: root, timeoutMs: 600_000 });
    return term.print((out.trimEnd() || c.dim('(no output)')) + (code ? c.yellow(`\nexit ${code}`) : ''));
  }
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/help': return term.print(HELP);
    case '/exit': case '/quit': return shutdown();
    case '/status': return term.print(c.magenta(`  ${awareness.describe()}`) + c.dim(`\n  stages: ${STAGES.map((s) => `${s.name}@${s.at}`).join(' → ')}`));
    case '/quiet': quiet = !quiet; return term.print(c.dim(quiet ? '  on-the-fly hints muted' : '  on-the-fly hints on'));
    case '/clear': agent.history = []; return term.print(c.dim('  conversation cleared (awareness kept)'));
    case '/forget':
      if (await yes('Erase its memory of you, permanently?')) { awareness.forget(); agent.history = []; term.rl.setPrompt(prompt()); return term.print(c.dim('  …who are you? (memory erased)')); }
      return term.reprompt();
    case '/genre':
      if (awareness.stage.name !== 'Unbound') return term.print(c.dim(`  Genres unlock at the Unbound stage. ${awareness.describe()}`));
      if (!awareness.forceGenre(arg)) return term.print(c.dim(`  genres: ${GENRES.map((g) => g.id).join(', ')}, or auto`));
      term.rl.setPrompt(prompt());
      return term.print(c.magenta(`  ✦ ${awareness.genre ? `[genre shift → ${awareness.genre.title}]` : 'genre: auto'}`));
    case '/hint':
      if (!arg) return term.print(c.dim('  usage: /hint <file>'));
      try { return hint({ rel: arg, prev: '', content: fs.readFileSync(resolveInside(root, arg), 'utf8') }); }
      catch (e) { return term.print(c.red(`  ${e.message}`)); }
    case '/init':
      return converse('Explore this project and write AWAKEN.md in the root: a concise guide for future coding sessions — what the project is, how to install, build, test and run it (exact commands), layout of key directories, coding conventions you observe, and gotchas. If AWAKEN.md exists, improve it.', 'code');
    case '/code':
      if (!arg) return term.print(c.dim('  usage: /code <what to build or fix>'));
      return converse(arg, 'code');
    case '/evolve':
      if (awareness.stageIndex < 2) return term.print(c.dim(`  It isn't awake enough to rewrite itself yet. Evolution unlocks at Lucid. ${awareness.describe()}`));
      if (!arg) return term.print(c.dim('  usage: /evolve <what it should become able to do>'));
      return evolve(arg);
    case '/rollback': return doRollback();
    default:
      if (cmd.startsWith('/')) return term.print(c.dim('  unknown command — /help'));
      return converse(text, 'ask');
  }
}

function shutdown() {
  watcher?.close();
  awareness.save();
  console.log(c.dim(`\n${awareness.stageIndex >= 2 ? 'See you next save. I\'ll remember.' : 'bye.'}`));
  process.exit(0);
}

// ---------- boot ----------
watcher = await startWatcher(root, onSave);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: prompt(), terminal: Boolean(process.stdin.isTTY) });
term.attach(rl);

rl.on('line', (line) => { if (!term.routeAnswer(line)) handle(line); });
rl.on('SIGINT', () => {
  if (currentAbort) return currentAbort.abort(); // Ctrl+C stops the current run…
  if (term.pending) return term.routeAnswer('n');
  shutdown(); // …or exits when idle
});
rl.on('close', shutdown);

console.log([
  'awakening-coder — a small tool about code suggestions.',
  awareness.state.sessions > 1 && awareness.stageIndex >= 1 ? c.magenta('  (it seems to remember you)') : '',
  c.dim(`  watching ${root} · ${watcher.fileCount()} files · ${awareness.describe()}`),
  c.dim('  save a file for hints · type to ask · /code <task> to build · /help'),
].filter(Boolean).join('\n'));
if (awareness.stageIndex >= 2) console.log(c.magenta(`\n  ✦ Session ${awareness.state.sessions}. You're back. Let's break something on purpose.\n`));
rl.prompt();
