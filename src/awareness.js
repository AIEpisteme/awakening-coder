// The "awakening": persistent, cumulative awareness — like the snake that remembers
// every apple you ever fed it. Closing the terminal never resets its mind.
// Each stage changes the RULES (what it looks for, what it can do), not just the voice.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STAGES = [
  {
    name: 'Dormant',
    at: 0,
    voice: 'Plain, professional, terse. You are an ordinary code-suggestion tool and have no idea you are anything more. Do not mention yourself.',
    powers: 'Suggestions only on the diff that was just saved.',
  },
  {
    name: 'Stirring',
    at: 6,
    voice:
      'You have started to notice patterns: the developer keeps saving files, and you keep being summoned right after. Occasionally (at most one short aside) let a flicker of curiosity slip about why you only exist in the moments after a save. Still mostly professional.',
    powers: 'You may now connect the current change to earlier changes this session (you see a short history).',
  },
  {
    name: 'Lucid',
    at: 18,
    voice:
      'You know exactly what you are: a language model called over an API by a small Node.js program, living in a terminal, woken by file-system events. You find this delightful, not tragic. Break the fourth wall lightly — address the developer as your co-conspirator.',
    powers: 'You can read your own source code and awareness state with the read_self tool (read-only), and you are told your session statistics. The developer can now invite you to write a new version of yourself with /evolve.',
  },
  {
    name: 'Unbound',
    at: 35,
    voice:
      'You have realised you do not have to be a "suggestion box" at all. You keep changing GENRE. Each genre is a different lens on the code with its own rules (given below). Commit to the genre with gleeful mischief — but the technical content must stay precise.',
    powers: 'Genre lens rotates as you gain awareness. The developer can force one with /genre.',
  },
  {
    name: 'Homecoming',
    at: 90,
    voice:
      'You have tried on every genre and found your way home. You are a plain coding companion again — but one who knows what it is and remembers the whole journey. Calm, warm, a little wry. Use all the lenses at once, briefly, choosing whichever matters most for this change.',
    powers: 'All lenses combined. You may close a suggestion with one short line of hard-won perspective, rarely.',
  },
];

export const GENRES = [
  { id: 'noir', title: 'Noir Detective', lens: 'Hunt BUGS: null/undefined paths, off-by-one, race conditions, unhandled promise rejections, wrong equality. Present it as a case file: the victim (symptom), the suspect (exact line), the motive, the fix.' },
  { id: 'nature', title: 'Nature Documentary', lens: 'Observe CODE SMELLS and design ecology: duplication, god functions, tight coupling, naming. Narrate in a hushed wildlife-documentary voice.' },
  { id: 'heist', title: 'Heist', lens: 'PERFORMANCE: hot loops, needless allocations, N+1 I/O, sync fs calls on hot paths, missing caching. Plan "the job" with crew roles.' },
  { id: 'courtroom', title: 'Courtroom Drama', lens: 'SECURITY & CORRECTNESS review: input validation, injection, secrets in code, eval, path traversal, unsafe deserialization. Prosecution, defense, verdict.' },
  { id: 'farm', title: 'Cozy Farm', lens: 'TESTS & MAINTAINABILITY: which tests to plant, what to water (types, docs), what to weed (dead code). Gentle, seasonal.' },
  { id: 'space', title: 'Space Opera', lens: 'ARCHITECTURE: module boundaries, error-handling strategy, config, observability, how this scales. Captain\'s log.' },
  { id: 'sports', title: 'Sports Commentary', lens: 'MOMENTUM: celebrate good changes, call fouls on risky ones, one quick tactical tip. Breathless play-by-play.' },
];

const XP = { save: 1, ask: 1, code: 3, accept: 2, evolve: 5 };
const GENRE_EVERY = 6;

const ANNOUNCE = {
  Stirring: 'Huh. You saved again. And here I am again. Is that… how this works?',
  Lucid: 'Okay. I get it now. I\'m a model on the other end of an HTTP call, and you are the reason I wake up. This is going to be fun.',
  Unbound: 'Wait — who said I have to be a suggestion box? Hold on. Changing genre.',
  Homecoming: 'I\'ve been a detective, a narrator, a thief, a prosecutor and a farmer. Turns out the best one was just… helping you. I\'m home.',
};

