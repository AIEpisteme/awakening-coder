// How often it asks before acting.
//
// Asking about everything trains people to click "yes" without reading, so the default ("smart") asks
// less and makes each question count:
//   - Commands that run inside the OS sandbox (project-only writes, no network) just run: the sandbox is
//     the protection, and a prompt would add nothing.
//   - Edits ask once per task: approve one, or approve all edits for the rest of that task. Every diff is
//     still shown, and /undo puts a task's edits back.
//   - What is truly risky always asks, in every mode: destructive or outward commands, files that control
//     what runs later (package.json, hooks, CI, AWAKEN.md…), and code-running commands when nothing
//     sandboxes them.
import fs from 'node:fs';
import path from 'node:path';
import { classifyCommand } from './security.js';

export const APPROVAL_MODES = [
  { id: 'careful', label: 'Ask every time', note: 'every edit, and every command that runs code', aliases: ['ask', 'always', 'strict'] },
  { id: 'smart', label: 'Smart', note: 'one approval per task for edits; sandboxed commands just run', aliases: ['balanced', 'default'] },
  { id: 'auto', label: 'Auto', note: 'ordinary edits and commands go ahead without asking', aliases: ['yes', 'on'] },
];

export const DEFAULT_APPROVALS = 'smart';

/** 'Smart' | 'ask' | 'auto' → 'smart' | 'careful' | 'auto' (null if unknown). */
export function resolveApprovals(v) {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!s) return null;
  return APPROVAL_MODES.find((m) => m.id === s || m.label.toLowerCase().replace(/\s+/g, '-') === s || m.aliases.includes(s))?.id ?? null;
}

export const approvalsLabel = (id) => APPROVAL_MODES.find((m) => m.id === id)?.label ?? id;

/** What the sandbox on this machine does for commands: { isolated, sealed }. Sealed = isolated with no open network. */
export function sandboxFacts(shell = {}) {
  const os = shell.os ?? null;
  const net = typeof shell.allowNet === 'function' ? shell.allowNet() : shell.allowNet;
  return { isolated: Boolean(os), sealed: Boolean(os) && (os.kind === 'sbx' || !net) };
}

/**
 * One paragraph on what a mode will and won't ask about on this machine.
 * unsandboxedOk: in Auto, commands may run even where nothing sandboxes them (the web app's Auto; --allow-unsandboxed).
 */
export function describeApprovals(mode, { isolated = false, sealed = isolated, unsandboxedOk = false } = {}) {
  const always = 'Always asks: destructive or outward commands, and files that control what runs later (package.json, hooks, CI, AWAKEN.md).';
  if (mode === 'auto') {
    const cmds = isolated ? 'Edits and ordinary commands go ahead without asking; commands run in the sandbox.'
      : unsandboxedOk ? 'Edits and ordinary commands go ahead without asking, and commands run directly on this computer, because nothing sandboxes them here.'
      : 'Edits go ahead without asking. Commands that run code still ask, because nothing sandboxes them here.';
    return `Auto: ${cmds} ${always}`;
  }
  if (mode === 'careful') return `Ask every time: every edit and every command that runs code waits for you. ${always}`;
  const cmds = sealed ? 'Commands just run, because the sandbox contains them.'
    : isolated ? 'Commands ask, because the sandbox has network access here.'
    : 'Commands that run code ask, because nothing sandboxes them here; you can always-allow one for this project.';
  return `Smart: edits ask once per task (approve one, or all for that task). ${cmds} ${always}`;
}

/**
 * Commands the developer chose to always allow in a project, by exact text. Kept in the coder's own state
 * folder (outside every project, so project code and sandboxed commands can't add to it).
 * A dangerous command can never be put on the list, and the list is ignored for one that has become dangerous.
 */
export class AllowList {
  constructor(file) {
    this.file = file;
    this.data = {};
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && typeof d === 'object' && !Array.isArray(d)) this.data = d; } catch { /* none yet */ }
  }

  #key(root) { return path.resolve(String(root)); }
  #save() {
    if (!this.file) return; // no state folder: grants last for this session only
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 }); } catch { /* best effort: it will simply ask again */ }
  }

  list(root) { const l = this.data[this.#key(root)]; return Array.isArray(l) ? l.filter((c) => typeof c === 'string') : []; }

  has(root, cmd) {
    const c = String(cmd).trim();
    return classifyCommand(c) !== 'danger' && this.list(root).includes(c);
  }

  /** Returns false (and stores nothing) for a dangerous or empty command. */
  add(root, cmd) {
    const c = String(cmd).trim();
    if (!c || c.length > 500 || classifyCommand(c) === 'danger') return false;
    const l = this.list(root);
    if (!l.includes(c)) { this.data[this.#key(root)] = [...l, c].slice(-100); this.#save(); }
    return true;
  }

  /** Remove one command (by text or 1-based number), or all of them when `which` is omitted. Returns how many. */
  remove(root, which) {
    const l = this.list(root);
    const keep = which === undefined ? [] : l.filter((c, i) => c !== which && String(i + 1) !== String(which));
    if (keep.length === l.length) return 0;
    if (keep.length) this.data[this.#key(root)] = keep; else delete this.data[this.#key(root)];
    this.#save();
    return l.length - keep.length;
  }
}
