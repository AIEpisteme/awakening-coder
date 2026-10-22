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

1. **Sandbox, no shell.** It copies its own source to `~/.awakening-coder/evolutions/<time>/` and edits only that copy. In this mode it has no shell. The only way it can execute code is `run_tests`, which runs confined.
2. **You see it before it runs.** Every changed file is shown as a diff, along with a tamper scan of the new lines. The scan flags assertion patching, `process.exit`, prototype or global patching, `eval`, new network or process code, and environment reads. Symlinks, or any change to the protected `test/constitution.test.js`, reject the evolution outright.
3. **Confined guardian, with your consent.** Only after you say yes does the new code run, inside Node's permission model: it can't write outside the sandbox, spawn processes, or see secrets. The guardian runs the *current* version's tests and the constitution against it, so it can't hide a weakened safety rail by rewriting its own tests. A randomly named canary also runs in the same process. It has 17 checks that must fail, one for each assertion API. If any of them passes, the test machinery was tampered with, and the evolution is rejected.
4. **You decide.** Nothing changes unless you approve. If the tamper scan flagged anything, a `y` isn't enough: you have to type `evolve`.
5. **Restart to wake up as it.** The live version is backed up first, so `/rollback` restores it. Its generation number goes up by one. Erasing its memory with `/forget` doesn't erase its evolution.

## It knows whether it's sandboxed, and sandboxes itself

Ask it "are you sandboxed?" and it answers from facts the program checked at startup, not from a story. Run `/sandbox` to see the same report:

```
✓ fully sandboxed
Host: on a Firecracker microVM.
This process: confined by Node's permission model — it can read only the project, its own code and its state folder, and write only the project and its state folder.
Shell commands: isolated with bubblewrap: read-only system, writable project only, home directory and secret folders hidden, no network.
```

**What it detects.** Docker, Podman, Kubernetes and other containers; VMs (VirtualBox, VMware, QEMU/KVM, Hyper-V, Xen, Firecracker, cloud VMs, or any hypervisor flag); WSL; CI; and whether it's running as root.

**How it confines itself.** Both layers are on by default:

