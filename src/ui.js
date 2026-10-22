// Terminal I/O that plays nicely with a live readline prompt:
// suggestions can stream in "on the fly" without trashing what you're typing.
import { styleText } from 'node:util';
import readline from 'node:readline';

const tty = () => Boolean(process.stdout.isTTY);
const paint = (fmt, s) => {
  if (!tty()) return s;
  try { return styleText(fmt, s); } catch { return s; }
};

export const c = {
  dim: (s) => paint('dim', s),
  bold: (s) => paint('bold', s),
  cyan: (s) => paint('cyan', s),
  magenta: (s) => paint('magenta', s),
  yellow: (s) => paint('yellow', s),
  green: (s) => paint('green', s),
  red: (s) => paint('red', s),
};

export function colorDiff(diff) {
  return diff
    .split('\n')
    .map((l) => (l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : c.dim(l)))
    .join('\n');
}

export class Terminal {
  constructor() {
    this.rl = null;
    this.pending = null; // resolver for an in-flight question()
    this.streaming = false;
    this.busy = false; // true while auto-coding: hold back on-the-fly chatter
  }

  attach(rl) { this.rl = rl; }

  clearLine() {
    if (!tty()) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }

  reprompt() {
    if (this.rl && !this.streaming && !this.pending && !this.busy) this.rl.prompt(true);
  }

  print(text = '') {
    this.clearLine();
    process.stdout.write(text + '\n');
    this.reprompt();
  }

  beginStream(header) {
    this.clearLine();
    this.streaming = true;
    if (header) process.stdout.write(header + '\n');
  }

  write(chunk) { process.stdout.write(chunk); }

  endStream() {
    process.stdout.write('\n');
    this.streaming = false;
    this.reprompt();
  }

  /** Ask a one-line question; the next line typed answers it. */
  question(q) {
    return new Promise((resolve) => {
      this.pending = resolve;
      this.clearLine();
      process.stdout.write(q);
    });
  }

  /** Route a typed line: answers a pending question first, else returns false. */
  routeAnswer(line) {
    if (!this.pending) return false;
    const r = this.pending;
    this.pending = null;
    r(line);
    return true;
  }
}
