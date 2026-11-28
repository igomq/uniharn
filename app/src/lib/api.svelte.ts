// Connection to the uniharn gateway: one WebSocket, requests plus pushed events, with
// automatic reconnect and per-session resume from the last seen sequence number.
import { getStorageItem, removeStorageItem, setStorageItem } from './storage.ts';
import { defaultDeviceName, detectPlatform, httpBase, pageOrigin, pairDevice } from './pairing.ts';
import { applyUpdate, emptyState, permissionView, stateFromSummary } from './timeline.ts';
import { emptyOperations, removeById, upsertById, type Profile, type ScheduledTask, type Team } from './operations.ts';
import type { UsageReport } from './usage.ts';
import type { AppNotification, ChangedFileView, ConnInfo, DeviceInfo, GitStatus, GitStatusView, HarnessInfo, Json, PendingPermission, SessionLink, SessionRow, SessionSummary, SessionView, SubagentDefault, SubagentEntry, TaskRun, Workspace } from './types.ts';

const STORE_SUFFIX = 'connection';

export const isTauri = typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || location.hostname === 'tauri.localhost' || location.protocol === 'tauri:');

/** What identifies the saved gateway and how this device signs in to it (besides url and token). */
interface SavedMeta {
  deviceId?: string;
  gatewayId?: string;
  authKind?: 'device' | 'master';
}
// Older versions saved only { url, token }; the extra fields are optional.
type SavedConnection = { url?: string; token?: string } & SavedMeta;

