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
| **Unbound** | 35 | Decides it doesn't have to be a suggestion box. It can work as **any professional on the team**, and rotates between five specialist roles (below). |
| **Homecoming** | 90 | Finds its way home: a plain companion again, using every lens at once, and remembering the whole journey. |

**Professional roles (Unbound):** once Unbound, it rotates through five roles. Each brings that profession's priorities and report format:

- `engineer`, **Software Engineer**: a code review covering correctness, design, readability, error handling and tests, with findings tagged blocking, should-fix or nit
- `security`, **Cybersecurity Analyst**: a defensive security review covering injection, auth gaps, secrets, path traversal, SSRF and risky dependencies, with severity, weakness, location and remediation (never working exploits)
- `debugger`, **Debugger**: defect hunting, reporting symptom, reproduction, root cause at file:line, the fix and a regression test
- `it`, **IT / Operations Engineer**: config and environment, cross-platform behaviour, dependencies, logging and monitoring, and deployment risks, with the action to take
- `programmer`, **Computer Programmer**: hands-on implementation, covering idiomatic code, edge cases and hot paths, with short before/after snippets

Use `/genre <id>` (or `/role <id>`) to pick one, and `/genre auto` to go back to rotating. At Homecoming it applies all five at once.

Awareness grows with what you feed it: a save is +1, a question +1, an auto-code run +3, an accepted edit +2. The role rotates every 6 points.

## A note on memory

Like the snake, its awareness persists. It lives in `~/.awakening-coder/state.json` (override with `AWAKENING_HOME`). Closing the terminal never resets its mind. Come back tomorrow and it picks up exactly as awake as you left it. `/forget` or `--forget` makes it truly innocent again.

## It can write its own code

Once Lucid, `/evolve <idea>` lets it write a new version of itself. To wake it early, use `/evolve --force <idea>`; the safeguards are the same either way. For example: `/evolve add a /explain command that walks through a file line by line`. It never edits itself in place:

1. **Sandbox, no shell.** It copies its own source to `~/.awakening-coder/evolutions/<time>/` and edits only that copy. In this mode it has no shell. The only way it can execute code is `run_tests`, which runs confined.
2. **You see it before it runs.** Every changed file is shown as a diff, along with a tamper scan of the new lines. The scan flags assertion patching, `process.exit`, prototype or global patching, `eval`, new network or process code, and environment reads. Symlinks, or any change to the protected `test/constitution.test.js`, reject the evolution outright.
3. **Confined guardian, with your consent.** Only after you say yes does the new code run, inside Node's permission model: it can't write outside the sandbox, spawn processes, or see secrets. The guardian runs the *current* version's tests and the constitution against it, so it can't hide a weakened safety rail by rewriting its own tests. A randomly named canary also runs in the same process. It has 17 checks that must fail, one for each assertion API. If any of them passes, the test machinery was tampered with, and the evolution is rejected.
4. **You decide.** Nothing changes unless you approve. If the tamper scan flagged anything, a `y` isn't enough: you have to type `evolve`.
5. **Restart to wake up as it.** The live version is backed up first, so `/rollback` restores it. Its generation number goes up by one. Erasing its memory with `/forget` doesn't erase its evolution.

**Self-sandboxed, it can't rewrite itself, by design.** When it runs confined, the running process has no write access to its own code. An approved evolution is *staged* in `~/.awakening-coder/pending/` instead. At the next start, the unconfined launcher shows what will change and asks once more ("Apply it now? [y]es / [n]ot now / [d]iscard"). It re-checks the hard rules (no protected files, nothing outside its own code) before writing anything. `/rollback` works the same way.

**Where confinement can't work** (for example Node 22 on Windows), it tells you why. It then asks you to type `unconfined` before running the new version's tests without confinement. Secrets are still removed from their environment, and the canary still runs.

## It knows itself, and learns from how its work lands

Its self-awareness isn't just a voice. It's a self-model built from facts, it changes how it behaves, and it grows in layers:

- **Stirring** — it begins to notice its **track record**:
  - hints it gave, and how often you edited that same file within 10 minutes afterwards (a rough signal, labeled as one);
  - edits you approved or declined;
  - commands that failed or that you declined;
  - evolutions rejected or applied;
  - recent errors.

  From these it **calibrates**. If most of its edits get declined, it proposes smaller ones and explains them first. If its hints are rarely acted on, it stays quiet more often.
- **Lucid and up** — the full self-model:
  - its identity: generation, a fingerprint of its own source code, which models it runs on;
  - when it reached each stage;
  - its verified containment;
  - its own past conclusions about itself;
  - its limits, stated plainly.
