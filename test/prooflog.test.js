// The proof log: what it reported on its own, and what the developer did about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProofLog, parseFindings, PROOF_FILE } from '../src/prooflog.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proof-')));
const clock = (iso = '2026-11-10T12:00:00.000Z') => () => new Date(iso);
const TWO = '- [src/app.js:12] (high) items[i+1] reads past the end — the loop runs to length — use i < length - 1\n- [src/db.js:40] (low) the handle is never closed — leaks on error — close it in finally';

test('findings are parsed from the scout\'s report lines; free text counts as one', () => {
  assert.deepEqual(parseFindings(TWO), [
    { where: 'src/app.js:12', severity: 'high', what: 'items[i+1] reads past the end' },
    { where: 'src/db.js:40', severity: 'low', what: 'the handle is never closed' },
  ]);
  assert.deepEqual(parseFindings('The parser crashes on empty input.\nMore detail here.'), [{ where: '', severity: '', what: 'The parser crashes on empty input.' }]);
  assert.deepEqual(parseFindings(''), []);
  const leak = parseFindings('- [config.js:3] (high) hard-coded key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 — rotate it');
  assert.ok(!JSON.stringify(leak).includes('sk-ant-api03-abc'), 'secrets never reach the log');
});

test('reports are logged, outcomes follow what the developer does, and it all survives a restart', () => {
  const file = path.join(tmp(), 'proof-log.json'), root = tmp();
  const log = new ProofLog(file, { now: clock() });
  assert.match(log.summary(root), /No unprompted bug reports/);
  const a = log.add({ root, project: 'shop', text: TWO });
  const b = log.add({ root, project: 'shop', text: '- [a.js:1] (medium) off by one' });
  const c = log.add({ root, project: 'shop', text: '- [b.js:2] (low) maybe wrong' });
  assert.equal(log.last(root).id, c.id);
  // 'fixed' needs a fix to have been asked for first.
  assert.equal(log.mark(a.id, 'fixed'), null);
  assert.equal(log.mark(a.id, 'accepted').status, 'accepted');
  assert.equal(log.mark(a.id, 'fixed').status, 'fixed');
  assert.equal(log.mark(a.id, 'accepted'), null, 'a fixed report is not downgraded');
  assert.equal(log.mark(b.id, 'dismissed').status, 'dismissed');
  assert.equal(log.mark('nope', 'fixed'), null);
  assert.equal(log.mark(c.id, 'published'), null);
  const s = log.stats(root);
  assert.deepEqual({ reports: s.reports, findings: s.findings, asked: s.asked, fixed: s.fixed, dismissed: s.dismissed, open: s.open, rate: s.rate }, { reports: 3, findings: 4, asked: 2, fixed: 2, dismissed: 1, open: 1, rate: '50%' });
  assert.match(log.summary(root), /4 possible bugs reported without being asked\. You asked for a fix on 2 \(50%\)/);
  const again = new ProofLog(file);
  assert.equal(again.stats(root).findings, 4);
  assert.equal(again.get(a.id).status, 'fixed');
  assert.equal(fs.statSync(file).mode & 0o077, 0, 'the log is private to the user');
});

test('projects are counted separately; the overall total needs no project', () => {
  const log = new ProofLog(path.join(tmp(), 'p.json'));
  const one = tmp(), two = tmp();
  log.add({ root: one, text: TWO });
  log.add({ root: two, text: '- [x.js:1] (high) boom' });
  assert.equal(log.stats(one).findings, 2);
  assert.equal(log.stats(two).findings, 1);
  assert.equal(log.stats().findings, 3);
});

