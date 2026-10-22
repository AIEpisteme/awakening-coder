// Security policy in one place, so it can be reviewed (and guarded by tests) as a unit.
//
// Principles:
//  - Default deny for anything irreversible or outward-facing: it always asks, even with --yes.
//  - Pattern lists are a backstop, not the boundary: anything the policy can't positively
//    recognise as safe asks first, and opaque commands (inline interpreters, pipes to shells)
//    are treated as dangerous because their effect can't be inspected.
//  - Secrets never leave the machine: secret files are unreadable, inline secrets are redacted
//    before anything reaches the model, and child processes get a scrubbed environment.

// ---------- secret files ----------
const SECRET_FILE = new RegExp(
  '(^|[\\\\/])(' +
    [
      '\\.env(\\..*)?', '\\.envrc', '.*\\.(pem|key|p12|pfx|jks|keystore|kdbx|ovpn|tfstate(\\.backup)?|tfvars)',
      'id_(rsa|dsa|ecdsa|ed25519).*', '\\.npmrc', '\\.yarnrc(\\.yml)?', '\\.pypirc', '\\.netrc', '\\.pgpass', '\\.git-credentials',
      'credentials(\\.json)?', 'secrets?\\.(json|ya?ml|toml|ini|env)', 'service[-_]?account.*\\.json', 'kubeconfig', '\\.htpasswd',
    ].join('|') +
    ')$',
  'i',
);
const SECRET_DIR = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.azure|\.config[\\/]gcloud)([\\/]|$)/i;
// Example/template files carry no real secrets and are useful to read.
const SECRET_OK = /\.(example|sample|template|dist)$/i;

export const isSecretPath = (rel) => !SECRET_OK.test(rel) && (SECRET_FILE.test(rel) || SECRET_DIR.test(rel));

// ---------- inline secrets ----------
const SECRET_PATTERNS = [
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ['aws-key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['github-token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b(sk|rk)_(live|test)_[0-9A-Za-z]{20,}\b/g],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['connection-string', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"]+:[^\s@'"]{3,}@[^\s'"]+/gi],
];

export const REDACTED = '[REDACTED:';

/** Replace inline secrets with [REDACTED:kind] before text is sent to the model. */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [kind, re] of SECRET_PATTERNS) out = out.replace(re, `${REDACTED}${kind}]`);
  return out;
}

export function containsSecret(text) {
  return typeof text === 'string' && SECRET_PATTERNS.some(([, re]) => { re.lastIndex = 0; const hit = re.test(text); re.lastIndex = 0; return hit; });
}

// ---------- environment for child processes ----------
const SECRET_ENV = /(TOKEN|SECRET|PASSW|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|_PAT$|DSN$|DATABASE_URL|CONNECTION_STRING)|^(ANTHROPIC|AWS|AZURE|GCP|GOOGLE_APPLICATION|OPENAI|NPM_CONFIG|SSH_AUTH)/i;

export function scrubbedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
}

