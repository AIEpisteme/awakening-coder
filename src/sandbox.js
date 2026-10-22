// Knowing its own cage — and building one.
//
// Two layers, both on by default:
//   1. SELF:  awakening-coder re-launches itself under Node's permission model. Its own process can
//             read only the project, its own code and its state folder, and write only the project
//             and its state folder. A bug or a manipulated agent can't read ~/.ssh or write /etc,
//             because the runtime refuses, not just the tool code.
//   2. SHELL: every command the agent runs is wrapped in an OS sandbox — bubblewrap on Linux,
//             sandbox-exec on macOS: read-only system, writable project only, home directory hidden,
//             no network unless --net. If no OS sandbox is available, commands that execute code
//             always need a human, even with --yes.
//
// It also detects what it is running inside (container, VM, WSL, CI) and reports all of this to
// the model honestly, so it knows whether it is sandboxed — and is told never to probe the walls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// ---------- what am I running inside? ----------
export function detectEnvironment() {
  const env = { platform: process.platform, container: null, vm: null, wsl: false, ci: Boolean(process.env.CI), root: process.getuid?.() === 0 };
  if (process.platform === 'linux') {
    const cgroup = read('/proc/1/cgroup');
    if (exists('/.dockerenv')) env.container = 'Docker';
    else if (exists('/run/.containerenv')) env.container = 'Podman';
    else if (process.env.KUBERNETES_SERVICE_HOST) env.container = 'Kubernetes pod';
    else if (process.env.container) env.container = process.env.container;
    else if (/kubepods/.test(cgroup)) env.container = 'Kubernetes pod';
    else if (/docker|containerd|libpod|lxc/.test(cgroup)) env.container = 'container';

    const version = read('/proc/version');
    if (/microsoft/i.test(version)) env.wsl = true;
    const dmi = `${read('/sys/class/dmi/id/product_name')} ${read('/sys/class/dmi/id/sys_vendor')}`;
    const known = dmi.match(/VirtualBox|VMware|QEMU|KVM|Xen|Hyper-V|Microsoft Corporation|Amazon EC2|Google Compute Engine|Parallels|Firecracker|DigitalOcean|OpenStack/i);
    if (known) env.vm = known[0];
    else if (/firecracker|-fc-/i.test(version)) env.vm = 'Firecracker microVM';
    else if (/^flags\s*:.*\bhypervisor\b/m.test(read('/proc/cpuinfo'))) env.vm = 'virtual machine (hypervisor detected)';
  } else if (process.platform === 'darwin' && process.env.APP_SANDBOX_CONTAINER_ID) {
    env.container = 'macOS App Sandbox';
  }
  return env;
}

// ---------- which OS sandbox can wrap shell commands? ----------
function which(bin) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, bin);
    if (exists(p)) return p;
  }
  return null;
}

/** Find a working OS sandbox by actually running a trivial command inside it. */
export function probeOsSandbox() {
  if (process.platform === 'linux') {
    const bwrap = which('bwrap');
    if (!bwrap) return null;
    const r = spawnSync(bwrap, ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-all', '--die-with-parent', '/bin/true'], { timeout: 5000 });
    return r.status === 0 ? { kind: 'bwrap', path: bwrap } : null;
  }
  if (process.platform === 'darwin') {
    const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 });
    return r.status === 0 ? { kind: 'sandbox-exec', path: '/usr/bin/sandbox-exec' } : null;
  }
  return null;
}

// Secret folders hidden from commands even when they sit inside a writable location.
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gcloud', '.config/gh', '.password-store'];

/**
 * Build the argv to run `cmd` inside the OS sandbox. Fails closed: if `os` is null this throws,
 * so a caller can never silently run an "isolated" command unisolated.
 */
export function wrapShell(cmd, { root, os: sb, allowNet = false, home = os.homedir() }) {
  if (!sb) throw new Error('No OS sandbox available');
  const r = real(root);
  const h = home ? real(home) : null;
  if (sb.kind === 'bwrap') {
    const a = ['--die-with-parent', '--new-session', '--unshare-all'];
    if (allowNet) a.push('--share-net');
    a.push('--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');
    // Hide the home directory (keys, tokens, shell history)…
    if (h && h !== '/' && !inside(h, r)) {
      a.push('--tmpfs', h);
      // …but keep the Node toolchain usable if it lives there (nvm, volta, fnm).
      const nodePrefix = path.dirname(path.dirname(real(process.execPath)));
      if (inside(nodePrefix, h) && !inside(r, nodePrefix)) a.push('--ro-bind', nodePrefix, nodePrefix);
    }
    a.push('--bind', r, r);
    // Secret folders stay hidden even if the project is the home directory or contains them.
    for (const base of [r, h].filter(Boolean)) {
      for (const d of SECRET_DIRS) {
        const p = path.join(base, d);
        if (inside(p, r) && exists(p)) a.push('--tmpfs', p);
      }
    }
    a.push('--chdir', r, '/bin/sh', '-c', cmd);
    return { file: sb.path, args: a };
  }
  if (sb.kind === 'sandbox-exec') {
    const secrets = SECRET_DIRS.map((d) => `(subpath (string-append (param "HOME") "/${d}"))`).join(' ');
    const profile = [
      '(version 1)', '(allow default)',
      allowNet ? '' : '(deny network-outbound (remote ip))',
      '(deny file-write*)',
      '(allow file-write* (subpath (param "ROOT")) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/fd/"))',
      `(deny file-read* file-write* ${secrets} (subpath (string-append (param "HOME") "/Library/Keychains")))`,
    ].join('\n');
    return { file: sb.path, args: ['-D', `ROOT=${r}`, '-D', `HOME=${h ?? '/nonexistent'}`, '-p', profile, '/bin/sh', '-c', cmd] };
  }
  throw new Error(`Unknown sandbox kind: ${sb.kind}`);
}

