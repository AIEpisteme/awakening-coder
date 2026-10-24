'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'tinykv.js');
let dir;
let file;

function run(...args) {
  const env = { ...process.env };
  delete env.TINYKV_FILE;
  const r = spawnSync(process.execPath, [BIN, '--file', file, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(__dirname, 'tmp-'));
  file = path.join(dir, 'kv.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('set then get a string', () => {
  assert.equal(run('set', 'greeting', 'hello world').code, 0);
  const r = run('get', 'greeting');
  assert.equal(r.code, 0);
  assert.equal(r.out, 'hello world\n');
});

test('strings stay strings unless --json is given', () => {
  run('set', 'a', '123');
  run('set', 'b', '123', '--json');
  run('set', 'c', '{"x":1}', '--json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data, { a: '123', b: 123, c: { x: 1 } });
  assert.equal(run('get', 'c').out, '{"x":1}\n');
});

test('invalid --json value is a usage error', () => {
  const r = run('set', 'a', '{bad', '--json');
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
});

test('missing key exits 1 for get and delete', () => {
  assert.equal(run('get', 'nope').code, 1);
  assert.equal(run('delete', 'nope').code, 1);
});

test('list prints sorted keys', () => {
  run('set', 'b', '2');
  run('set', 'a', '1');
  assert.equal(run('list').out, 'a\nb\n');
});

test('delete removes a key', () => {
  run('set', 'a', '1');
  assert.equal(run('delete', 'a').code, 0);
  assert.equal(run('get', 'a').code, 1);
});

test('usage errors exit 2', () => {
  assert.equal(run('frobnicate').code, 2);
  assert.equal(run('get').code, 2);
  assert.equal(run('set', 'only-key').code, 2);
  assert.equal(run('--bogus').code, 2);
});

test('empty key is a usage error (exit 2), not a store error', () => {
  for (const args of [['get', ''], ['set', '', 'v'], ['delete', '']]) {
    const r = run(...args);
    assert.equal(r.code, 2, `${args[0]} ""`);
    assert.match(r.err, /non-empty key/);
  }
  assert.equal(fs.existsSync(file), false, 'nothing written');
});

test('help exits 0 and prints usage', () => {
  const r = run('help');
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: tinykv/);
  assert.match(r.out, /Negative numbers work as keys or values directly/);
});

test('negative numbers work as values and keys without "--"', () => {
  assert.equal(run('set', 'temp', '-5').code, 0);
  assert.equal(run('set', 'n', '-12', '--json').code, 0);
  assert.equal(run('set', 'f', '-1.5').code, 0);
  assert.equal(run('set', 'e', '-2e3', '--json').code, 0);
  assert.equal(run('set', '-7', 'minus seven').code, 0);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data, { temp: '-5', n: -12, f: '-1.5', e: -2000, '-7': 'minus seven' });
  assert.equal(run('get', 'temp').out, '-5\n');
  assert.equal(run('get', '-7').out, 'minus seven\n');
  assert.equal(run('delete', '-7').code, 0);
});

test('"--" still works, and is required for non-numeric dash args', () => {
  assert.equal(run('set', 'temp', '--', '-5').code, 0);
  assert.equal(run('set', '--json', 'n', '--', '-5').code, 0);
  assert.equal(run('set', '--', '-dash-key', 'v').code, 0);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(data, { temp: '-5', n: -5, '-dash-key': 'v' });
  assert.equal(run('get', '--', '-dash-key').out, 'v\n');

  const bad = run('set', 'k', '-x');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /Unknown option '-x'.*'--'/);
});

test('strict option checks are preserved', () => {
  assert.match(run('--jsn', 'set', 'a', 'b').err, /Unknown option '--jsn'/);
  assert.equal(run('set', 'a', 'b', '--json=yes').code, 2);
  assert.match(run('set', 'a', 'b', '--json=yes').err, /does not take an argument/);
  // run() always passes --file first; a trailing bare --file has no value.
  assert.match(run('list', '--file').err, /argument missing/);
  assert.match(run('list', '--file', '-5').err, /ambiguous/);
});

test('empty --file value is a usage error, not a silent fallback to the default', () => {
  const env = { ...process.env };
  delete env.TINYKV_FILE;
  for (const fileArgs of [['--file='], ['-f', ''], ['--file', '']]) {
    const r = spawnSync(process.execPath, [BIN, ...fileArgs, 'set', 'k', 'v'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(r.status, 2, fileArgs.join(' '));
    assert.match(r.stderr, /needs a non-empty path/);
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing written (no stray tinykv.json)');
});

test('corrupt store file exits 3 with a clear message', () => {
  fs.writeFileSync(file, 'garbage');
  const r = run('get', 'a');
  assert.equal(r.code, 3);
  assert.match(r.err, /not valid JSON/);
});
