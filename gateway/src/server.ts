import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { AuthStore, MIN_APP_VERSION, PROTOCOL_VERSION } from './auth.js';
import type { Config } from './config.js';
import { BUILD, collectDiagnostics, gatewaySecurity, installedBuild, suggestedUrls, VERSION } from './diagnostics.js';
import { createGitRpc } from './git-rpc.js';
import { createSchedulerRpc, gatewaySchedulerOptions } from './scheduler-rpc.js';
import { createBuiltinAcpAdapters, createCustomAcpAdapter } from './harnesses/builtins.js';
import { DevinHarnessAdapter } from './harnesses/devin.js';
import { type DevinUsage, fetchDevinUsage } from './harnesses/devin-usage.js';
import { formatScopedSessionId, HarnessRegistry, loadSessionInPath } from './harnesses/registry.js';
import { checkRateLimit, clientIp, exchangePairingCode, handlePairRequest, RequestError, sendJson } from './pairing.js';
import { NotificationService, redactSecrets as redactNotificationSecrets } from './notifications.js';
import { Orchestrator } from './orchestrator.js';
import { SubagentSettings, sessionRefs } from './subagents.js';
import { listDirectory, listProjects } from './projects.js';
import { ProfileStore, TeamStore, launchProfile, launchTeam } from './presets.js';
import { assertAllowedPath, isPathWithinRoots, RateLimiter, redactSecrets } from './security.js';
import { folderPolicy, recreatedFolders, type PromptFile, type Session } from './sessions.js';
import { serveStatic } from './static.js';
import { detectTestCommand, TaskRunner } from './tasks.js';
import { TerminalManager } from './terminal.js';
import { WorkspaceStore } from './workspaces.js';
import { UsageCenter } from './usage.js';

type Json = any;

