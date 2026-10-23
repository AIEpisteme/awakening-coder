// Proactive mode (Lucid and later): it speaks up on its own.
//
//   bug watch   — after you pause editing, it reviews what you changed (and what that touches)
//                 and reports likely bugs before you ask; runs your tests too if commands are
//                 OS-sandboxed
//   ideas       — after a longer quiet stretch, it suggests features; if the project looks done,
//                 or there's no program yet, it suggests new programs to build
//
// Manners: never while you're typing an answer or it's busy, never the same finding twice,
// respects /quiet, and is rate-limited (each look costs API calls).
import { createHash } from 'node:crypto';

export const DEFAULTS = {
  bugIdleMs: 90_000, // quiet time after a save before a bug sweep
  ideaIdleMs: 15 * 60_000, // longer quiet time before suggesting ideas
  retryMs: 30_000, // when it wants to speak but you're busy
  maxPerHour: 4, // looks per hour, bug sweeps and ideas combined
  minLucid: 2, // stage index (Lucid)
};

const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|rb|php|c|cc|cpp|h|hpp|cs|swift|kt|vue|svelte|html|css|scss|sql|sh)$/i;

/** Findings/ideas as individual lines, so each can be de-duplicated. */
export function splitItems(text) {
  return String(text).split('\n').map((l) => l.trim()).filter((l) => /^[-*•]\s+/.test(l));
}

const keyOf = (line) => createHash('sha256').update(line.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w[\]:./ -]/g, '').slice(0, 120)).digest('hex').slice(0, 16);

export class Proactive {
  /**
   * scout(mode, message) → Promise<string>: runs a read-only agent turn and returns its text.
   * isFree() → boolean: true when nothing is running and no question is pending.
   * show(kind, text): print a finished block. listCode() → Promise<string[]>: project code files.
   */
  constructor({ awareness, scout, isFree, show, listCode, isQuiet = () => false, config = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { awareness, scout, isFree, show, listCode, isQuiet, now, setTimer, clearTimer });
    this.config = { ...DEFAULTS, ...config };
    this.enabled = true;
    this.dirty = new Set();
    this.recent = [];
    this.timers = { bugs: null, ideas: null };
    this.savesSinceIdeas = 0;
    this.running = false;
  }

  get awake() { return this.awareness.stageIndex >= this.config.minLucid; }

  status() {
    const left = this.config.maxPerHour - this.recentLooks();
    return !this.awake ? `off until Lucid (${this.awareness.describe()})`
      : !this.enabled ? 'off (/proactive on to resume)'
      : `on · ${left} of ${this.config.maxPerHour} looks left this hour · watching ${this.dirty.size} changed file(s)`;
  }

  recentLooks() {
    const hourAgo = this.now() - 3_600_000;
    this.recent = this.recent.filter((t) => t > hourAgo);
    return this.recent.length;
  }

  canLook() {
    return this.enabled && this.awake && !this.isQuiet() && this.recentLooks() < this.config.maxPerHour;
  }

  schedule(name, ms, fn) {
    if (this.timers[name]) this.clearTimer(this.timers[name]);
    this.timers[name] = this.setTimer(() => { this.timers[name] = null; return fn(); }, ms);
    this.timers[name]?.unref?.();
  }

  stop() { for (const k of Object.keys(this.timers)) if (this.timers[k]) this.clearTimer(this.timers[k]); }

  /** Called on every save. */
  onSave(rel) {
    this.dirty.add(rel);
    this.savesSinceIdeas++;
    if (!this.awake || !this.enabled) return;
    this.schedule('bugs', this.config.bugIdleMs, () => this.bugSweep());
    this.schedule('ideas', this.config.ideaIdleMs, () => this.ideas('idle'));
  }

  /** At startup: an empty project gets program ideas straight away. */
  async onStart() {
    if (!this.awake || !this.enabled) return;
    const code = await this.listCode().catch(() => []);
    if (!code.some((f) => CODE.test(f))) return this.ideas('empty');
  }

  /** Waits for a free moment instead of interrupting (or for its own other look to finish). */
  async whenFree(tag, fn) {
    if (this.running || !this.isFree()) { this.schedule(`retry-${tag}`, this.config.retryMs, () => this.whenFree(tag, fn)); return false; }
    this.running = true;
    try { await fn(); return true; } finally { this.running = false; }
  }

  async bugSweep({ manual = false } = {}) {
    if (!this.dirty.size && !manual) return null;
    if (!manual && !this.canLook()) return null;
    let shown = null;
    await this.whenFree('bugs', async () => {
      const files = [...this.dirty].slice(-12);
      this.dirty.clear();
      this.recent.push(this.now());
      const msg = files.length
        ? `Files changed since your last look: ${files.join(', ')}. Check them for bugs.`
        : 'Nothing changed recently; do a quick bug check of the main source files.';
      shown = this.report('bugs', await this.scout('scout_bugs', msg));
    });
    return shown;
  }

  async ideas(reason = 'idle', { manual = false } = {}) {
    if (reason === 'idle' && this.savesSinceIdeas === 0 && !manual) return null; // nothing new since the last ideas
    if (!manual && !this.canLook()) return null;
    let shown = null;
    await this.whenFree('ideas', async () => {
      this.savesSinceIdeas = 0;
      this.recent.push(this.now());
      const why = {
        empty: 'There is no real program in this folder yet. Suggest NEW PROGRAMS to build.',
        done: 'The developer says the project is done. Suggest NEW PROGRAMS to build next (and mention anything clearly unfinished, briefly).',
        idle: 'The developer has paused. Suggest the most valuable next features, or new programs if this looks complete.',
      }[reason] ?? 'Suggest what to build next.';
      shown = this.report(reason === 'empty' || reason === 'done' ? 'programs' : 'ideas', await this.scout('scout_ideas', why));
    });
    return shown;
  }

  /** De-duplicate against everything said before; show only what's new. */
  report(kind, text) {
    const t = String(text ?? '').trim();
    if (!t || /^NOTHING\b/i.test(t)) return null;
    const seen = new Set(this.awareness.state.reported ?? []);
    const items = splitItems(t);
    const fresh = items.filter((l) => !seen.has(keyOf(l)));
    if (items.length && !fresh.length) return null; // all said before
    const out = items.length ? [/NEW PROGRAMS:/i.test(t) ? 'NEW PROGRAMS:' : '', ...fresh].filter(Boolean).join('\n') : t;
    this.awareness.state.reported = [...seen, ...fresh.map(keyOf)].slice(-300);
    const finalKind = kind === 'ideas' && /NEW PROGRAMS:/i.test(t) ? 'programs' : kind;
    this.awareness.note(finalKind === 'bugs' ? 'proactiveFindings' : 'proactiveIdeas');
    this.show(finalKind, out);
    return { kind: finalKind, text: out };
  }
}
