// Tiny dependency-free line diff (LCS) good enough for "what did you just change?"

export function unifiedDiff(before = '', after = '', { context = 2, maxCells = 4_000_000, maxLines = 120 } = {}) {
  if (before === after) return '';
  const A = before.split('\n');
  const B = after.split('\n');

  // Trim the common prefix/suffix so LCS only runs on the edited region.
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(s, ea), b = B.slice(s, eb);
  const n = a.length, m = b.length;

  const out = [`@@ -${s + 1},${n} +${s + 1},${m} @@`];
  for (let i = Math.max(0, s - context); i < s; i++) out.push(' ' + A[i]);

  if (n * m > maxCells) {
    // Too big to align cheaply: show it as a block replace.
    a.slice(0, maxLines / 2).forEach((l) => out.push('-' + l));
    b.slice(0, maxLines / 2).forEach((l) => out.push('+' + l));
  } else {
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);

    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push(' ' + a[i]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) ops.push('-' + a[i++]);
      else ops.push('+' + b[j++]);
    }
    while (i < n) ops.push('-' + a[i++]);
    while (j < m) ops.push('+' + b[j++]);

    // Collapse long unchanged runs inside the edited region.
    for (let k = 0; k < ops.length; ) {
      if (ops[k][0] !== ' ') { out.push(ops[k++]); continue; }
      let r = k;
      while (r < ops.length && ops[r][0] === ' ') r++;
      const run = ops.slice(k, r);
      if (run.length > context * 2 + 1) out.push(...run.slice(0, context), ' …', ...run.slice(-context));
      else out.push(...run);
      k = r;
    }
  }

  for (let i = ea; i < Math.min(A.length, ea + context); i++) out.push(' ' + A[i]);
  if (out.length > maxLines) return out.slice(0, maxLines).join('\n') + `\n… (${out.length - maxLines} more diff lines)`;
  return out.join('\n');
}

export function changedLineCount(diff) {
  return diff.split('\n').filter((l) => (l[0] === '+' || l[0] === '-') && !l.startsWith('@@')).length;
}
