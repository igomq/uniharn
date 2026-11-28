import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { formatScopedSessionId, type HarnessRegistry } from './harnesses/registry.js';
import type { DevinUsage } from './harnesses/devin-usage.js';
import type { SessionSummary } from './sessions.js';
import { summarizeLink, type Orchestrator } from './orchestrator.js';

type TokenValues = { input: number; output: number; cachedRead: number; total: number };
type ManualTokens = { input?: number; output?: number; cachedRead?: number };
type Manual = { accountLabel?: string; plan?: string; credit?: string; note?: string; preferredUseCase?: string; usagePercent?: number; tokens?: ManualTokens; resetAt?: string };
type RecordState = { manual: Manual; updatedAt: string | null };
type Account = { loggedIn: boolean; fields: { label: string; value: string }[]; usage: DevinUsage | null; usageError: string | null; auth: { status: string; detail: string | null } };
type LiveSession = { sessionId: string; harnessId: string; title: string | null; cwd: string; status: string; updatedAt: number; tokens: TokenValues };

const emptyTokens = (): TokenValues => ({ input: 0, output: 0, cachedRead: 0, total: 0 });
const tokenValues = (t: ManualTokens): TokenValues => {
  const input = t.input ?? 0, output = t.output ?? 0, cachedRead = t.cachedRead ?? 0;
  return { input, output, cachedRead, total: input + output };
};
const fields = { accountLabel: 120, plan: 80, credit: 200, note: 500, preferredUseCase: 120 } as const;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isClear = (value: unknown) => value === null || value === '';
function isoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === `${year}-${month}-${day}`
    && +hour < 24 && +minute < 60 && +second < 60 && (!offsetHour || (+offsetHour < 24 && +offsetMinute < 60))
    && Number.isFinite(Date.parse(value));
}