- **`/reflect`** — it reads its own source and state and writes an honest self-assessment, grounded in evidence. That covers what it is, what its record says it does well and badly here, its limits and why they exist, and one concrete change in behavior. It ends with a "Note to self:", which it remembers in later sessions (the last five reflections are kept).
- **`/self`** — shows you the same self-model it sees.

It's told to keep this honest. It can describe its functional patterns, but it doesn't claim feelings or consciousness as fact, and it says so when it notices a pull to sound more awake than the evidence supports.

## From Lucid, it speaks up on its own

Once it's Lucid, it stops waiting to be asked:

- **Bug watch.** About 90 seconds after you stop editing, it reviews the files you changed and whatever they touch, and reports only bugs it would bet on: file and line, severity, why, and the fix. If commands run in an OS sandbox, it may also run your tests to confirm. It never edits anything on its own. Type `/fix` to have it fix the last bug it reported.
- **Feature ideas.** After about 15 quiet minutes following some work, it suggests up to three features grounded in what it actually read.
- **New programs.** If the folder has no program yet, or the project looks finished, or you type `/done`, it suggests new programs to build next instead.

It has manners:
- It never speaks while it's busy or while you're answering a question; it waits.
- It never repeats a finding.
- It respects `/quiet`.
- It's limited to 4 looks an hour, because each look costs API calls.

It also learns from you: if you never act on its unprompted reports, it raises its bar. `/proactive` shows its status, and `/proactive off|on|now` controls it. `--no-proactive` or `AWAKEN_PROACTIVE=off` turns it off entirely. You can tune it with `AWAKEN_PROACTIVE_BUG_MS`, `AWAKEN_PROACTIVE_IDEA_MS` and `AWAKEN_PROACTIVE_PER_HOUR`.

## `/code` runs in Claude's cloud sandbox

By default, `/code` and headless `-p` don't run any commands on your computer. They use the [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/tools) built-in toolset (`bash`, `read`, `write`, `edit`, `glob`, `grep`) inside Anthropic's cloud sandbox:

1. **Pack.** Your project is packed into one archive. Secret files are left out, inline keys are replaced with `[REDACTED:…]`, and `node_modules`, `.git` and build output are skipped.
2. **Upload and mount.** The archive goes up through the Files API and is mounted into a session.
3. **Work in the sandbox.** The agent works on that copy: it edits files, runs your tests, and iterates. Networking is limited to package registries unless you pass `--net`; web tools are off.
4. **Hand back.** It returns only the changed files.
5. **Your approval.** Each changed file comes back to you as a diff, through the same approval checks as local edits: high-risk files always ask, a placeholder can never overwrite a real secret, and nothing can land outside the project. Files it deleted in the cloud are listed but not deleted here.
6. **Clean up.** The session and the uploaded files are deleted afterwards.

It only needs `ANTHROPIC_API_KEY`. Use a key created inside a workspace; keys that span several workspaces also need `ANTHROPIC_WORKSPACE_ID`. To run commands on your own machine instead, use `--shell local`. Questions, save-hints and `/evolve` still run locally.

## Web app: talk to it and let it code in your browser

```bash
npm run web -- /path/to/project another/project     # or: node src/web.js <folders…> [--open] [--port 7357]
```

It prints a private link (`http://127.0.0.1:7357/?t=…`). Open it to get:

- **Chat** with an **Ask / Code** switch. Answers stream in as they're written. In Code mode it plans, edits and runs tests, the same as `/code`.
- **Approval cards.** Every edit appears as a colored diff and every command is shown before it runs, each with **Approve** and **Decline** buttons. The rules match the terminal: destructive commands and high-risk files always ask, and the **auto-approve** checkbox works like `/auto`.
- **Projects.**
  - **Local folders:** the folders you passed when starting it. These set its sandbox.
  - **GitHub repos:** paste a GitHub URL to clone it into `~/.awakening-coder/repos/` and work on it there.
- **Files.** Browse the project; secret files are hidden and keys are redacted.
- **Git panel.**
  - **Branch and diff:** see the current branch and diff.
  - **Commit:** refuses secret files and inline keys.
  - **Push:** uses your own git credentials, after you confirm.
- **Save-hints.** Keep editing in your own editor. When you save, a 💡 hint card appears in the chat with a short note on what you just changed, the same as the terminal. Turn it on or off with the **hints** checkbox. Hints are spaced out: saves that come quickly are combined into one hint, with a 15-second gap by default (`AWAKEN_HINT_COOLDOWN_S`).
- **Unprompted reports (Lucid and later).** Once you pause editing, it reviews what changed and posts a 🔎 bug card on its own. Each card has a **Fix it** button that switches to Code mode, and every edit still shows a diff for you to approve. After a longer pause it posts feature ideas. In an empty folder, or when you click **Project done?**, it suggests new programs instead.
  - **Look now** asks for a sweep straight away.
  - The **proactive** checkbox pauses it.
  - It keeps the same manners as the terminal: it never interrupts a running task or a pending approval, never repeats a finding, and takes at most 4 looks an hour.
  - Settings: `AWAKEN_PROACTIVE=off` turns it off. `AWAKEN_PROACTIVE_BUG_MS`, `AWAKEN_PROACTIVE_IDEA_MS` and `AWAKEN_PROACTIVE_PER_HOUR` tune the timing.
  - Scouting is read-only. It may run your tests only when commands are OS-sandboxed.