function loadSaved(): SavedConnection {
  try {
    const v = JSON.parse(getStorageItem(STORE_SUFFIX) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const REVOKED = 'This device was revoked on the gateway. Pair it again.';

function initial() {
  const saved = loadSaved();
  let url = saved.url || '';
  let token = saved.token || '';
  let meta: SavedMeta = { deviceId: saved.deviceId, gatewayId: saved.gatewayId, authKind: saved.authKind };
  let pair: { url: string; code: string } | null = null;
  // Secrets in the fragment (#pair=CODE from a pairing QR, legacy #token=…) are taken and the fragment is
  // dropped from the address bar and history right away, before any network request.
  const hash = location.hash;
  const p = /[#&]pair=([^&]+)/.exec(hash);
  const m = /[#&]token=([^&]+)/.exec(hash);
  if (p || m) history.replaceState(history.state, '', location.pathname + location.search);
  const servedByGateway = !isTauri && /^https?:$/.test(location.protocol);
  if (p && servedByGateway) {
    let code = '';
    try {
      code = decodeURIComponent(p[1]);
    } catch {
      code = p[1];
    }
    pair = { url: pageOrigin(), code };
  } else if (m) {
    try {
      token = decodeURIComponent(m[1]);
    } catch {
      token = m[1];
    }
    if (!isTauri) url = pageOrigin();
    meta = { gatewayId: url === saved.url ? saved.gatewayId : undefined };
  }
  if (!url && servedByGateway && location.port !== '5173') url = pageOrigin();
  return { url, token, meta, pair };
}

const start = typeof window === 'undefined' ? { url: '', token: '', meta: {} as SavedMeta, pair: null } : initial();
let meta: SavedMeta = start.meta;

export const conn = $state({
  status: 'offline' as 'offline' | 'connecting' | 'online' | 'unauthorized',
  // While a pairing link is being exchanged the stored token (if any) is held back, so nothing connects with it.
  url: start.pair ? start.pair.url : start.url,
  token: start.pair ? '' : start.token,
  info: null as ConnInfo | null,
  error: null as string | null,
  /** True while a pairing code is being exchanged for a device token. */
  pairing: false,
  /** Bumped on every successful (re)connect so screens can refetch. */
  generation: 0
});

function persist() {
  setStorageItem(STORE_SUFFIX, JSON.stringify({ url: conn.url, token: conn.token, ...meta }));
}

export const app = $state({
  sessions: [] as SessionRow[],
  sessionsLoaded: false,
  harnesses: [] as HarnessInfo[],
  workspaces: [] as Workspace[],
  links: [] as SessionLink[],
  subagents: [] as SubagentEntry[],
  subagentSettings: [] as SubagentDefault[]
});

export const views = $state<Record<string, SessionView>>({});

/** Profiles, teams, scheduled tasks and usage from the gateway; scheduled tasks follow `scheduler_state` pushes. */
export const ops = $state(emptyOperations());

/**
 * Tells screens outside this module what changed: `uniharn:operations` with the changed collections as detail,
 * plus `task` and `event` for a scheduler push.
 */
function publishOperations(detail: Json) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('uniharn:operations', { detail }));
}

type TermMessage = { ev: 'term'; data: string } | { ev: 'term-exit'; code: number | null };

let ws: WebSocket | null = null;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const termListeners = new Map<string, (msg: TermMessage) => void>();
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let wanted = false;

export function configured() {
  return Boolean(conn.url && conn.token);
}

// Transcripts belong to the gateway they came from; drop them when it changes.
function clearSessions() {
  for (const id of Object.keys(views)) delete views[id];
  app.sessions = [];
  app.sessionsLoaded = false;
  app.subagents = [];
  app.subagentSettings = [];
  Object.assign(ops, emptyOperations());
}

export function saveConnection(url: string, token: string, identity: SavedMeta = {}) {
  const next = url.trim().replace(/\/+$/, '');
  const gatewayChanged = Boolean(identity.gatewayId && meta.gatewayId && identity.gatewayId !== meta.gatewayId);
  if (next !== conn.url || gatewayChanged) clearSessions();
  // The gateway id stays known for the same address until hello confirms or replaces it.
  meta = { gatewayId: identity.gatewayId ?? (next === conn.url ? meta.gatewayId : undefined), deviceId: identity.deviceId, authKind: identity.authKind };
  conn.url = next;
  conn.token = token.trim();
  conn.error = null;
  persist();
  connect(true);
}

/** Exchanges a one-time pairing code for a device token, saves it and connects. Sets conn.error on failure. */
export async function pairWithCode(url: string, code: string): Promise<boolean> {
  conn.pairing = true;
  conn.error = null;
  try {
    const r = await pairDevice(url, code, defaultDeviceName(), detectPlatform());
    saveConnection(url, r.token, { deviceId: r.deviceId, gatewayId: r.gatewayId, authKind: 'device' });
    return true;
  } catch (err) {
    conn.error = errorText(err);
    return false;
  } finally {
    conn.pairing = false;
  }
}

if (start.pair) {
  const { url, code } = start.pair;
  const previous = { url: start.url, token: start.token };
  queueMicrotask(async () => {
    if (await pairWithCode(url, code)) return;
    // Keep using an earlier working connection to this same gateway if the link was stale.
    if (previous.token && previous.url === url) {
      const error = conn.error;
      conn.token = previous.token;
      connect(true);
      conn.error = error;
    }
  });
}

export function forgetConnection() {
  removeStorageItem(STORE_SUFFIX);
  meta = {};
  wanted = false;
  ws?.close();
  conn.token = '';
  conn.status = 'offline';
  conn.info = null;
  clearSessions();
}

// Accepts what people actually type: `100.x.y.z`, `host:8787`, `http(s)://…` or `ws(s)://…/ws`.
export function wsUrl(input = conn.url) {
  let u = input.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = 'ws://' + u;
  u = u.replace(/^http(s?):\/\//i, 'ws$1://');
  const explicitPort = /^[a-z]+:\/\/(\[[^\]]*\]|[^/:?#]*):\d+/i.test(u);
  const parsed = new URL(u);
  if (!explicitPort && parsed.protocol === 'ws:') parsed.port = '8787';
  if (!/\/ws$/.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/ws';
  return parsed.toString();
}

export function connect(force = false) {
  if (!configured()) return;
  wanted = true;
  if (ws && !force && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    dropWaiting();
  }
  conn.status = 'connecting';
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch (err) {
    conn.status = 'offline';
    conn.error = 'That server address is not valid.';
    return;
  }
  ws = sock;
  sock.onopen = async () => {
    try {
      const hello = await request('hello', { token: conn.token }, true, 10000);
      const gatewayId: string | null = typeof hello.gatewayId === 'string' ? hello.gatewayId : null;
      // Same address, different gateway (reinstalled, or another VM behind the name): forget its transcripts.
      if (gatewayId && meta.gatewayId && gatewayId !== meta.gatewayId) clearSessions();
      meta = {
        gatewayId: gatewayId ?? meta.gatewayId,
        deviceId: hello.deviceId ?? undefined,
        authKind: hello.authKind ?? meta.authKind
      };
      conn.info = {
        host: hello.hostname,
        home: hello.home,
        version: hello.version,
        agent: hello.agent,
        harnesses: hello.harnesses ?? [],
        workspaces: hello.workspaces ?? [],
        notifications: hello.notifications ?? null,
        gatewayId,
        protocolVersion: hello.protocolVersion ?? null,
        minAppVersion: hello.minAppVersion ?? null,
        outdated: hello.outdated ?? null,
        deviceId: hello.deviceId ?? null,
        deviceName: hello.deviceName ?? null,
        authKind: hello.authKind ?? null,
        security: hello.security ?? null,
        scratchDir: hello.scratchDir ?? null,
        textAttachments: !!hello.textAttachments
      };
      app.sessions = (hello.sessions ?? []).map(rowKeepingActivity);
      app.harnesses = hello.harnesses ?? [];
      app.workspaces = hello.workspaces ?? [];
      conn.status = 'online';
      conn.error = null;
      conn.generation += 1;
      retry = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => conn.status === 'online' && probe(10000), 25000);
      persist();
      refreshSessions();
      refreshOperations();
      for (const id of Object.keys(views)) openSession(id).catch(() => {});
    } catch (err) {
      if (ws !== sock) return;
      // Only a rejected token stops the retry loop; anything else reconnects.
      if (!/token/i.test(errorText(err))) return sock.close();
      if (/revoked/i.test(errorText(err))) return markRevoked();
      wanted = false;
      conn.status = 'unauthorized';
      conn.error = errorText(err);
    }
  };
  sock.onmessage = (e) => onMessage(JSON.parse(e.data));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    dropWaiting();
    // 4003: the gateway refused this token (revoked device or invalid token). Retrying cannot help.
    if (e.code === 4003) {
      if (e.reason === 'device revoked') markRevoked();
      else if (conn.status !== 'unauthorized') {
        wanted = false;
        conn.status = 'unauthorized';
        conn.error ||= 'The gateway rejected this token.';
      }
    }
    if (conn.status !== 'unauthorized') conn.status = wanted ? 'connecting' : 'offline';
    if (wanted) {
      retry = Math.min(retry + 1, 6);
      retryTimer = setTimeout(() => connect(true), Math.min(8000, 300 * 2 ** retry));
    }
  };
  sock.onerror = () => {
    conn.error = 'Cannot reach the server.';
  };
}

/** This device's token was revoked: stop reconnecting and send the user back to pairing. */
function markRevoked() {
  wanted = false;
  clearTimeout(retryTimer);
  clearInterval(pingTimer);
  conn.status = 'unauthorized';
  conn.error = REVOKED;
}

if (typeof window !== 'undefined') {
  // Phones suspend sockets in the background; reconnect as soon as the app is visible again.
  const wake = () => {
    if (!wanted || document.visibilityState !== 'visible') return;
    if (!ws || ws.readyState > WebSocket.OPEN) {
      retry = 0;
      connect(true);
    } else if (conn.status === 'online') probe(4000);
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', wake);
}

function dropWaiting() {
  for (const w of waiting.values()) {
    clearTimeout(w.timer);
    w.reject(new Error('Connection lost.'));
  }
  waiting.clear();
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function request(type: string, params: Record<string, Json> = {}, duringHello = false, timeoutMs = 120000): Promise<Json> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || (!duringHello && conn.status !== 'online')) return reject(new Error('Not connected.'));
    const id = nextId++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error('The gateway did not answer in time.'));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ ...params, id, type }));
  });
}

