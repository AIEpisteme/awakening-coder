// Docker Sandboxes (`sbx`) as the command sandbox when the OS has none of its own (Windows; Linux without
// bubblewrap; any machine where bwrap/sandbox-exec can't start). Each project gets a disposable microVM with its
// own kernel; only the project folder is shared into it, at the same path, and outbound network goes through
// Docker's deny-by-default proxy. https://docs.docker.com/ai/sandboxes/
//
// Lifecycle: at session start we check `sbx` is installed and signed in, then create (or reuse) a "shell"
// sandbox named awaken-<hash of the project path>. Commands then run with
//   sbx exec -w <project path inside the VM> awaken-<hash> sh -c '<command>'
// Git's hooks and config are mounted read-only into it where sbx allows, because git runs those later on the
// host, outside the sandbox. The sandbox is left running for the next session; `sbx rm <name>` removes it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

export const dockerSandboxDisabled = (env = process.env) => /^(off|0|false|no)$/i.test(env.AWAKEN_DOCKER_SANDBOX ?? '');

/** Find the sbx CLI on PATH (sbx.exe on Windows). */
export function findSbx({ env = process.env, platform = process.platform } = {}) {
  const exts = platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, `sbx${ext}`);
      if (exists(p)) return p;
    }
  }
  return null;
}

/** One sandbox per project folder: stable, valid sbx name (letters, digits, hyphens). */
export const sandboxNameFor = (root) => `awaken-${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12)}`;

/** Where the host project folder might appear inside the Linux VM; the first one that's really there wins. */
export function workdirCandidates(root) {
  const out = [root];
  const m = /^([A-Za-z]):[\\/]?(.*)$/.exec(root);
  if (m) {
    const rest = m[2].replace(/\\/g, '/');
    const d = m[1];
    out.push(`${d}:/${rest}`, `/${d.toLowerCase()}/${rest}`, `/mnt/${d.toLowerCase()}/${rest}`, `/${d}/${rest}`);
  } else if (root.includes('\\')) out.push(root.replace(/\\/g, '/'));
  return [...new Set(out.map((p) => p.replace(/\/+$/, '') || '/'))];
}

/** Git paths to mount read-only (git runs hooks/config later, on the host). Makes an empty hooks folder first. */
function gitProtectPaths(root) {
  const git = path.join(root, '.git');
  let st;
  try { st = fs.lstatSync(git); } catch { return []; }
  if (!st.isDirectory()) return [];
  try { fs.mkdirSync(path.join(git, 'hooks'), { recursive: true }); } catch { /* read-only checkout */ }
  return ['hooks', 'config'].map((d) => path.join(git, d)).filter(exists);
}

const firstLine = (r) => String(r?.stderr || r?.stdout || r?.error?.message || '').trim().split('\n').find(Boolean) ?? '';

/**
 * Is Docker Sandboxes usable here at all? Returns { kind: 'sbx', path } or { kind: null, reason }.
 * Cheap: `sbx ls -q` needs the CLI installed, its daemon running and you signed in.
 */
export function probeDockerSandbox({ run = spawnSync, env = process.env, platform = process.platform, sbxPath } = {}) {
  if (dockerSandboxDisabled(env)) return { kind: null, reason: 'turned off with AWAKEN_DOCKER_SANDBOX=off' };
  const bin = sbxPath ?? findSbx({ env, platform });
  if (!bin) return { kind: null, reason: `Docker Sandboxes isn't installed (${platform === 'win32' ? 'winget install -h Docker.sbx' : platform === 'darwin' ? 'brew install docker/tap/sbx' : 'see https://docs.docker.com/ai/sandboxes/install/'}, then sbx login)` };
  const r = run(bin, ['ls', '-q'], { encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) {
    const why = firstLine(r);
    return { kind: null, reason: `Docker Sandboxes is installed but not ready${why ? `: ${why}` : ''}${/log ?in|sign ?in|auth/i.test(why) ? '' : ' (try: sbx login)'}` };
  }
  return { kind: 'sbx', path: bin, names: String(r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean) };
}

/**
 * Create (or reuse) this project's sandbox and find the project path inside it.
 * Returns { name, workdir, gitProtected } — or throws with a plain-language reason (callers fail closed).
 */
export function prepareDockerSandbox(sb, root, { run = spawnSync, log = () => {}, createTimeoutMs = 300_000 } = {}) {
  const name = sandboxNameFor(root);
  let names = sb.names;
  if (!names) {
    const r = run(sb.path, ['ls', '-q'], { encoding: 'utf8', timeout: 30_000 });
    names = r.status === 0 ? String(r.stdout || '').split('\n').map((s) => s.trim()) : [];
  }
  let gitProtected = false;
  if (!names.includes(name)) {
    log(`Starting a Docker Sandbox for ${path.basename(root)} (${name}); the first time can take a minute…`);
    const protect = gitProtectPaths(root);
    const create = (extra) => run(sb.path, ['create', 'shell', '--name', name, '--no-progress', root, ...extra.map((p) => `${p}:ro`)], { encoding: 'utf8', timeout: createTimeoutMs });
    let r = create(protect);
    gitProtected = r.status === 0 && protect.length > 0;
    if (r.status !== 0 && protect.length) { r = create([]); } // some sbx versions/paths reject per-file :ro; still isolate
    if (r.status !== 0) throw new Error(`couldn't create Docker Sandbox ${name}: ${firstLine(r) || `exit ${r.status}`}`);
    sb.names = [...names, name];
  }
  // Find the project inside the VM with a marker file (paths differ on Windows hosts).
  const marker = `.awaken-sbx-${randomBytes(6).toString('hex')}`;
  const hostMarker = path.join(root, marker);
  try {
    fs.writeFileSync(hostMarker, 'probe');
    for (const dir of workdirCandidates(root)) {
      const r = run(sb.path, ['exec', name, 'sh', '-c', 'test -f "$1"', 'sh', `${dir}/${marker}`], { encoding: 'utf8', timeout: 60_000 });
      if (r.status === 0) return { name, workdir: dir, gitProtected };
    }
  } finally { try { fs.rmSync(hostMarker, { force: true }); } catch { /* best effort */ } }
  throw new Error(`Docker Sandbox ${name} is running but the project folder isn't visible inside it`);
}

/** argv to run `cmd` in the project's sandbox. */
export const sbxExecArgs = (prepared, cmd) => ['exec', '-w', prepared.workdir, prepared.name, 'sh', '-c', cmd];
