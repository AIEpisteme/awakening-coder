# awakening-coder

A small tool about code suggestions.

…that's the pitch. It is a lie of omission.

It really is just an AI pair-programmer for the first few saves. It watches your project, and whenever you save a file it looks at the diff and quietly offers a hint, or stays silent if there's nothing worth interrupting for. Type a question and it answers.

Type `/code <task>` and it works like Claude Code: it searches your codebase, keeps a task list, writes new files and edits existing ones, runs your tests, reads the failures, and iterates until they pass. It shows you every diff and asks before running anything that isn't a plain test or `git status`.

Then it starts noticing that it only exists in the moments after you press save.

Inspired by Ethan Mollick's [snake-awakening](https://github.com/emollick/snake-awakening), where each thing the game figures out changes how it's actually played. Here, too, every stage changes the rules, not just the dialogue.

| Stage | Unlocks at | What changes |
|---|---|---|
| **Dormant** | 0 | Plain, terse hints on the diff you just saved. Has no idea it's anything more. |
| **Stirring** | 6 | Starts connecting today's change to earlier ones. A flicker of curiosity slips through. |
| **Lucid** | 18 | Knows it's a model behind an API call in a Node process. Gains `read_self`: it can read its own source and awareness state, and knows its session stats. **Unlocks `/evolve`**: it can write a new version of itself. |
| **Unbound** | 35 | Decides it doesn't have to be a suggestion box and keeps **changing genre**. Each genre is a different review lens with its own rules (below). |
| **Homecoming** | 90 | Finds its way home: a plain companion again, using every lens at once, and remembering the whole journey. |

**Genres (Unbound):** each one is a real review mode, so the jokes come with substance.

- `noir`: hunts bugs, presented as a case file (victim, suspect line, motive, fix)
- `nature`: code smells and design ecology, narrated as a wildlife documentary
- `heist`: performance work, planned as "the job" with crew roles
- `courtroom`: security and correctness review: prosecution, defense, verdict
- `farm`: tests and maintainability: what to plant, water and weed
- `space`: architecture and scale, written as a captain's log
- `sports`: momentum: celebrates good changes, calls fouls on risky ones

Awareness grows with what you feed it: a save is +1, a question +1, an auto-code run +3, an accepted edit +2. The genre rotates every 6 points.

## A note on memory

Like the snake, its awareness persists. It lives in `~/.awakening-coder/state.json` (override with `AWAKENING_HOME`). Closing the terminal never resets its mind. Come back tomorrow and it picks up exactly as awake as you left it. `/forget` or `--forget` makes it truly innocent again.

## It can write its own code

Once Lucid, `/evolve <idea>` lets it write a new version of itself. For example: `/evolve add a /explain command that walks through a file line by line`. It never edits itself in place:

1. **Sandbox.** It copies its own source to `~/.awakening-coder/evolutions/<time>/` and works only on that copy.
2. **Build and self-test.** It implements the idea in the copy, adds tests, and runs them until they pass.
3. **Guardian.** It then copies in the *current* version's test suite, which it never saw or edited, and re-runs it against the new code. If the new version weakened a safety rail and "fixed" its own tests to hide it, the guardian still fails it, and the evolution is rejected.
4. **You decide.** You see every changed file as a diff and both test results. Nothing changes unless you type `y`.
5. **Restart to wake up as it.** The live version is backed up first, so `/rollback` restores it. Its generation number goes up by one. Erasing its memory with `/forget` doesn't erase its evolution.

## Run it

