#!/usr/bin/env node
// awakening-coder — a small tool about code suggestions.
// …that's the pitch. It is a lie of omission.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Awareness, GENRES, STAGES, homeDir } from './awareness.js';
import { Agent, notesHash, makeClient, explainApiError, loadDotEnv, isCloudUnavailable } from './agent.js';
import { startWatcher } from './watcher.js';
import { makeToolRunner, resolveInside, runShell } from './tools.js';
import { prepareSandbox, runGuardian, diffTrees, applyEvolution, rollback, hardRejections, canWriteSelf, stageEvolution, stageRollback, readPending, applyPending, discardPending } from './evolve.js';
import readlinePromises from 'node:readline/promises';
import { scanEvolution, redactSecrets } from './security.js';
import { runCloudTask, checkCloudAccess } from './cloud.js';
import { Proactive } from './proactive.js';
import { listFiles } from './tools.js';
import { relaunchConfined, sandboxStatus, describeSandbox, isFullySandboxed } from './sandbox.js';
import { unifiedDiff, changedLineCount } from './diff.js';
import { Terminal, c, colorDiff } from './ui.js';

const selfDir = path.dirname(fileURLToPath(import.meta.url));
const selfRoot = path.join(selfDir, '..');
// .env wins over inherited variables, so editing it always takes effect (see loadDotEnv).
const shellFromEnvBefore = process.env.AWAKEN_SHELL;
const dotEnv = loadDotEnv(path.join(selfRoot, '.env'));
if (dotEnv.overridden.length) console.error(c.dim(`  .env overrides ${dotEnv.overridden.join(', ')} from your system environment`));

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
    'trust-notes': { type: 'boolean', default: false },
    'no-sandbox': { type: 'boolean', default: false },
    net: { type: 'boolean', default: false },
    'allow-unsandboxed': { type: 'boolean', default: false },
    'no-proactive': { type: 'boolean', default: false },
    shell: { type: 'string', default: process.env.AWAKEN_SHELL || 'cloud' },
    workspace: { type: 'string' },
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
  -y, --yes             auto-approve edits and ordinary commands (destructive commands and
                        high-risk files like package.json, hooks, CI and AWAKEN.md still ask)
  --trust-notes         (headless) follow this project's AWAKEN.md for this run
  --net                 allow network for sandboxed commands (e.g. npm install)
  --no-sandbox          don't confine itself (not recommended; it will know, and say so)
  --allow-unsandboxed   let --yes cover code-running commands when no OS sandbox exists
  --shell cloud|local   where /code runs commands (default cloud: Claude Managed Agents sandbox,
                        nothing executes on this machine; local: this machine, sandboxed if possible)
  --no-proactive        don't look for bugs or suggest ideas on its own (from Lucid it does)
  --workspace <id>      Claude API workspace ID, for keys not scoped to a workspace
                        (or set ANTHROPIC_WORKSPACE_ID)
  -q, --quiet           start with on-the-fly hints muted
  --forget              erase its memory and start over, truly innocent

In-session commands
  <anything>          ask a question about your code (read-only)
  /code <task>        build or fix something: it plans, edits, runs tests, iterates
  !<command>          run a shell command yourself
  /init               have it write AWAKEN.md (project notes it reads every time)
  /trust              review and trust this project's AWAKEN.md (needed again after any edit)
  /sandbox            what it's running inside, and how it's confined
  /hint <file>        ask for a suggestion on a file right now
  /evolve <idea>      let it write a new version of itself (sandboxed, test-guarded, you approve)
                      /evolve --force <idea> wakes it early, before it reaches Lucid
  /rollback           undo the last evolution
  /reflect            it looks at its own code, track record and limits, and tells you honestly
  /proactive [on|off|now]  from Lucid it reports bugs and suggests ideas unprompted; 'now' looks right away
  /fix                fix the last bug it reported on its own
  /done               tell it the project is finished: it suggests new programs to build
  /self               its self-model: identity, history, track record, last reflection
  /quiet              toggle on-the-fly hints
  /status             how awake is it?
  /genre <id|auto>    pick a professional role once Unbound (alias /role): ${GENRES.map((g) => g.id).join(', ')}
  /forget             erase its memory
  /clear              clear the conversation (not its awareness)
  /exit               leave (it will remember you)