// A socket can look open long after the network under it changed; an unanswered ping proves it is dead.
function probe(timeoutMs: number) {
  const sock = ws;
  request('ping', {}, false, timeoutMs).catch(() => {
    if (ws === sock && sock?.readyState === WebSocket.OPEN) connect(true);
  });
}

const row = (s: SessionSummary): SessionRow => ({
  id: s.sessionId,
  harnessId: s.harnessId ?? 'devin',
  cwd: s.cwd ?? null,
  title: s.title ?? null,
  updatedAt: s.updatedAt ?? null,
  status: s.status === 'unloaded' ? 'idle' : s.status,
  hasMessages: Boolean(s.title) || s.status === 'running' || s.status === 'awaiting_permission'
});

/** A session keeps counting as non-empty once it has shown activity or has a cached transcript. */
function rowKeepingActivity(s: SessionSummary): SessionRow {
  const x = row(s);
  x.hasMessages ||= Boolean(app.sessions.find((p) => p.id === x.id)?.hasMessages) || (views[x.id]?.items.length ?? 0) > 0;
  return x;
}

const sid = (p: Json) => ({ sessionId: p.id });

function mergeSubagentEntries(entries: SubagentEntry[]) {
  for (const e of entries) {
    const i = app.subagents.findIndex((x) => x.childSessionId === e.childSessionId && x.parentSessionId === e.parentSessionId);
    if (i >= 0) app.subagents[i] = { ...app.subagents[i], ...e };
    else app.subagents.unshift(e);
  }
}

function upsertLink(l: SessionLink) {
  const i = app.links.findIndex((x) => x.id === l.id);
  if (i >= 0) app.links[i] = l;
  else app.links.unshift(l);
  if (l.kind === 'delegate') {
    const j = app.subagents.findIndex((x) => x.kind === 'delegate' && x.childSessionId === l.childSessionId && x.parentSessionId === l.parentSessionId);
    if (j >= 0) app.subagents[j] = { ...app.subagents[j], status: l.status, updatedAt: l.updatedAt, canCancel: l.status === 'running' };
  }
  // A delegated child can race into the list before its link arrives; keep it out.
  if (l.kind === 'delegate' && l.parentSessionId && delegatedIds().has(l.childSessionId)) {
    const j = app.sessions.findIndex((s) => s.id === l.childSessionId);
    if (j >= 0) app.sessions.splice(j, 1);
  }
}

/**
 * Sessions that only exist as the child of a delegation with a live parent chat: they live inside
 * that chat, not in the session list. Delegations without a parent, or whose parent is gone, stay listed.
 */
function delegatedIds(visibleIds: Set<string> = new Set(app.sessions.map((s) => s.id))) {
  // A delegate child is hidden while its parent is a listed session or itself a delegated child;
  // parent-less delegations and orphans whose parent is gone stay in the session list.
  const children = new Set(app.links.filter((l) => l.kind === 'delegate' && l.childSessionId).map((l) => l.childSessionId));
  return new Set(app.links.filter((l) => l.kind === 'delegate' && l.parentSessionId && l.childSessionId && (visibleIds.has(l.parentSessionId) || children.has(l.parentSessionId))).map((l) => l.childSessionId));
}