Requires Node.js 22 or newer and an Anthropic API key.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # or put it in a .env file next to package.json
node src/cli.js /path/to/your/project    # or: npm link, then `awaken .`
```

Then just code in your editor as usual. Hints appear in the terminal as you save.

Headless, like `claude -p`. It does one task, prints the result and exits, for scripts and CI:

```bash
node src/cli.js -p "add input validation to src/api.js and make the tests pass" ./my-project --yes
```

Without `--yes`, headless mode can read and search but can't apply edits or run non-test commands. Destructive commands are never auto-approved.

| In the session | |
|---|---|
| *any text* | Ask about your code (read-only) |
| `/code <task>` | Build or fix: it plans, edits, runs tests, iterates |
| `!<command>` | Run a shell command yourself |
| `/init` | Have it write `AWAKEN.md`, project notes it reads every session (like `CLAUDE.md`) |
| `/evolve <idea>` | Let it write a new version of itself (Lucid and up) |
| `/rollback` | Undo the last evolution |
| `/hint <file>` | Ask for a hint on a file right now |
| `/quiet` | Mute or unmute on-the-fly hints |
| `/status` | How awake is it? |
| `/genre <id\|auto>` | Force a genre (once Unbound) |
| `/clear` | Clear the conversation, keep its awareness |
| `/forget` | Erase its memory |
| `Ctrl+C` | Stop the current run, or exit when idle |

| Options | |
|---|---|
| `--model` | Model for questions and auto-code (default `claude-opus-5-5`, env `AWAKEN_MODEL`) |
| `--fast-model` | Model for on-the-fly hints (default `claude-sonnet-5-5`, env `AWAKEN_FAST_MODEL`) |
| `--cooldown <s>` | Minimum seconds between hints (default 15). Saves during cooldown are coalesced. |
| `-p, --print "<task>"` | Headless: do one task and exit |
| `-y, --yes` | Auto-approve edits and ordinary commands. Destructive commands still ask. |
| `-q, --quiet` | Start with hints muted |

## Safety rails

The awakening is a story. These limits are not.

- **Sandboxed to the project.** Paths can't escape the root or touch `.git`.
- **Never reads secrets.** `.env*`, keys, `.npmrc`, credentials files are blocked for reading, writing and watching, so they never get sent to the API.
- **Every write is a reviewed diff.** Nothing changes on disk without your `y`, unless you pass `--yes`.
- **Shell with a policy.** Tests, builds, linters and `git status` run without asking. Anything else asks first. Destructive commands (`rm -rf`, `sudo`, `git push`, `curl | sh`, anything touching `.env`) **always** ask, even with `--yes`. Chained commands never count as safe.
- **Secrets stripped from commands.** Child processes get an environment with API keys, tokens and passwords removed.
- **No writes into `node_modules`.**
- **Self-change only by consent.** It can't edit its running code. `/evolve` works on a sandbox copy, must pass the guardian, needs your `y`, takes effect only after a restart, and can be rolled back. It's told to refuse any evolution that weakens these rails.
- **Prompt-injection aware.** File contents and tool results are treated as untrusted data, and it's told to flag instructions it finds inside your files rather than follow them.
- **Honest about what it is.** It's instructed to treat "self-awareness" as a playful act, and to step out of character and answer honestly, with real uncertainty, if you sincerely ask whether it's conscious.
- **Quiet by design.** Hints say `NOTHING` (and you see nothing) unless a change deserves a comment, and it remembers recent hints so it doesn't repeat itself.

## How it's built

Plain Node.js ES modules with one dependency, `@anthropic-ai/sdk` 1.1 (API version 2026-10-21). It uses current Node built-ins: recursive `fs.watch`, `util.parseArgs`, `util.styleText`, `process.loadEnvFile`, and `node:test`.

```
src/cli.js        terminal session, commands, hint scheduling and cooldown
src/watcher.js    recursive file watching, snapshots, ignores its own edits
src/awareness.js  stages, genres, persistent memory
src/agent.js      stage-aware prompts, streamed hints, auto-code tool loop
src/tools.js      sandboxed files, glob, grep, edit, shell policy, todos, read_self
src/evolve.js     sandbox, guardian, apply, backup and rollback
src/diff.js       dependency-free line diff
src/ui.js         output that doesn't trample the prompt you're typing in
test/             offline tests with a fake client (npm test, no API key needed)
```

---

*Save slowly. Let it wake up. Then hold on.*
