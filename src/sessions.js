// Session memory: conversations are saved per project, so a restart doesn't lose them.
//
// What is saved is exactly what the model would be sent again: the message history, already bounded by the
// agent (it keeps the last 30 messages) and with secrets redacted. Files live in the coder's own state folder
// (~/.awakening-coder/sessions/<project hash>/), private to the user, never inside the project.
// A saved chat is only ever loaded back if it is still a well-formed conversation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { redactSecrets } from './security.js';

export const MAX_CHATS = 20; // per project; the oldest are dropped
const MAX_BYTES = 2_000_000; // per saved chat
const ID = /^[a-z0-9]{6,14}-[a-f0-9]{6}$/;

const redactDeep = (v) => (typeof v === 'string' ? redactSecrets(v)
  : Array.isArray(v) ? v.map(redactDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]))
  : v);

const isPlainUser = (m) => m?.role === 'user' && typeof m.content === 'string';
const toolUses = (m) => (Array.isArray(m?.content) ? m.content.filter((b) => b?.type === 'tool_use') : []);

/**
 * A history the API will accept again: user/assistant messages, starting at a plain user turn, ending on an
 * assistant turn, with every tool call answered by the message after it. Returns a cleaned copy, or null.
 */
export function validHistory(history) {
  if (!Array.isArray(history)) return null;
  const h = history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && (typeof m.content === 'string' || Array.isArray(m.content)));
  if (h.length !== history.length) return null;
  let end = h.length; // drop a trailing question with no answer, or a tool call that never got its result
  while (end > 0 && (h[end - 1].role !== 'assistant' || toolUses(h[end - 1]).length)) end--;
  const out = h.slice(0, end);
  if (!out.length || !isPlainUser(out[0])) return null;
  for (let i = 0; i < out.length; i++) {
    const uses = toolUses(out[i]);
    if (out[i].role === 'assistant' && uses.length) {
      const next = out[i + 1];
      const answered = new Set((Array.isArray(next?.content) ? next.content : []).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id));
      if (next?.role !== 'user' || !uses.every((u) => answered.has(u.id))) return null;
    }
    if (out[i].role === 'user' && Array.isArray(out[i].content) && out[i].content.some((b) => b?.type === 'tool_result') && toolUses(out[i - 1]).length === 0) return null;
  }
  return out;
}

/** Drop the oldest exchanges (cutting only at a plain user turn) until the chat fits in `maxBytes`. */
export function fitHistory(history, maxBytes = MAX_BYTES) {
  let h = history;
  while (h.length > 2 && Buffer.byteLength(JSON.stringify(h)) > maxBytes) {
    let cut = 1;
    while (cut < h.length && !isPlainUser(h[cut])) cut++;
    if (cut >= h.length) break;
    h = h.slice(cut);
  }
  return h;
}