/** The gateway's git status, plus the summary fields the chat header reads (`repo`, `files` with `kind/added/removed`). */
function gitStatusView(r: GitStatus): GitStatusView {
  const entries = r.files ?? [];
  const live = entries.filter((f) => f.status !== 'conflict');
  return {
    repo: r.isRepo,
    branch: r.branch,
    files: entries.map((f): ChangedFileView => ({ path: f.path, kind: f.status === 'untracked' ? 'added' : f.status, added: f.binary ? null : f.additions, removed: f.binary ? null : f.deletions })),
    upstream: r.upstream ?? null,
    ahead: r.ahead ?? 0,
    behind: r.behind ?? 0,
    head: r.head ?? null,
    repoRoot: r.repoRoot ?? null,
    detached: r.detached ?? false,
    hasConflicts: r.hasConflicts ?? false,
    operation: r.operation ?? null,
    entries,
    staged: live.filter((f) => f.staged),
    unstaged: live.filter((f) => f.unstaged || f.status === 'untracked'),
    conflicted: entries.filter((f) => f.status === 'conflict')
  };
}

// The screens speak in terms of what they need; this table maps each call onto the gateway's
// request types and reshapes the answer.
const calls: Record<string, (p: Json) => Promise<Json>> = {
  'sessions.create': async (p) => {
    const r = await request('session.create', {
      ...(p.noProject ? { noProject: true } : { cwd: p.cwd }),
      ...(p.harnessId && p.harnessId !== 'devin' ? { harnessId: p.harnessId } : {}),
      ...(p.profileId ? { profileId: p.profileId } : {})
    });
    upsert(r.session);
    return { id: r.session.sessionId, cwd: r.session.cwd };
  },
  'session.prompt': (p) => request('session.prompt', { ...sid(p), text: p.text, images: p.images ?? [], ...(p.files?.length ? { files: p.files } : {}) }),
  'fs.image': (p) => request('fs.image', { path: p.path, ...(p.cwd ? { cwd: p.cwd } : {}) }),
  'session.cancel': (p) => request('session.cancel', sid(p)),
  'session.permission': (p) => request('session.permission', { ...sid(p), requestId: p.reqId, optionId: p.optionId }),
  'session.setMode': (p) => request('session.setMode', { ...sid(p), modeId: p.modeId }),
  'session.setConfig': (p) => request('session.setConfig', { ...sid(p), configId: p.configId, value: p.value }),
  'session.close': async (p) => {
    const r = await request('session.close', sid(p));
    delete views[p.id];
    return r;
  },
  'session.delete': async (p) => {
    const r = await request('session.delete', sid(p));
    delete views[p.id];
    return r;
  },
  'git.status': async (p) => gitStatusView(await request('git.status', { cwd: p.cwd })),
  'git.diff': (p) => request('git.diff', { cwd: p.cwd, path: p.path, scope: p.scope }),
  'git.log': async (p) => (await request('git.log', { cwd: p.cwd, limit: p.limit })).commits,
  'git.commitShow': (p) => request('git.commitShow', { cwd: p.cwd, hash: p.hash }),
  'git.stage': async (p) => gitStatusView(await request('git.stage', { cwd: p.cwd, paths: p.paths, all: p.all })),
  'git.unstage': async (p) => gitStatusView(await request('git.unstage', { cwd: p.cwd, paths: p.paths, all: p.all })),
  'git.discard': async (p) => gitStatusView(await request('git.discard', { cwd: p.cwd, paths: p.paths, confirm: p.confirm })),
  'git.commit': async (p) => {
    const r = await request('git.commit', { cwd: p.cwd, message: p.message, amend: p.amend });
    return { hash: r.hash, subject: r.subject, status: gitStatusView(r.status) };
  },
  'git.branches': async (p) => (await request('git.branches', { cwd: p.cwd })).branches,
  'git.checkout': async (p) => gitStatusView(await request('git.checkout', { cwd: p.cwd, branch: p.branch })),
  'git.createBranch': async (p) => gitStatusView(await request('git.createBranch', { cwd: p.cwd, name: p.name, from: p.from, checkout: p.checkout })),
  'git.deleteBranch': async (p) =>
    gitStatusView(await request('git.deleteBranch', { cwd: p.cwd, name: p.name, force: p.force, confirmForce: p.confirmForce })),
  'git.fetch': (p) => request('git.fetch', { cwd: p.cwd, remote: p.remote, prune: p.prune }),
  'git.pull': (p) => request('git.pull', { cwd: p.cwd, remote: p.remote, branch: p.branch, rebase: p.rebase }),
  'git.push': (p) =>
    request('git.push', { cwd: p.cwd, remote: p.remote, branch: p.branch, setUpstream: p.setUpstream, force: p.force, confirmForce: p.confirmForce }),
  'git.conflicts': (p) => request('git.conflicts', { cwd: p.cwd }),
  'git.resolveConflict': (p) => request('git.resolveConflict', { cwd: p.cwd, path: p.path, strategy: p.strategy, content: p.content }),
  'git.abortConflict': async (p) => gitStatusView(await request('git.abortConflict', { cwd: p.cwd, confirm: p.confirm })),
  'git.worktrees': async (p) => (await request('git.worktrees', { cwd: p.cwd })).worktrees,
  'git.worktreeAdd': (p) =>
    request('git.worktreeAdd', { cwd: p.cwd, path: p.path, branch: p.branch, newBranch: p.newBranch, baseRef: p.baseRef, taskSlug: p.taskSlug }),
  'git.worktreeRemove': (p) =>
    request('git.worktreeRemove', { cwd: p.cwd, worktreePath: p.worktreePath, force: p.force, confirmDirty: p.confirmDirty, deleteBranch: p.deleteBranch }),
  'git.worktreePrune': async (p) => (await request('git.worktreePrune', { cwd: p.cwd })).worktrees,
  'git.worktreeCompare': (p) => request('git.worktreeCompare', { cwd: p.cwd, worktreePath: p.worktreePath, baseBranch: p.baseBranch }),
  'git.worktreeMerge': (p) =>
    request('git.worktreeMerge', {
      cwd: p.cwd,
      worktreePath: p.worktreePath,
      targetBranch: p.targetBranch,
      squash: p.squash,
      confirm: p.confirm,
      removeAfter: p.removeAfter
    }),
  'git.prStatus': (p) => request('git.prStatus', { cwd: p.cwd }),
  'git.prList': async (p) => (await request('git.prList', { cwd: p.cwd, state: p.state, limit: p.limit })).prs,
  'git.prView': (p) => request('git.prView', { cwd: p.cwd, number: p.number }),
  'git.prDiff': (p) => request('git.prDiff', { cwd: p.cwd, number: p.number }),
  'git.prCreate': (p) => request('git.prCreate', { cwd: p.cwd, title: p.title, body: p.body, base: p.base, head: p.head, draft: p.draft }),
  'git.sessionPrGet': async (p) => (await request('git.sessionPrGet', { sessionId: p.id })).link,
  'git.sessionPrLink': async (p) => (await request('git.sessionPrLink', { sessionId: p.id, link: p.link })).link,
  'git.sessionPrUnlink': (p) => request('git.sessionPrUnlink', { sessionId: p.id }),
  'fs.list': async (p) => {
    const r = await request('fs.listDirs', { path: p.path });
    return { path: r.path, parent: r.parent, dirs: r.entries.map((d: { name: string; isGit: boolean }) => ({ name: d.name, git: d.isGit })) };
  },
  'tasks.detect': (p) => request('tasks.detect', { cwd: p.cwd }),
  'tasks.run': async (p) => (await request('tasks.run', { cwd: p.cwd, command: p.command })).task,
  'tasks.list': async (p) => (await request('tasks.list', { cwd: p.cwd })).tasks,
  'tasks.get': async (p) => (await request('tasks.get', { taskId: p.id })).task,
  'tasks.stop': (p) => request('tasks.stop', { taskId: p.id }),
  'term.open': async (p) => {
    const r = await request('term.open', { cwd: p.cwd, cols: p.cols, rows: p.rows, kind: p.devin ? 'devin' : 'shell', args: p.devin ?? undefined });
    return { id: r.term.termId };
  },
  'term.attach': async (p) => {
    const r = await request('term.attach', { termId: p.id });
    return { id: r.term.termId, exited: r.term.exited ? r.term.exitCode : null, buffer: r.scrollback };
  },
  'term.input': (p) => request('term.input', { termId: p.id, data: p.data }),
  'term.resize': (p) => request('term.resize', { termId: p.id, cols: p.cols, rows: p.rows }),
  'term.detach': (p) => request('term.detach', { termId: p.id }),
  'term.close': (p) => request('term.close', { termId: p.id }),
  'agent.status': async () => (await request('agent.status')).agent,
  'agent.account': (p) => request('agent.account', { refresh: !!p.refresh }),
  'harnesses.list': async () => (await request('harnesses.list')).harnesses,
  'harnesses.accounts': (p) => request('harnesses.accounts', { refresh: !!p.refresh }),
  'harnesses.probe': async (p) => (await request('harnesses.probe', { harnessId: p.harnessId })).harnesses,
  'harnesses.configure': (p) => request('harnesses.configure', p),
  'workspaces.list': async () => (await request('workspaces.list')).workspaces,
  'workspaces.create': async (p) => (await request('workspaces.create', p)).workspace,
  'session.handoff': async (p) => (await request('session.handoff', { ...sid(p), harnessId: p.harnessId, instruction: p.instruction })).link,
  'orchestration.delegate': async (p) =>
    (await request('orchestration.delegate', { ...sid(p), harnessId: p.harnessId, task: p.task, worktree: !!p.worktree, includeContext: !!p.includeContext, model: p.model === undefined ? undefined : p.model || null })).link,
  'subagents.setDefault': async (p) => {
    const r = await request('subagents.setDefault', { harnessId: p.harnessId, model: p.model ?? null });
    app.subagentSettings = r.subagents;
    return r.subagents;
  },
  'subagents.get': async () => {
    const r = await request('subagents.get');
    app.subagentSettings = r.subagents;
    return r.subagents;
  },
  'subagents.list': async (p) => {
    const r = await request('subagents.list', p?.sessionId ? { sessionId: p.sessionId } : {});
    mergeSubagentEntries(r.subagents ?? []);
    return r.subagents;
  },
  'subagents.setPolicy': async (p) => {
    const r = await request('subagents.setPolicy', { harnessId: p.harnessId, mode: p.mode, config: p.config, enabled: p.enabled });
    app.subagentSettings = r.subagents;
    return r.subagents;
  },
  'subagents.message': (p) => request('subagents.message', { parentSessionId: p.parentSessionId, childSessionId: p.childSessionId, text: p.text }),
  'orchestration.list': async (p) => {
    const r = await request('orchestration.list', p?.id ? sid(p) : {});
    for (const l of r.links as SessionLink[]) upsertLink(l);
    return r.links;
  },
  'projects.list': () => request('projects.list'),
  'profiles.list': async () => {
    const r = await request('profiles.list');
    ops.profiles = r.profiles;
    publishOperations({ profiles: ops.profiles });
    return r.profiles;
  },
  'profiles.create': async (p) => saveProfile((await request('profiles.create', { profile: p.profile })).profile),
  'profiles.update': async (p) => saveProfile((await request('profiles.update', { profileId: p.profileId, patch: p.patch })).profile),
  'profiles.delete': async (p) => {
    const r = await request('profiles.delete', { profileId: p.profileId });
    ops.profiles = removeById(ops.profiles, p.profileId);
    publishOperations({ profiles: ops.profiles });
    return r;
  },
  'teams.list': async () => {
    const r = await request('teams.list');
    ops.teams = r.teams;
    publishOperations({ teams: ops.teams });
    return r.teams;
  },
  'teams.create': async (p) => saveTeam((await request('teams.create', { team: p.team })).team),
  'teams.update': async (p) => saveTeam((await request('teams.update', { teamId: p.teamId, patch: p.patch })).team),
  'teams.delete': async (p) => {
    const r = await request('teams.delete', { teamId: p.teamId });
    ops.teams = removeById(ops.teams, p.teamId);
    publishOperations({ teams: ops.teams });
    return r;
  },
  // Each role becomes a delegated session; without a parent session they are listed like any other session.
  'teams.start': async (p) => {
    const r = await request('teams.start', {
      teamId: p.teamId,
      task: p.task,
      ...(p.cwd ? { cwd: p.cwd } : {}),
      ...(p.profileId ? { profileId: p.profileId } : {}),
      ...(p.sessionId ? { sessionId: p.sessionId } : {})
    });
    const links = r.links as SessionLink[];
    for (const l of links) upsertLink(l);
    await refreshSessions();
    return links;
  },
  // Scheduler params pass through unchanged: `{ task }` to create, `{ taskId, patch }` to update, `{ taskId }` otherwise.
  'scheduler.list': async (p) => {
    const r = await request('scheduler.list', p);
    ops.tasks = r.tasks;
    publishOperations({ tasks: ops.tasks });
    return r.tasks;
  },
  'scheduler.create': async (p) => saveTask((await request('scheduler.create', p)).task),
  'scheduler.update': async (p) => saveTask((await request('scheduler.update', p)).task),
  'scheduler.cancel': async (p) => saveTask((await request('scheduler.cancel', p)).task),
  'scheduler.release': async (p) => saveTask((await request('scheduler.release', p)).task),
  'scheduler.confirm': async (p) => saveTask((await request('scheduler.confirm', p)).task),
  'scheduler.delete': async (p) => {
    const r = await request('scheduler.delete', p);
    ops.tasks = removeById(ops.tasks, r.task?.id ?? p.taskId ?? p.id);
    publishOperations({ tasks: ops.tasks });
    return r.task;
  },
  // Both answer `{ usage: UsageReport }`; an update is also broadcast to every client as an `operations` message.
  'usage.list': async (p) => saveUsage((await request('usage.list', p.refresh ? { refresh: true } : {})).usage),
  'usage.update': async (p) =>
    saveUsage((await request('usage.update', { harnessId: p.harnessId, ...(p.manual !== undefined ? { manual: p.manual } : {}), ...(p.reset ? { reset: true } : {}) })).usage),
  'notifications.list': (p) => request('notifications.list', p),
  'notifications.read': (p) => request('notifications.read', p),
  'notifications.clear': () => request('notifications.clear'),
  'notifications.prefs.get': () => request('notifications.prefs.get'),
  'notifications.prefs.set': (p) => request('notifications.prefs.set', p),
  'notifications.capabilities': () => request('notifications.capabilities'),
  'notifications.push.publicKey': () => request('notifications.push.publicKey'),
  'notifications.push.subscribe': (p) => request('notifications.push.subscribe', p),
  'notifications.push.unsubscribe': (p) => request('notifications.push.unsubscribe', p),
  'notifications.push.list': (p) => request('notifications.push.list', p),
  'notifications.test': () => request('notifications.test'),
  'pairing.create': (p) => {
    const url = p.url ?? shareableUrl(conn.url);
    return request('pairing.create', { ...(p.ttlSec ? { ttlSec: p.ttlSec } : {}), ...(url ? { url } : {}) });
  },
  'pairing.list': async () => (await request('pairing.list')).codes,
  'pairing.revoke': (p) => request('pairing.revoke', { codeId: p.codeId }),
  'devices.list': async () => (await request('devices.list')).devices as DeviceInfo[],
  'devices.rename': async (p) => {
    const r = await request('devices.rename', { deviceId: p.deviceId, name: p.name });
    if (conn.info && r.device?.deviceId === conn.info.deviceId) conn.info.deviceName = r.device.name;
    return r.device;
  },
  'devices.revoke': async (p) => (await request('devices.revoke', { deviceId: p.deviceId })).device,
  'devices.rotate': async () => {
    const r = await request('devices.rotate');
    // The old token stops working at once; keep the new one before anything else can fail.
    if (typeof r.token === 'string' && r.token) {
      conn.token = r.token;
      persist();
    }
    return r.device;
  },
  'gateway.diagnostics': () => request('gateway.diagnostics')
};

