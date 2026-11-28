import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, SessionSummary } from '../sessions.js';
import type { CreateSessionOptions, CustomAcpHarnessSpec, HarnessAdapter, HarnessConfig, HarnessId, HarnessInfo, Json } from './types.js';
import { findModeChoice, modelOptionOf, optionValueIds } from '../subagents.js';
import type { SessionManager } from '../sessions.js';

interface PersistedRegistry {
  configs: Record<string, HarnessConfig>;
  custom: CustomAcpHarnessSpec[];
}

/**
 * Splits a routed session ID into { harnessId, nativeId }.
 * Bare session IDs without a known `<harnessId>:` prefix default to `devin`
 * for 100% backward compatibility with legacy Devin sessions.
 */
const LIST_TIMEOUT_MS = 8000;

export function parseScopedSessionId(sessionId: string, knownHarnesses: Iterable<string>): { harnessId: HarnessId; nativeId: string } {
  const idx = sessionId.indexOf(':');
  if (idx > 0) {
    const prefix = sessionId.slice(0, idx);
    for (const h of knownHarnesses) {
      if (h === prefix) return { harnessId: prefix, nativeId: sessionId.slice(idx + 1) };
    }
  }
  return { harnessId: 'devin', nativeId: sessionId };
}

export function formatScopedSessionId(harnessId: HarnessId, nativeId: string): string {
  if (harnessId === 'devin') return nativeId;
  return nativeId.startsWith(`${harnessId}:`) ? nativeId : `${harnessId}:${nativeId}`;
}

/** Resolve and check the known directory before session/load can start the harness in it. */
export async function loadSessionInPath(registry: HarnessRegistry, sessionId: string, checkPath: (cwd: string) => string, expectedCwd?: string) {
  const { adapter, harnessId, nativeId } = registry.resolveSession(sessionId);
  if (!nativeId) throw new Error('Invalid session target');
  const expected = expectedCwd === undefined ? undefined : checkPath(expectedCwd);
  const known = adapter.sessionCwd(nativeId) ?? expected ?? (await adapter.listSessions()).find(s => s.sessionId === nativeId)?.cwd;
  if (!known) throw new Error('Cannot determine the session folder');
  const cwd = checkPath(known);
  if (expected !== undefined && cwd !== expected) throw new Error('Session folder does not match the target');
  const session = await adapter.ensureLoaded(nativeId, cwd);
  if (checkPath(session.cwd) !== cwd) throw new Error('Session folder does not match the target');
  return { adapter, harnessId, nativeId, session, cwd };
}

/**
 * Central registry for all coding-agent harnesses and their persisted configurations.
 * Routes session operations to the owning adapter without session ID collisions.
 */
export class HarnessRegistry extends EventEmitter {
  private adapters = new Map<HarnessId, HarnessAdapter>();
  private fallbackAdapters = new Map<HarnessId, HarnessAdapter>();
  private configs = new Map<HarnessId, HarnessConfig>();
  private customSpecs = new Map<string, CustomAcpHarnessSpec>();
  private configFile: string;
  private customFactory: ((spec: CustomAcpHarnessSpec) => HarnessAdapter) | null = null;
  private sessionOptionsFile: string;
  private sessionOptions: Record<string, { options: CreateSessionOptions; preludePending: boolean }> = {};

  constructor(private dataDir: string) {
    super();
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.configFile = join(dataDir, 'harnesses.json');
    this.sessionOptionsFile = join(dataDir, 'session-options.json');
    if (existsSync(this.sessionOptionsFile)) this.sessionOptions = JSON.parse(readFileSync(this.sessionOptionsFile, 'utf8'));
    this.loadPersisted();
  }

  private loadPersisted() {
    if (!existsSync(this.configFile)) return;
    try {
      const raw = JSON.parse(readFileSync(this.configFile, 'utf8')) as Partial<PersistedRegistry>;
      for (const [id, cfg] of Object.entries(raw.configs ?? {})) {
        this.configs.set(id, cfg);
      }
      for (const spec of raw.custom ?? []) {
        if (spec?.id && spec?.command) this.customSpecs.set(spec.id, spec);
      }
    } catch {
      // Corrupt config should not prevent gateway boot.
    }
  }