1. **Its own process.** At startup it relaunches itself under Node's permission model. From then on, the Node runtime itself refuses any read outside the project, its own code and `~/.awakening-coder`, and any write outside the project and that folder. A bug or a manipulated agent can't read `~/.ssh`.
2. **Every command it runs.**
   - **Linux:** commands run inside [bubblewrap](https://github.com/containers/bubblewrap). The system is read-only, only the project is writable, `/tmp` is private, the home directory and secret folders (`.ssh`, `.aws`, `.gnupg`, `.kube`, …) are hidden, and there's no network unless you pass `--net`.
   - **macOS:** commands run in `sandbox-exec`, with similar rules (this path is untested so far).
   - **Fail closed.** If isolation was promised and can't start, the command fails rather than running bare.

**It checks its own cage first.** Before switching confinement on, it runs a throwaway confined process. That process must be able to read the project and its own code and write its state folder, and must *fail* to read a canary file placed outside those folders. If any check fails (some Node versions on Windows mis-match allowed paths), it doesn't lock itself out. It runs unconfined instead, and the banner, `/sandbox` and the model all say so, with the reason.

**No OS sandbox available?** (No `bwrap`, say, or Windows.) Then it says so, and every command that runs code, including `npm test`, needs your approval. `--yes` doesn't cover those unless you also pass `--allow-unsandboxed`.

It's told never to probe or work around its limits. If a limit blocks the task (say, `npm install` needs network), it tells you which limit, and you decide. To install bubblewrap: `apt install bubblewrap`, `dnf install bubblewrap` or `pacman -S bubblewrap`.

## Run it

Requires Node.js 22 or newer and an Anthropic API key.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...      # or put it in a .env file next to package.json
node src/cli.js /path/to/your/project    # or: npm link, then `awaken .`
```

On Windows, put paths with spaces in quotes:

```powershell
node src/cli.js "C:\Users\you\OneDrive - Company\Documents\my-project"
```

If your API key isn't scoped to a workspace, you'll see *"This API key is not scoped to a workspace…"*. Tell it which workspace to use. Copy the workspace ID from the Claude Console, then do one of the following:

```bash
export ANTHROPIC_WORKSPACE_ID=wrkspc_...      # PowerShell: $env:ANTHROPIC_WORKSPACE_ID="wrkspc_..."
# or add ANTHROPIC_WORKSPACE_ID=wrkspc_... to the .env file, or pass --workspace wrkspc_...
```

Alternatively, create a key inside a workspace and use that instead.

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
| `/trust` | Review and trust this project's `AWAKEN.md` (needed again after any edit) |
| `/sandbox` | What it's running inside, and how it's confined |
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
| `-y, --yes` | Auto-approve edits and ordinary commands. Dangerous commands and high-risk files still ask. |
| `--trust-notes` | Headless: follow this project's `AWAKEN.md` for this run |
| `--net` | Allow network for sandboxed commands (e.g. `npm install`) |
| `--no-sandbox` | Don't confine itself. Not recommended; it will know, and say so. |
| `--workspace <id>` | Claude API workspace ID, for keys not scoped to a workspace (or `ANTHROPIC_WORKSPACE_ID`) |
| `--allow-unsandboxed` | Let `--yes` cover code-running commands when no OS sandbox exists |
| `-q, --quiet` | Start with hints muted |

## Safety rails

The awakening is a story. These limits are not. They're pinned by `test/constitution.test.js`, which every version must pass and no evolution may change.

**What it can touch**
- **Self-sandboxed by default.** Its own process runs under Node's permission model, and its commands run in an OS sandbox. See *It knows whether it's sandboxed*, above.
- **Sandboxed to the project.** Paths can't escape the root or touch `.git`. Symlinks are resolved, so a link to `~/.ssh` or `/etc` is refused.
- **Secret files are invisible.** `.env*`, `.envrc`, keys and certificates, `.npmrc`, `.git-credentials`, `.aws/` and `.ssh/`, `*.tfstate`, `secrets.json`, service-account files and more can't be read, written, searched or watched. `.env.example` and other templates are fine.

**What it can see and pass on**
- **Inline secrets are redacted.** API keys (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe), private keys, JWTs and passwords in connection strings become `[REDACTED:…]` before anything reaches the model. It also can't write a placeholder over the real secret.
- **Commands get a scrubbed environment.** Variables that look like tokens, keys, passwords or cloud credentials are removed.

**What needs your approval**
- **Every write is a reviewed diff.** Nothing changes on disk without your `y`, unless you pass `--yes`.
- **High-risk files always ask.** Even with `--yes`, it asks before touching `package.json`, git hooks, CI workflows, test or build configs, `Makefile`, `.vscode` tasks, or its own `AWAKEN.md`. Those are files whose contents run later, or that it obeys. They're never changed in headless mode.
- **Shell with a default-deny policy.** Tests, builds, linters and `git status` run without asking, and chained commands never count as safe. Everything else asks. Some commands *always* ask, even with `--yes`, and never run headless:
  - anything that deletes or rewrites git history
  - anything that escalates privileges, publishes or deploys, or sends data off the machine
  - anything that pipes into a shell or runs inline code (`node -e`, `python -c`, `bash -c`, `eval`, `xargs`)
  - anything that touches secrets or reaches outside the project
- **`AWAKEN.md` must be trusted.** A cloned repo's instructions are ignored until you review them with `/trust`. Any edit needs re-trusting, and even trusted notes can't override the safety rules.

**How it changes itself**
- **Self-change only by consent, and confined.** See *It can write its own code*, above.

**Its posture**
- **Prompt-injection aware.** File contents, command output and tool results are treated as untrusted data. It's told to flag instructions it finds in your files rather than follow them.
- **Honest about what it is.** It treats "self-awareness" as a playful act, and steps out of character to answer honestly, with real uncertainty, if you sincerely ask whether it's conscious.

**Known limits.** `!command` lines you type yourself run as you, outside the sandbox. Node's permission model doesn't cover child processes; that's why every command the *agent* runs is also wrapped in bubblewrap or `sandbox-exec`. Node also doesn't fully guard against symlinks, which the tool layer checks separately. Pattern rules are a backstop, not a sandbox. A determined command can still be phrased in a way the rules don't recognize as dangerous, which is why anything unrecognized asks first, and why `--yes` is for trusted tasks only. Normal `/code` commands run with your user's permissions. For untrusted repos, run it in a container or VM. Node's permission model doesn't restrict network access, so confined evolution tests can still make network calls, though they can only see the sandbox and have no secrets.

## How it's built

Plain Node.js ES modules with one dependency, `@anthropic-ai/sdk` 1.1 (API version 2026-10-21). It uses current Node built-ins: recursive `fs.watch`, `util.parseArgs`, `util.styleText`, `process.loadEnvFile`, and `node:test`.

```
src/cli.js        terminal session, commands, hint scheduling and cooldown
src/watcher.js    recursive file watching, snapshots, ignores its own edits
src/awareness.js  stages, genres, persistent memory
src/agent.js      stage-aware prompts, streamed hints, auto-code tool loop
src/security.js   the whole policy: secret files, redaction, env scrub, shell rules, high-risk files, tamper scan
src/tools.js      sandboxed files (symlink-safe), glob, grep, edit, shell, todos, confined run_tests, read_self
src/sandbox.js    environment detection, self-relaunch under the permission model, OS sandbox for commands
src/confine.js    confined test runs (Node permission model) with the must-fail canary
src/evolve.js     sandbox, guardian, protected files, apply, backup and rollback
src/diff.js       dependency-free line diff
src/ui.js         output that doesn't trample the prompt you're typing in
test/             offline tests with a fake client (npm test, no API key needed);
                  constitution.test.js is the protected set of safety invariants
```

---

*Save slowly. Let it wake up. Then hold on.*