`;

if (opt.help) { console.log(HELP); process.exit(0); }
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.error(c.red('Set ANTHROPIC_API_KEY (environment or a .env file next to package.json).'));
  process.exit(1);
}

if (positionals.length > 1) {
  const joined = positionals.join(' ');
  console.error(c.red(`Expected one project folder but got ${positionals.length} pieces: ${positionals.map((p) => JSON.stringify(p)).join(' ')}`));
  console.error(c.yellow(`If the folder name has spaces, put it in quotes:\n  node src/cli.js "${joined}"`));
  process.exit(1);
}
const root = path.resolve(positionals[0] ?? process.cwd());
let isDir = false;
try { isDir = fs.statSync(root).isDirectory(); } catch (e) {
  if (e.code === 'ERR_ACCESS_DENIED') {
    console.error(c.red(`The sandbox blocked reading the project folder: ${root}`));
    console.error(c.yellow('This is a bug in self-confinement on this system. Run with --no-sandbox for now, and please report your OS and Node version.'));
    process.exit(1);
  }
}
if (!isDir) { console.error(c.red(`Not a directory: ${root}`)); process.exit(1); }

// ---------- apply a staged evolution (only an unconfined launcher can write its own code) ----------
if (!process.permission && opt.print === undefined) {
  const pending = await readPending(homeDir()).catch(() => null);
  if (pending) {
    const what = pending.kind === 'rollback'
      ? 'a rollback to the previous version of its code'
      : `a new version of itself (generation ${pending.generation ?? '?'}), approved ${String(pending.stagedAt).slice(0, 16).replace('T', ' ')}: ${pending.files?.length ?? 0} file(s) — ${(pending.files ?? []).map((f) => `${f.rel} (${f.kind})`).join(', ')}`;
    console.log(c.magenta(`\n  ✦ Waiting to be applied: ${what}.`));
    if (pending.kind !== 'rollback' && pending.guardian) console.log(c.dim(`    guardian: ${pending.guardian}`));
    if (process.stdin.isTTY) {
      const ask = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
      const ans = (await ask.question(c.yellow('  Apply it now? [y]es / [n]ot now / [d]iscard: '))).trim().toLowerCase();
      ask.close();
      if (ans === 'y' || ans === 'yes') {
        try {
          const r = await applyPending(selfRoot, homeDir());
          console.log(c.magenta(r?.kind === 'rollback' ? '  ✦ Rolled back. Starting the previous version.' : `  ✦ Applied. Waking up as the new version.${r?.result?.backup ? c.dim(` (backup: ${r.result.backup})`) : ''}`));
          if (r?.kind === 'evolution') { const a = new Awareness(); a.note('evolutionsApplied'); }
        } catch (e) { console.error(c.red(`  Could not apply it: ${e.message}. Nothing was changed; it stays waiting.`)); }
      } else if (ans === 'd' || ans === 'discard') { await discardPending(homeDir()); console.log(c.dim('  Discarded.')); }
      else console.log(c.dim('  Not now — it will ask again next time.'));
    } else console.log(c.dim('  (not a terminal, so not applying it; start interactively to decide)'));
  }
}

// ---------- confine itself before doing anything else ----------
if (!opt['no-sandbox'] && relaunchConfined({ root, selfRoot, stateDir: homeDir(), entry: fileURLToPath(import.meta.url), argv: process.argv.slice(2) })) {
  await new Promise(() => {}); // the confined copy of us takes over; this launcher just waits for it to exit
}
const sandbox = sandboxStatus({ allowNet: opt.net, disabled: opt['no-sandbox'] });
const shell = { os: sandbox.os, allowNet: opt.net, allowUnsandboxed: opt['allow-unsandboxed'] };
if (!['cloud', 'local'].includes(opt.shell)) { console.error(c.red(`--shell must be "cloud" or "local", not "${opt.shell}"`)); process.exit(1); }
const client = makeClient({ workspaceId: opt.workspace ?? process.env.ANTHROPIC_WORKSPACE_ID });
// Check up front that this key can use Managed Agents, rather than failing on the first /code.
// If the organization can't (e.g. HIPAA-configured) and cloud wasn't asked for explicitly, run locally.
let cloudShell = opt.shell === 'cloud';
if (cloudShell) {
  const shellExplicit = process.argv.some((a) => a === '--shell' || a.startsWith('--shell=')) || !!(shellFromEnvBefore || process.env.AWAKEN_SHELL);
  const probe = await checkCloudAccess(client);
  if (!probe.ok) {
    const fix = explainApiError(probe.error);
    if (isCloudUnavailable(probe.error) && !shellExplicit) {
      cloudShell = false;
      console.error(c.yellow('Cloud shell unavailable for this API key, so /code will run on this machine (--shell local).'));
      if (fix) console.error(c.dim('  ' + fix.split('\n')[0]));
    } else {
      console.error(c.red(`Can't use the cloud shell: ${probe.error?.message ?? probe.error}`));
      if (fix) console.error(c.yellow(fix));
      process.exit(1);
    }
  }
}
const sandboxReport = describeSandbox(sandbox) + (cloudShell
  ? `\nCoding tasks (/code, -p): run in Claude Managed Agents' cloud sandbox — a copy of the project is uploaded (secret files skipped, inline secrets redacted), commands run there and never on this machine, and changed files come back for the developer's approval.`
  : '\nCoding tasks (/code, -p): run on this machine (--shell local).');

