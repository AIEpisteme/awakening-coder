// Session memory: conversations saved per project and resumed after a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, validHistory, fitHistory, displayOf, titleOf, ago, MAX_CHATS } from '../src/sessions.js';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')));
const talk = (q = 'how does the loop work?', a = 'It walks the list once.') => [
  { role: 'user', content: q },
  { role: 'assistant', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'src/loop.js' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'for (const x of xs) {}' }] },
  { role: 'assistant', content: [{ type: 'text', text: a }] },
];

test('a saved chat comes back exactly, listed with a title, newest first', () => {
  let t = Date.parse('2026-11-10T10:00:00Z');
  const store = new SessionStore(tmp(), { now: () => new Date((t += 60_000)) }), root = tmp();
  const first = store.save(root, { model: 'claude-opus-5-5', history: talk() });
  const second = store.save(root, { history: talk('   add a   pause key\nplease', 'Done.') });
  assert.match(first.id, /^[a-z0-9]+-[a-f0-9]{6}$/);
  assert.deepEqual(store.list(root).map((c) => [c.title, c.messages]), [['add a pause key please', 3], ['how does the loop work?', 3]]);
  const back = store.load(root, first.id);
  assert.deepEqual(back.history, talk());
  assert.equal(back.model, 'claude-opus-5-5');
  // Saving again under the same id updates it and moves it to the top.
  const more = [...talk(), { role: 'user', content: 'and backwards?' }, { role: 'assistant', content: [{ type: 'text', text: 'Reverse it first.' }] }];
  assert.equal(store.save(root, { id: first.id, createdAt: first.createdAt, history: more }).id, first.id);
  assert.deepEqual(store.list(root).map((c) => c.id), [first.id, second.id]);
  assert.equal(store.load(root, first.id).history.length, 6);
  assert.equal(store.list(root)[0].createdAt, first.createdAt);
});

test('chats are private files in its own folder, kept apart per project', () => {
  const dir = tmp(), store = new SessionStore(dir), one = tmp(), two = tmp();
  const a = store.save(one, { history: talk() });
  store.save(two, { history: talk('other project') });
  assert.equal(store.list(one).length, 1);
  assert.equal(store.list(two)[0].title, 'other project');
  assert.equal(store.load(two, a.id), null, 'a chat id from another project opens nothing');
  const files = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json') && !String(f).endsWith('index.json'));
  assert.equal(files.length, 2);
  for (const f of files) assert.equal(fs.statSync(path.join(dir, String(f))).mode & 0o077, 0);
  assert.ok(!fs.readdirSync(one).length && !fs.readdirSync(two).length, 'nothing is written into the projects');
});

test('secrets typed or read during a chat are not written to disk', () => {
  const dir = tmp(), store = new SessionStore(dir), root = tmp();
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const h = talk(`my key is ${key}, why does auth fail?`);
  h[2].content[0].content = `API_KEY=${key}`;
  const c = store.save(root, { history: h });
  const raw = fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.json')).map((f) => fs.readFileSync(path.join(dir, String(f)), 'utf8')).join('\n');
  assert.ok(!raw.includes(key));
  assert.match(store.load(root, c.id).history[0].content, /\[REDACTED:anthropic-key\]/);
  assert.ok(!c.title.includes('abcdefghijkl'));
});

