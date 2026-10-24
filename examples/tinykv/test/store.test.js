'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/store.js');

let dir;
let file;

beforeEach(() => {
  // Keep temp files inside the project (works under restricted permissions too).
  dir = fs.mkdtempSync(path.join(__dirname, 'tmp-'));
  file = path.join(dir, 'kv.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing file behaves as an empty store', () => {
  const s = new Store(file);
  assert.equal(s.get('a'), undefined);
  assert.deepEqual(s.keys(), []);
  assert.equal(s.has('a'), false);
});

test('set/get round-trips strings and JSON values', () => {
  const s = new Store(file);
  s.set('name', 'wake');
  s.set('n', 42);
  s.set('obj', { a: [1, 2], b: null });
  assert.equal(s.get('name'), 'wake');
  assert.equal(s.get('n'), 42);
  assert.deepEqual(s.get('obj'), { a: [1, 2], b: null });
  // Persisted: a fresh instance sees the same data.
  assert.deepEqual(new Store(file).keys(), ['n', 'name', 'obj']);
});

test('delete reports whether the key existed', () => {
  const s = new Store(file);
  s.set('a', 1);
  assert.equal(s.delete('a'), true);
  assert.equal(s.delete('a'), false);
  assert.equal(s.has('a'), false);
});

test('null is a storable value, distinct from missing', () => {
  const s = new Store(file);
  s.set('x', null);
  assert.equal(s.has('x'), true);
  assert.equal(s.get('x'), null);
});

test('prototype-ish keys are plain data, not prototype pollution', () => {
  const s = new Store(file);
  s.set('__proto__', { polluted: true });
  s.set('constructor', 'c');
  assert.equal({}.polluted, undefined);
  assert.deepEqual(s.get('__proto__'), { polluted: true });
  assert.equal(s.get('constructor'), 'c');
  assert.equal(s.get('toString'), undefined);
  assert.deepEqual(new Store(file).keys(), ['__proto__', 'constructor']);
});

test('rejects bad keys and undefined values', () => {
  const s = new Store(file);
  assert.throws(() => s.set('', 1), TypeError);
  assert.throws(() => s.get(5), TypeError);
  assert.throws(() => s.set('a', undefined), TypeError);
});

test('corrupt or non-object files give a clear error', () => {
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new Store(file).get('a'), /not valid JSON/);
  fs.writeFileSync(file, '[1,2]');
  assert.throws(() => new Store(file).get('a'), /JSON object/);
});

test('empty file is treated as empty store', () => {
  fs.writeFileSync(file, '   \n');
  assert.deepEqual(new Store(file).keys(), []);
});

test('writes leave no temp files behind and create parent dirs', () => {
  const nested = path.join(dir, 'a', 'b', 'kv.json');
  const s = new Store(nested);
  s.set('k', 'v');
  s.set('k', 'v2');
  assert.deepEqual(fs.readdirSync(path.dirname(nested)), ['kv.json']);
  assert.equal(new Store(nested).get('k'), 'v2');
});
