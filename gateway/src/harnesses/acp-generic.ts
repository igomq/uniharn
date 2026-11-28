import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fallbackBinDirs, mergePath } from '../shell-path.js';
import { SessionManager, type PromptFile, type Session, type SessionSummary } from '../sessions.js';
import { authState, type CommandResult, type CommandRunner, isAuthError, notInstalled, runCommand } from './auth.js';
import type { AuthState, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessConfig, HarnessInfo, Json } from './types.js';
import { safeEnvAllowlist } from '../presets.js';

const execFileAsync = promisify(execFile);

/** Variables always passed to a harness process when an env allowlist is in effect. */
export const BASE_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

export interface AcpHarnessSpec {
  id: string;
  name: string;
  /** Executable name (resolved on PATH) or absolute path. */
  bin: string;
  /** Older or alternative executable names tried when `bin` is not found. */
  altBins?: string[];
  /** Arguments that start the ACP server, e.g. `['acp']`. */
  acpArgs: string[];
  versionArgs?: string[];
  installHint?: string | null;
  authMethod?: string | null;
  /** The harness CLI's own login-status command; without one the login state stays `unknown`. */
  authCheck?: { bin: string; args: string[]; parse: (r: CommandResult) => AuthState };
  custom?: boolean;
  cwd?: string;
  envAllowlist?: string[];
  /** False when no documented ACP entrypoint is known; the harness starts disabled until configured. */
  verified?: boolean;
  note?: string | null;
  enabled?: boolean;
}

export function resolveBin(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(bin)) return isExecutable(bin) ? bin : null;
  const dirs = mergePath(env.PATH, fallbackBinDirs().join(delimiter)).split(delimiter);
  for (const d of dirs) {
    const p = join(d, bin);
    if (isExecutable(p)) return p;
  }
  return null;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function filterEnv(allowlist: string[] | undefined, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!allowlist || allowlist.length === 0) return env;
  const out: NodeJS.ProcessEnv = {};
  for (const k of [...BASE_ENV_KEYS, ...allowlist]) {
    if (env[k] !== undefined) out[k] = env[k];
  }
  return out;
}

/**
 * Harness adapter for any agent that speaks ACP over stdio. Capabilities are taken from
 * the agent's `initialize` response instead of being assumed.
 */
export class AcpHarnessAdapter extends EventEmitter implements HarnessAdapter {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  readonly manager: SessionManager;

  private bin: string;
  private args: string[] = [];
  private envAllowlist: string[];
  private launchedEnvAllowlist: string[] | null = null;
  private enabled: boolean;
  private installed = false;
  private resolvedBin: string | null = null;
  private version: string | null = null;
  private probedAuth: AuthState = authState('unknown', { checkedAt: null, detail: 'Not checked yet.' });
  /** Set when the agent itself rejects a request for lack of a login; cleared by the next probe. */
  private runtimeAuth: AuthState | null = null;

  constructor(private readonly spec: AcpHarnessSpec, private readonly run: CommandRunner = runCommand) {
    super();
    this.id = spec.id;
    this.name = spec.name;
    this.custom = !!spec.custom;
    this.bin = spec.bin;
    this.envAllowlist = [...(spec.envAllowlist ?? [])];
    this.enabled = spec.enabled ?? spec.verified !== false;
    this.manager = new SessionManager(this.bin, this.args, {
      harnessId: spec.id,
      baseArgs: spec.acpArgs,
      label: `${spec.id} acp`,
      cwd: spec.cwd,
      env: () => {
        this.launchedEnvAllowlist = [...this.envAllowlist];
        return filterEnv(this.envAllowlist);
      },
    });
    this.manager.validateSessionOptions = (options) => {
      if (options.envAllowlist?.length) this.assertSessionEnvAllowlist(options.envAllowlist);
    };
    for (const ev of ['event', 'state', 'permission', 'permission_resolved', 'reset', 'deleted'] as const) {
      this.manager.on(ev, (...a: Json[]) => this.emit(ev, ...a));
    }
    this.manager.on('agent', () => this.emit('status', this.info()));
  }

