// The proof log: a record of the bugs it reported on its own, and what the developer did about each.
//
// The program writes this, not the model: a report is logged when the proactive scout shows it, and its
// outcome changes only when the developer acts (Fix it, Not a bug) or a fix run actually edits files.
// The log lives in the coder's state folder. Nothing is published unless the developer turns that on for
// a project (/proof on); then PROOF.md in that project is rewritten after every change, ready to commit.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { redactSecrets } from './security.js';

export const PROOF_FILE = 'PROOF.md';
const MARKER = '<!-- awakening-coder proof log: generated file, rewritten after every report. Do not edit by hand. -->';
const STATUSES = ['open', 'accepted', 'fixed', 'dismissed'];
const OUTCOME = { open: 'no response yet', accepted: 'fix requested', fixed: 'fixed', dismissed: 'dismissed' };
const ITEM = /^[-*•]\s+(?:\[([^\]\n]{1,200})\]\s*)?(?:\((critical|high|medium|low)\)\s*)?(.+)$/i;

/** "- [src/a.js:12] (high) what — why — fix" → { where, severity, what }. Free text becomes one finding. */
export function parseFindings(text) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = [];
  for (const l of lines) {
    const m = ITEM.exec(l);
    if (!m) continue;
    const what = m[3].split(/\s+(?:—|–|--)\s+/)[0].trim();
    items.push({ where: redactSecrets(m[1]?.trim() ?? ''), severity: (m[2] ?? '').toLowerCase(), what: redactSecrets(what).slice(0, 200) });
  }
  if (!items.length && lines.length) items.push({ where: '', severity: '', what: redactSecrets(lines[0]).slice(0, 200) });
  return items;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').trim() || '—';
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export class ProofLog {
  constructor(file, { now = () => new Date() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { version: 1, publish: {}, reports: [] };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (d && Array.isArray(d.reports)) this.data = { version: 1, publish: d.publish && typeof d.publish === 'object' ? d.publish : {}, reports: d.reports.filter((r) => r && r.id && Array.isArray(r.items)) };
    } catch { /* nothing logged yet */ }
  }

  #save() {
    if (!this.file) return;
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 }); } catch { /* the log is best effort; never break a session over it */ }
  }

  #key(root) { return path.resolve(String(root)); }

  /** Log one unprompted bug report (the text the scout showed). Returns the stored report. */
  add({ root, project, text }) {
    const report = {
      id: randomBytes(6).toString('hex'), at: this.now().toISOString(), root: this.#key(root), project: String(project ?? path.basename(root)),
      status: 'open', statusAt: null, text: redactSecrets(String(text ?? '')).slice(0, 4000), items: parseFindings(text),
    };
    this.data.reports = [...this.data.reports, report].slice(-1000);
    this.#save();
    return report;
  }

  get(id) { return this.data.reports.find((r) => r.id === id) ?? null; }
  last(root) { const k = this.#key(root); return this.data.reports.findLast((r) => r.root === k) ?? null; }

  /**
   * Record what happened to a report. 'fixed' only follows 'accepted' (a fix was asked for, and edits were
   * applied); a report already fixed is not downgraded. Returns the report, or null if nothing changed.
   */
  mark(id, status) {
    const r = this.get(id);
    if (!r || !STATUSES.includes(status) || r.status === status) return null;
    if (status === 'fixed' && r.status !== 'accepted') return null;
    if (status === 'accepted' && r.status === 'fixed') return null;
    r.status = status; r.statusAt = this.now().toISOString();
    this.#save();
    return r;
  }

  /** Counts for one project, or for everything when root is omitted. Findings are the individual bugs in the reports. */
  stats(root) {
    const k = root === undefined ? null : this.#key(root);
    const s = { reports: 0, findings: 0, open: 0, accepted: 0, fixed: 0, dismissed: 0 };
    for (const r of this.data.reports) {
      if (k && r.root !== k) continue;
      s.reports++; s.findings += r.items.length; s[r.status] += r.items.length;
    }
    s.asked = s.accepted + s.fixed; // the developer asked for a fix (whether or not one has been applied yet)
    s.rate = pct(s.asked, s.findings);
    return s;
  }

  /** One or two sentences for a terminal or a card. */
  summary(root) {
    const s = this.stats(root);
    if (!s.findings) return 'No unprompted bug reports logged yet. From the Lucid stage it reports bugs on its own after you pause editing.';
    return `${plural(s.findings, 'possible bug')} reported without being asked. You asked for a fix on ${s.asked} (${s.rate}); ${s.fixed} ended with edits applied. ${s.dismissed} dismissed as not a bug, ${s.open} with no response yet.`;
  }

  publishing(root) { const m = this.data.publish[this.#key(root)]; return m === 'detail' || m === 'summary' ? m : null; }

  /** mode: 'detail' (counts and the list of findings) | 'summary' (counts only) | null (stop publishing). */
  setPublishing(root, mode) {
    if (mode === 'detail' || mode === 'summary') this.data.publish[this.#key(root)] = mode; else delete this.data.publish[this.#key(root)];
    this.#save();
  }

  /** The Markdown page for one project. */
  markdown(root, mode = 'detail') {
    const k = this.#key(root), s = this.stats(root);
    const reports = this.data.reports.filter((r) => r.root === k);
    const name = reports.at(-1)?.project ?? path.basename(k);
    const day = (iso) => String(iso ?? '').slice(0, 10);
    const out = [
      MARKER, '', '# Bugs awakening-coder found on its own', '',
      s.findings
        ? `While working on **${cell(name)}**, [awakening-coder](https://github.com/AIEpisteme/awakening-coder) reported **${plural(s.findings, 'possible bug')}** that nobody asked it to look for. The developer asked it to fix **${s.asked}** of them (${s.rate}) and dismissed **${s.dismissed}** as not a bug.`
        : `[awakening-coder](https://github.com/AIEpisteme/awakening-coder) has not reported a bug on its own in **${cell(name)}** yet.`,
      '', '| Outcome | Findings |', '|---|---:|',
      `| Reported without being asked | ${s.findings} |`,
      `| Developer asked for a fix | ${s.asked} |`,
      `| …and the fix run applied edits | ${s.fixed} |`,
      `| Dismissed as not a bug | ${s.dismissed} |`,
      `| No response yet | ${s.open} |`, '',
    ];
    if (mode === 'detail' && s.findings) {
      out.push('## Log', '', '| Date | Where | Severity | Finding | Outcome |', '|---|---|---|---|---|');
      for (const r of [...reports].reverse()) for (const it of r.items) out.push(`| ${day(r.at)} | ${it.where ? `\`${cell(it.where).replace(/`/g, '')}\`` : '—'} | ${cell(it.severity)} | ${cell(it.what)} | ${OUTCOME[r.status]} |`);
      out.push('');
    }
    out.push(
      '## How this is counted', '',
      '- A finding is one bug awakening-coder reported unprompted, after the developer paused editing. Reports it was asked for are not counted.',
      '- "Asked for a fix" means the developer chose **Fix it** for that report. It shows the report was worth acting on, not that the bug was proven.',
      '- "The fix run applied edits" means that run ended with at least one file edit applied.',
      '- The program records these events as they happen. The model does not write or edit this page.', '',
      `_Updated ${day(this.now().toISOString())}._`, '',
    );
    return out.join('\n');
  }

  /**
   * Write PROOF.md in the project if publishing is on for it. Never overwrites a PROOF.md it did not generate.
   * Returns { written, file?, reason? }. onWrite(rel, content) is called first (so the file watcher ignores it).
   */
  publish(root, { onWrite } = {}) {
    const mode = this.publishing(root);
    if (!mode) return { written: false, reason: 'off' };
    const file = path.join(this.#key(root), PROOF_FILE);
    let existing = null;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
    if (existing !== null && !existing.startsWith(MARKER)) return { written: false, reason: `${PROOF_FILE} already exists here and was not generated by awakening-coder. Rename it, then turn publishing on again.` };
    const content = this.markdown(root, mode);
    if (existing === content) return { written: false, file, reason: 'unchanged' };
    try { onWrite?.(PROOF_FILE, content); fs.writeFileSync(file, content); } catch (e) { return { written: false, reason: `could not write ${PROOF_FILE}: ${e.message}` }; }
    return { written: true, file };
  }
}
