// The models and effort levels you can switch between (web menu, /model and /effort).
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', note: 'most capable — complex work', aliases: ['opus'] },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'balanced speed and depth', aliases: ['sonnet'] },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', note: 'fastest and lightest', aliases: ['haiku'] },
];

// Sent as output_config.effort. Higher effort thinks harder and takes longer.
export const EFFORTS = [
  { id: 'low', label: 'Low', note: 'quick answers' },
  { id: 'medium', label: 'Medium', note: 'a bit more thought' },
  { id: 'high', label: 'High', note: 'thorough (default)' },
  { id: 'xhigh', label: 'Extra high', note: 'deeper reasoning', aliases: ['extra', 'x-high', 'extra-high', 'extrahigh'] },
  { id: 'max', label: 'Max', note: 'as much as it takes', aliases: ['maximum'] },
];

export const DEFAULT_EFFORT = 'high';

const find = (list, v) => {
  const s = String(v ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!s) return null;
  return list.find((x) => x.id === s || x.label.toLowerCase().replace(/\s+/g, '-') === s || x.aliases?.includes(s)) ?? null;
};

/** 'opus' | 'Opus 5.5' | 'claude-opus-5-5' → 'claude-opus-5-5'. Other full model ids pass through. */
export function resolveModel(v) {
  const hit = find(MODELS, v);
  if (hit) return hit.id;
  const s = String(v ?? '').trim();
  return /^claude-[a-z0-9.-]+$/.test(s) ? s : null;
}

/** 'extra high' | 'xhigh' | 'Max' → 'xhigh' | 'max'. */
export const resolveEffort = (v) => find(EFFORTS, v)?.id ?? null;

export const modelLabel = (id) => MODELS.find((m) => m.id === id)?.label ?? id;
export const effortLabel = (id) => EFFORTS.find((e) => e.id === id)?.label ?? id ?? 'default';