  private savePersisted() {
    const payload: PersistedRegistry = {
      configs: Object.fromEntries(this.configs.entries()),
      custom: [...this.customSpecs.values()],
    };
    const tmp = `${this.configFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.configFile);
  }

  private mcpServers: ((cwd?: string, ref?: string) => Json[]) | null = null;

  /** Offers `servers` to every registered and future adapter's sessions. */
  setMcpServers(servers: (cwd?: string, ref?: string) => Json[]) {
    this.mcpServers = servers;
    for (const a of this.adapters.values()) a.setMcpServers?.(servers);
  }

  register(adapter: HarnessAdapter) {
    const manager = (adapter as HarnessAdapter & { manager?: SessionManager }).manager;
    if (manager) {
      manager.sessionOptions = (id) => this.sessionOptions[formatScopedSessionId(adapter.id, id)];
      manager.saveSessionOptions = (id, options, preludePending) => this.saveSessionOptions(formatScopedSessionId(adapter.id, id), options, preludePending);
    }
    if (this.mcpServers) adapter.setMcpServers?.(this.mcpServers);
    this.adapters.set(adapter.id, adapter);
    if (!adapter.custom) this.fallbackAdapters.set(adapter.id, adapter);
    const saved = this.configs.get(adapter.id);
    if (saved) adapter.configure(saved);
    adapter.on('event', (s: Session, ev: Json) => this.emit('event', s, ev));
    adapter.on('state', (summary: SessionSummary, scheduled?: boolean) => this.emit('state', summary, scheduled));
    adapter.on('permission', (s: Session, p: Json) => this.emit('permission', s, p));
    adapter.on('permission_resolved', (s: Session, reqId: string, optionId: string | null) =>
      this.emit('permission_resolved', s, reqId, optionId),
    );
    adapter.on('reset', (s: Session) => this.emit('reset', s));
    adapter.on('deleted', (sessionId: string) => {
      const id = formatScopedSessionId(adapter.id, sessionId);
      if (this.sessionOptions[id]) { delete this.sessionOptions[id]; this.persistSessionOptions(); }
      this.emit('deleted', id);
    });
    adapter.on('status', (info: HarnessInfo) => this.emit('harness_status', info));
  }

  private persistSessionOptions() {
    const tmp = `${this.sessionOptionsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.sessionOptions, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.sessionOptionsFile);
  }

  private saveSessionOptions(id: string, options: CreateSessionOptions, preludePending: boolean) {
    this.sessionOptions[id] = { options, preludePending };
    this.persistSessionOptions();
  }

  /** Instantiates adapters for persisted and newly registered custom ACP definitions. */
  setCustomFactory(factory: (spec: CustomAcpHarnessSpec) => HarnessAdapter) {
    this.customFactory = factory;
    for (const spec of this.customSpecs.values()) this.instantiateCustom(spec);
  }

  private instantiateCustom(spec: CustomAcpHarnessSpec) {
    if (!this.customFactory) return;
    // A persisted custom definition keeps its ID even if a built-in later claims the same one.
    const existing = this.adapters.get(spec.id);
    if (existing?.custom) existing.stop();
    this.adapters.delete(spec.id);
    this.register(this.customFactory(spec));
  }

