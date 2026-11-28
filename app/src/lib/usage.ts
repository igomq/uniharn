import type { Json } from './types.ts';

/** Self-serve quota, remaining credits and reset time live here; the Devin CLI does not report them. */
export const USAGE_URL = 'https://app.devin.ai/settings/usage';

export const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(n));

// The usage report from `usage.list` and `usage.update` (gateway/src/usage.ts). Official values come from the
// harness account or the Devin quota API; manual values are what the user entered; session values are counted
// by the gateway from session token reports since it started.
export type UsageSource = 'official' | 'manual' | 'session' | 'none';
export interface UsageTokens {
  input: number;
  output: number;
  cachedRead: number;
  total: number;
}
export interface UsageWindow {
  id: string;
  label: string;
  remainingPercent: number;
  resetsAt?: string | null;
}
export interface ManualUsage {
  accountLabel: string | null;
  plan: string | null;
  credit: string | null;
  note: string | null;
  preferredUseCase: string | null;
  usagePercent: number | null;
  tokens: UsageTokens | null;
  resetAt: string | null;
}
export interface HarnessUsage {
  harnessId: string;
  name: string;
  custom: boolean;
  enabled: boolean;
  installed: boolean;
  version: string | null;
  auth: { status: string; method: string | null; checkedAt: string | null; expiresAt: string | null; detail: string | null };
  accountLabel: string | null;
  plan: string | null;
  /** `remaining` is true when `percent` counts what is left (official quota) and false when it counts what is used. */
  usage: { kind: 'percent' | 'tokens' | 'none'; percent: number | null; remaining: boolean; tokens: UsageTokens | null; source: UsageSource };
  windows: UsageWindow[];
  reset: { at: string; source: 'official' | 'manual'; windowId: string | null; label: string | null } | null;
  credit: string | null;
  note: string | null;
  preferredUseCase: string | null;
  manual: ManualUsage | null;
  sources: { accountLabel: UsageSource; plan: UsageSource; usage: UsageSource; reset: UsageSource };
  sessions: { count: number; running: number; tokens: UsageTokens; lastUsedAt: number | null };
  delegations: { count: number; running: number; done: number; error: number; lastAt: number | null };
  updatedAt: string | null;
}
export interface UsageReport {
  generatedAt: string;
  harnesses: HarnessUsage[];
  sessions: { sessionId: string; harnessId: string; title: string | null; cwd: string; status: string; updatedAt: number; tokens: UsageTokens }[];
  delegations: { id: string; harnessId: string; parentSessionId: string; childSessionId: string; status: string; model: string | null; createdAt: number; updatedAt: number }[];
  officialError: string | null;
}

/** The manual-entry form for one harness. Empty text clears a field; numbers stay text until saved. */
export interface ManualForm {
  accountLabel: string;
  plan: string;
  credit: string;
  note: string;
  preferredUseCase: string;
  usagePercent: string;
  input: string;
  output: string;
  cachedRead: string;
  /** datetime-local value, local time. */
  resetAt: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
function localInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export function manualForm(manual: ManualUsage | null): ManualForm {
  const tokens = manual?.tokens;
  return {
    accountLabel: manual?.accountLabel ?? '',
    plan: manual?.plan ?? '',
    credit: manual?.credit ?? '',
    note: manual?.note ?? '',
    preferredUseCase: manual?.preferredUseCase ?? '',
    usagePercent: manual?.usagePercent == null ? '' : String(manual.usagePercent),
    input: tokens ? String(tokens.input) : '',
    output: tokens ? String(tokens.output) : '',
    cachedRead: tokens ? String(tokens.cachedRead) : '',
    resetAt: localInput(manual?.resetAt ?? null)
  };
}

/**
 * The `manual` patch for `usage.update`, or an error message. Every field is sent: an empty field is sent as null,
 * which the gateway treats as "clear". Token counts must be whole numbers; the percentage is 0 to 100.
 */
export function manualPatch(form: ManualForm): { patch: Json } | { problem: string } {
  const percent = form.usagePercent.trim();
  if (percent && !(Number(percent) >= 0 && Number(percent) <= 100)) return { problem: 'Usage must be a percentage from 0 to 100.' };
  const tokens: Record<string, number | null> = {};
  for (const key of ['input', 'output', 'cachedRead'] as const) {
    const value = form[key].trim();
    if (value && !/^\d+$/.test(value)) return { problem: 'Token counts must be whole numbers.' };
    tokens[key] = value ? Number(value) : null;
  }
  const resetAt = form.resetAt ? new Date(form.resetAt) : null;
  if (resetAt && !Number.isFinite(resetAt.getTime())) return { problem: 'Pick a valid reset time.' };
  const textOrNull = (value: string) => value.trim() || null;
  return {
    patch: {
      accountLabel: textOrNull(form.accountLabel),
      plan: textOrNull(form.plan),
      credit: textOrNull(form.credit),
      note: textOrNull(form.note),
      preferredUseCase: textOrNull(form.preferredUseCase),
      usagePercent: percent ? Number(percent) : null,
      tokens: Object.values(tokens).some((v) => v !== null) ? tokens : null,
      resetAt: resetAt ? resetAt.toISOString() : null
    }
  };
}

export const SOURCE_LABEL: Record<UsageSource, string> = { official: 'Official', manual: 'Manual', session: 'Sessions', none: 'Not reported' };