const brief = (input = {}) => Object.entries(input).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v)}`).join(', ');

/** What a person would see of a history: [{ role: 'you' | 'coder' | 'tool', text }]. */
export function displayOf(history = []) {
  const out = [];
  for (const m of history) {
    if (m.role === 'user') { if (typeof m.content === 'string') out.push({ role: 'you', text: m.content }); continue; }
    if (typeof m.content === 'string') { out.push({ role: 'coder', text: m.content }); continue; }
    for (const b of m.content ?? []) {
      if (b?.type === 'text' && b.text?.trim()) out.push({ role: 'coder', text: b.text });
      else if (b?.type === 'tool_use') out.push({ role: 'tool', text: `↳ ${b.name}(${brief(b.input)})` });
    }
  }
  return out;
}

export function titleOf(history = []) {
  const first = history.find(isPlainUser)?.content ?? '';
  const line = redactSecrets(first).replace(/\s+/g, ' ').trim();
  return line ? (line.length > 60 ? `${line.slice(0, 59)}…` : line) : 'Untitled chat';
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", or the date. */
export function ago(iso, now = Date.now()) {
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  if (min < 30 * 24 * 60) return `${Math.floor(min / 1440)} days ago`;
  return String(iso).slice(0, 10);
}

export class SessionStore {
  /** dir: where chats are kept (null disables saving: every method becomes a no-op). */
  constructor(dir, { now = () => new Date() } = {}) {
    this.dir = dir;
    this.now = now;
  }

  #projectDir(root) { return path.join(this.dir, createHash('sha256').update(path.resolve(String(root))).digest('hex').slice(0, 16)); }
  #file(root, id) { return path.join(this.#projectDir(root), `${id}.json`); }

  #read(root, id) {
    if (!this.dir || !ID.test(String(id))) return null; // ids come from the browser: never let one become a path
    try {
      const d = JSON.parse(fs.readFileSync(this.#file(root, id), 'utf8'));
      return d && d.id === id ? d : null;
    } catch { return null; }
  }

  // A small index per project, so listing chats never has to parse every saved conversation.
  #indexFile(root) { return path.join(this.#projectDir(root), 'index.json'); }
  #meta(d) { return { title: String(d.title ?? 'Untitled chat'), createdAt: d.createdAt, updatedAt: d.updatedAt, messages: displayOf(d.history).filter((e) => e.role !== 'tool').length }; }
  #index(root) {
    try {
      const idx = JSON.parse(fs.readFileSync(this.#indexFile(root), 'utf8'));
      if (idx && typeof idx === 'object' && !Array.isArray(idx)) return idx;
    } catch { /* missing or damaged: rebuild from the chat files */ }
    const idx = {};
    let names = [];
    try { names = fs.readdirSync(this.#projectDir(root)); } catch { return idx; }
    for (const n of names) {
      const id = n.replace(/\.json$/, '');
      if (!n.endsWith('.json') || !ID.test(id)) continue;
      const d = this.#read(root, id);
      if (d && Array.isArray(d.history)) idx[id] = this.#meta(d);
    }
    this.#writeIndex(root, idx);
    return idx;
  }
  #writeIndex(root, idx) { try { fs.writeFileSync(this.#indexFile(root), JSON.stringify(idx), { mode: 0o600 }); } catch { /* rebuilt next time */ } }

  /** Saved chats for a project, newest first: [{ id, title, createdAt, updatedAt, messages }]. */
  list(root) {
    if (!this.dir) return [];
    return Object.entries(this.#index(root))
      .filter(([id]) => ID.test(id) && fs.existsSync(this.#file(root, id)))
      .map(([id, m]) => ({ id, title: String(m.title ?? 'Untitled chat'), createdAt: m.createdAt, updatedAt: m.updatedAt, messages: Number(m.messages) || 0 }))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  /** { id, title, createdAt, updatedAt, model, history } — or null if missing or no longer a valid conversation. */
  load(root, id) {
    const d = this.#read(root, id);
    const history = d ? validHistory(d.history) : null;
    return history ? { id: d.id, title: String(d.title ?? 'Untitled chat'), createdAt: d.createdAt, updatedAt: d.updatedAt, model: d.model ?? null, history } : null;
  }

  /**
   * Save a conversation (creating it if `id` is not given). Returns { id, title, createdAt, updatedAt }, or
   * null when there is nothing worth saving or saving failed. Saving is best effort: it never throws.
   */
  save(root, { id, createdAt, model, history }) {
    if (!this.dir) return null;
    const clean = validHistory(redactDeep(history ?? []));
    if (!clean) return null;
    const at = this.now().toISOString();
    const chat = { id: ID.test(String(id)) ? id : `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, title: titleOf(clean), createdAt: createdAt ?? at, updatedAt: at, model: model ?? null, history: fitHistory(clean) };
    try {
      const dir = this.#projectDir(root);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = this.#file(root, chat.id), tmp = `${file}.${randomBytes(3).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(chat), { mode: 0o600 });
      fs.renameSync(tmp, file); // whole file or nothing
      this.#writeIndex(root, { ...this.#index(root), [chat.id]: this.#meta(chat) });
      for (const old of this.list(root).slice(MAX_CHATS)) this.remove(root, old.id);
    } catch { return null; }
    return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt };
  }

  remove(root, id) {
    if (!this.dir || !ID.test(String(id))) return false;
    try { fs.rmSync(this.#file(root, id)); } catch { return false; }
    const idx = this.#index(root);
    delete idx[id];
    this.#writeIndex(root, idx);
    return true;
  }

  /** Forget every saved chat for one project, or for all projects when root is omitted. */
  clear(root) {
    if (!this.dir) return;
    try { fs.rmSync(root === undefined ? this.dir : this.#projectDir(root), { recursive: true, force: true }); } catch { /* nothing to forget */ }
  }
}