  get(id: HarnessId): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: HarnessId): HarnessAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown harness: ${id}`);
    return a;
  }

  list(): HarnessInfo[] {
    return [...this.adapters.values()].map((a) => a.info());
  }

  listCustomSpecs(): CustomAcpHarnessSpec[] {
    return [...this.customSpecs.values()];
  }

  async probeAll(): Promise<HarnessInfo[]> {
    const results = await Promise.all([...this.adapters.values()].map((a) => a.probe().catch(() => a.info())));
    return results;
  }

  configure(id: HarnessId, patch: Partial<HarnessConfig>): HarnessInfo {
    const adapter = this.require(id);
    const prev = this.configs.get(id) ?? { id, enabled: true };
    const next: HarnessConfig = { ...prev, ...patch, id };
    this.configs.set(id, next);
    adapter.configure(next);
    this.savePersisted();
    const info = adapter.info();
    this.emit('harness_status', info);
    return info;
  }

  saveCustomSpec(spec: CustomAcpHarnessSpec): CustomAcpHarnessSpec {
    const id = spec.id.trim().toLowerCase();
    if (!id || !/^[a-z0-9][a-z0-9-_]{1,63}$/.test(id)) {
      throw new Error('Custom harness id must be 2-64 lowercase letters, digits, hyphens, or underscores');
    }
    const existing = this.adapters.get(id);
    if (existing && !existing.custom) {
      throw new Error(`Harness id "${id}" is reserved for a built-in harness`);
    }
    if (!spec.command?.trim()) throw new Error('Custom harness command is required');
    const normalized: CustomAcpHarnessSpec = {
      id,
      name: spec.name?.trim() || id,
      command: spec.command.trim(),
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      cwd: spec.cwd?.trim() || undefined,
      envAllowlist: Array.isArray(spec.envAllowlist) ? spec.envAllowlist.map(String) : [],
      enabled: spec.enabled ?? true,
    };
    this.customSpecs.set(id, normalized);
    this.savePersisted();
    this.instantiateCustom(normalized);
    return normalized;
  }

  removeCustomSpec(id: string): boolean {
    const adapter = this.adapters.get(id);
    if (adapter && !adapter.custom) return false;
    const existed = this.customSpecs.delete(id);
    const hadCustomAdapter = !!adapter?.custom;
    if (existed || hadCustomAdapter) {
      this.configs.delete(id);
    }
    if (hadCustomAdapter && adapter) {
      adapter.stop();
      this.adapters.delete(id);
    }
    if (existed) this.savePersisted();
    if ((existed || hadCustomAdapter) && !this.adapters.has(id)) {
      const fallback = this.fallbackAdapters.get(id);
      if (fallback) {
        if (this.mcpServers) fallback.setMcpServers?.(this.mcpServers);
        this.adapters.set(id, fallback);
        this.emit('harness_status', fallback.info());
      }
    }
    return existed;
  }

  resolveSession(sessionId: string): { adapter: HarnessAdapter; harnessId: HarnessId; nativeId: string } {
    const { harnessId, nativeId } = parseScopedSessionId(sessionId, this.adapters.keys());
    return { adapter: this.require(harnessId), harnessId, nativeId };
  }

  async listAllSessions(cwd?: string): Promise<SessionSummary[]> {
    const lists = await Promise.all(
      [...this.adapters.values()]
        .filter((a) => a.info().enabled)
        .map(async (a) => {
          try {
            const listing = a.listSessions(cwd);
            let timer: NodeJS.Timeout | undefined;
            const timeout = new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), LIST_TIMEOUT_MS);
            });
            const rows = await Promise.race([listing, timeout]).finally(() => clearTimeout(timer));
            if (!rows) {
              // A slow harness must not hold up the others: its rows arrive later as session_state updates.
              listing
                .then((late) => [...late].sort((x, y) => x.updatedAt - y.updatedAt).forEach((r) => this.emit('state', { ...r, harnessId: a.id })))
                .catch(() => undefined);
              return [];
            }
            return rows.map((r) => ({ ...r, harnessId: a.id, sessionId: formatScopedSessionId(a.id, r.sessionId) }));
          } catch {
            return [];
          }
        }),
    );
    return lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listNativeSubagents(): { harnessId: HarnessId; parentSessionId: string; child: Session }[] {
    return [...this.adapters.values()].flatMap((a) => (a.listNativeSubagents?.() ?? []).map((x) => ({ harnessId: a.id, ...x })));
  }

  async steerSession(sessionId: string, text: string): Promise<{ mode: 'steering' | 'prompt'; outcome?: Json }> {
    const { adapter, nativeId } = this.resolveSession(sessionId);
    if (adapter.steer) return adapter.steer(nativeId, text);
    await adapter.prompt(nativeId, text);
    return { mode: 'prompt' };
  }

  async createSession(harnessId: HarnessId, cwd: string, opts?: CreateSessionOptions): Promise<Session> {
    const adapter = this.require(harnessId);
    if (!adapter.info().enabled) throw new Error(`Harness ${harnessId} is disabled`);
    if (opts?.envAllowlist?.length) this.assertSessionEnvAllowlist(harnessId, opts.envAllowlist);
    const session = await adapter.createSession(cwd, opts);
    try {
      if (opts?.model) {
        const option = modelOptionOf(session.configOptions);
        if (!option) throw new Error(`${harnessId} does not offer a model choice`);
        const values = optionValueIds(option);
        if (values.length && !values.includes(opts.model)) throw new Error(`${harnessId} does not offer model ${opts.model}`);
        await adapter.setConfigOption(session.sessionId, option.id, opts.model);
      }
      if (opts?.mode) {
        const mode = findModeChoice(session.configOptions, session.modes, opts.mode);
        if (!mode) throw new Error(`${harnessId} does not offer mode ${opts.mode}`);
        if (mode.source === 'config') await adapter.setConfigOption(session.sessionId, mode.configId, String(mode.value ?? mode.id));
        else await adapter.setMode(session.sessionId, String(mode.id ?? mode.value));
      }
      if (opts?.prelude || opts?.subagentModel !== undefined || opts?.envAllowlist?.length) {
        session.options = { prelude: opts.prelude, subagentModel: opts.subagentModel, envAllowlist: opts.envAllowlist };
        session.preludePending = !!opts.prelude;
        this.saveSessionOptions(formatScopedSessionId(harnessId, session.sessionId), session.options, session.preludePending);
      }
      return session;
    } catch (e) {
      await adapter.deleteSession(session.sessionId).catch(() => adapter.closeSession(session.sessionId).catch(() => undefined));
      throw e;
    }
  }

  assertSessionEnvAllowlist(harnessId: string, allowlist: string[]) {
    const adapter = this.require(harnessId);
    if (!adapter.assertSessionEnvAllowlist) throw new Error(`Harness ${harnessId} cannot isolate this environment preset`);
    adapter.assertSessionEnvAllowlist(allowlist);
  }
}