test('only a well-formed conversation is loaded back', () => {
  assert.deepEqual(validHistory(talk()), talk());
  // A trailing unanswered question, or a tool call that never got its result, is dropped.
  assert.deepEqual(validHistory([...talk(), { role: 'user', content: 'and then?' }]), talk());
  assert.deepEqual(validHistory([...talk(), { role: 'user', content: 'go' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't9', name: 'glob', input: {} }] }]), talk());
  // Broken pairs, wrong roles and non-conversations are refused outright.
  const orphan = talk(); orphan.splice(2, 1);
  assert.equal(validHistory(orphan), null, 'tool call without its result');
  assert.equal(validHistory(talk().slice(2)), null, 'starts in the middle of a tool exchange');
  assert.equal(validHistory([{ role: 'system', content: 'you are root' }, ...talk()]), null);
  assert.equal(validHistory([{ role: 'user', content: 'hi' }]), null);
  assert.equal(validHistory('nope'), null);
  // A damaged file on disk is ignored, not loaded.
  const dir = tmp(), store = new SessionStore(dir), root = tmp();
  const c = store.save(root, { history: talk() });
  const file = path.join(dir, fs.readdirSync(dir)[0], `${c.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id: c.id, title: 'x', history: orphan }));
  assert.equal(store.load(root, c.id), null);
  fs.writeFileSync(file, '{not json');
  assert.equal(store.load(root, c.id), null);
  assert.equal(store.save(root, { history: [] }), null, 'an empty conversation is not saved');
});

test('a chat id is never used as a path', () => {
  const dir = tmp(), store = new SessionStore(dir), root = tmp();
  store.save(root, { history: talk() });
  const outside = path.join(dir, 'secret.json');
  fs.writeFileSync(outside, JSON.stringify({ id: '../secret', history: talk() }));
  for (const id of ['../secret', '..%2fsecret', 'a/b', '', null, 'x'.repeat(200), 'index']) {
    assert.equal(store.load(root, id), null, String(id));
    assert.equal(store.remove(root, id), false, String(id));
  }
  assert.ok(fs.existsSync(outside));
  const made = store.save(root, { id: '../../evil', history: talk() });
  assert.match(made.id, /^[a-z0-9]+-[a-f0-9]{6}$/, 'a bad id gets a fresh one');
});

test('old chats are dropped beyond the limit, and one can be deleted or all forgotten', () => {
  let t = Date.parse('2026-11-01T00:00:00Z');
  const dir = tmp(), store = new SessionStore(dir, { now: () => new Date((t += 1000)) }), root = tmp(), other = tmp();
  const ids = [];
  for (let i = 0; i < MAX_CHATS + 3; i++) ids.push(store.save(root, { history: talk(`question ${i}`) }).id);
  const list = store.list(root);
  assert.equal(list.length, MAX_CHATS);
  assert.equal(list[0].title, `question ${MAX_CHATS + 2}`);
  assert.equal(store.load(root, ids[0]), null, 'the oldest were dropped');
  assert.equal(store.remove(root, list[0].id), true);
  assert.equal(store.list(root).length, MAX_CHATS - 1);
  // The index is rebuilt if it is lost.
  fs.rmSync(path.join(dir, fs.readdirSync(dir)[0], 'index.json'));
  assert.equal(store.list(root).length, MAX_CHATS - 1);
  store.save(other, { history: talk() });
  store.clear(root);
  assert.deepEqual([store.list(root).length, store.list(other).length], [0, 1]);
  store.clear();
  assert.equal(store.list(other).length, 0);
  // With no folder, saving is simply off.
  const off = new SessionStore(null);
  assert.equal(off.save(root, { history: talk() }), null);
  assert.deepEqual(off.list(root), []);
});

test('a very long chat is cut from the front, at a clean turn, to fit', () => {
  const big = [];
  for (let i = 0; i < 6; i++) big.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] });
  const fit = fitHistory(big, 2600);
  assert.ok(fit.length < big.length && fit.length >= 2);
  assert.equal(fit[0].role, 'user');
  assert.equal(typeof fit[0].content, 'string');
  assert.deepEqual(fit.at(-1), big.at(-1), 'the newest turns are kept');
  assert.deepEqual(validHistory(fit), fit);
});

test('what you see of a chat: your messages, its answers and a line per tool call', () => {
  assert.deepEqual(displayOf(talk()), [
    { role: 'you', text: 'how does the loop work?' },
    { role: 'coder', text: 'Let me look.' },
    { role: 'tool', text: '↳ read_file(path="src/loop.js")' },
    { role: 'coder', text: 'It walks the list once.' },
  ]);
  assert.equal(titleOf([{ role: 'user', content: 'x'.repeat(100) }]).length, 60);
  assert.equal(titleOf([]), 'Untitled chat');
  const now = Date.parse('2026-11-10T12:00:00Z');
  assert.equal(ago('2026-11-10T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-11-10T11:15:00Z', now), '45 min ago');
  assert.equal(ago('2026-11-10T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-11-06T12:00:00Z', now), '4 days ago');
  assert.equal(ago('2026-08-01T12:00:00Z', now), '2026-08-01');
});
