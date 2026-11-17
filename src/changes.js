// What changed on disk, and putting it back.
//
//  - snapshotTree / diffTree / restoreFile: taken around every command that can change files. Commands may
//    run without a prompt (inside the sandbox), so afterwards the program itself checks the files that
//    control what runs later (package.json, hooks, CI, AWAKEN.md…). A change to one of those is shown as a
//    diff and needs a human to keep it; otherwise it is put back. The sandbox limits where a command can
//    write; this limits what an unattended command can leave behind for the host to run.
//  - EditJournal: the edits the coder made through its file tools in one task, so /undo can put them back.
import fs from 'node:fs/promises';
import path from 'node:path';
import { isHighRiskWrite } from './security.js';

const SKIP = new Set(['node_modules', '.git', '.awakening', 'dist', 'build', 'coverage', '.next', '.cache']);
const MAX_FILES = 20_000;
const MAX_KEEP = 1_000_000; // bytes of a high-risk file kept in memory so it can be restored

/** rel → { mtimeMs, size } for files; high-risk files also carry `content` (Buffer) and symlinks carry `link`. */
export async function snapshotTree(root) {
  const files = new Map();
  let capped = false;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.size >= MAX_FILES) { capped = true; return; }
      if (SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name), rel = path.relative(root, abs);
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      const entry = {};
      try {
        if (e.isSymbolicLink()) entry.link = await fs.readlink(abs);
        else { const st = await fs.stat(abs); entry.mtimeMs = st.mtimeMs; entry.size = st.size; }
        if (isHighRiskWrite(rel)) {
          entry.risky = true;
          if (!e.isSymbolicLink()) entry.content = entry.size <= MAX_KEEP ? await fs.readFile(abs) : null;
        }
      } catch { continue; } // vanished mid-walk
      files.set(rel, entry);
    }
  }
  await walk(root);
  return { files, capped };
}

function same(a, b) {
  if (a.link !== undefined || b.link !== undefined) return a.link === b.link;
  if (a.content && b.content) return a.content.equals(b.content);
  return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** { changed: [rel…], risky: [{ rel, before, after }] } — `risky` are changes to files that control what runs later. */
export function diffTree(before, after) {
  const changed = [], risky = [];
  for (const [rel, a] of after.files) {
    const b = before.files.get(rel);
    if (b && same(b, a)) continue;
    changed.push(rel);
    if (a.risky || b?.risky) risky.push({ rel, before: b ?? null, after: a });
  }
  for (const [rel, b] of before.files) {
    if (after.files.has(rel)) continue;
    changed.push(rel);
    if (b.risky) risky.push({ rel, before: b, after: null });
  }
  return { changed: changed.sort(), risky: risky.sort((x, y) => (x.rel < y.rel ? -1 : 1)) };
}

export const textOf = (entry) => (!entry ? '' : entry.link !== undefined ? `(symlink → ${entry.link})\n` : entry.content ? entry.content.toString('utf8') : '');

/** Put one file back to its snapshot state. Returns 'removed' | 'restored', or throws with the reason. */
export async function restoreFile(root, { rel, before }) {
  const abs = path.join(root, rel);
  await fs.rm(abs, { force: true, recursive: true });
  if (!before) return 'removed';
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (before.link !== undefined) { await fs.symlink(before.link, abs); return 'restored'; }
  if (!before.content) throw new Error('it was too large to keep a copy of');
  await fs.writeFile(abs, before.content);
  return 'restored';
}

/** The file-tool edits of one task. */
export class EditJournal {
  constructor() { this.entries = []; }

  /** before: the previous text, or null when the file did not exist. */
  record(rel, abs, before, after) { this.entries.push({ rel, abs, before, after }); }

  get files() { return [...new Set(this.entries.map((e) => e.rel))]; }

  /**
   * Put every edited file back to how it was before this task. A file that has changed since the coder
   * last wrote it (you kept working on it) is left alone and reported in `skipped`.
   */
  async undo({ onWrite } = {}) {
    const byFile = new Map();
    for (const e of this.entries) { const f = byFile.get(e.abs) ?? { rel: e.rel, abs: e.abs, original: e.before }; f.last = e.after; byFile.set(e.abs, f); }
    const out = { restored: [], removed: [], skipped: [] };
    for (const f of byFile.values()) {
      const now = await fs.readFile(f.abs, 'utf8').catch(() => null);
      if (now !== f.last) { out.skipped.push(f.rel); continue; }
      if (f.original === null) { await fs.rm(f.abs, { force: true }); out.removed.push(f.rel); }
      else { onWrite?.(f.rel, f.original); await fs.writeFile(f.abs, f.original); out.restored.push(f.rel); }
    }
    this.entries = [];
    return out;
  }
}