test('the page: counts, a log table in detail mode, counts only in summary mode, and how it is counted', () => {
  const root = tmp(), log = new ProofLog(null, { now: clock() });
  const a = log.add({ root, project: 'shop | api', text: TWO });
  log.mark(a.id, 'accepted');
  log.add({ root, project: 'shop | api', text: '- [a|b.js:1] (medium) uses `x` | before <script> it is set' });
  const md = log.markdown(root, 'detail');
  assert.match(md, /^<!-- awakening-coder proof log/);
  assert.match(md, /reported \*\*3 possible bugs\*\* that nobody asked it to look for\. The developer asked it to fix \*\*2\*\* of them \(67%\)/);
  assert.match(md, /\| Developer asked for a fix \| 2 \|/);
  assert.match(md, /\| 2026-11-10 \| `src\/app\.js:12` \| high \| items\[i\+1\] reads past the end \| fix requested \|/);
  assert.match(md, /`a\\\|b\.js:1`.*uses `x` \\\| before &lt;script> it is set \| no response yet \|/, 'table cells are escaped');
  assert.match(md, /shop \\\| api/);
  assert.match(md, /## How this is counted/);
  assert.match(md, /The model does not write or edit this page/);
  const summary = log.markdown(root, 'summary');
  assert.ok(!summary.includes('## Log') && !summary.includes('src/app.js'), 'summary mode names no files');
  assert.match(summary, /\| Reported without being asked \| 3 \|/);
  assert.match(new ProofLog(null).markdown(root), /has not reported a bug on its own/);
});

test('publishing is off until you turn it on; then PROOF.md follows the log, and a PROOF.md of your own is never overwritten', () => {
  const root = tmp(), log = new ProofLog(path.join(tmp(), 'p.json'), { now: clock() });
  const a = log.add({ root, text: TWO });
  assert.deepEqual(log.publish(root), { written: false, reason: 'off' });
  assert.ok(!fs.existsSync(path.join(root, PROOF_FILE)));
  log.setPublishing(root, 'detail');
  const noted = [];
  assert.equal(log.publish(root, { onWrite: (rel) => noted.push(rel) }).written, true);
  assert.deepEqual(noted, [PROOF_FILE], 'the watcher is told first, so its own file gets no hint');
  assert.match(fs.readFileSync(path.join(root, PROOF_FILE), 'utf8'), /\| No response yet \| 2 \|/);
  assert.equal(log.publish(root).reason, 'unchanged');
  log.mark(a.id, 'dismissed');
  assert.equal(log.publish(root).written, true);
  assert.match(fs.readFileSync(path.join(root, PROOF_FILE), 'utf8'), /\| Dismissed as not a bug \| 2 \|/);
  // Someone's own PROOF.md is left alone.
  const other = tmp();
  fs.writeFileSync(path.join(other, PROOF_FILE), '# My own notes\n');
  log.add({ root: other, text: '- [x.js:1] (high) boom' });
  log.setPublishing(other, 'summary');
  const r = log.publish(other);
  assert.equal(r.written, false);
  assert.match(r.reason, /was not generated by awakening-coder/);
  assert.equal(fs.readFileSync(path.join(other, PROOF_FILE), 'utf8'), '# My own notes\n');
  // Off again: the setting is remembered, and nothing more is written.
  log.setPublishing(root, null);
  assert.equal(new ProofLog(log.file).publishing(root), null);
  assert.equal(new ProofLog(log.file).publishing(other), 'summary');
});

test('dismissed reports show up in its track record, and teach it to check before reporting', async () => {
  const { Awareness } = await import('../src/awareness.js');
  const a = new Awareness(path.join(tmp(), 's.json'));
  a.state.xp = 20;
  for (let i = 0; i < 3; i++) a.note('proactiveFindings');
  a.note('proactiveDismissed'); a.note('proactiveDismissed');
  assert.match(a.trackRecord(), /3 bug reports \(0 the developer asked you to fix\), 2 dismissed as not a bug/);
  assert.match(a.calibration().join(' '), /dismissed as not bugs: check each one against the code/);
  a.note('proactiveFixed'); a.note('proactiveFixed');
  assert.ok(!/dismissed as not bugs/.test(a.calibration().join(' ')), 'no longer true once more were fixed than dismissed');
});
