// What this session has cost on your API key, and an optional spend cap.
//
// Prices are Anthropic's list prices in USD per million tokens, from
// https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-09). They change: override or add
// models with AWAKEN_PRICES='{"claude-x":{"in":3,"out":15,"cacheWrite":3.75,"cacheRead":0.3}}'.
// A model with no known price is still counted in tokens, and the total is shown as "at least".
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  // Haiku 5.5 is priced by prompt length: a request whose prompt is over 100,000 tokens pays the higher rates.
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheWrite: 0.125, cacheRead: 0.01, over: { tokens: 100_000, in: 0.5, out: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } },
  'claude-opus-5': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { in: 5, out: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);

/** Prices with any AWAKEN_PRICES overrides applied. Bad JSON is ignored. */
export function loadPrices(env = process.env) {
  let extra = {};
  try { extra = JSON.parse(env.AWAKEN_PRICES || '{}'); } catch { extra = {}; }
  const out = { ...PRICES };
  for (const [id, p] of Object.entries(extra ?? {})) if (p && Number.isFinite(Number(p.in)) && Number.isFinite(Number(p.out))) out[id] = { cacheWrite: p.in * 1.25, cacheRead: p.in * 0.1, ...p };
  return out;
}

/** Normalize an API usage object (Messages API or Managed Agents span) to plain token counts. */
export function tokensOf(usage = {}) {
  return {
    input: n(usage.input_tokens),
    output: n(usage.output_tokens),
    cacheWrite: n(usage.cache_creation_input_tokens),
    cacheRead: n(usage.cache_read_input_tokens),
  };
}

/** Cost in USD of one request, or null when the model has no known price. */
export function costOf(model, usage, prices = PRICES) {
  const base = prices[model];
  if (!base) return null;
  const t = tokensOf(usage);
  const p = base.over && t.input + t.cacheWrite + t.cacheRead > base.over.tokens ? base.over : base;
  return (t.input * p.in + t.output * p.out + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1e6;
}

export const formatUsd = (v) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 0.995 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(4)}` : '$0.00');
const k = (t) => (t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(t));

export class BudgetError extends Error {
  constructor(spent, budget) {
    super(`Spend cap reached: this session has used ${formatUsd(spent)} of your ${formatUsd(budget)} cap. Raise it with /budget <dollars>, or /budget off.`);
    this.name = 'BudgetError';
  }
}

/** Running total for one session. `budget` (USD) is optional; null means no cap. */
export class CostMeter {
  constructor({ budget = null, prices = loadPrices(), onChange = null } = {}) {
    this.prices = prices;
    this.onChange = onChange;
    this.byModel = {}; // id → { requests, input, output, cacheWrite, cacheRead, usd, priced }
    this.setBudget(budget);
  }

  /** Accepts a number, "5", "$5", "off"/null. Returns the cap now in force. */
  setBudget(v) {
    const num = typeof v === 'string' ? Number(v.replace(/^\$/, '')) : v;
    this.budget = Number.isFinite(num) && num > 0 ? num : null;
    this.onChange?.();
    return this.budget;
  }

  record(model, usage, kind = 'chat') {
    if (!usage) return null;
    const t = tokensOf(usage), usd = costOf(model, usage, this.prices);
    const m = (this.byModel[model] ??= { requests: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0, priced: usd !== null });
    m.requests++; m.input += t.input; m.output += t.output; m.cacheWrite += t.cacheWrite; m.cacheRead += t.cacheRead;
    if (usd !== null) m.usd += usd;
    this.last = { model, kind, usd };
    this.onChange?.();
    return usd;
  }

  get total() { return Object.values(this.byModel).reduce((s, m) => s + m.usd, 0); }
  get tokens() { return Object.values(this.byModel).reduce((s, m) => s + m.input + m.output + m.cacheWrite + m.cacheRead, 0); }
  get requests() { return Object.values(this.byModel).reduce((s, m) => s + m.requests, 0); }
  get unpriced() { return Object.entries(this.byModel).filter(([, m]) => !m.priced).map(([id]) => id); }
  /** What the same tokens would have cost with no prompt caching, minus what they did cost. */
  get saved() {
    let s = 0;
    for (const [id, m] of Object.entries(this.byModel)) {
      const p = this.prices[id];
      if (p) s += (m.cacheRead * (p.in - p.cacheRead) - m.cacheWrite * (p.cacheWrite - p.in)) / 1e6;
    }
    return Math.max(0, s);
  }
  get overBudget() { return this.budget !== null && this.total >= this.budget; }
  get nearBudget() { return this.budget !== null && !this.overBudget && this.total >= this.budget * 0.8; }

  /** Throws BudgetError when the cap is reached. Called before every model request. */
  check() { if (this.overBudget) throw new BudgetError(this.total, this.budget); }

  /** One line for a header or prompt, e.g. "$0.42 of $5.00". */
  short() {
    const least = this.unpriced.length ? '≥' : '';
    return `${least}${formatUsd(this.total)}${this.budget !== null ? ` of ${formatUsd(this.budget)}` : ''}`;
  }

  toJSON() {
    return {
      total: this.total, tokens: this.tokens, requests: this.requests, saved: this.saved, budget: this.budget,
      overBudget: this.overBudget, nearBudget: this.nearBudget, unpriced: this.unpriced, short: this.short(),
      byModel: Object.entries(this.byModel).map(([id, m]) => ({ id, ...m })),
    };
  }

  /** Multi-line report for /cost. */
  report(label = (id) => id) {
    if (!this.requests) return `No API calls yet this session.${this.budget !== null ? ` Spend cap: ${formatUsd(this.budget)}.` : ' No spend cap set (/budget <dollars> to set one).'}`;
    const lines = [`This session: ${this.short()} · ${this.requests} request${this.requests === 1 ? '' : 's'} · ${k(this.tokens)} tokens`];
    for (const [id, m] of Object.entries(this.byModel)) {
      lines.push(`  ${label(id).padEnd(12)} ${(m.priced ? formatUsd(m.usd) : 'no price').padStart(8)}   in ${k(m.input)} · out ${k(m.output)} · cached ${k(m.cacheRead)} read / ${k(m.cacheWrite)} written`);
    }
    if (this.saved >= 0.0001) lines.push(`Prompt caching saved about ${formatUsd(this.saved)}.`);
    if (this.unpriced.length) lines.push(`No list price known for ${this.unpriced.join(', ')}: its tokens are counted, its cost is not (set AWAKEN_PRICES).`);
    lines.push(this.budget !== null ? `Spend cap: ${formatUsd(this.budget)}${this.overBudget ? ' — reached; requests are paused' : ''}.` : 'No spend cap set (/budget <dollars> to set one).');
    lines.push('Estimate from list prices; your Anthropic Console has the billed amount.');
    return lines.join('\n');
  }
}