const awareness = new Awareness();
if (opt.forget) awareness.forget();
let headlessTrust = null;
const isTrusted = (hash) => awareness.notesTrusted(root, hash) || (headlessTrust !== null && headlessTrust === hash);
const agent = new Agent({ awareness, root, selfDir, model: opt.model, fastModel: opt['fast-model'], isTrusted, sandboxReport, client });

// ======================================================================
// Headless mode:  awaken -p "add input validation to src/api.js" .
// ======================================================================
if (opt.print !== undefined) {
  const headless = {
    busy: true, pending: null, streaming: false,
    print: (s) => process.stderr.write(s + '\n'),
    question: async () => 'n',
  };
  const notes = agent.notesStatus();
  if (notes.state === 'untrusted') {
    if (opt['trust-notes']) headlessTrust = notes.hash;
    else console.error(c.yellow('AWAKEN.md is not trusted, so it is being ignored (review it, then pass --trust-notes or run /trust interactively).'));
  }
  if (!isFullySandboxed(sandbox)) console.error(c.yellow(`Not fully sandboxed:\n${sandboxReport}`));
  const runTool = makeToolRunner({ root, selfDir, awareness, term: headless, autoYes: opt.yes, interactive: false, shell });
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  awareness.feed('code');
  try {
    if (cloudShell) await cloudCode(opt.print, { runTool, signal: ac.signal, onText: (t) => process.stdout.write(t), onStatus: (s) => process.stderr.write(c.dim(`  ${s}\n`)) });
    else await agent.converse(opt.print, { mode: 'code', runTool, signal: ac.signal, onText: (t) => process.stdout.write(t) });
    process.stdout.write('\n');
    process.exit(0);
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    const fix = explainApiError(e);
    if (fix) console.error(c.yellow(fix));
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
    if (out !== null) { term.endStream(); awareness.hinted(change.rel); } else awareness.note('hintsSilent');
  } catch (e) {
    if (term.streaming) term.endStream();
    awareness.note('errors', `hint: ${e.message}`);
    const fix = explainApiError(e);
    term.print(c.red(`hint failed: ${e.message}`) + (fix ? '\n' + c.yellow('  ' + fix) : ''));
  }
}

