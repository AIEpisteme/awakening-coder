#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { Store } = require('../src/store.js');

const EXIT_OK = 0;
const EXIT_NOT_FOUND = 1;
const EXIT_USAGE = 2;
const EXIT_ERROR = 3;

const USAGE = `Usage: tinykv [--file <path>] <command> [args]

Commands:
  get <key>                   Print the value (exit 1 if missing)
  set <key> <value> [--json]  Store a value (string by default; --json parses it)
  delete <key>                Remove a key (exit 1 if missing)
  list                        Print all keys, one per line
  help                        Show this help

Options:
  -f, --file <path>  Store file (default: $TINYKV_FILE or ./tinykv.json)
      --json         For "set": parse <value> as JSON
  -h, --help         Show this help

Negative numbers work as keys or values directly:  tinykv set temp -5
Other keys or values starting with "-" go after "--":  tinykv set -- -dash-key v`;

const OPTIONS = {
  file: { type: 'string', short: 'f' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

// Arguments that look like negative numbers (-5, -1.5, -.5, -2e3) are treated
// as positionals. No option of ours can look like this, so it is unambiguous.
const NEGATIVE_NUMBER = /^-(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Like parseArgs in strict mode, except negative numbers are positionals.
 * Runs parseArgs non-strict with tokens, then re-applies the strict checks.
 */
function parseCli(argv) {
  const { tokens } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  const values = { file: undefined, json: false, help: false };
  const positionals = [];
  let numberIndex = -1;

  for (const token of tokens) {
    if (token.kind === 'positional') {
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== 'option') continue; // option-terminator "--"

    const raw = argv[token.index];
    if (NEGATIVE_NUMBER.test(raw)) {
      // "-12" is tokenised as a short-option group (-1, -2) sharing one index.
      if (token.index !== numberIndex) positionals.push(raw);
      numberIndex = token.index;
      continue;
    }

    if (!Object.hasOwn(OPTIONS, token.name)) {
      throw new Error(`Unknown option '${token.rawName}'. To pass a key or value starting with '-', put it after '--', as in: -- "${raw}"`);
    }
    if (OPTIONS[token.name].type === 'string') {
      if (typeof token.value !== 'string') {
        throw new Error(`Option '${token.rawName} <value>' argument missing`);
      }
      if (token.value === '') {
        // Otherwise `values.file || ...` would silently fall back to the default file.
        throw new Error(`Option '${token.rawName}' needs a non-empty path`);
      }
      if (!token.inlineValue && token.value.startsWith('-')) {
        throw new Error(`Option '${token.rawName}' argument is ambiguous; use '${token.rawName}=${token.value}' if you mean it`);
      }
      values[token.name] = token.value;
    } else {
      if (token.value !== undefined) {
        throw new Error(`Option '${token.rawName}' does not take an argument`);
      }
      values[token.name] = true;
    }
  }
  return { values, positionals };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (err) {
    process.stderr.write(`tinykv: ${err.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;
  const [command, ...args] = positionals;

  if (values.help || !command || command === 'help') {
    process.stdout.write(USAGE + '\n');
    return command || values.help ? EXIT_OK : EXIT_USAGE;
  }

  const expected = { get: 1, set: 2, delete: 1, list: 0 };
  if (!Object.hasOwn(expected, command)) {
    process.stderr.write(`tinykv: unknown command "${command}"\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (args.length !== expected[command]) {
    process.stderr.write(`tinykv: "${command}" expects ${expected[command]} argument(s), got ${args.length}\n`);
    return EXIT_USAGE;
  }
  if (command !== 'list' && args[0] === '') {
    process.stderr.write(`tinykv: "${command}" needs a non-empty key\n`);
    return EXIT_USAGE;
  }

  const store = new Store(values.file || process.env.TINYKV_FILE || 'tinykv.json');

  try {
    switch (command) {
      case 'get': {
        const [key] = args;
        // Read once: a has() + get() pair could straddle another process's delete.
        const data = store.load();
        if (!Object.hasOwn(data, key)) {
          process.stderr.write(`tinykv: key not found: ${key}\n`);
          return EXIT_NOT_FOUND;
        }
        const value = data[key];
        process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');
        return EXIT_OK;
      }
      case 'set': {
        const [key, raw] = args;
        let value = raw;
        if (values.json) {
          try {
            value = JSON.parse(raw);
          } catch (err) {
            process.stderr.write(`tinykv: --json value is not valid JSON (${err.message})\n`);
            return EXIT_USAGE;
          }
        }
        store.set(key, value);
        return EXIT_OK;
      }
      case 'delete': {
        const [key] = args;
        if (!store.delete(key)) {
          process.stderr.write(`tinykv: key not found: ${key}\n`);
          return EXIT_NOT_FOUND;
        }
        return EXIT_OK;
      }
      case 'list': {
        const keys = store.keys();
        if (keys.length) process.stdout.write(keys.join('\n') + '\n');
        return EXIT_OK;
      }
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT_ERROR;
  }
  return EXIT_ERROR;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