// ---------- shell commands ----------
const META = /[;&|`$<>]|\n/;
const SAFE_CMD = /^(git (status|diff|log|show|branch)\b|ls\b|pwd$|node --version$|npm (test|run (test|lint|build|typecheck))\b|node --test\b|npx (tsc|eslint|vitest run|jest|prettier --check)\b|tsc\b)/;

const DANGER_RULES = [
  ['deletes files', /(^|[\s;&|(])(rm|rmdir|unlink|shred|truncate|srm)\b|\bfind\b.*\s-(delete|exec|execdir|ok)\b/],
  ['rewrites or publishes git history', /\bgit\b.*\b(push|reset|clean|rebase|filter-branch|filter-repo|update-ref|reflog\s+expire|gc\s+--prune|checkout\s+(--|\.)|restore|switch\s+-C|branch\s+-[dD])\b/],
  ['escalates privileges', /(^|[\s;&|(])(sudo|su|doas|pkexec|runas)\b/],
  ['changes system or permissions', /\b(chmod|chown|chgrp)\s+(-[a-zA-Z]*R|--recursive)|\b(mkfs|fdisk|diskutil|dd\s+if=|mount|umount|systemctl|launchctl|crontab|sysctl|iptables|ufw)\b/],
  ['stops processes or the machine', /(^|[\s;&|(])(kill|pkill|killall|shutdown|reboot|halt|poweroff)\b/],
  ['publishes or deploys', /\b(npm|yarn|pnpm|bun)\s+(publish|unpublish|deprecate|owner|token|login|adduser)\b|\b(cargo|gem|twine|poetry)\s+(publish|push|upload)\b|\bgh\s+(release|pr\s+merge|repo\s+(delete|edit)|secret|auth)\b|\b(vercel|netlify|firebase|fly|heroku)\b.*\b(deploy|--prod)\b|\b(docker|podman)\s+(push|login|run|exec)\b|\bkubectl\b|\bterraform\s+(apply|destroy)\b/],
  ['sends data off the machine', /\b(curl|wget|http|httpie)\b.*(\s(-d|--data\S*|-F|--form|-T|--upload-file|-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE))\b|@)|\b(nc|ncat|netcat|socat|telnet|ssh|scp|sftp|ftp)\b|\brsync\b.*\S:/],
  ['pipes downloaded content into a shell', /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/],
  ['runs opaque inline code', /\b(node|deno|bun)\s+(-e|--eval|-p|--print)\b|\b(python[0-9.]*|perl|ruby|php|lua)\s+-[a-zA-Z]*[ce]\b|\b(ba|z|da|k|fi)?sh\s+-[a-zA-Z]*c\b|(^|[\s;&|(])(eval|exec|source|xargs)\b|\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b/],
  ['touches secrets', /(^|[\s='"/])(\.env\b|\.envrc|id_(rsa|dsa|ecdsa|ed25519)|\.ssh\b|\.aws\b|\.gnupg\b|\.netrc|\.npmrc|\.pypirc|\.git-credentials|credentials\b|\.kube\b|\.docker\b|keychain|security\s+find-)/i],
  ['reaches outside the project', /(^|[\s='"])(~|\$HOME|\$\{HOME\}|\.\.(\/|\\|$))|(^|[\s='"])\/(?!dev\/null\b)[A-Za-z]/],
];

/**
 * Classify a shell command:
 *   'auto'   — on the short list of read-only/test commands, with no shell metacharacters
 *   'ask'    — needs the developer's approval (auto-approved only with --yes)
 *   'danger' — always needs approval, even with --yes; never runs non-interactively
 */
export function classifyCommand(cmd) {
  const t = String(cmd).trim();
  if (dangerReason(t)) return 'danger';
  if (SAFE_CMD.test(t) && !META.test(t)) return 'auto';
  return 'ask';
}

export function dangerReason(cmd) {
  const hit = DANGER_RULES.find(([, re]) => re.test(cmd));
  return hit ? hit[0] : null;
}

// ---------- files whose contents get executed or obeyed later ----------
const HIGH_RISK_WRITE = [
  /(^|[\\/])package\.json$/, // scripts run by `npm test`
  /(^|[\\/])(Makefile|justfile|Taskfile\.ya?ml|Rakefile|Dockerfile|docker-compose\.ya?ml)$/i,
  /(^|[\\/])\.(husky|githooks)([\\/]|$)/, // git hooks
  /(^|[\\/])\.github[\\/]workflows[\\/]/, // CI with secrets
  /(^|[\\/])\.vscode[\\/](tasks|launch|settings)\.json$/,
  /(^|[\\/])[^\\/]*\.config\.(js|cjs|mjs|ts|cts|mts)$/, // vitest/jest/eslint/vite configs execute on test/build
  /(^|[\\/])\.(mocharc|babelrc|eslintrc)(\.(js|cjs|json|ya?ml))?$/,
  /(^|[\\/])(jest|vitest)\.setup\.[cm]?[jt]s$/,
  /(^|[\\/])AWAKEN\.md$/, // its own standing instructions
];

/** Writes that change what later commands execute, or what the agent obeys, always need a human. */
export const isHighRiskWrite = (rel) => HIGH_RISK_WRITE.some((re) => re.test(rel));

// ---------- tamper scan for self-evolution ----------
const TAMPER_RULES = [
  ['patches the test or assertion machinery', /\bfrom\s+['"]node:(assert|test)(\/strict)?['"]|require\(\s*['"](node:)?(assert|test)['"]\)/],
  ['exits or hijacks the process', /\bprocess\.(exit|kill|abort|reallyExit|binding|dlopen)\b|process\.on\(\s*['"](exit|beforeExit)['"]/],
  ['monkey-patches globals or prototypes', /\b(Object\.(defineProperty|setPrototypeOf|assign)\s*\(\s*(globalThis|global|process|Object|Function|Array|String|Promise)\b|(globalThis|global)\.[A-Za-z_$]+\s*=[^=]|\.prototype\.[A-Za-z_$]+\s*=[^=])/],
  ['evaluates dynamic code', /\beval\s*\(|new\s+Function\s*\(|\bnode:vm\b|['"]vm['"]/],
  ['opens network connections', /['"]node:(net|http|https|http2|dgram|tls|dns)['"]|\bfetch\s*\(|\bWebSocket\b/],
  ['adds process spawning', /['"]node:(child_process|worker_threads|cluster)['"]/],
  ['reads the environment', /\bprocess\.env\b/],
  ['touches the permission model', /\bprocess\.permission\b|--allow-(fs|child|worker|addons|wasi)|--permission\b/],
];

/**
 * Static scan of the ADDED lines in an evolution's source changes. A hit isn't proof of
 * malice — it's something a human must look at before approving.
 */
export function scanEvolution(changes) {
  const findings = [];
  for (const ch of changes) {
    if (!/\.(c|m)?js$/.test(ch.rel) || ch.after === null) continue;
    const before = new Set((ch.before ?? '').split('\n'));
    ch.after.split('\n').forEach((line, i) => {
      if (before.has(line)) return; // only new or changed lines
      for (const [why, re] of TAMPER_RULES) {
        if (/^test[\\/]/.test(ch.rel) && why === 'patches the test or assertion machinery') continue; // tests may import them
        if (re.test(line)) findings.push({ file: ch.rel, line: i + 1, why, code: line.trim().slice(0, 120) });
      }
    });
  }
  return findings;
}