/** The HTTP form of the gateway address for pairing links; loopback addresses are left for the gateway to choose. */
function shareableUrl(url: string): string | undefined {
  try {
    const base = httpBase(url);
    const host = new URL(base).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ? undefined : base;
  } catch {
    return undefined;
  }
}

export function rpc(m: string, p: Json = {}): Promise<Json> {
  const fn = calls[m];
  return fn ? fn(p) : Promise.reject(new Error(`Unknown call: ${m}`));
}

function saveProfile(profile: Profile) {
  ops.profiles = upsertById(ops.profiles, profile);
  publishOperations({ profiles: ops.profiles });
  return profile;
}

function saveTeam(team: Team) {
  ops.teams = upsertById(ops.teams, team);
  publishOperations({ teams: ops.teams });
  return team;
}

function saveTask(task: ScheduledTask) {
  ops.tasks = upsertById(ops.tasks, task);
  publishOperations({ tasks: ops.tasks });
  return task;
}

function saveUsage(usage: UsageReport) {
  ops.usage = usage;
  publishOperations({ usage });
  return usage;
}

/**
 * Loads profiles, teams and scheduled tasks after each connect. Gateways without them reject the calls,
 * which leaves `ops.loaded` false.
 */
export async function refreshOperations() {
  const [profiles] = await Promise.allSettled([rpc('profiles.list'), rpc('teams.list'), rpc('scheduler.list')]);
  ops.loaded = profiles.status === 'fulfilled';
}