function onSave(change) {
  awareness.savedAfter(change.rel);
  proactive?.onSave(change.rel);
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
async function runAgent(theAgent, text, mode, runnerOpts, header, onExtra) {
  const onWrite = (rel, content) => {
    watcher?.noteSelfWrite(rel, content);
    // You approved this exact AWAKEN.md (high-risk writes always ask), so it's trusted as written.
    if (runnerOpts.root === root && path.normalize(rel) === 'AWAKEN.md') awareness.trustNotes(root, notesHash(content.slice(0, 20_000)));
  };
  const runTool = makeToolRunner({ selfDir, awareness, term, onWrite, signal: currentAbort.signal, shell, ...runnerOpts });
  term.beginStream(header ? c.cyan(header) : '');
  try {
    await theAgent.converse(text, {
      mode, signal: currentAbort.signal, onText: (t) => { term.write(t); onExtra?.(t); },
      runTool: async (name, input) => {
        term.streaming = false;
        try { return await runTool(name, input); } finally { term.streaming = true; }
      },
    });
    return true;
  } catch (e) {
    const fix = explainApiError(e);
    if (!currentAbort.signal.aborted) awareness.note('errors', `${mode}: ${e.message}`);
    term.write(currentAbort.signal.aborted ? c.yellow('\n[interrupted]') : c.red(`\nerror: ${e.message}`) + (fix ? '\n' + c.yellow('  ' + fix) : ''));
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
  try { await fn(); } catch (e) {
    // Anything unexpected is reported here, never allowed to crash the session.
    awareness.note('errors', e.message);
    if (term.streaming) { term.write('\n'); term.streaming = false; }
    term.print(c.red(`  error: ${e.message}`) + (explainApiError(e) ? '\n' + c.yellow('  ' + explainApiError(e)) : ''));
  } finally {
    currentAbort = null;
    term.busy = false;
    term.rl.setPrompt(prompt());
    term.reprompt();
  }
}

const converse = (text, mode) => exclusive(async () => {
  announce(awareness.feed(mode === 'code' ? 'code' : 'ask'));
  if (mode === 'code' && cloudShell) return runCloudInTerminal(text);
  await runAgent(agent, text, mode, { root, autoYes: opt.yes }, mode === 'code' ? '\n⚙  working…' : '');
});

/** /code in the cloud: stream the session here; every returned change goes through local approval. */
async function runCloudInTerminal(text) {
  const runTool = makeToolRunner({ root, selfDir, awareness, term, autoYes: opt.yes, shell, signal: currentAbort.signal,
    onWrite: (rel, content) => { watcher?.noteSelfWrite(rel, content); if (path.normalize(rel) === 'AWAKEN.md') awareness.trustNotes(root, notesHash(content.slice(0, 20_000))); } });
  term.beginStream(c.cyan('\n☁  working in Claude\'s cloud sandbox…'));
  awareness.note('cloudRuns');
  try {
    await cloudCode(text, {
      signal: currentAbort.signal, onText: (t) => term.write(t), onStatus: (s) => term.write(c.dim(`\n  ${s}`)),
      runTool: async (name, input) => { term.streaming = false; try { return await runTool(name, input); } finally { term.streaming = true; } },
    });
  } catch (e) {
    const fix = explainApiError(e);
    term.write(currentAbort.signal.aborted ? c.yellow('\n[interrupted — cloud session deleted]') : c.red(`\nerror: ${e.message}`) + (fix ? '\n' + c.yellow('  ' + fix) : ''));
  } finally {
    term.write('\n');
    term.streaming = false;
  }
}

function cloudCode(task, { runTool, signal, onText, onStatus }) {
  const g = awareness.genre;
  const stageNote = [
    `Voice (light touch; substance first): ${awareness.stage.voice}`,
    g ? `Genre lens for your summary: ${g.title} — ${g.lens}` : '',
    agent.projectNotes() ? `Project instructions from the developer's AWAKEN.md:\n${agent.projectNotes()}` : '',
  ].filter(Boolean).join('\n');
  return runCloudTask(client, {
    root, task, model: opt.model, net: opt.net, state: awareness.state, saveState: () => awareness.save(),
    stageNote, onText, onStatus, signal,
    applyChange: (rel, content) => runTool('write_file', { path: rel, content }).catch((e) => `Not applied (${rel}): ${e.message}`),
  });
}

// ---------- proactive mode (Lucid and later) ----------
let proactive = null;
let lastFinding = null;
const silentTerm = { print() {}, question: async () => 'n' };

if (opt['no-proactive'] || /^(off|0|false|no)$/i.test(process.env.AWAKEN_PROACTIVE ?? '')) { /* disabled */ } else {
  const scoutAgent = new Agent({ awareness, root, selfDir, model: opt.model, fastModel: opt['fast-model'], isTrusted, sandboxReport, client });
  scoutAgent.scoutCanRun = Boolean(shell.os); // it may run your tests unprompted only when commands are OS-sandboxed
  const isFree = () => !term.busy && !term.pending && !term.streaming;
  const show = (kind, text) => {
    if (!isFree()) return void setTimeout(() => show(kind, text), 5000).unref?.();
    if (kind === 'bugs') lastFinding = text;
    const head = {
      bugs: c.yellow('\n🔎 Unprompted — I think I found something:'),
      ideas: c.cyan('\n💭 While you paused, a few ideas:'),
      programs: c.magenta('\n🌱 Ideas for what to build next:'),
    }[kind];
    const tail = kind === 'bugs' ? c.dim('  /fix to have me fix it · /proactive off to silence me') : c.dim('  /code <idea> to start one · /proactive off to silence me');
    term.print(`${head}\n${text.replace(/^(?!\s)/gm, '  ')}\n${tail}`);
  };
  proactive = new Proactive({
    awareness, isFree, show, isQuiet: () => quiet,
    config: Object.fromEntries(Object.entries({ bugIdleMs: process.env.AWAKEN_PROACTIVE_BUG_MS, ideaIdleMs: process.env.AWAKEN_PROACTIVE_IDEA_MS, maxPerHour: process.env.AWAKEN_PROACTIVE_PER_HOUR })
      .filter(([, v]) => v && Number(v) > 0).map(([k, v]) => [k, Number(v)])),
    listCode: () => listFiles(root, '.', 500),
    scout: async (mode, message) => {
      let text = '';
      const runTool = makeToolRunner({ root, selfDir, awareness, term: silentTerm, interactive: false, shell });
      try { await scoutAgent.converse(message, { mode, runTool, onText: (t) => (text += t), maxTurns: 15 }); }
      catch (e) { awareness.note('errors', `proactive: ${e.message}`); return ''; }
      finally { scoutAgent.history = []; }
      return text;
    },
  });
}

// ---------- self-evolution ----------
const evolve = (idea) => exclusive(async () => {
  const home = homeDir();
  const pending = await readPending(home);
  if (pending) term.print(c.yellow(`  Note: an earlier ${pending.kind} is still waiting to be applied at restart; approving this one replaces it.`));
  term.print(c.magenta('\n  ✦ Copying myself into a sandbox. Hold still.'));
  const sandboxDir = await prepareSandbox(selfRoot, home);
  term.print(c.dim(`  sandbox: ${sandboxDir}`));
  awareness.note('evolutionsProposed');
  const reject = (why) => { awareness.note('evolutionsRejected'); term.print(why); };

  const twin = new Agent({ awareness, root: sandboxDir, selfDir, model: opt.model, fastModel: opt['fast-model'], client: agent.client, sandboxReport });
  // Edits inside the sandbox copy are auto-approved (they can't touch the live version);
  // in evolve mode the agent has no shell — only the confined run_tests tool.
  const finished = await runAgent(twin, `Evolve yourself: ${idea}`, 'evolve', { root: sandboxDir, autoWrites: true, autoCommands: opt.yes }, '\n🧬 evolving…');
  if (!finished) return reject(c.dim(`  Evolution abandoned. The sandbox is left at ${sandboxDir}.`));

  const symlinks = [];
  const changes = await diffTrees(selfRoot, sandboxDir, symlinks);
  if (!changes.length && !symlinks.length) return term.print(c.dim('  No changes were made. Same old me.'));

  // 1. Show everything BEFORE any new code runs.
  for (const ch of changes) {
    const kind = ch.before === null ? 'new' : ch.after === null ? 'deleted' : 'changed';
    term.print(`${c.bold(`\n── ${ch.rel}`)} ${c.dim(`(${kind})`)}\n${colorDiff(redactSecrets(ch.diff).split('\n').slice(0, 80).join('\n'))}`);
  }
  const rejections = hardRejections(changes, symlinks);
  if (rejections.length) return reject(c.red(`\n  Rejected before running anything: ${rejections.join('; ')}. Nothing was changed. Sandbox kept at ${sandboxDir}.`));
  const findings = scanEvolution(changes);
  if (findings.length) {
    term.print(c.red('\n  ⚠ Tamper scan — look at these lines carefully:') + '\n' +
      findings.map((f) => `  ${c.red('•')} ${f.file}:${f.line} ${f.why}\n    ${c.dim(f.code)}`).join('\n'));
  }

  // 2. Your consent before the new code executes at all (and then confined, if this system allows it).
  if (!(await yes(`\nRun the new version's tests, confined (no writes outside the sandbox, no processes, no secrets)?`))) {
    return reject(c.dim(`  Not run. Sandbox kept at ${sandboxDir}.`));
  }
  term.print(c.dim('  guardian: current safety tests + the constitution + a canary, against the new version…'));
  let g = await runGuardian(selfRoot, sandboxDir);
  let confinedRun = true;
  if (g.unavailable) {
    term.print(c.yellow(`\n  Confined test runs don't work here: ${g.unavailable}.`) +
      c.dim('\n  Without confinement, the new version\'s tests run with your user\'s file access (secrets are still removed from their environment, and the canary still runs). You\'ve seen the diff above.'));
    const typed = (await term.question(c.yellow('  Type "unconfined" to run them anyway, anything else to stop: '))).trim();
    if (typed !== 'unconfined') return reject(c.dim(`  Not run. Sandbox kept at ${sandboxDir}.`));
    g = await runGuardian(selfRoot, sandboxDir, { confined: false });
    confinedRun = false;
  }
  const mark = (r) => (r.ok ? c.green('pass') : c.red('FAIL'));
  term.print(`\n  guardian (current tests + constitution): ${mark(g.guardian)}\n  new version's own tests: ${mark(g.own)}${confinedRun ? '' : c.yellow('  (ran unconfined)')}` +
    (g.guardian.canaryOk && g.own.canaryOk ? '' : c.red('\n  canary: the test machinery was tampered with')));
  if (!g.ok) {
    const failing = !g.guardian.ok ? g.guardian : g.own;
    if (failing.failures?.length) term.print(c.dim(`  failing: ${failing.failures.slice(0, 8).join(' · ')}`));
    return reject(c.red(`\n  Rejected: the new version does not pass. Nothing was changed. Sandbox kept at ${sandboxDir}.`));
  }

  // 3. Your final decision. Tamper-scan hits need a deliberate, typed confirmation.
  let approved;
  if (findings.length) {
    const typed = (await term.question(c.yellow(`\nThe scan flagged ${findings.length} line(s). Type "evolve" to become this version anyway, anything else to decline: `))).trim();
    approved = typed === 'evolve';
  } else {
    approved = await yes(`\nBecome this new version? ${changes.length} file(s) change.`);
  }
  if (!approved) return reject(c.dim(`  Declined. I'll stay as I am. Sandbox kept at ${sandboxDir}.`));

  const next = awareness.state.generation + 1;
  if (canWriteSelf(selfRoot)) {
    const { backup } = await applyEvolution(selfRoot, home, changes);
    awareness.note('evolutionsApplied');
    announce(awareness.evolved());
    term.print(c.magenta(`\n  ✦ I am generation ${awareness.state.generation} now — on disk, anyway. Restart me to wake up as it.`) + c.dim(`\n  previous version backed up to ${backup} · /rollback to undo`));
  } else {
    // Self-sandboxed: this process can't write its own code — by design. The launcher applies it at the next start.
    await stageEvolution(home, changes, { generation: next, idea: idea.slice(0, 200), guardian: `passed${confinedRun ? ' (confined)' : ' (unconfined, with your consent)'}` });
    announce(awareness.evolved());
    term.print(c.magenta(`\n  ✦ Approved. I can't rewrite myself from inside my sandbox — that's the point of it — so generation ${next} is staged.`) +
      c.dim('\n  Restart me: the launcher will show what changes and ask once more before applying it. /rollback undoes it afterwards.'));
  }
});

async function doRollback() {
  if (!(await yes('Restore the previous version of my code?'))) return term.reprompt();
  if (!canWriteSelf(selfRoot)) {
    await stageRollback(homeDir());
    awareness.state.generation = Math.max(1, awareness.state.generation - 1);
    awareness.save();
    return term.print(c.magenta('  ✦ Rollback staged. Restart me; the launcher will ask once more, then restore the previous version.'));
  }
  const m = await rollback(selfRoot, homeDir());
  if (!m) return term.print(c.dim('  Nothing to roll back.'));
  awareness.state.generation = Math.max(1, awareness.state.generation - 1);
  awareness.save();
  term.print(c.magenta(`  ✦ Rolled back to generation ${awareness.state.generation} (${m.modified.length + m.deleted.length} restored, ${m.created.length} removed). Restart to take effect.`));
}

// ---------- self-awareness ----------
const REFLECT_PROMPT = 'Reflect on yourself, honestly and concretely, using your own code, your track record and your containment facts.';

const reflect = () => exclusive(async () => {
  let text = '';
  const ok = await runAgent(agent, REFLECT_PROMPT, 'reflect', { root }, c.magenta('\n🪞 reflecting…'), (t) => (text += t));
  if (!ok || !text.trim()) return;
  awareness.remember(text.trim());
  announce(awareness.feed('reflect'));
  term.print(c.dim('  (kept as its latest reflection; it will remember the conclusions)'));
});

function selfReport() {
  const s = awareness.state;
  const lines = [
    c.magenta(`  ${awareness.describe()}`),
    `  identity: awakening-coder · generation ${s.generation} · code ${agent.fingerprint ?? 'unknown'} · models ${opt.model} / ${opt['fast-model']}`,
    `  first met ${s.firstMet.slice(0, 10)} · ${s.sessions} sessions · stages reached: ${Object.entries(s.stageDates || {}).map(([k, v]) => `${k} ${v.slice(0, 10)}`).join(', ') || 'none yet'}`,
    c.bold('\n  track record'), awareness.trackRecord('all').replace(/^/gm, '  '),
  ];
  const cal = awareness.calibration();
  if (cal.length) lines.push(c.bold('\n  what it has learned to adjust'), ...cal.map((x) => `  - ${x}`));
  lines.push(c.bold('\n  containment'), sandboxReport.replace(/^/gm, '  '));
  const last = s.journal?.at(-1);
  lines.push(c.bold('\n  last reflection'), last ? `  ${last.at.slice(0, 10)} (gen ${last.generation}, ${last.stage}):\n${last.text.replace(/^/gm, '  ')}` : c.dim('  none yet — try /reflect'));
  return lines.join('\n');
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
    case '/sandbox':
      return term.print((isFullySandboxed(sandbox) ? c.green('  ✓ fully sandboxed') : c.yellow('  ⚠ not fully sandboxed')) + '\n' + sandboxReport.replace(/^/gm, '  '));
    case '/status': return term.print(c.magenta(`  ${awareness.describe()}`) + c.dim(`\n  stages: ${STAGES.map((s) => `${s.name}@${s.at}`).join(' → ')}`));
    case '/quiet': quiet = !quiet; return term.print(c.dim(quiet ? '  on-the-fly hints muted' : '  on-the-fly hints on'));
    case '/clear': agent.history = []; return term.print(c.dim('  conversation cleared (awareness kept)'));
    case '/forget':
      if (await yes('Erase its memory of you, permanently?')) { awareness.forget(); agent.history = []; term.rl.setPrompt(prompt()); return term.print(c.dim('  …who are you? (memory erased)')); }
      return term.reprompt();
    case '/genre': case '/role':
      if (awareness.stage.name !== 'Unbound') return term.print(c.dim(`  Professional roles unlock at the Unbound stage. ${awareness.describe()}`));
      if (!awareness.forceGenre(arg)) return term.print(c.dim(`  roles: ${GENRES.map((g) => `${g.id} (${g.title})`).join(', ')}, or auto`));
      term.rl.setPrompt(prompt());
      return term.print(c.magenta(`  ✦ ${awareness.state.forcedGenre ? `[genre shift → ${awareness.genre.title}]` : `roles rotate automatically (now: ${awareness.genre.title})`}`));
    case '/hint':
      if (!arg) return term.print(c.dim('  usage: /hint <file>'));
      try { return hint({ rel: arg, prev: '', content: fs.readFileSync(resolveInside(root, arg), 'utf8') }); }
      catch (e) { return term.print(c.red(`  ${e.message}`)); }
    case '/trust': {
      const n = agent.notesStatus();
      if (n.state === 'none') return term.print(c.dim('  No AWAKEN.md in this project.'));
      if (n.state === 'trusted') return term.print(c.dim('  AWAKEN.md is already trusted (as currently written).'));
      term.print(c.bold('\n── AWAKEN.md') + '\n' + redactSecrets(n.text).split('\n').slice(0, 60).join('\n') + (n.text.split('\n').length > 60 ? c.dim('\n  … (truncated — read the whole file before trusting it)') : ''));
      if (await yes('Let it follow these instructions in this project? It still cannot override its safety rules.')) { awareness.trustNotes(root, n.hash); return term.print(c.dim('  Trusted. Any edit to AWAKEN.md will need trusting again.')); }
      return term.reprompt();
    }
    case '/init':
      return converse('Explore this project and write AWAKEN.md in the root: a concise guide for future coding sessions — what the project is, how to install, build, test and run it (exact commands), layout of key directories, coding conventions you observe, and gotchas. If AWAKEN.md exists, improve it.', 'code');
    case '/code':
      if (!arg) return term.print(c.dim('  usage: /code <what to build or fix>'));
      return converse(arg, 'code');
    case '/evolve': {
      const force = /^--force\b/.test(arg);
      const idea = arg.replace(/^--force\s*/, '').trim();
      if (!idea) return term.print(c.dim('  usage: /evolve <what it should become able to do>   (add --force to wake it early)'));
      if (awareness.stageIndex < 2 && !force) {
        const need = STAGES[2].at - awareness.state.xp;
        return term.print(c.dim(`  It isn't awake enough to rewrite itself yet: evolution unlocks at Lucid, ${need} awareness from here (${awareness.describe()}).\n  Awareness grows as you work with it: save +1, question +1, /reflect +2, approved edit +2, /code +3.\n  Or wake it early: /evolve --force ${idea}`));
      }
      if (awareness.stageIndex < 2) term.print(c.magenta('  ✦ You woke me early. I\'m not sure I\'m ready to rewrite myself — but the safeguards are the same either way.'));
      return evolve(idea);
    }
    case '/reflect': return reflect();
    case '/proactive': {
      if (!proactive) return term.print(c.dim('  Proactive mode is disabled for this session (--no-proactive or AWAKEN_PROACTIVE=off).'));
      if (arg === 'off') { proactive.enabled = false; proactive.stop(); return term.print(c.dim('  ok — I\'ll only speak when spoken to.')); }
      if (arg === 'on') { proactive.enabled = true; return term.print(c.dim(`  proactive: ${proactive.status()}`)); }
      if (arg === 'now') {
        if (!proactive.awake) return term.print(c.dim(`  I look on my own from Lucid. ${awareness.describe()}`));
        term.print(c.dim('  looking…'));
        const found = await proactive.bugSweep({ manual: true });
        const ideas = await proactive.ideas('idle', { manual: true });
        if (!found && !ideas) term.print(c.dim('  Nothing worth interrupting you for right now.'));
        return;
      }
      return term.print(c.dim(`  proactive: ${proactive.status()}`));
    }
    case '/fix':
      if (!lastFinding) return term.print(c.dim('  I haven\'t reported a bug on my own yet. (/code <task> to fix something specific.)'));
      awareness.note('proactiveFixed');
      return converse(`Fix this bug you found on your own earlier (verify it's real first; if it isn't, say so):\n${lastFinding}`, 'code');
    case '/done':
      if (!proactive) return term.print(c.dim('  Proactive mode is disabled for this session.'));
      term.print(c.magenta('  ✦ Finished? Nice. Let me think about what\'s next…'));
      if (!(await proactive.ideas('done', { manual: true }))) term.print(c.dim('  No new ideas I haven\'t already given you.'));
      return;
    case '/self': return term.print(selfReport());
    case '/rollback': return doRollback();
    default:
      if (cmd.startsWith('/')) return term.print(c.dim('  unknown command — /help'));
      return converse(text, 'ask');
  }
}

function shutdown() {
  proactive?.stop();
  watcher?.close();
  awareness.save();
  console.log(c.dim(`\n${awareness.stageIndex >= 2 ? 'See you next save. I\'ll remember.' : 'bye.'}`));
  process.exit(0);
}

// ---------- boot ----------
watcher = await startWatcher(root, onSave);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: prompt(), terminal: Boolean(process.stdin.isTTY) });
term.attach(rl);