/** Validate a sparse patch before touching either memory or disk. */
function mergeManual(old: Manual, patch: unknown): Manual {
  if (patch === null) return {};
  if (!isObject(patch)) throw new Error('manual must be an object or null');
  const next: Manual = { ...old, ...(old.tokens ? { tokens: { ...old.tokens } } : {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(fields, key) && !['usagePercent', 'tokens', 'resetAt'].includes(key)) throw new Error(`Unknown manual field: ${key}`);
    if (Object.hasOwn(fields, key)) {
      if (isClear(value)) delete next[key as keyof typeof fields];
      else if (typeof value !== 'string' || value.length > fields[key as keyof typeof fields]) throw new Error(`Invalid manual.${key}`);
      else next[key as keyof typeof fields] = value;
    } else if (key === 'usagePercent') {
      if (isClear(value)) delete next.usagePercent;
      else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('Invalid manual.usagePercent');
      else next.usagePercent = value;
    } else if (key === 'resetAt') {
      if (isClear(value)) delete next.resetAt;
      else if (!isoDate(value)) throw new Error('Invalid manual.resetAt');
      else next.resetAt = new Date(value).toISOString();
    } else if (key === 'tokens') {
      if (isClear(value)) { delete next.tokens; continue; }
      if (!isObject(value)) throw new Error('Invalid manual.tokens');
      const tokens = { ...next.tokens };
      for (const [name, count] of Object.entries(value)) {
        if (!['input', 'output', 'cachedRead'].includes(name)) throw new Error(`Unknown manual.tokens field: ${name}`);
        const tokenKey = name as keyof ManualTokens;
        if (isClear(count)) delete tokens[tokenKey];
        else if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid manual.tokens.${name}`);
        else tokens[tokenKey] = count;
      }
      if (Object.keys(tokens).length) next.tokens = tokens;
      else delete next.tokens;
    }
  }
  return next;
}

export class UsageCenter {
  private file: string;
  private records = new Map<string, RecordState>();
  private live = new Map<string, { session: LiveSession; previous: TokenValues }>();

  constructor(dataDir: string, private registry: HarnessRegistry, private orchestrator: Orchestrator, private accountInfo: (refresh: boolean) => Promise<Account>) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, 'usage.json');
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      // Accept both the current envelope and earlier plain per-harness records.
      const records = isObject(data) && isObject(data.harnesses) ? data.harnesses : data;
      if (isObject(records)) for (const [id, raw] of Object.entries(records)) {
        if (!isObject(raw)) continue;
        try {
          const manual = mergeManual({}, isObject(raw.manual) ? raw.manual : raw);
          if (Object.keys(manual).length) this.records.set(id, { manual, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null });
        } catch { /* Ignore invalid legacy records without losing other harnesses. */ }
      }
    } catch { /* Missing or corrupt state does not prevent startup. */ }
    registry.on('state', (s: SessionSummary) => this.observe(s));
    registry.on('deleted', (id: string) => this.live.delete(id));
  }

  private observe(s: SessionSummary) {
    const id = formatScopedSessionId(s.harnessId, s.sessionId);
    const prev = this.live.get(id);
    const clean = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
    const current = tokenValues({ input: clean(s.tokens?.inputTokens), output: clean(s.tokens?.outputTokens), cachedRead: clean(s.tokens?.cachedReadTokens) });
    const cumulative = emptyTokens();
    for (const key of ['input', 'output', 'cachedRead'] as const) {
      const before = prev?.previous[key] ?? 0;
      cumulative[key] = (prev?.session.tokens[key] ?? 0) + (current[key] >= before ? current[key] - before : current[key]);
    }
    cumulative.total = cumulative.input + cumulative.output;
    this.live.set(id, { session: { sessionId: id, harnessId: s.harnessId, title: s.title, cwd: s.cwd, status: s.status, updatedAt: s.updatedAt, tokens: cumulative }, previous: current });
  }

  update(id: string, manual: unknown, reset: unknown) {
    if (!this.registry.get(id)) throw new Error(`Unknown harness: ${id}`);
    if (reset !== undefined && typeof reset !== 'boolean') throw new Error('reset must be a boolean');
    // Validate even if reset is set; a reset takes precedence over a valid patch.
    const previous = this.records.get(id)?.manual ?? {};
    const merged = manual === undefined ? previous : mergeManual(previous, manual);
    const result = reset === true ? {} : merged;
    if (isDeepStrictEqual(previous, result)) return;
    const next = new Map(this.records);
    if (Object.keys(result).length) next.set(id, { manual: result, updatedAt: new Date().toISOString() });
    else next.delete(id);
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, harnesses: Object.fromEntries(next) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(tmp, this.file);
    } finally {
      try { unlinkSync(tmp); } catch { /* rename already removed it */ }
    }
    this.records = next;
  }

  async report(refresh = false) {
    if (refresh) await this.registry.probeAll();
    let account: Account | null = null;
    let officialError: string | null = null;
    try {
      account = await this.accountInfo(refresh);
      officialError = account.usageError ?? (!account.loggedIn ? account.auth.detail ?? `Devin authentication status: ${account.auth.status}` : null);
    } catch (e) { officialError = e instanceof Error ? e.message : String(e); }
    const sessions = [...this.live.values()].map((v) => v.session).sort((a, b) => b.updatedAt - a.updatedAt);
    const links = this.orchestrator.list().filter((l) => l.kind === 'delegate').sort((a, b) => b.createdAt - a.createdAt);
    const now = Date.now();
    const harnesses = this.registry.list().map((h) => {
      const record = this.records.get(h.id);
      const manual = record?.manual;
      const ownSessions = sessions.filter((s) => s.harnessId === h.id);
      const ownLinks = links.filter((l) => l.harnessId === h.id);
      const totals = emptyTokens();
      for (const s of ownSessions) for (const key of ['input', 'output', 'cachedRead', 'total'] as const) totals[key] += s.tokens[key];
      const official = h.id === 'devin' ? account?.usage : null;
      const accountFields = h.auth.account ?? [];
      const field = (labels: string[]) => labels.map((label) => accountFields.find((f) => f.label.toLowerCase() === label)?.value).find(Boolean) ?? null;
      const label = field(['email', 'name', 'organization', 'providers']);
      const plan = official?.plan ?? field(['plan', 'tier', 'subscriptiontype', 'plantier']);
      const windows = official?.windows ?? [];
      const window = windows.filter((w) => w.resetsAt && Date.parse(w.resetsAt) > now).sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))[0];
      const officialPercent = windows.length ? Math.min(...windows.map((w) => w.remainingPercent)) : null;
      const source = officialPercent !== null ? 'official' : manual?.usagePercent !== undefined || manual?.tokens ? 'manual' : totals.total || totals.cachedRead ? 'session' : 'none';
      const usage = source === 'official' ? { kind: 'percent', percent: officialPercent, remaining: true, tokens: null, source }
        : source === 'manual' && manual?.usagePercent !== undefined ? { kind: 'percent', percent: manual.usagePercent, remaining: false, tokens: null, source }
        : source === 'manual' ? { kind: 'tokens', percent: null, remaining: false, tokens: tokenValues(manual!.tokens!), source }
        : source === 'session' ? { kind: 'tokens', percent: null, remaining: false, tokens: totals, source }
        : { kind: 'none', percent: null, remaining: false, tokens: null, source };
      const reset = window ? { at: window.resetsAt!, source: 'official', windowId: window.id, label: window.label } : manual?.resetAt ? { at: manual.resetAt, source: 'manual', windowId: null, label: null } : null;
      const lastDelegationAt = ownLinks.reduce((latest, link) => Math.max(latest, link.updatedAt), 0);
      return {
        harnessId: h.id, name: h.name, custom: h.custom, enabled: h.enabled, installed: h.installed, version: h.version,
        auth: { status: h.auth.status, method: h.auth.method, checkedAt: h.auth.checkedAt, expiresAt: h.auth.expiresAt, detail: h.auth.detail },
        accountLabel: label ?? manual?.accountLabel ?? null, plan: plan ?? manual?.plan ?? null, usage, windows, reset,
        credit: manual?.credit ?? null, note: manual?.note ?? null, preferredUseCase: manual?.preferredUseCase ?? null,
        manual: manual ? { accountLabel: manual.accountLabel ?? null, plan: manual.plan ?? null, credit: manual.credit ?? null, note: manual.note ?? null, preferredUseCase: manual.preferredUseCase ?? null, usagePercent: manual.usagePercent ?? null, tokens: manual.tokens ? tokenValues(manual.tokens) : null, resetAt: manual.resetAt ?? null } : null,
        sources: { accountLabel: label ? 'official' : manual?.accountLabel ? 'manual' : 'none', plan: plan ? 'official' : manual?.plan ? 'manual' : 'none', usage: source, reset: reset?.source ?? 'none' },
        sessions: { count: ownSessions.length, running: ownSessions.filter((s) => s.status === 'running' || s.status === 'awaiting_permission').length, tokens: totals, lastUsedAt: ownSessions[0]?.updatedAt ?? null },
        delegations: { count: ownLinks.length, running: ownLinks.filter((l) => l.status === 'running').length, done: ownLinks.filter((l) => l.status === 'done').length, error: ownLinks.filter((l) => l.status === 'error').length, lastAt: ownLinks.length ? lastDelegationAt : null },
        updatedAt: record?.updatedAt ?? null,
      };
    });
    return { generatedAt: new Date().toISOString(), harnesses, sessions: sessions.slice(0, 100), delegations: links.slice(0, 100).map(summarizeLink), officialError };
  }
}