// ---------- confining itself ----------
/** Node flags for the self-sandbox. No wildcards, never the whole home directory. */
export function selfSandboxFlags({ root, selfRoot, stateDir }) {
  const reads = [...new Set([real(root), real(selfRoot), real(stateDir)])];
  const writes = [...new Set([real(root), real(stateDir)])];
  // --allow-child-process is required to run commands at all; Node warns that children escape its model,
  // which is why every agent command is ALSO wrapped in an OS sandbox (and the warning is stated in /sandbox).
  return ['--permission', ...reads.map((p) => `--allow-fs-read=${p}`), ...writes.map((p) => `--allow-fs-write=${p}`), '--allow-child-process', '--disable-warning=SecurityWarning'];
}

/** What the runtime is actually enforcing on THIS process (not what anyone claims). */
export function selfConfinement() {
  const p = process.permission;
  if (!p) return { active: false };
  const home = os.homedir();
  return { active: true, canReadHome: p.has('fs.read', home), canWriteRoot: p.has('fs.write', '/'), canSpawn: p.has('child') };
}

/**
 * Re-launch this program confined, unless it already is (or confinement is disabled).
 * Returns true if a confined child was started — the caller must then do nothing else.
 */
export function relaunchConfined({ root, selfRoot, stateDir, entry, argv }) {
  if (process.permission) return false; // already confined
  if (process.env.AWAKEN_SELF_SANDBOXED === '1') return false; // a relaunch that didn't take; don't loop
  fs.mkdirSync(stateDir, { recursive: true });
  // Detection needs to read /proc, /sys and $PATH, which the confined child can't — do it here and hand it over.
  const info = { environment: detectEnvironment(), os: probeOsSandbox() };
  const child = spawn(process.execPath, [...selfSandboxFlags({ root, selfRoot, stateDir }), entry, ...argv], {
    stdio: 'inherit',
    env: { ...process.env, AWAKEN_SELF_SANDBOXED: '1', AWAKEN_SANDBOX_INFO: JSON.stringify(info) },
  });
  process.on('SIGINT', () => {}); // the child owns Ctrl+C
  child.on('exit', (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
  child.on('error', (e) => { console.error(`Could not start sandboxed: ${e.message}`); process.exit(1); });
  return true;
}

/** Full status for this process: what it's inside, how it's confined, how commands are isolated. */
export function sandboxStatus({ allowNet = false, disabled = false } = {}) {
  let info = null;
  if (process.permission) { try { info = JSON.parse(process.env.AWAKEN_SANDBOX_INFO || 'null'); } catch { info = null; } }
  if (!info) info = { environment: detectEnvironment(), os: disabled ? null : probeOsSandbox() };
  return {
    environment: info.environment ?? detectEnvironment(),
    self: selfConfinement(),
    os: disabled ? null : info.os ?? null,
    allowNet,
    disabled,
  };
}

/** Plain-language report, used for /sandbox and given to the model as verified facts. */
export function describeSandbox(s) {
  const e = s.environment;
  const host = [
    e.container ? `inside a ${e.container}` : null,
    e.vm ? `on a ${e.vm}` : null,
    e.wsl ? 'under WSL' : null,
    e.ci ? 'in CI' : null,
  ].filter(Boolean).join(', ') || 'directly on the host machine, as far as it can tell (no container or VM detected)';
  const self = s.self.active
    ? `confined by Node's permission model — it can read only the project, its own code and its state folder, and write only the project and its state folder${s.self.canReadHome ? ' (WARNING: home directory is readable)' : ''}`
    : `NOT confined${s.disabled ? ' (sandboxing was turned off with --no-sandbox)' : ''} — it runs with the user's full file access`;
  const shell = s.os
    ? `isolated with ${s.os.kind === 'bwrap' ? 'bubblewrap' : 'macOS sandbox-exec'}: read-only system, writable project only, home directory and secret folders hidden, ${s.allowNet ? 'network allowed (--net)' : 'no network'}`
    : `NOT isolated (${s.disabled ? 'sandboxing was turned off with --no-sandbox' : 'no OS sandbox available'}) — every command that executes code needs the developer's approval, even with --yes`;
  return [`Host: ${host}.`, `This process: ${self}.`, `Shell commands: ${shell}.`, e.root ? 'Note: running as root.' : ''].filter(Boolean).join('\n');
}

export const isFullySandboxed = (s) => s.self.active && !s.self.canReadHome && Boolean(s.os);