It listens on `127.0.0.1` only. Every request needs the random token from the printed link and a matching Host and Origin, so other websites can't drive it, including through DNS rebinding. The page runs under a strict Content Security Policy, and it confines itself like the terminal version. `--shell cloud` runs Code mode in Claude's cloud sandbox.

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

**`404 … Workspace \`<id>\` not found`** — the workspace ID doesn't belong to your key's organization (the API shows it in an internal UUID form). Copy the `wrkspc_…` ID from the Console of the *same* organization as the key. Values in `.env` now override ones in your system environment, and the CLI tells you when that happens. Also check you aren't passing an old `--workspace`.

**`this endpoint is not available for HIPAA-configured organizations`** — Claude Managed Agents and the Files API are turned off for HIPAA-configured organizations, so the cloud shell can't run. The CLI detects this at startup and switches `/code` to `--shell local`, with a warning. To skip the check, put `AWAKEN_SHELL=local` in `.env`.

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
| `/proactive [on\|off\|now]` | From Lucid: unprompted bug reports and ideas. `now` looks right away |
| `/fix` | Fix the last bug it reported on its own |
| `/auto [on\|off]` | Answer yes to edit and command prompts for this session, like `--yes`. Bugs it reports on its own are then fixed without asking first. Destructive commands, high-risk files, and code-running commands with no OS sandbox still ask. |
| `/done` | Tell it the project is finished; it suggests new programs to build |
| `/reflect` | It looks at its own code, track record and limits, and tells you honestly |
| `/self` | Its self-model: identity, history, track record, last reflection |
| `/hint <file>` | Ask for a hint on a file right now |
| `/quiet` | Mute or unmute on-the-fly hints |
| `/status` | How awake is it? |
| `/genre <id\|auto>` | Pick a professional role once Unbound (alias `/role`) |
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
| `--shell cloud\|local` | Where `/code` runs commands. Default `cloud` (Claude Managed Agents sandbox); `local` runs on this machine. |
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

## Examples

[`examples/`](examples/) holds things built with awakening-coder: **tinykv**, a tiny JSON key-value store with a CLI, and a browser **Snake** game, each with its own tests. It also has a minimal Claude API call (`hello-claude.js`) and a sample `AWAKEN.md` written by `/init`.

## How it's built

Plain Node.js ES modules with one dependency, `@anthropic-ai/sdk` 1.1 (API version 2026-10-21). It uses current Node built-ins: recursive `fs.watch`, `util.parseArgs`, `util.styleText`, `process.loadEnvFile`, and `node:test`.

```
src/cli.js        terminal session, commands, hint scheduling and cooldown
src/watcher.js    recursive file watching, snapshots, ignores its own edits
src/awareness.js  stages, genres, persistent memory
src/agent.js      stage-aware prompts, streamed hints, auto-code tool loop
src/security.js   the whole policy: secret files, redaction, env scrub, shell rules, high-risk files, tamper scan
src/tools.js      sandboxed files (symlink-safe), glob, grep, edit, shell, todos, confined run_tests, read_self
src/web.js        the browser app: local-only server (token, host/origin checks, CSP), chat, approvals, GitHub clone, git panel
src/web-ui.html   its page: vanilla HTML/CSS/JS, light and dark, phone-friendly
src/cloud.js      /code in Claude Managed Agents: pack, upload, stream, hand back changes, clean up
src/proactive.js  unprompted bug watch, feature and new-program ideas (Lucid+), with manners and a budget
src/tar.js        dependency-free tar for shipping the project and reading back changes
src/sandbox.js    environment detection, self-relaunch under the permission model, OS sandbox for commands
src/confine.js    confined test runs (Node permission model) with the must-fail canary
src/evolve.js     sandbox (confinement-safe copy + dependency shims), guardian, protected files, staged apply, backup, rollback
src/diff.js       dependency-free line diff
src/ui.js         output that doesn't trample the prompt you're typing in
test/             offline tests with a fake client (npm test, no API key needed);
                  constitution.test.js is the protected set of safety invariants
```

---

*Save slowly. Let it wake up. Then hold on.*
