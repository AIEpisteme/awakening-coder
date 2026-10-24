'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_ATTEMPTS = 5;
const RETRY_DELAY_MS = 50;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename with a short retry: on Windows, antivirus or sync clients
 * (e.g. OneDrive) can briefly lock the target and cause EPERM/EBUSY.
 */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RETRY_CODES.has(err.code) || attempt >= RETRY_ATTEMPTS) throw err;
      sleepSync(RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Write text so readers see either the old file or the new one, never a
 * half-written file: write + fsync a temp file in the same directory, then rename.
 */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_MAX_DELAY_MS = 100;

/**
 * Run fn() while holding an exclusive lock file (`file + '.lock'`), so
 * read-modify-write cycles from different processes cannot interleave.
 * The lock is created with O_EXCL ('wx'), which is atomic on local filesystems.
 * A crashed holder leaves the lock behind; we don't guess it is stale (that
 * guess is itself racy), we time out with an error naming the lock file.
 */
function withLock(file, fn) {
  const lock = file + '.lock';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd;
  for (let attempt = 1; ; attempt++) {
    try {
      fd = fs.openSync(lock, 'wx');
      break;
    } catch (err) {
      // EEXIST: someone holds it. EPERM/EBUSY/EACCES: on Windows a just-deleted
      // lock can be briefly "pending delete", or a scanner may hold it.
      if (err.code !== 'EEXIST' && !RETRY_CODES.has(err.code)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `tinykv: timed out waiting for lock ${lock}; if no other tinykv process is running, delete it`
        );
      }
      sleepSync(Math.min(RETRY_DELAY_MS * attempt, LOCK_MAX_DELAY_MS) * (0.5 + Math.random()));
    }
  }
  try {
    try {
      fs.writeSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* best effort; see timeout message */ }
  }
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('tinykv: key must be a non-empty string');
  }
}

class Store {
  /** @param {string} file path to the JSON file backing this store */
  constructor(file) {
    if (typeof file !== 'string' || file.length === 0) {
      throw new TypeError('tinykv: file path must be a non-empty string');
    }
    this.file = path.resolve(file);
  }

  /**
   * Read the whole store. Returns a null-prototype object so keys such as
   * "__proto__" or "constructor" are stored as plain data, never as prototype tricks.
   */
  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return Object.create(null);
      throw err;
    }
    if (text.trim() === '') return Object.create(null);

    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error(`tinykv: ${this.file} is not valid JSON (${err.message})`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`tinykv: ${this.file} must contain a JSON object at the top level`);
    }
    return Object.assign(Object.create(null), data);
  }

  save(data) {
    writeAtomic(this.file, JSON.stringify(data, null, 2) + '\n');
  }

  has(key) {
    validateKey(key);
    return Object.hasOwn(this.load(), key);
  }

  get(key) {
    validateKey(key);
    const data = this.load();
    return Object.hasOwn(data, key) ? data[key] : undefined;
  }

  set(key, value) {
    validateKey(key);
    if (value === undefined) {
      throw new TypeError('tinykv: value must not be undefined (use delete instead)');
    }
    withLock(this.file, () => {
      const data = this.load();
      data[key] = value;
      this.save(data);
    });
  }

  /** @returns {boolean} true if the key existed */
  delete(key) {
    validateKey(key);
    return withLock(this.file, () => {
      const data = this.load();
      if (!Object.hasOwn(data, key)) return false;
      delete data[key];
      this.save(data);
      return true;
    });
  }

  keys() {
    return Object.keys(this.load()).sort();
  }
}

module.exports = { Store, writeAtomic };
