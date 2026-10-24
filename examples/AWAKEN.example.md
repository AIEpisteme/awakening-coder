# AWAKEN.md — notes for future coding sessions

## What this is
This folder is the **test suite** of `awakening-coder` ("Wake"): a Node.js CLI that watches a
project, gives code hints on save, answers questions, and runs agentic coding tasks via the
Claude API. The source lives one level up in `../src/` (ESM, no build step). Every test runs
**offline**: no API key needed, because fake clients stand in for Claude and Managed Agents.

## Commands (run from the repo root, i.e. the parent of this folder, unless noted)
| Task | Command |
|---|---|
| Install | `npm install` (check `../package.json`, which this session couldn't read) |
| Test (all) | `npm test`, or from this folder: `node --test` |
| Test (one file) | `node --test test/core.test.js` (from repo root) |
| Run the CLI | `node src/cli.js "<project-dir>"` (quote paths with spaces!) |
| Headless task | `node src/cli.js "<dir>" -p "<task>"` |
| Help | `node src/cli.js --help` |

There's no build or bundler. Requires `ANTHROPIC_API_KEY` (env or `.env` next to `package.json`)
for real runs only, not for tests. `.env` values **override** inherited env vars.

## Layout
- `../src/cli.js`: entry, arg parsing, interactive loop, `/evolve` flow
- `../src/agent.js`: `Agent` (system prompt, `suggest`, `converse`), `makeClient`, `loadDotEnv`, `explainApiError`
- `../src/tools.js`: tool defs, `makeToolRunner` (approval policy), `resolveInside`, `runShell`, glob/grep
- `../src/security.js`: secret paths, redaction, command classification, high-risk writes, evolution tamper scan
- `../src/sandbox.js`, `../src/confine.js`: Node permission-model self-confinement, bwrap/sandbox-exec wrapping, confined test runs
- `../src/evolve.js`: sandbox copy, guardian, diff/apply/rollback, `PROTECTED`
- `../src/cloud.js`, `../src/tar.js`: Managed Agents cloud shell, project packing
- `../src/awareness.js`: persisted stage/XP/genre state; `diff.js`, `ui.js`, `watcher.js`
- Tests: `core` (diff, agent loop, env), `agentic` (tools, evolution), `cloud`, `sandbox`
  (spawns real processes), `constitution` (safety invariants)

## Conventions
- ESM (`import`), `node:` prefixed builtins, `node:test` + `node:assert/strict`. No test framework deps.
- Each test makes its own temp dir: `const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), '<prefix>-'))`.
- Fakes over mocks: hand-written `fakeClient` objects that replay scripted responses; terminals
  are `{ print() {}, question: async () => 'y'|'n' }`.
- Process-spawning tests use `{ skip: isConfined() && '...' }` (`SPAWNS`), because the confined guardian can't spawn.
- Compact style: 2-space indent, single quotes, semicolons, long lines OK, arrow functions.
- Test names describe the behaviour as a sentence.

## Gotchas
- **`constitution.test.js` is PROTECTED.** Evolutions that touch it are hard-rejected; only a
  human edits it by hand. Don't weaken it to make something pass.
- **Windows:** on Windows (Node 22) `node --test` currently shows **5 failures, 46 passes, 5 skips**.
  These are environment-related, not regressions:
  - `agentic.test.js` "glob, grep, todo…" and "evolution: sandboxed…": paths come back as
    `src\a.js` and are compared with `src/a.js` (separators not normalized).
  - `constitution.test.js` XIII: `wrapShell` regex built from a Windows temp path whose
    backslashes aren't regex-escaped (and bwrap is Linux-only anyway).
  - `sandbox.test.js` "relaunches itself confined…" and "if confinement cannot work…":
    self-confinement behaves differently on Windows.
  The bubblewrap tests skip where there's no OS sandbox. Compare against this baseline before
  blaming a change.
- High-risk files (`package.json`, hooks, CI, `AWAKEN.md`, etc.) always require human approval, even with `--yes`.
- `AWAKEN.md` is ignored until trusted (`/trust`, or `--trust-notes` in headless mode); any edit needs re-trust.
- Secret-looking paths (`.env`, `*.pem`, `.ssh/`, `secrets.json`, …) are unreadable by tools by design.