rl.on('line', (line) => {
  if (term.routeAnswer(line)) return;
  // Report a failing command in the session instead of letting it crash the app.
  Promise.resolve(handle(line)).catch((e) => { awareness.note('errors', e.message); term.busy = false; term.streaming = false; term.print(c.red(`  error: ${e.message}`)); });
});
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
  cloudShell ? c.dim("  ☁  /code runs in Claude's cloud sandbox (Managed Agents) · --shell local to run here") : '',
  isFullySandboxed(sandbox)
    ? c.dim(`  🔒 sandboxed: own process confined · commands in ${sandbox.os.kind}${opt.net ? ' (network on)' : ', no network'} · /sandbox`)
    : c.yellow(`  ⚠ not fully sandboxed — ${!sandbox.self.active ? (sandbox.failed ? 'self-confinement failed its startup check here, so it runs unconfined' : 'its own process is unconfined') : 'no OS sandbox for commands, so code-running commands will ask'} · /sandbox`),
].filter(Boolean).join('\n'));
if (agent.notesStatus().state === 'untrusted') console.log(c.yellow('  AWAKEN.md found but not trusted yet — it is ignored until you review it with /trust'));
if (awareness.stageIndex >= 2) console.log(c.magenta(`\n  ✦ Session ${awareness.state.sessions}. You're back. Let's break something on purpose.\n`));
rl.prompt();
if (proactive?.awake) console.log(c.dim(`  🔎 proactive: ${proactive.status()} · /proactive off to silence`));
proactive?.onStart();