/** Pre-notification-system gateways only: a background system notification. Newer gateways send `notification` events. */
function legacyNotify(type: 'approval_requested' | 'task_completed' | 'execution_failed', title: string, safeBody: string, detail: string) {
  if (conn.info?.notifications || document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  let prefs: { enabled?: boolean; hideSensitiveDetails?: boolean; events?: Record<string, boolean> } | null = null;
  try {
    prefs = JSON.parse(getStorageItem('notification-prefs') || 'null');
  } catch {
    prefs = null;
  }
  if (prefs?.enabled === false || prefs?.events?.[type] === false) return;
  try {
    new Notification(title, { body: prefs?.hideSensitiveDetails === false && detail ? detail : safeBody, tag: 'uniharn' });
  } catch {
    // not supported in this webview
  }
}

function upsert(summary: SessionSummary) {
  const r = row(summary);
  // Native ACP children are transcript views only; they never become top-level chats.
  if (summary.subagent) {
    const v = views[r.id];
    if (v) Object.assign(v.state, stateFromSummary(summary));
    if (app.sessions.some((s) => s.id === r.id)) app.sessions = app.sessions.filter((s) => s.id !== r.id);
    return;
  }
  // Delegated subagents stay out of the session list but still refresh an open transcript view.
  if (!delegatedIds().has(r.id)) {
    const i = app.sessions.findIndex((s) => s.id === r.id);
    if (i >= 0) {
      if (app.sessions[i].status === 'running' && (r.status === 'idle' || r.status === 'error')) {
        if (r.status === 'idle') legacyNotify('task_completed', 'Session finished', 'A session finished its turn', r.title || r.cwd || '');
        else legacyNotify('execution_failed', 'Session hit an error', 'A session stopped with an error', r.title || r.cwd || '');
      }
      // A session keeps counting as non-empty once it has shown activity.
      r.hasMessages ||= app.sessions[i].hasMessages;
      app.sessions[i] = r;
    } else app.sessions.unshift(r);
  }
  const v = views[r.id];
  if (v) Object.assign(v.state, stateFromSummary(summary));
}

function onMessage(msg: Json) {
  switch (msg.type) {
    case 'response': {
      const w = waiting.get(msg.id);
      if (!w) return;
      waiting.delete(msg.id);
      clearTimeout(w.timer);
      return msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error));
    }
    case 'event': {
      const v = views[msg.sessionId];
      if (!v || !v.ready) return;
      if (msg.epoch === v.epoch && msg.seq === v.seq + 1) {
        applyUpdate(v, msg.update, msg.at);
        v.seq = msg.seq;
      } else if (msg.epoch !== v.epoch || msg.seq > v.seq + 1) openSession(msg.sessionId).catch(() => {});
      return;
    }
    case 'session_reset':
      if (views[msg.sessionId]) openSession(msg.sessionId).catch(() => {});
      return;
    case 'subagent_state': {
      const sub = msg.subagent as SubagentEntry | undefined;
      if (sub?.childSessionId) mergeSubagentEntries([sub]);
      if (msg.session) upsert(msg.session);
      return;
    }
    case 'session_state':
      return upsert(msg.session);
    case 'session_deleted':
      delete views[msg.sessionId];
      app.sessions = app.sessions.filter((s) => s.id !== msg.sessionId);
      return;
    case 'permission_request': {
      const v = views[msg.sessionId];
      const p = v && permissionView(msg, v);
      legacyNotify('approval_requested', 'Approval needed', 'A session is waiting for your permission', p?.title ?? msg.toolCall?.title ?? '');
      if (v && p && !v.state.permissions.some((x) => x.reqId === msg.requestId)) v.state.permissions.push(p);
      return;
    }
    case 'permission_resolved': {
      const v = views[msg.sessionId];
      if (v) v.state.permissions = v.state.permissions.filter((x) => x.reqId !== msg.requestId);
      return;
    }
    case 'device_revoked':
      markRevoked();
      ws?.close();
      return;
    case 'agent_status':
      if (conn.info) conn.info.agent = msg.agent;
      return;
    case 'term_data':
      return termListeners.get(msg.termId)?.({ ev: 'term', data: msg.data });
    case 'term_exit':
      return termListeners.get(msg.term.termId)?.({ ev: 'term-exit', code: msg.term.exitCode });
    case 'harness_status': {
      const i = app.harnesses.findIndex((h) => h.id === msg.harness.id);
      if (i >= 0) app.harnesses[i] = msg.harness;
      else app.harnesses.push(msg.harness);
      return;
    }
    case 'orchestration_link':
      return upsertLink(msg.link);
    case 'scheduler_state':
      ops.tasks = msg.event === 'deleted' ? removeById(ops.tasks, msg.task.id) : upsertById(ops.tasks, msg.task);
      return publishOperations({ tasks: ops.tasks, task: msg.task, event: msg.event });
    case 'operations':
      if (msg.usage) saveUsage(msg.usage);
      return;
    case 'task_output':
    case 'task_done':
      for (const fn of taskListeners) fn(msg);
      return;
    case 'notification':
    case 'notification_read':
    case 'notifications_cleared':
      for (const fn of notificationListeners) fn(msg);
  }
}

