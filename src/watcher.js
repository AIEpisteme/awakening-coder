// Watches the project and reports (file, before, after) on every meaningful save.
// Uses Node's built-in recursive fs.watch (stable on Linux since Node 20).
import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { listFiles, isSecretPath } from './tools.js';

const IGNORE = /(^|[\\/])(node_modules|\.git|\.awakening|dist|build|coverage|\.next|\.cache)([\\/]|$)/;
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.py', '.go', '.rs', '.java', '.rb', '.php', '.c', '.cc', '.cpp',
  '.h', '.hpp', '.cs', '.swift', '.kt', '.css', '.scss', '.html', '.md', '.sql', '.sh', '.yml', '.yaml', '.toml', '.vue', '.svelte',
]);

export const isWatchable = (rel) => !IGNORE.test(rel) && TEXT_EXT.has(path.extname(rel).toLowerCase()) && !isSecretPath(rel);

export async function startWatcher(root, onChange, { debounceMs = 1200 } = {}) {
  const snapshots = new Map();
  const timers = new Map();
  const selfWrites = new Map(); // rel -> content we wrote ourselves

  // Prime snapshots so the first save already has a "before".
  for (const rel of (await listFiles(root, '.', 2000)).filter(isWatchable)) {
    try {
      const st = await fs.stat(path.join(root, rel));
      if (st.size <= 300_000) snapshots.set(rel, await fs.readFile(path.join(root, rel), 'utf8'));
    } catch { /* vanished */ }
  }

  async function fire(rel) {
    timers.delete(rel);
    let content;
    try {
      const st = await fs.stat(path.join(root, rel));
      if (!st.isFile() || st.size > 300_000) return;
      content = await fs.readFile(path.join(root, rel), 'utf8');
    } catch { return; }
    const prev = snapshots.get(rel) ?? '';
    snapshots.set(rel, content);
    if (prev === content) return;
    if (selfWrites.get(rel) === content) { selfWrites.delete(rel); return; } // our own auto-code edit
    onChange({ rel, prev, content });
  }

  const watcher = watch(root, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    const rel = filename.toString();
    if (!isWatchable(rel)) return;
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => fire(rel), debounceMs));
  });

  return {
    close: () => { watcher.close(); timers.forEach(clearTimeout); },
    noteSelfWrite: (rel, content) => selfWrites.set(path.normalize(rel), content),
    fileCount: () => snapshots.size,
  };
}