interface Client {
  ws: WebSocket;
  ip: string;
  authed: boolean;
  deviceId: string | null;
  subs: Set<string>;
  terms: Set<string>;
  alive: boolean;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

export function createGatewayRegistry(config: Config) {
  const registry = new HarnessRegistry(config.dataDir);
  const devinHarness = new DevinHarnessAdapter(config.devinBin, config.devinArgs);
  registry.register(devinHarness);
  for (const adapter of createBuiltinAcpAdapters()) registry.register(adapter);
  registry.setCustomFactory(createCustomAcpAdapter);
  return { registry, manager: devinHarness.manager };
}

export function createGatewayServer(input: Config) {
  const config = { ...input };
  const authStore = new AuthStore(config.dataDir, config.token);
  const { registry, manager } = createGatewayRegistry(config);
  const workspaces = new WorkspaceStore(config.dataDir);
  const subagents = new SubagentSettings(config.dataDir);
  const orchestrator = new Orchestrator(registry, config.dataDir, subagents, config.strictRoots ? { loadSource: loadProjectSession, check: absCwd } : undefined);

  const modelValue = (configOptions: Json[] | undefined) => {
    const opt = (configOptions ?? []).find((o) => o?.category === 'model' || o?.id === 'model');
    return typeof opt?.currentValue === 'string' ? opt.currentValue : null;
  };
  function nativeSubagentEntry(harnessId: string, parentNativeId: string, child: Session) {
    const summary = child.summary();
    const sub = summary.subagent;
    if (!sub) return null;
    const stateName = typeof sub.state?.state === 'string' ? sub.state.state : summary.status;
    return {
      kind: 'native',
      id: `native:${formatScopedSessionId(harnessId, child.sessionId)}`,
      parentSessionId: formatScopedSessionId(harnessId, parentNativeId),
      childSessionId: formatScopedSessionId(harnessId, child.sessionId),
      harnessId,
      title: sub.title ?? summary.title ?? child.sessionId,
      description: sub.description ?? null,
      task: null,
      cwd: sub.cwd ?? summary.cwd,
      worktree: null,
      branch: null,
      model: modelValue(summary.configOptions),
      status: stateName,
      state: sub.state ?? null,
      capabilities: sub.capabilities ?? null,
      configOptions: summary.configOptions,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      canMessage: false,
      canCancel: !!sub.capabilities?.cancel,
    };
  }
  function listSubagents(parentSessionId?: string) {
    const out: Json[] = [];
    for (const l of orchestrator.list()) {
      if (l.kind !== 'delegate') continue;
      const entry = {
        kind: 'delegate',
        id: l.id,
        parentSessionId: l.parentSessionId,
        childSessionId: l.childSessionId,
        harnessId: l.harnessId,
        title: l.task.split('\n')[0] || 'Subagent',
        description: null,
        task: l.task,
        cwd: l.cwd,
        worktree: l.worktree,
        branch: l.branch,
        model: l.model ?? null,
        status: l.status,
        state: null,
        capabilities: { prompt: {} },
        configOptions: [],
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        canMessage: true,
        canCancel: l.status === 'running',
      };
      if (!parentSessionId || entry.parentSessionId === parentSessionId) out.push(entry);
    }
    for (const { harnessId, parentSessionId: parentNativeId, child } of registry.listNativeSubagents()) {
      const entry = nativeSubagentEntry(harnessId, parentNativeId, child);
      if (entry && (!parentSessionId || entry.parentSessionId === parentSessionId)) out.push(entry);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const mcpEntry = join(dirname(fileURLToPath(import.meta.url)), 'mcp.js');
  if (process.env.UNIHARN_SUBAGENT_MCP !== '0' && existsSync(mcpEntry)) {
    // Every harness session gets uniharn's MCP server so its agent can delegate to other harnesses.
    // The token goes in a 0600 file, not the MCP env, so harnesses never see it in ACP request payloads.
    const mcpTokenFile = join(config.dataDir, 'mcp-token');
    writeFileSync(mcpTokenFile, config.token + '\n', { mode: 0o600 });
    chmodSync(mcpTokenFile, 0o600);
    registry.setMcpServers((cwd, ref) => {
      const bind = config.hosts[0] ?? '127.0.0.1';
      const host = bind === '*' || bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
      const env = [
        { name: 'UNIHARN_DATA_DIR', value: config.dataDir },
        { name: 'UNIHARN_TOKEN_FILE', value: mcpTokenFile },
        { name: 'UNIHARN_GATEWAY_URL', value: `ws://${host.includes(':') ? `[${host}]` : host}:${config.port}/ws` },
      ];
      if (cwd) env.push({ name: 'UNIHARN_SESSION_CWD', value: cwd });
      if (ref) env.push({ name: 'UNIHARN_SESSION_REF', value: ref });
      return [{ name: 'uniharn', command: process.execPath, args: [mcpEntry], env }];
    });
  }
  const tasks = new TaskRunner();
  const terminals = new TerminalManager(config.devinBin);
  const notifications = new NotificationService(config.dataDir);
  const clients = new Set<Client>();
  const pairLimiter = new RateLimiter();
  const helloLimiter = new RateLimiter();
  const gatewayInfo = {
    gatewayId: authStore.gatewayId,
    hostname: hostname(),
    version: VERSION,
    build: BUILD,
    startedAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    minAppVersion: MIN_APP_VERSION,
  };
  const security = gatewaySecurity(config);
  const safeMessage = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error), [config.token]);

  function send(c: Client, msg: Json) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }
  function broadcast(msg: Json, filter: (c: Client) => boolean = () => true) {
    const data = JSON.stringify(msg);
    for (const c of clients) if (c.authed && filter(c) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  registry.on('event', (s: Session, ev) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'event', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch, ...ev }, (c) => c.subs.has(sid));
    notifications.onSessionActivity(sid, s.harnessId, s.title);
  });
  registry.on('state', (summary, scheduled?: boolean) => {
    const sid = formatScopedSessionId(summary.harnessId, summary.sessionId);
    if (summary.subagent) {
      const native = registry.listNativeSubagents().find((x) => x.harnessId === summary.harnessId && x.child.sessionId === summary.sessionId);
      const subagent = native ? nativeSubagentEntry(native.harnessId, native.parentSessionId, native.child) : null;
      if (subagent) broadcast({ type: 'subagent_state', sessionId: sid, harnessId: summary.harnessId, subagent, session: { ...summary, sessionId: sid, subagent: summary.subagent } });
      return;
    }
    broadcast({ type: 'session_state', session: { ...summary, sessionId: sid } });
    notifications.onSessionState({ ...summary, sessionId: sid }, !scheduled);
  });
  registry.on('reset', (s: Session) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'session_reset', sessionId: sid, harnessId: s.harnessId, epoch: s.epoch }, (c) => c.subs.has(sid));
  });
  registry.on('deleted', (sessionId) => {
    broadcast({ type: 'session_deleted', sessionId });
    notifications.onSessionForgotten(sessionId);
    try {
      workspaces.removeSession(sessionId);
    } catch (err) {
      console.warn(safeMessage(`[uniharn] failed to update workspace after session deletion (${sessionId}): ${err}`));
    }
  });
  registry.on('harness_status', (harness) => broadcast({ type: 'harness_status', harness }));
  manager.on('agent', (status) => broadcast({ type: 'agent_status', agent: status }));
  registry.on('permission', (s: Session, p) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({
      type: 'permission_request',
      sessionId: sid,
      harnessId: s.harnessId,
      title: s.title,
      requestId: p.requestId,
      toolCall: p.toolCall,
      options: p.options,
    });
    notifications.onPermissionRequested({
      sessionId: sid,
      harnessId: s.harnessId,
      title: s.title,
      requestId: p.requestId,
      toolTitle: p.toolCall?.title ?? null,
      command: typeof p.toolCall?.rawInput?.command === 'string' ? p.toolCall.rawInput.command : null,
    });
  });
  registry.on('permission_resolved', (s: Session, requestId, optionId) => {
    const sid = formatScopedSessionId(s.harnessId, s.sessionId);
    broadcast({ type: 'permission_resolved', sessionId: sid, harnessId: s.harnessId, requestId, optionId });
    notifications.onPermissionResolved(sid, requestId);
  });
  orchestrator.on('link', (link) => broadcast({ type: 'orchestration_link', link }));
  // Emitted by the orchestrator when a delegated subagent task ends.
  registry.on('subagent_completed', (t: Json) => notifications.notifySubagentCompleted(t ?? {}));
  notifications.on('notification', (n) => broadcast({ type: 'notification', notification: n }));
  notifications.on('read', (ids: string[], unreadCount: number) => broadcast({ type: 'notification_read', ids, unreadCount }));
  notifications.on('cleared', () => broadcast({ type: 'notifications_cleared' }));
  tasks.on('output', (run, chunk) => broadcast({ type: 'task_output', taskId: run.taskId, cwd: run.cwd, chunk }));
  tasks.on('done', (run) => {
    const { output: _o, ...rest } = run;
    broadcast({ type: 'task_done', task: rest });
    notifications.onTaskDone(run);
  });
  terminals.on('data', (termId, data) => broadcast({ type: 'term_data', termId, data }, (c) => c.terms.has(termId)));
  terminals.on('exit', (info) => broadcast({ type: 'term_exit', term: info }));

  function requireString(v: unknown, name: string): string {
    if (typeof v !== 'string' || !v) throw new Error(`${name} is required`);
    return v;
  }
  // Sessions started without a project run in gateway-owned folders under the data dir.
  const scratchRoot = join(config.dataDir, 'scratch');
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const sessionRoots = [...config.roots, scratchRoot];
  const isScratchPath = (path: string) => isPathWithinRoots(path, [scratchRoot]);
  folderPolicy.mayRecreate = (path) => !config.strictRoots || isPathWithinRoots(path, sessionRoots);
  function newScratchDir(): string {
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const dir = join(scratchRoot, `${stamp.slice(0, 8)}-${stamp.slice(8)}-${randomBytes(3).toString('hex')}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Its own repository, so Changes never resolves to a checkout that happens to contain the data dir.
    spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore', timeout: 5000 });
    return dir;
  }

  /** Text attachments from the app: at most 10, 1 MB of text each. */
  function promptFiles(v: unknown): PromptFile[] {
    if (!Array.isArray(v)) return [];
    if (v.length > 10) throw new Error('At most 10 files can be attached.');
    return v.map((f) => {
      const text = f?.text;
      if (typeof text !== 'string') throw new Error('files.text must be a string');
      if (text.length > 1024 * 1024) throw new Error(`${String(f?.name)} is over 1 MB of text.`);
      return { name: String(f?.name || 'file.txt').slice(0, 200), mimeType: String(f?.mimeType || 'text/plain'), text };
    });
  }

  function absCwd(v: unknown): string {
    const p = requireString(v, 'cwd');
    return assertAllowedPath(resolve(p.startsWith('~') ? homedir() + p.slice(1) : p), sessionRoots, config.strictRoots);
  }

  async function loadProjectSession(sessionId: string) {
    const { adapter, harnessId, nativeId } = registry.resolveSession(sessionId);
    if (!config.strictRoots) return { adapter, harnessId, nativeId, session: await adapter.ensureLoaded(nativeId) };
    const scopedId = formatScopedSessionId(harnessId, nativeId);
    const workspace = workspaces.list().find(ws => ws.sessions.some(s => s.sessionId === scopedId && s.harnessId === harnessId));
    return loadSessionInPath(registry, sessionId, absCwd, workspace?.cwd);
  }

  const profiles = new ProfileStore(config.dataDir, absCwd);
  const teams = new TeamStore(config.dataDir, absCwd);
  function validateProfileWorkspace(value: Json) {
    if (!value.workspaceId) return;
    const ws = workspaces.get(value.workspaceId);
    if (!ws) throw new Error('Workspace not found');
    if (absCwd(ws.cwd) !== absCwd(value.cwd)) throw new Error('Profile cwd must match its workspace');
  }
  function validateTeamProfile(value: Json) {
    if (!value.profileId) return;
    const profile = profiles.get(value.profileId);
    if (!profile) throw new Error('Profile not found');
    absCwd(profile.cwd);
    validateProfileWorkspace(profile);
  }

  function termCwd(v: unknown): string {
    const requested = typeof v === 'string' && v ? v : '~';
    if (requested === '~' && config.strictRoots && config.roots.length && !isPathWithinRoots(homedir(), sessionRoots)) return scratchRoot;
    return absCwd(requested);
  }

  const gitRpc = createGitRpc(config.dataDir, {
    onStatus: (cwd, st) => notifications.notifyGitConflict(cwd, st.files.filter((f) => f.status === 'conflict').map((f) => f.path)),
    checkPath: config.strictRoots ? (path) => assertAllowedPath(path, sessionRoots, true) : undefined,
    isRecreated: (path) => recreatedFolders.has(path),
  });

  const schedulerOptions = gatewaySchedulerOptions(registry, workspaces, absCwd, (task, event) => {
    broadcast({ type: 'scheduler_state', task, event });
    if (!['completed', 'failed', 'awaiting_confirmation', 'interrupted', 'dependency_failed'].includes(event)) return;
    const type = event === 'completed' ? 'task_completed' : event === 'failed' ? 'execution_failed' : 'attention_needed';
    const detail = task.logs.at(-1)?.message;
    notifications.notify({
      type, title: `Scheduled task ${event.replaceAll('_', ' ')}`,
      body: safeMessage(detail ? `${task.title}\n${detail}` : task.title),
      safeBody: event === 'completed' ? 'A scheduled task finished.' : event === 'failed' ? 'A scheduled task failed.' : 'A scheduled task needs your attention.',
      sessionId: task.sessionId,
      dedupKey: `scheduler:${task.id}:${event}:${task.currentStep}:${task.updatedAt}`,
    });
  }, { profiles, teams, orchestrator });
  const schedulerRpc = createSchedulerRpc(config.dataDir, { ...schedulerOptions, sanitizeLog: message => redactNotificationSecrets(safeMessage(message)) });

  let accountCache: { at: number; value: Json } | null = null;

  /** Devin login and plan quota; the quota comes from the same user-status call the Devin CLI makes. */
  async function accountInfo(refresh: boolean, probe = refresh): Promise<Json> {
    if (!refresh && accountCache && Date.now() - accountCache.at < 60_000) return accountCache.value;
    const devin = registry.require('devin');
    const checkedAt = devin.info().auth.checkedAt;
    const stale = !checkedAt || Date.now() - Date.parse(checkedAt) >= 60_000;
    const info = probe || stale ? await devin.probe() : devin.info();
    let usage: DevinUsage | null = null;
    let usageError: string | null = null;
    if (info.auth.status === 'authenticated') {
      try {
        usage = await fetchDevinUsage({ version: VERSION });
      } catch (e) {
        usageError = redactSecrets(e instanceof Error ? e.message : String(e), [config.token]);
      }
    }
    const value = { loggedIn: info.auth.status === 'authenticated', fields: info.auth.account, auth: info.auth, usage, usageError };
    accountCache = { at: Date.now(), value };
    return value;
  }

  const usageCenter = new UsageCenter(config.dataDir, registry, orchestrator, async (refresh) => {
    try { return await accountInfo(refresh, false); }
    catch (error) { throw new Error(safeMessage(error)); }
  });

  async function handle(c: Client, type: string, p: Json): Promise<Json> {
    const schedulerResult = schedulerRpc.handle(type, p);
    if (schedulerResult) return schedulerResult;
    const gitResult = gitRpc.handle(type, p);
    if (gitResult) return gitResult;
    switch (type) {
      case 'hello': {
        checkRateLimit(helloLimiter, c.ip);
        const auth = authStore.authenticate(typeof p.token === 'string' ? p.token : '', config.token, c.ip);
        if (!auth.ok) {
          helloLimiter.recordFailure(c.ip);
          throw new RequestError(401, auth.error);
        }
        helloLimiter.reset(c.ip);
        c.deviceId = auth.deviceId;
        c.authed = true;
        manager.ensureAgent().catch(() => undefined);
        return {
          ...gatewayInfo,
          outdated: installedBuild() !== BUILD,
          deviceId: auth.deviceId,
          authKind: auth.authKind,
          deviceName: auth.deviceName,
          security,
          home: homedir(),
          scratchDir: scratchRoot,
          textAttachments: true,
          agent: manager.agentStatus(),
          harnesses: registry.list(),
          workspaces: workspaces.list(),
          sessions: manager.topLevelSessions().map((s) => s.summary()).filter((s) => !orchestrator.delegatedSessionIds().has(s.sessionId)),
          terminals: terminals.list(),
          tasks: tasks.list(),
          notifications: { unreadCount: notifications.unreadCount(), lastSeq: notifications.lastSeq() },
        };
      }
      case 'pair': {
        const { device, token } = exchangePairingCode(authStore, pairLimiter, c.ip, p);
        c.authed = true;
        c.deviceId = device.deviceId;
        manager.ensureAgent().catch(() => undefined);
        return { deviceId: device.deviceId, token, device, ...gatewayInfo };
      }
      case 'pairing.create': {
        if (p.ttlSec !== undefined && (typeof p.ttlSec !== 'number' || !Number.isFinite(p.ttlSec))) {
          throw new Error('ttlSec must be a number');
        }
        const url = p.url === undefined ? config.publicUrl ?? suggestedUrls(config)[0] : requireString(p.url, 'url');
        const { codeId, code, pairingUri, qrSvg, expiresAt } = await authStore.createPairingCode({ ttlSec: p.ttlSec, url });
        return { codeId, code, pairingUri, qrSvg, expiresAt };
      }
      case 'pairing.list':
        return { codes: authStore.listPairingCodes() };
      case 'pairing.revoke':
        return { revoked: authStore.revokePairingCode(requireString(p.codeId, 'codeId')) };
      case 'devices.list':
        return { devices: authStore.listDevices(c.deviceId) };
      case 'devices.rename':
        return { device: authStore.renameDevice(requireString(p.deviceId, 'deviceId'), requireString(p.name, 'name')) };
      case 'devices.revoke': {
        const device = authStore.revokeDevice(requireString(p.deviceId, 'deviceId'));
        notifications.removeDeviceSubscriptions(device.deviceId);
        const targets = [...clients].filter((client) => client.authed && client.deviceId === device.deviceId);
        // Let the RPC reply reach the caller before closing it on self-revocation.
        for (const target of targets) {
          if (target === c) setImmediate(() => disconnectRevoked(target));
          else disconnectRevoked(target);
        }
        return { device, disconnected: targets.length };
      }
      case 'devices.rotate':
        if (!c.deviceId) throw new Error('Master token cannot be rotated here');
        return authStore.rotateDeviceToken(c.deviceId);
      case 'gateway.diagnostics':
        return collectDiagnostics(config, registry, authStore, new Set(
          [...clients].filter((client) => client.authed && client.deviceId).map((client) => client.deviceId),
        ).size);
      case 'ping':
        return { now: Date.now() };
      case 'harnesses.list':
        return { harnesses: registry.list(), custom: registry.listCustomSpecs() };
      case 'usage.list':
        if (p.refresh !== undefined && typeof p.refresh !== 'boolean') throw new Error('refresh must be a boolean');
        return { usage: await usageCenter.report(p.refresh === true) };
      case 'usage.update': {
        usageCenter.update(requireString(p.harnessId, 'harnessId'), p.manual, p.reset);
        const usage = await usageCenter.report();
        broadcast({ type: 'operations', usage });
        return { usage };
      }
      case 'harnesses.probe': {
        if (typeof p.harnessId === 'string' && p.harnessId) {
          const adapter = registry.get(p.harnessId);
          if (!adapter) throw new Error(`Unknown harness: ${p.harnessId}`);
          return { harnesses: [await adapter.probe()] };
        }
        return { harnesses: await registry.probeAll() };
      }
      case 'harnesses.configure': {
        const harnessId = requireString(p.harnessId, 'harnessId');
        const patch: Record<string, unknown> = { ...(typeof p.config === 'object' && p.config ? p.config : {}) };
        for (const k of ['enabled', 'bin', 'args', 'defaultModel', 'envAllowlist'] as const) {
          if (p[k] !== undefined) patch[k] = p[k];
        }
        return { harness: registry.configure(harnessId, patch) };
      }
      case 'harnesses.registerCustom': {
        const src = typeof p.spec === 'object' && p.spec ? p.spec : p;
        return {
          custom: registry.saveCustomSpec({
            id: requireString(src.id, 'id'),
            name: requireString(src.name, 'name'),
            command: requireString(src.command, 'command'),
            args: src.args,
            cwd: src.cwd,
            envAllowlist: src.envAllowlist,
            enabled: src.enabled,
          }),
        };
      }
      case 'harnesses.removeCustom':
        return { removed: registry.removeCustomSpec(requireString(p.id ?? p.harnessId, 'id')) };
      case 'workspaces.list':
        return { workspaces: workspaces.list() };
      case 'workspaces.create': {
        const ws = workspaces.createOrGet(absCwd(p.cwd), { name: p.name, harnessId: p.harnessId });
        return { workspace: ws };
      }
      case 'workspaces.get': {
        const ws = workspaces.get(requireString(p.workspaceId, 'workspaceId'));
        if (!ws) throw new Error('Workspace not found');
        return { workspace: ws };
      }
      case 'agent.account':
        return accountInfo(!!p.refresh);
      case 'harnesses.accounts': {
        const harnesses = p.refresh ? await registry.probeAll() : registry.list();
        const devin = await accountInfo(!!p.refresh, false);
        return { harnesses, devinUsage: devin.usage, devinUsageError: devin.usageError };
      }
      case 'agent.status':
        try {
          await manager.ensureAgent();
        } catch {
          /* reported in status */
        }
        return { agent: manager.agentStatus(), capabilities: manager.initResult?.agentCapabilities ?? null };
      case 'agent.authenticate':
        return manager.authenticate(requireString(p.methodId, 'methodId'));
      case 'projects.list': {
        const paths = [...new Set(manager.topLevelSessions().map((s) => s.cwd))].filter((path) => !isScratchPath(path));
        const projects = listProjects(config.roots, paths)
          .filter((project) => !config.strictRoots || isPathWithinRoots(project.path, config.roots));
        return { projects, roots: config.roots };
      }
      case 'fs.image': {
        // Agents link screenshots by local path (`![shot](/tmp/x.png)`), which the phone cannot open itself.
        let raw = requireString(p.path, 'path').replace(/^file:\/\//, '');
        try {
          raw = decodeURIComponent(raw);
        } catch {
          /* keep it as written */
        }
        const base = typeof p.cwd === 'string' && p.cwd ? absCwd(p.cwd) : homedir();
        const path = resolve(base, raw.startsWith('~') ? homedir() + raw.slice(1) : raw);
        const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
        if (!mimeType) throw new Error('Not an image file');
        if (config.strictRoots) assertAllowedPath(path, sessionRoots, true);
        if ((await stat(path)).size > 10 * 1024 * 1024) throw new Error('Image is over 10 MB');
        return { mimeType, data: (await readFile(path)).toString('base64') };
      }
      case 'fs.listDirs': {
        const requested = typeof p.path === 'string' && p.path ? p.path : '~';
        const home = requested === '~' || resolve(requested) === homedir();
        // The picker starts at home; with strict roots that exclude home, start at the first root instead.
        if (home && config.strictRoots && config.roots.length && !isPathWithinRoots(homedir(), config.roots)) {
          return listDirectory(config.roots[0]);
        }
        return listDirectory(absCwd(requested));
      }
      case 'sessions.list': {
        const sessions = await registry.listAllSessions(p.cwd ? absCwd(p.cwd) : undefined);
        const filtered = config.strictRoots ? sessions.filter((s: Json) => !s.cwd || isPathWithinRoots(s.cwd, sessionRoots)) : sessions;
        // A delegated subagent belongs to the chat that started it, not to the session list.
        const present = new Set(filtered.map((s: Json) => s.sessionId));
        const delegated = orchestrator.delegatedSessionIds(present);
        return { sessions: delegated.size ? filtered.filter((s: Json) => !delegated.has(s.sessionId)) : filtered };
      }
      case 'session.create': {
        const profile = p.profileId ? profiles.get(requireString(p.profileId, 'profileId')) : undefined;
        if (p.profileId && !profile) throw new Error('Profile not found');
        if (profile) { absCwd(profile.cwd); validateProfileWorkspace(profile); }
        // No project: a fresh gateway-owned scratch folder, which needs no root check and gets no workspace.
        const scratch = !profile && (p.noProject === true || typeof p.cwd !== 'string' || !p.cwd);
        const cwd = scratch ? newScratchDir() : absCwd(p.cwd || profile?.cwd);
        const harnessId = typeof p.harnessId === 'string' && p.harnessId ? p.harnessId : profile?.harnessId ?? 'devin';
        const requestedWorkspaceId = p.workspaceId ?? profile?.workspaceId;
        if (!scratch && requestedWorkspaceId) {
          const workspace = workspaces.get(requestedWorkspaceId);
          if (!workspace) throw new Error('Workspace not found');
          if (absCwd(workspace.cwd) !== cwd) throw new Error('Session folder does not match workspace');
        }
        const effective = profile ? { ...profile, cwd, harnessId, model: p.model === undefined ? profile.model : p.model } : null;
        const s = effective ? await launchProfile(registry, effective, absCwd, p.mode) : await registry.createSession(harnessId, cwd, { model: p.model, mode: p.mode });
        const scopedId = formatScopedSessionId(harnessId, s.sessionId);
        c.subs.add(scopedId);
        let workspaceId: string | null = null;
        try {
          const ws = scratch ? null : requestedWorkspaceId ? workspaces.get(requestedWorkspaceId) : workspaces.createOrGet(cwd, { harnessId });
          if (ws) {
            workspaces.attachSession(ws.workspaceId, { harnessId, sessionId: scopedId, title: s.title, updatedAt: s.updatedAt });
            workspaceId = ws.workspaceId;
          }
        } catch (err) {
          console.warn(safeMessage(`[uniharn] failed to persist workspace for session ${scopedId}: ${err}`));
        }
        return { session: { ...s.summary(), sessionId: scopedId, harnessId }, epoch: s.epoch, workspaceId };
      }
      case 'profiles.list': return { profiles: profiles.list() };
      case 'profiles.create': { const value = p.profile ?? p; validateProfileWorkspace(value); return { profile: profiles.create(value) }; }
      case 'profiles.update': {
        const id = requireString(p.profileId, 'profileId');
        const previous = profiles.get(id); if (!previous) throw new Error('Profile not found');
        const patch = p.patch ?? p.profile ?? {}; validateProfileWorkspace({ ...previous, ...patch });
        return { profile: profiles.update(id, patch) };
      }
      case 'profiles.delete': return { deleted: profiles.delete(requireString(p.profileId, 'profileId')) };
      case 'teams.list': return { teams: teams.list() };
      case 'teams.create': { const value = p.team ?? p; validateTeamProfile(value); return { team: teams.create(value) }; }
      case 'teams.update': {
        const id = requireString(p.teamId, 'teamId'); const previous = teams.get(id); if (!previous) throw new Error('Team not found');
        const patch = p.patch ?? p.team ?? {}; validateTeamProfile({ ...previous, ...patch });
        return { team: teams.update(id, patch) };
      }
      case 'teams.delete': return { deleted: teams.delete(requireString(p.teamId, 'teamId')) };
      case 'teams.start': {
        const team = teams.get(requireString(p.teamId, 'teamId'));
        if (!team) throw new Error('Team not found');
        const profileId = p.profileId ?? team.profileId;
        const profile = profileId ? profiles.get(requireString(profileId, 'profileId')) : undefined;
        if (profileId && !profile) throw new Error('Profile not found');
        if (team.cwd) absCwd(team.cwd);
        if (profile) { absCwd(profile.cwd); validateProfileWorkspace(profile); }
        const cwd = absCwd(p.cwd ?? team.cwd ?? profile?.cwd);
        if (p.sessionId) absCwd((await loadProjectSession(requireString(p.sessionId, 'sessionId'))).session.cwd);
        const launches = await launchTeam(orchestrator, team, requireString(p.task, 'task'), cwd, absCwd, p.sessionId ?? null, profile);
        for (const { link } of launches) c.subs.add(link.childSessionId);
        return { links: launches.map(({ link }) => link) };
      }
      case 'session.handoff': {
        const id = requireString(p.sessionId, 'sessionId');
        const target = requireString(p.harnessId, 'harnessId');
        const { link } = await orchestrator.handoff(id, target, typeof p.instruction === 'string' ? p.instruction : undefined);
        c.subs.add(link.childSessionId);
        return { link };
      }
      case 'orchestration.delegate': {
        const ref = typeof p.sessionRef === 'string' ? sessionRefs.get(p.sessionRef) : undefined;
        const id = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : ref ? formatScopedSessionId(ref.harnessId, ref.sessionId) : null;
        const harnessId = requireString(p.harnessId, 'harnessId');
        const task = requireString(p.task, 'task');
        const { link, done } = await orchestrator.delegate(id, harnessId, task, {
          cwd: typeof p.cwd === 'string' && p.cwd ? absCwd(p.cwd) : id ? undefined : absCwd(p.cwd),
          worktree: !!p.worktree,
          includeContext: !!p.includeContext,
          // null asks for the harness default; omitted uses the default subagent model.
          model: typeof p.model === 'string' && p.model ? p.model : p.model === null ? null : undefined,
          effort: typeof p.effort === 'string' && p.effort ? p.effort : null,
        });
        c.subs.add(link.childSessionId);
        if (p.wait) {
          await done;
          return { link: orchestrator.get(link.id) };
        }
        return { link };
      }
      case 'subagents.get':
        return { subagents: subagents.list() };
      case 'subagents.setDefault': {
        const harnessId = requireString(p.harnessId, 'harnessId');
        subagents.setDefault(harnessId, typeof p.model === 'string' && p.model ? p.model : null);
        return { subagents: subagents.list() };
      }
      case 'subagents.list':
        return { subagents: listSubagents(typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined) };
      case 'subagents.setPolicy': {
        const harnessId = requireString(p.harnessId, 'harnessId');
        const patch: Json = {};
        if (p.mode !== undefined) patch.mode = typeof p.mode === 'string' && p.mode ? p.mode : null;
        if (p.config !== undefined) patch.config = typeof p.config === 'object' && p.config ? p.config : {};
        if (p.enabled !== undefined) patch.enabled = !!p.enabled;
        subagents.setPolicy(harnessId, patch);
        return { subagents: subagents.list() };
      }
      case 'subagents.message': {
        const parentSessionId = requireString(p.parentSessionId, 'parentSessionId');
        const childSessionId = requireString(p.childSessionId, 'childSessionId');
        const text = requireString(p.text, 'text');
        const link = orchestrator.list().find((l) => l.kind === 'delegate' && l.parentSessionId === parentSessionId && l.childSessionId === childSessionId);
        if (link) {
          const delivery = await registry.steerSession(link.childSessionId, `[Urgent message from the parent session]\n\n${text}`);
          return { delivery: 'delegate', mode: delivery.mode, outcome: delivery.outcome ?? null };
        }
        const native = registry.listNativeSubagents().find((x) => formatScopedSessionId(x.harnessId, x.child.sessionId) === childSessionId && formatScopedSessionId(x.harnessId, x.parentSessionId) === parentSessionId);
        if (native) {
          const title = native.child.subagent?.title ?? native.child.title ?? childSessionId;
          await registry.resolveSession(parentSessionId).adapter.prompt(registry.resolveSession(parentSessionId).nativeId, `[Urgent user message for subagent "${title}" (${childSessionId})]\n\n${text}\n\nThis is an urgent user instruction. Please forward it to that subagent or handle it directly, whichever is safest. Do not treat it as a normal queued follow-up if you can steer the running work.`);
          return { delivery: 'parent', mode: 'prompt' };
        }
        throw new Error('Subagent not found');
      }
      case 'orchestration.list': {
        const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
        const filter = { sessionId: str(p.sessionId), status: str(p.status), id: str(p.taskId) ?? str(p.id) };
        return { links: p.summary === true ? orchestrator.summaries(filter) : orchestrator.list(filter.sessionId, filter) };
      }
      case 'orchestration.get': {
        const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
        const link = await orchestrator.detail(requireString(p.id ?? p.taskId, 'id'), { sinceSeq: num(p.sinceSeq), limit: num(p.limit) });
        if (!link) throw new Error('Delegation not found');
        return { link };
      }
      case 'session.open': {
        const id = requireString(p.sessionId, 'sessionId');
        const { adapter, harnessId, nativeId } = registry.resolveSession(id);
        const s = await adapter.ensureLoaded(nativeId, p.cwd ? absCwd(p.cwd) : undefined);
        if (config.strictRoots && !s.subagent) assertAllowedPath(s.cwd, sessionRoots, true);
        c.subs.add(id);
        const firstSeq = s.events[0]?.seq ?? s.seq + 1;
        let since = p.epoch === s.epoch && typeof p.sinceSeq === 'number' ? p.sinceSeq : 0;
        if (since > 0 && since < firstSeq - 1) since = 0;
        return {
          session: { ...s.summary(), sessionId: id, harnessId },
          epoch: s.epoch,
          full: since === 0,
          truncated: since === 0 && firstSeq > 1,
          events: s.events.filter((e) => e.seq > since),
          permissions: [...s.permissions.values()].map(({ rpcId: _r, ...rest }) => rest),
        };
      }
      case 'session.unsubscribe':
        c.subs.delete(requireString(p.sessionId, 'sessionId'));
        return {};
      case 'session.prompt': {
        const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
        await adapter.prompt(nativeId, String(p.text ?? ''), Array.isArray(p.images) ? p.images : [], promptFiles(p.files));
        return {};
      }
      case 'session.cancel': {
        const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
        await adapter.cancel(nativeId);
        return {};
      }
      case 'session.permission': {
        const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
        adapter.resolvePermission(nativeId, requireString(p.requestId, 'requestId'), p.optionId ?? null);
        return {};
      }
      case 'session.setConfig': {
        const id = requireString(p.sessionId, 'sessionId');
        const { adapter, harnessId, nativeId } = registry.resolveSession(id);
        const summary = await adapter.setConfigOption(nativeId, requireString(p.configId, 'configId'), p.value);
        return { session: { ...summary, sessionId: id, harnessId } };
      }
      case 'session.setMode': {
        const id = requireString(p.sessionId, 'sessionId');
        const { adapter, harnessId, nativeId } = registry.resolveSession(id);
        const summary = await adapter.setMode(nativeId, requireString(p.modeId, 'modeId'));
        return { session: { ...summary, sessionId: id, harnessId } };
      }
      case 'session.close': {
        const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
        await adapter.closeSession(nativeId);
        return {};
      }
      case 'session.delete': {
        const { adapter, nativeId } = registry.resolveSession(requireString(p.sessionId, 'sessionId'));
        await adapter.deleteSession(nativeId);
        return {};
      }
      case 'notifications.list':
        return notifications.list({ sinceSeq: typeof p.sinceSeq === 'number' ? p.sinceSeq : undefined, limit: typeof p.limit === 'number' ? p.limit : undefined, unreadOnly: !!p.unreadOnly });
      case 'notifications.read':
        return { ids: notifications.markRead(Array.isArray(p.ids) ? p.ids.map(String) : null), unreadCount: notifications.unreadCount() };
      case 'notifications.clear':
        notifications.clear();
        return {};
      case 'notifications.prefs.get':
        return { prefs: notifications.getPrefs() };
      case 'notifications.prefs.set':
        return { prefs: notifications.setPrefs(typeof p.prefs === 'object' && p.prefs ? p.prefs : {}) };
      case 'notifications.capabilities':
        return { capabilities: notifications.getCapabilities() };
      case 'notifications.push.publicKey':
        return { publicKey: notifications.publicKey() };
      case 'notifications.push.subscribe':
        return notifications.subscribe(p.subscription, typeof p.label === 'string' ? p.label : null, c.deviceId);
      case 'notifications.push.unsubscribe':
        return notifications.unsubscribe(requireString(p.endpoint, 'endpoint'));
      case 'notifications.push.list':
        return { subscriptions: notifications.listSubscriptions(), subscribed: typeof p.endpoint === 'string' ? notifications.hasSubscription(p.endpoint) : undefined };
      case 'notifications.test': {
        const n = notifications.notify({ type: 'task_completed', title: 'Test notification', body: 'Notifications from this gateway are working.', safeBody: 'Notifications from this gateway are working.', route: '#/settings', dedupKey: `test:${Date.now()}` });
        if (!n) return { delivered: false, reason: 'Notifications or the task-completed event are turned off' };
        const push = await notifications.waitForPush(n.id);
        return { delivered: true, notification: n, push };
      }
      case 'tasks.detect':
        return { command: detectTestCommand(absCwd(p.cwd)) };
      case 'tasks.run': {
        const cwd = absCwd(p.cwd);
        const command = typeof p.command === 'string' && p.command.trim() ? p.command : detectTestCommand(cwd);
        if (!command) throw new Error('No test command detected; enter one manually');
        const { output: _o, ...rest } = tasks.start(cwd, command);
        return { task: rest };
      }
      case 'tasks.get': {
        const run = tasks.runs.get(requireString(p.taskId, 'taskId'));
        if (!run) throw new Error('Task not found');
        return { task: run };
      }
      case 'tasks.list':
        return { tasks: tasks.list(p.cwd ? absCwd(p.cwd) : undefined) };
      case 'tasks.stop':
        tasks.stop(requireString(p.taskId, 'taskId'));
        return {};
      case 'term.open': {
        const info = terminals.open({ cwd: termCwd(p.cwd), cols: p.cols, rows: p.rows, kind: p.kind, args: p.args });
        c.terms.add(info.termId);
        return { term: info, scrollback: '' };
      }
      case 'term.attach': {
        const id = requireString(p.termId, 'termId');
        const r = terminals.attach(id);
        c.terms.add(id);
        return { term: r.info, scrollback: r.scrollback };
      }
      case 'term.detach':
        c.terms.delete(requireString(p.termId, 'termId'));
        return {};
      case 'term.input':
        terminals.write(requireString(p.termId, 'termId'), String(p.data ?? ''));
        return undefined;
      case 'term.resize':
        terminals.resize(requireString(p.termId, 'termId'), p.cols, p.rows);
        return undefined;
      case 'term.close':
        terminals.close(requireString(p.termId, 'termId'));
        return {};
      case 'term.list':
        return { terminals: terminals.list() };
      default:
        throw new Error(`Unknown request: ${type}`);
    }
  }

  function disconnectRevoked(client: Client) {
    if (!client.authed || !client.deviceId) return;
    notifications.removeDeviceSubscriptions(client.deviceId);
    client.authed = false;
    send(client, { type: 'device_revoked', deviceId: client.deviceId, reason: 'Device token has been revoked' });
    client.ws.close(4003, 'device revoked');
  }

  function checkDevice(client: Client): boolean {
    if (!client.deviceId) return true;
    const device = authStore.listDevices().find((row) => row.deviceId === client.deviceId);
    if (device?.revokedAt === null) return true;
    disconnectRevoked(client);
    return false;
  }

  async function request(req: IncomingMessage, res: ServerResponse) {
    try {
      const { pathname } = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true, name: 'uniharn', ...gatewayInfo, tailscaleIp: config.tailscaleIp, magicDns: config.magicDns });
      } else if (pathname === '/api/pair') {
        await handlePairRequest(req, res, authStore, pairLimiter, gatewayInfo);
      } else if (config.staticDir) {
        serveStatic(config.staticDir, req, res);
      } else {
        res.writeHead(404).end('uniharn gateway. Connect with the app at ws(s)://<host>/ws');
      }
    } catch (error) {
      console.error(`[uniharn] HTTP error: ${safeMessage(error)}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Internal server error' });
      else res.end();
    }
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  wss.on('error', (error) => console.error(`[uniharn] WebSocket server error: ${safeMessage(error)}`));
  const servers: Server[] = config.hosts.map(() => {
    const server = createServer(request);
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.split('?', 1)[0] !== '/ws') {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
    return server;
  });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const c: Client = { ws, ip: clientIp(req), authed: false, deviceId: null, subs: new Set(), terms: new Set(), alive: true };
    clients.add(c);
    const authTimer = setTimeout(() => {
      if (!c.authed) ws.close(4001, 'auth timeout');
    }, 10_000);
    ws.on('pong', () => (c.alive = true));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(authTimer);
      clients.delete(c);
    });
    ws.on('message', async (raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let msg: Json;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { id, type, ...params } = msg ?? {};
      if (!c.authed && type !== 'hello' && type !== 'pair') {
        send(c, { type: 'response', id, ok: false, error: 'Not authenticated' });
        return;
      }
      try {
        if (!checkDevice(c)) return;
        const result = await handle(c, type, params);
        if (c.authed) clearTimeout(authTimer);
        if (id !== undefined) send(c, { type: 'response', id, ok: true, result: result ?? {} });
      } catch (error) {
        const expected = error instanceof RequestError;
        if (id !== undefined) send(c, {
          type: 'response', id, ok: false, error: expected ? error.message : safeMessage(error),
          ...(expected && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
        });
        if (type === 'hello') {
          c.authed = false;
          ws.close(4003, expected && error.message === 'Device token has been revoked' ? 'device revoked' : 'invalid token');
        }
      }
    });
  });

  let heartbeat: NodeJS.Timeout | undefined;
  let idleRelease: NodeJS.Timeout | undefined;
  let revocationPoll: NodeJS.Timeout | undefined;
  let starting = false;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= (async () => {
      clearInterval(heartbeat);
      clearInterval(idleRelease);
      clearInterval(revocationPoll);
      for (const client of clients) client.ws.terminate();
      for (const term of terminals.list()) terminals.close(term.termId);
      tasks.stopAll();
      schedulerRpc.close();
      notifications.dispose();
      manager.stop();
      await Promise.all([
        new Promise<void>((done) => wss.close(() => done())),
        ...servers.map((server) => new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        })),
      ]);
    })();
    return closing;
  }

  async function start(): Promise<AddressInfo[]> {
    if (starting || closing) throw new Error('Gateway has already been started or closed');
    if (!servers.length) throw new Error('Gateway requires at least one bind host');
    starting = true;
    const addresses: AddressInfo[] = [];
    try {
      for (const [i, server] of servers.entries()) {
        const host = config.hosts[i] === '*' ? '0.0.0.0' : config.hosts[i];
        await new Promise<void>((done, reject) => {
          server.once('error', reject);
          server.listen(config.port, host, () => {
            server.off('error', reject);
            done();
          });
        });
        const address = server.address() as AddressInfo;
        config.port = address.port;
        addresses.push(address);
        server.on('error', (error) => console.error(`[uniharn] HTTP server error: ${safeMessage(error)}`));
      }
    } catch (error) {
      await close();
      throw error;
    }
    if (security.isRoot) console.warn('[uniharn] Gateway is running as root. Run it as a non-root user.');
    if (security.publicBindWarning) console.warn('[uniharn] Gateway is listening on all interfaces. Bind to loopback or your Tailscale address.');
    const idleReleaseMs = Number(process.env.UNIHARN_IDLE_RELEASE_MS ?? 120_000);
    if (idleReleaseMs > 0) {
      idleRelease = setInterval(() => {
        for (const info of registry.list()) {
          const watched = (id: string) => [...clients].some((c) => c.subs.has(formatScopedSessionId(info.id, id)));
          registry.get(info.id)?.releaseIdle?.(watched, idleReleaseMs).catch(() => undefined);
        }
      }, Math.max(10_000, Math.min(idleReleaseMs, 60_000))).unref();
    }
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (!client.alive) client.ws.terminate();
        else if (client.ws.readyState === WebSocket.OPEN) {
          client.alive = false;
          client.ws.ping();
        }
      }
    }, 20_000).unref();
    let lastPollError: string | undefined;
    let revocationTick = 0;
    revocationPoll = setInterval(() => {
      // Every 250 ms while device clients are connected, otherwise every 5 s (push subscriptions only).
      if (![...clients].some((client) => client.authed && client.deviceId) && revocationTick++ % 20 !== 0) return;
      try {
        const devices = authStore.listDevices();
        // Revocations can come from the CLI while the device is offline: drop its push subscriptions too.
        for (const device of devices) if (device.revokedAt !== null) notifications.removeDeviceSubscriptions(device.deviceId);
        const active = new Set(devices.filter((device) => device.revokedAt === null).map((device) => device.deviceId));
        for (const client of clients) {
          if (client.deviceId && !active.has(client.deviceId)) disconnectRevoked(client);
        }
        lastPollError = undefined;
      } catch (error) {
        const message = safeMessage(error);
        if (message !== lastPollError) console.error(`[uniharn] Could not check device revocations: ${message}`);
        lastPollError = message;
      }
    }, 250).unref();
    schedulerRpc.start();
    registry.probeAll().catch(() => undefined);
    manager.ensureAgent().catch((error) => {
      if (!closing) console.error(`[uniharn] could not start devin acp: ${safeMessage(error)}`);
    });
    return addresses;
  }

  /** Tells connected apps and Web Push subscribers the gateway is going away, then waits briefly for delivery. */
  async function notifyShutdown(reason: string): Promise<void> {
    const n = notifications.notifyGatewayShutdown(reason);
    const push = n ? notifications.waitForPush(n.id) : Promise.resolve();
    await Promise.race([push, new Promise((done) => setTimeout(done, 1500))]);
  }

  return { start, close, notifyShutdown };
}
