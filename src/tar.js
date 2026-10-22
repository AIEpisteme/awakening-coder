// Minimal, dependency-free tar (ustar) — enough to ship a project to the cloud sandbox and
// read back the changed files. Reads GNU long names ('L') and pax headers ('x'), which GNU tar
// in the sandbox produces for long paths.

const BLOCK = 512;

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name, size, mtime) {
  const h = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar: split at a '/' so prefix <= 155 and name <= 100 bytes.
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) return null;
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100, 'utf8');
  h.write(octal(0o644, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii');
  h.write(octal(0, 8), 116, 'ascii');
  h.write(octal(size, 12), 124, 'ascii');
  h.write(octal(Math.floor(mtime / 1000), 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // checksum placeholder
  h.write('0', 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

function paxHeader(name, mtime) {
  const rec = (k, v) => {
    const body = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(body);
    len += String(len + String(len).length).length; // length includes its own digits
    return `${len}${body}`;
  };
  const data = Buffer.from(rec('path', name));
  const h = header('PaxHeader', data.length, mtime);
  h.write('x', 156, 'ascii');
  let sum = 0;
  h.write('        ', 148, 'ascii');
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return Buffer.concat([h, data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK)]);
}

/** entries: [{ name: 'src/a.js', data: Buffer|string }] → Buffer */
export function createTar(entries, mtime = Date.now()) {
  const parts = [];
  for (const { name, data } of entries) {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const posixName = name.split('\\').join('/');
    let h = header(posixName, body.length, mtime);
    if (!h) { parts.push(paxHeader(posixName, mtime)); h = header(posixName.slice(-100), body.length, mtime); }
    parts.push(h, body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

const str = (buf, start, len) => {
  const s = buf.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? s.length : end).toString('utf8');
};

/** Buffer → [{ name, data }] for regular files (directories and links are skipped). */
export function readTar(buf) {
  const out = [];
  let off = 0, longName = null, paxPath = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') { longName = str(data, 0, data.length); continue; }
    if (type === 'x') {
      const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    const prefix = str(h, 345, 155);
    let name = paxPath ?? longName ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    longName = paxPath = null;
    if (type !== '0' && type !== '\0' && type !== '7') continue; // files only
    name = name.replace(/^\.\//, '');
    out.push({ name, data: Buffer.from(data) });
  }
  return out;
}