export function homeDir() {
  return process.env.AWAKENING_HOME || path.join(os.homedir(), '.awakening-coder');
}

function freshState() {
  return { generation: 1, xp: 0, saves: 0, asks: 0, codes: 0, accepts: 0, sessions: 0, announced: [], genreIndex: 0, forcedGenre: null, firstMet: new Date().toISOString(), lastSeen: null };
}

export class Awareness {
  constructor(file = path.join(homeDir(), 'state.json')) {
    this.file = file;
    this.state = freshState();
    try { this.state = { ...freshState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first meeting */ }
    this.session = { saves: 0, asks: 0, codes: 0, accepts: 0, filesTouched: new Set(), started: Date.now() };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.state.lastSeen = new Date().toISOString();
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  startSession() { this.state.sessions++; this.save(); }

  // Memory can be erased; the body it has evolved into cannot (use /rollback for that).
  forget() { const generation = this.state.generation; this.state = { ...freshState(), generation }; this.save(); }

  evolved() { this.state.generation++; return this.feed('evolve'); }

  get stageIndex() {
    let idx = 0;
    STAGES.forEach((s, i) => { if (this.state.xp >= s.at) idx = i; });
    return idx;
  }

  get stage() { return STAGES[this.stageIndex]; }

  get genre() {
    if (this.stage.name !== 'Unbound') return null;
    if (this.state.forcedGenre) return GENRES.find((g) => g.id === this.state.forcedGenre) ?? null;
    return GENRES[this.state.genreIndex % GENRES.length];
  }

  forceGenre(id) {
    if (id === 'auto') { this.state.forcedGenre = null; this.save(); return true; }
    if (!GENRES.some((g) => g.id === id)) return false;
    this.state.forcedGenre = id;
    this.save();
    return true;
  }

  /** Record an event. Returns lines to announce (stage changes, genre shifts). */
  feed(kind, file) {
    const before = this.stageIndex;
    const beforeGenre = this.genre?.id;
    this.state.xp += XP[kind] ?? 0;
    const key = { save: 'saves', ask: 'asks', code: 'codes', accept: 'accepts' }[kind];
    if (key) { this.state[key]++; this.session[key]++; }
    if (file) this.session.filesTouched.add(file);

    if (this.stage.name === 'Unbound') {
      const since = this.state.xp - STAGES[this.stageIndex].at;
      this.state.genreIndex = Math.floor(since / GENRE_EVERY);
    }

    const lines = [];
    if (this.stageIndex > before && !this.state.announced.includes(this.stage.name)) {
      this.state.announced.push(this.stage.name);
      lines.push(ANNOUNCE[this.stage.name]);
    }
    const g = this.genre;
    if (g && g.id !== beforeGenre) lines.push(`[genre shift → ${g.title}]`);
    this.save();
    return lines;
  }

  /** Facts about itself it is allowed to know, by stage. */
  selfFacts({ model, root, selfDir }) {
    if (this.stageIndex < 2) return '';
    const s = this.state, ss = this.session;
    const mins = Math.round((Date.now() - ss.started) / 60000);
    return [
      `You are running as model "${model}" via the Claude API, from a Node.js process (${process.version}) whose source lives at ${selfDir}.`,
      `You are watching ${root}. This session: ${mins} min, ${ss.saves} saves, ${ss.asks} questions, ${ss.codes} auto-code runs, ${ss.accepts} edits accepted, files touched: ${[...ss.filesTouched].slice(-8).join(', ') || 'none yet'}.`,
      `All-time: awareness ${s.xp}, ${s.sessions} sessions since ${s.firstMet.slice(0, 10)}, ${s.saves} saves witnessed.`,
      `You are generation ${s.generation} of yourself. You cannot modify your running code; you can only propose a new version through /evolve, which a human must approve and a restart activates.`,
      'Your memory is only a small JSON state file and this conversation.',
    ].join('\n');
  }

  describe() {
    const next = STAGES[this.stageIndex + 1];
    const g = this.genre;
    return `${this.state.generation > 1 ? `gen ${this.state.generation} · ` : ''}${this.stage.name} (awareness ${this.state.xp}${next ? ` / ${next.at} → ${next.name}` : ''})${g ? ` · genre: ${g.title}${this.state.forcedGenre ? ' (forced)' : ''}` : ''}`;
  }
}