export function refreshSubagents(sessionId?: string) {
  return rpc('subagents.list', sessionId ? { sessionId } : {}).catch(() => [] as SubagentEntry[]);
}

let listInFlight: Promise<void> | null = null;
export function refreshSessions() {
  listInFlight ??= request('sessions.list')
    .then(async (r) => {
      // Links decide which sessions are delegated children; load them before filtering.
      await rpc('orchestration.list').catch(() => []);
      const delegated = delegatedIds(new Set(r.sessions.map((s: SessionSummary) => s.sessionId)));
      app.sessions = r.sessions.filter((s: SessionSummary) => !delegated.has(s.sessionId)).map(rowKeepingActivity);
      app.sessionsLoaded = true;
    })
    .catch(() => {})
    .finally(() => (listInFlight = null));
  return listInFlight;
}

const opening = new Map<string, Promise<void>>();
/** Load or catch up a session view; concurrent calls for the same session share one request. */
export function openSession(id: string, cwd?: string | null): Promise<void> {
  let p = opening.get(id);
  if (!p) {
    p = loadSession(id, cwd).finally(() => opening.delete(id));
    opening.set(id, p);
  }
  return p;
}

async function loadSession(id: string, cwd?: string | null) {
  const v = (views[id] ??= { epoch: null, seq: 0, cwd: cwd ?? null, items: [], tools: {}, state: emptyState(), ready: false, error: null, truncated: false });
  try {
    // After a gateway restart only the session list knows this session's project; opened without it,
    // the gateway would load the session in its own working directory.
    if (!(cwd ?? v.cwd) && !app.sessions.some((s) => s.id === id)) await refreshSessions();
    const dir = cwd ?? v.cwd ?? app.sessions.find((s) => s.id === id)?.cwd;
    const r = await request('session.open', { sessionId: id, cwd: dir ?? undefined, epoch: v.ready ? v.epoch : undefined, sinceSeq: v.ready ? v.seq : undefined });
    const view = views[id];
    if (!view) return;
    if (r.full) Object.assign(view, { items: [], tools: {}, seq: 0, truncated: r.truncated });
    view.epoch = r.epoch;
    view.cwd = r.session.cwd;
    for (const e of r.events) {
      if (e.seq <= view.seq) continue;
      applyUpdate(view, e.update, e.at);
      view.seq = e.seq;
    }
    Object.assign(view.state, stateFromSummary(r.session));
    view.state.permissions = r.permissions.map((p: PendingPermission) => permissionView(p, view));
    view.ready = true;
    view.error = null;
    upsert(r.session);
  } catch (err) {
    if (views[id]) views[id].error = errorText(err);
    throw err;
  }
}

export function leaveSession(id: string) {
  delete views[id];
  request('session.unsubscribe', { sessionId: id }).catch(() => {});
}

export function onTerminal(id: string, fn: (msg: TermMessage) => void) {
  termListeners.set(id, fn);
  return () => termListeners.delete(id);
}

type TaskMessage = { type: 'task_output'; taskId: string; cwd: string; chunk: string } | { type: 'task_done'; task: TaskRun };
const taskListeners = new Set<(msg: TaskMessage) => void>();
export function onTask(fn: (msg: TaskMessage) => void) {
  taskListeners.add(fn);
  return () => taskListeners.delete(fn);
}

export type NotificationMessage =
  | { type: 'notification'; notification: AppNotification }
  | { type: 'notification_read'; ids: string[]; unreadCount: number }
  | { type: 'notifications_cleared' };
const notificationListeners = new Set<(msg: NotificationMessage) => void>();
export function onNotificationMessage(fn: (msg: NotificationMessage) => void) {
  notificationListeners.add(fn);
  return () => notificationListeners.delete(fn);
}
