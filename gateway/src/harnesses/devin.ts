import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { SessionManager, type PromptFile, type Session, type SessionSummary } from '../sessions.js';
import { authState, type CommandRunner, isAuthError, notInstalled, parseDevinAuthStatus, runCommand } from './auth.js';
import type { AuthState, CreateSessionOptions, HarnessAdapter, HarnessCapabilities, HarnessConfig, HarnessInfo, Json } from './types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CAPABILITIES: HarnessCapabilities = {
  acp: true,
  acpVersion: 1,
  streaming: true,
  models: true,
  reasoningLevels: true,
  modes: true,
  permissions: true,
  mcp: true,
  sessionResume: true,
  sessionClose: true,
  sessionDelete: false,
  subagents: false,
  usage: true,
};

/**
 * Devin CLI harness adapter backed by `devin acp` via the existing SessionManager,
 * preserving 100% compatibility with existing Devin sessions.
 */
export class DevinHarnessAdapter extends EventEmitter implements HarnessAdapter {
  readonly id = 'devin';
  readonly name = 'Devin CLI';
  readonly custom = false;

  public readonly manager: SessionManager;
  private bin: string;
  private args: string[];
  private enabled = true;
  private installed = false;
  private version: string | null = null;
  private probedAuth: AuthState = authState('unknown', { checkedAt: null, detail: 'Not checked yet.' });
  private runtimeAuth: AuthState | null = null;

  constructor(bin: string, extraArgs: string[] = [], private readonly run: CommandRunner = runCommand) {
    super();
    this.bin = bin;
    this.args = [...extraArgs];
    this.manager = new SessionManager(bin, extraArgs);
    this.forwardEvents();
  }

  private forwardEvents() {
    for (const ev of ['event', 'state', 'permission', 'permission_resolved', 'reset', 'deleted'] as const) {
      this.manager.on(ev, (...args: Json[]) => this.emit(ev, ...args));
    }
    this.manager.on('agent', () => this.emit('status', this.info()));
  }

  configure(patch: Partial<HarnessConfig>): void {
    if (patch.enabled !== undefined) this.enabled = patch.enabled;
    if (patch.bin) this.bin = patch.bin;
    if (patch.args) this.args = [...patch.args];
    this.manager.updateLaunchConfig(this.bin, this.args);
  }

  async probe(): Promise<HarnessInfo> {
    this.installed = existsSync(this.bin);
    try {
      const { stdout } = await execFileAsync(this.bin, ['--version'], { timeout: 5000 });
      this.installed = true;
      this.version = stdout.trim().split('\n')[0] || null;
    } catch {
      if (!this.installed) this.version = null;
    }
    this.probedAuth = this.installed ? parseDevinAuthStatus(await this.run(this.bin, ['auth', 'status'], { timeout: 10_000 })) : notInstalled(this.bin);
    this.runtimeAuth = null;
    return this.info();
  }

  private noteAuthFailure(e: unknown) {
    if (!isAuthError(e)) return;
    this.runtimeAuth = authState('unauthenticated', { method: this.probedAuth.method, detail: `Devin asked for a login: ${e instanceof Error ? e.message : String(e)}` });
    this.emit('status', this.info());
  }

  info(): HarnessInfo {
    const st = this.manager.agentStatus();
    const caps = this.manager.initResult?.agentCapabilities;
    const sessionCaps = caps?.sessionCapabilities;
    const capabilities: HarnessCapabilities = {
      ...DEFAULT_CAPABILITIES,
      sessionClose: Boolean(sessionCaps?.close ?? true),
      sessionDelete: Boolean(sessionCaps?.delete ?? false),
      subagents: this.manager.mcpServers().length > 0,
    };
    const auth = this.runtimeAuth ?? this.probedAuth;
    const status = !this.installed && !st.running ? 'unavailable' : st.error && !st.running ? 'error' : st.running ? 'running' : 'idle';
    return {
      id: this.id,
      name: this.name,
      version: st.agentInfo?.version ?? this.version,
      bin: this.bin,
      installed: this.installed || st.running,
      enabled: this.enabled,
      custom: false,
      authStatus: auth.status,
      auth,
      authMethod: 'devin auth login',
      acpSupported: true,
      acpVersion: 1,
      capabilities,
      models: [],
      status,
      error: st.error,
      installHint: 'curl -fsSL https://cli.devin.ai/install.sh | sh',
    };
  }

  setMcpServers(servers: (cwd?: string, ref?: string) => Json[]): void {
    this.manager.mcpServers = servers;
  }

  async ensureReady(): Promise<void> {
    await this.manager.ensureAgent();
  }

  listSessions(cwd?: string): Promise<SessionSummary[]> {
    return this.manager.listSessions(cwd);
  }

  async createSession(cwd: string, _opts?: CreateSessionOptions): Promise<Session> {
    try {
      return await this.manager.createSession(cwd);
    } catch (e) {
      this.noteAuthFailure(e);
      throw e;
    }
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
