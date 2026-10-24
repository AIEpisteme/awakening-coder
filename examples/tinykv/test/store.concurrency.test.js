'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store } = require('../src/store.js');

const WRITERS = 6;
const KEYS_PER_WRITER = 15;

// Each child writes its own distinct keys. Without a lock around the
// read-modify-write, concurrent writers overwrite each other's keys.
const CHILD = `
const { Store } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'store.js'))});
const [file, id, n] = process.argv.slice(1);
const s = new Store(file);
for (let i = 0; i < Number(n); i++) s.set(id + '-' + i, i);
`;

function run(file, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD, file, String(id), String(KEYS_PER_WRITER)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${id} exited ${code}: ${stderr}`))));
  });
}

test('concurrent writers from separate processes do not lose updates', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'tmp-'));
  try {
    const file = path.join(dir, 'kv.json');
    await Promise.all(Array.from({ length: WRITERS }, (_, id) => run(file, id)));
    const keys = new Store(file).keys();
    assert.equal(keys.length, WRITERS * KEYS_PER_WRITER, `lost ${WRITERS * KEYS_PER_WRITER - keys.length} update(s)`);
    assert.deepEqual(fs.readdirSync(dir), ['kv.json'], 'no lock or temp files left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