  configure(patch: Partial<HarnessConfig>): void {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.bin) this.bin = patch.bin;
    if (patch.args) this.args = [...patch.args];
    if (patch.envAllowlist) this.envAllowlist = [...patch.envAllowlist];
    this.resolveLaunchBin();
  }

  assertSessionEnvAllowlist(allowlist: string[]): void {
    if (!this.custom) throw new Error('Environment presets require a custom ACP harness with a matching environment allowlist');
    const desired = safeEnvAllowlist(allowlist);
    const configured = safeEnvAllowlist(this.envAllowlist);
    if (!configured.length) throw new Error('The custom harness inherits its full environment; configure an explicit allowlist');
    const same = (actual: string[]) => {
      const a = new Set([...BASE_ENV_KEYS, ...safeEnvAllowlist(actual)]);
      const b = new Set([...BASE_ENV_KEYS, ...desired]);
      return a.size === b.size && [...a].every((key) => b.has(key));
    };
    if (!same(configured)) throw new Error('Profile environment allowlist does not match the custom harness configuration');
    if (this.manager.agentStartingOrRunning && this.launchedEnvAllowlist && !same(this.launchedEnvAllowlist)) {
      throw new Error('The running custom harness has a different environment; stop it before using this preset');
    }
  }

  /** Resolves `bin` (or, while it is not overridden, the spec's `altBins`) and launches with the result. */
  private resolveLaunchBin() {
    this.resolvedBin = resolveBin(this.bin);
    if (!this.resolvedBin && this.bin === this.spec.bin) {
      for (const alt of this.spec.altBins ?? []) {
        this.resolvedBin = resolveBin(alt);
        if (this.resolvedBin) break;
      }
    }
    this.manager.updateLaunchConfig(this.resolvedBin ?? this.bin, this.args);
  }

  async probe(): Promise<HarnessInfo> {
    this.resolveLaunchBin();
    this.installed = !!this.resolvedBin;
    this.version = null;
    if (this.resolvedBin) {
      try {
        const { stdout } = await execFileAsync(this.resolvedBin, this.spec.versionArgs ?? ['--version'], { timeout: 5000, env: filterEnv(this.envAllowlist) });
        this.version = stdout.trim().split('\n')[0] || null;
      } catch {
        // Version probing is best effort; some ACP shims do not support --version.
      }
    }
    this.probedAuth = await this.checkAuth();
    this.runtimeAuth = null;
    return this.info();
  }

  private async checkAuth(): Promise<AuthState> {
    if (!this.resolvedBin) return notInstalled(this.bin);
    const check = this.spec.authCheck;
    if (!check) return authState('unknown', { detail: 'This harness has no login status command; its login is checked when a session starts.' });
    const bin = check.bin === this.spec.bin ? this.resolvedBin : resolveBin(check.bin);
    if (!bin) return authState('unknown', { detail: `\`${check.bin}\` was not found, so the login could not be checked.` });
    try {
      return check.parse(await this.run(bin, check.args, { timeout: 10_000, env: filterEnv(this.envAllowlist) }));
    } catch (e) {
      return authState('error', { detail: `Login check failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private noteAuthFailure(e: unknown) {
    if (!isAuthError(e)) return;
    this.runtimeAuth = authState('unauthenticated', { method: this.probedAuth.method, detail: `The agent asked for a login: ${e instanceof Error ? e.message : String(e)}` });
    this.emit('status', this.info());
  }

  info(): HarnessInfo {
    const st = this.manager.agentStatus();
    const init = this.manager.initResult;
    const caps = init?.agentCapabilities;
    const sc = caps?.sessionCapabilities;
    const known = !!init;
    const capabilities: HarnessCapabilities = {
      acp: true,
      acpVersion: init?.protocolVersion ?? null,
      streaming: true,
      models: known ? true : false,
      reasoningLevels: false,
      modes: known,
      permissions: true,
      mcp: !!(caps?.mcpCapabilities || caps?.mcp),
      sessionResume: !!caps?.loadSession,
      sessionClose: !!sc?.close,
      sessionDelete: !!sc?.delete,
      subagents: this.manager.mcpServers().length > 0,
      usage: false,
    };
    const unverified = this.spec.verified === false;
    let error = st.error;
    if (!error && unverified && !this.installed) error = this.spec.note ?? 'No documented ACP entrypoint; configure bin/args.';
    const auth = this.runtimeAuth ?? (this.installed || !st.running ? this.probedAuth : authState('unknown', { detail: 'Not checked yet.' }));
    return {
      id: this.id,
      name: this.name,
      version: st.agentInfo?.version ?? this.version,
      bin: this.resolvedBin ?? this.bin,
      installed: this.installed || st.running,
      enabled: this.enabled,
      custom: this.custom,
      authStatus: auth.status,
      auth,
      authMethod: this.spec.authMethod ?? null,
      acpSupported: !unverified || this.custom,
      acpVersion: init?.protocolVersion ?? null,
      capabilities,
      models: [],
      status: !this.installed && !st.running ? 'unavailable' : st.error && !st.running ? 'error' : st.running ? 'running' : 'idle',
      error,
      installHint: this.spec.installHint ?? null,
    };
  }

  setMcpServers(servers: (cwd?: string, ref?: string) => Json[]): void {
    this.manager.mcpServers = servers;
  }

  async ensureReady(): Promise<void> {
    await this.manager.ensureAgent();
  }
  listSessions(cwd?: string): Promise<SessionSummary[]> {
    if (!this.enabled || (!this.installed && !this.manager.agentStatus().running)) return Promise.resolve([]);
    return this.manager.listSessions(cwd);
  }
  async createSession(cwd: string, _opts?: CreateSessionOptions): Promise<Session> {
    try {
      return await this.manager.createSession(cwd);
    } catch (e) {
      this.noteAuthFailure(e);
      throw this.withAuthHint(e);
    }
  }

  /** Adds how to sign in to an agent's "Authentication required" error. */
  private withAuthHint(e: unknown): unknown {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/auth/i.test(msg)) return e;
    const hints: string[] = [];
    if (this.spec.authMethod) hints.push(`run \`${this.spec.authMethod}\``);
    const vars = (this.manager.initResult?.authMethods ?? [])
      .flatMap((m: Json) => (Array.isArray(m?.vars) ? m.vars.map((v: Json) => v?.name) : []))
      .filter((v: unknown): v is string => typeof v === 'string');
    if (vars.length) hints.push(`set ${vars.join(' or ')} (add it to envAllowlist if one is set)`);
    return hints.length ? new Error(`${msg}: ${hints.join(', or ')}`) : e;
  }
  async ensureLoaded(sessionId: string, cwd?: string): Promise<Session> {
    try {
      return await this.manager.ensureLoaded(sessionId, cwd);
    } catch (e) {
      this.noteAuthFailure(e);
      throw e;
    }
  }
  sessionCwd(sessionId: string): string | undefined {
    return this.manager.sessionCwd(sessionId);
  }

  listNativeSubagents() {
    return this.manager.nativeSubagentSessions();
  }
  prompt(sessionId: string, text: string, images: { mimeType: string; data: string }[] = [], files: PromptFile[] = []): Promise<void> {
    return this.manager.prompt(sessionId, text, images, files);
  }

  promptAndWait(sessionId: string, text: string, signal: AbortSignal, prelude?: string): Promise<void> {
    return this.manager.promptAndWait(sessionId, text, signal, prelude);
  }
  steer(sessionId: string, text: string) {
    return this.manager.steer(sessionId, text);
  }
  cancel(sessionId: string): Promise<void> {
    return this.manager.cancel(sessionId);
  }
  resolvePermission(sessionId: string, requestId: string, optionId: string | null): void {
    this.manager.resolvePermission(sessionId, requestId, optionId);
  }
  setConfigOption(sessionId: string, configId: string, value: Json): Promise<SessionSummary> {
    return this.manager.setConfigOption(sessionId, configId, value);
  }
  setMode(sessionId: string, modeId: string): Promise<SessionSummary> {
    return this.manager.setMode(sessionId, modeId);
  }
  releaseIdle(isWatched: (sessionId: string) => boolean, idleMs: number): Promise<number> {
    return this.manager.releaseIdle(isWatched, idleMs);
  }

  closeSession(sessionId: string): Promise<void> {
    return this.manager.closeSession(sessionId);
  }
  deleteSession(sessionId: string): Promise<void> {
    return this.manager.deleteSession(sessionId);
  }
  authenticate(methodId: string): Promise<Json> {
    return this.manager.authenticate(methodId);
  }
  stop(): void {
    this.manager.stop();
  }
}
