import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

export const NOTIFICATION_EVENTS = [
  'approval_requested',
  'task_completed',
  'execution_failed',
  'subagent_completed',
  'git_conflict',
  'gateway_disconnected',
  'attention_needed',
] as const;
export type NotificationEventType = (typeof NOTIFICATION_EVENTS)[number];
export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRecord {
  id: string;
  seq: number;
  type: NotificationEventType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Lock-screen safe text sent over Web Push when sensitive details are hidden. */
  safeBody: string;
  sessionId: string | null;
  harnessId: string | null;
  route: string | null;
  dedupKey: string;
  at: number;
  read: boolean;
}

export interface NotificationPrefs {
  enabled: boolean;
  inApp: boolean;
  webPush: boolean;
  hideSensitiveDetails: boolean;
  dedupWindowMs: number;
  attentionTimeoutMs: number;
  events: Record<NotificationEventType, boolean>;
}

export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}
interface StoredSubscription extends PushSubscriptionJson {
  label: string | null;
  deviceId?: string | null;
  createdAt: number;
}

export interface NotifyInput {
  type: NotificationEventType;
  title: string;
  body?: string;
  safeBody?: string;
  severity?: NotificationSeverity;
  sessionId?: string | null;
  harnessId?: string | null;
  route?: string | null;
  dedupKey?: string;
}

export type SendWebPush = (sub: PushSubscriptionJson, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;

export interface PushResult {
  sent: number;
  failed: number;
  removed: number;
}

export interface PlatformCapability {
  status: 'available' | 'requires_secure_context' | 'requires_external_setup' | 'blocked_by_signing';
  background: boolean;
  detail: string;
}

export interface NotificationServiceOptions {
  sendWebPush?: SendWebPush;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  maxItems?: number;
}

const DEFAULT_PREFS: NotificationPrefs = {
  enabled: true,
  inApp: true,
  webPush: true,
  hideSensitiveDetails: true,
  dedupWindowMs: 60_000,
  attentionTimeoutMs: 300_000,
  events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true])) as Record<NotificationEventType, boolean>,
};

const SEVERITY: Record<NotificationEventType, NotificationSeverity> = {
  approval_requested: 'warning',
  task_completed: 'success',
  execution_failed: 'error',
  subagent_completed: 'success',
  git_conflict: 'warning',
  gateway_disconnected: 'error',
  attention_needed: 'warning',
};

const SAFE_BODY: Record<NotificationEventType, string> = {
  approval_requested: 'A session is waiting for your approval.',
  task_completed: 'A session finished its work.',
  execution_failed: 'A session stopped with an error.',
  subagent_completed: 'A subagent finished its task.',
  git_conflict: 'A repository has merge conflicts.',
  gateway_disconnected: 'The gateway went offline.',
  attention_needed: 'A session needs your attention.',
};

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/([#?&](?:token|access_token|key|secret|password)=)[^&\s#]+/gi, '$1[redacted]'],
  [/\b((?:password|passwd|pwd|secret|api[_-]?key|token)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[redacted]'],
  [/\bsk-[A-Za-z0-9_-]{10,}/g, '[redacted]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, '[redacted]'],
  [/\btskey-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]'],
];

/** Strips credentials that must never appear in a notification, whatever the privacy setting. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function readJson<T>(file: string): T | null {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
  } catch {
    return null;
  }
}
function writePrivate(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Watches gateway activity and turns it into notifications: kept in a ring buffer for in-app
 * display and reconnect catch-up, and delivered as Web Push to subscribed browsers/PWAs.
 */
export class NotificationService extends EventEmitter {
  private items: NotificationRecord[] = [];
  private seq = 0;
  private lastSent = new Map<string, number>();
  private prefsFile: string;
  private vapidFile: string;
  private subsFile: string;
  private subs: StoredSubscription[];
  private vapid: { publicKey: string; privateKey: string; subject: string };
  private sendPush: SendWebPush;
  private now: () => number;
  private maxItems: number;
  private attentionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sessionStatus = new Map<string, string>();
  private pushes = new Map<string, Promise<PushResult>>();
  prefs: NotificationPrefs;

  constructor(dataDir: string, opts: NotificationServiceOptions = {}) {
    super();
    const env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
    this.maxItems = opts.maxItems ?? 200;
    this.prefsFile = join(dataDir, 'notifications-prefs.json');
    this.vapidFile = join(dataDir, 'notifications-vapid.json');
    this.subsFile = join(dataDir, 'notifications-push-subs.json');
    this.prefs = mergePrefs(DEFAULT_PREFS, readJson<Partial<NotificationPrefs>>(this.prefsFile) ?? {});
    this.subs = (readJson<StoredSubscription[]>(this.subsFile) ?? []).filter((s) => s && typeof s.endpoint === 'string' && s.keys);

    const envPub = env.UNIHARN_VAPID_PUBLIC_KEY;
    const envPriv = env.UNIHARN_VAPID_PRIVATE_KEY;
    const subject = env.UNIHARN_VAPID_SUBJECT || 'mailto:uniharn@localhost';
    if (envPub && envPriv) this.vapid = { publicKey: envPub, privateKey: envPriv, subject };
    else {
      const stored = readJson<{ publicKey: string; privateKey: string }>(this.vapidFile);
      const keys = stored?.publicKey && stored?.privateKey ? stored : webpush.generateVAPIDKeys();
      if (!stored) writePrivate(this.vapidFile, keys);
      this.vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject };
    }
    this.sendPush = opts.sendWebPush ?? ((sub, payload, options) => webpush.sendNotification(sub, payload, options));
  }

  // ---- preferences -------------------------------------------------------

  getPrefs(): NotificationPrefs {
    return structuredClone(this.prefs);
  }

  setPrefs(patch: Partial<NotificationPrefs>): NotificationPrefs {
    this.prefs = mergePrefs(this.prefs, patch ?? {});
    writePrivate(this.prefsFile, this.prefs);
    return this.getPrefs();
  }

  // ---- history -----------------------------------------------------------

  list(opts: { sinceSeq?: number; limit?: number; unreadOnly?: boolean } = {}) {
    let out = this.items;
    if (typeof opts.sinceSeq === 'number') out = out.filter((n) => n.seq > opts.sinceSeq!);
    if (opts.unreadOnly) out = out.filter((n) => !n.read);
    if (opts.limit && opts.limit > 0) out = out.slice(-opts.limit);
    return { notifications: out.map((n) => ({ ...n })), lastSeq: this.seq, unreadCount: this.unreadCount() };
  }

  unreadCount() {
    return this.items.filter((n) => !n.read).length;
  }

  lastSeq() {
    return this.seq;
  }

  markRead(ids?: string[] | null): string[] {
    const changed: string[] = [];
    for (const n of this.items) {
      if (!n.read && (!ids || ids.includes(n.id))) {
        n.read = true;
        changed.push(n.id);
      }
    }
    if (changed.length) this.emit('read', changed, this.unreadCount());
    return changed;
  }

  clear() {
    this.items = [];
    this.emit('cleared');
  }

  // ---- emission ----------------------------------------------------------

  /** Records and delivers a notification; returns null when disabled or a duplicate. */
  notify(input: NotifyInput): NotificationRecord | null {
    if (!this.prefs.enabled || !this.prefs.events[input.type]) return null;
    const dedupKey = input.dedupKey ?? `${input.type}:${input.sessionId ?? ''}:${input.title}`;
    const now = this.now();
    const last = this.lastSent.get(dedupKey);
    if (last !== undefined && now - last < this.prefs.dedupWindowMs) return null;
    this.lastSent.set(dedupKey, now);
    if (this.lastSent.size > 1000) {
      for (const [k, t] of this.lastSent) if (now - t >= this.prefs.dedupWindowMs) this.lastSent.delete(k);
    }

    const rec: NotificationRecord = {
      id: `n${now.toString(36)}-${(this.seq + 1).toString(36)}`,
      seq: ++this.seq,
      type: input.type,
      severity: input.severity ?? SEVERITY[input.type],
      title: clip(redactSecrets(input.title), 120),
      body: clip(redactSecrets(input.body ?? ''), 400),
      safeBody: clip(redactSecrets(input.safeBody ?? SAFE_BODY[input.type]), 200),
      sessionId: input.sessionId ?? null,
      harnessId: input.harnessId ?? null,
      route: input.route ?? (input.sessionId ? `#/s/${encodeURIComponent(input.sessionId)}` : null),
      dedupKey,
      at: now,
      read: false,
    };
    this.items.push(rec);
    if (this.items.length > this.maxItems) this.items.splice(0, this.items.length - this.maxItems);
    this.emit('notification', rec);
    if (this.prefs.webPush && this.subs.length) {
      const p = this.deliverPush(rec).catch((e) => {
        console.warn(`[uniharn] web push failed: ${e?.message ?? e}`);
        return { sent: 0, failed: this.subs.length, removed: 0 };
      });
      this.pushes.set(rec.id, p);
      p.finally(() => this.pushes.delete(rec.id));
    }
    return rec;
  }

  /** What leaves the gateway over Web Push: generic text unless the user opted into details. */
  pushPayload(rec: NotificationRecord) {
    const hide = this.prefs.hideSensitiveDetails;
    return {
      id: rec.id,
      seq: rec.seq,
      type: rec.type,
      title: hide ? 'uniharn' : rec.title,
      body: hide ? rec.safeBody : rec.body || rec.safeBody,
      route: rec.route,
      tag: `${rec.type}-${hashish(rec.dedupKey)}`,
      at: rec.at,
    };
  }

  /** Resolves once the Web Push fan-out for a notification has finished (immediately if none). */
  waitForPush(id: string): Promise<PushResult> {
    return this.pushes.get(id) ?? Promise.resolve({ sent: 0, failed: 0, removed: 0 });
  }

  async deliverPush(rec: NotificationRecord): Promise<PushResult> {
    const payload = JSON.stringify(this.pushPayload(rec));
    let sent = 0;
    let failed = 0;
    const gone: string[] = [];
    await Promise.all(
      this.subs.map(async (sub) => {
        try {
          await this.sendPush({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys }, payload, {
            TTL: 3600,
            urgency: rec.severity === 'error' || rec.type === 'approval_requested' ? 'high' : 'normal',
            // Per-notification topic: the push service replaces queued messages that share one.
            topic: `${rec.type.replace(/_/g, '').slice(0, 20)}${hashish(rec.dedupKey)}`,
            vapidDetails: this.vapid,
          });
          sent++;
        } catch (e: any) {
          failed++;
          if (e?.statusCode === 404 || e?.statusCode === 410) gone.push(sub.endpoint);
        }
      }),
    );
    if (gone.length) {
      this.subs = this.subs.filter((s) => !gone.includes(s.endpoint));
      writePrivate(this.subsFile, this.subs);
    }
    this.emit('push_result', rec, { sent, failed, removed: gone.length });
    return { sent, failed, removed: gone.length };
  }

  // ---- web push subscriptions -------------------------------------------

  publicKey() {
    return this.vapid.publicKey;
  }

  subscribe(sub: PushSubscriptionJson, label?: string | null, deviceId?: string | null) {
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) throw new Error('A push subscription with an https endpoint is required');
    if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') throw new Error('The push subscription is missing its keys');
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: label ?? null, deviceId: deviceId ?? null, createdAt: this.now() });
    writePrivate(this.subsFile, this.subs);
    return { count: this.subs.length };
  }

  unsubscribe(endpoint: string) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) writePrivate(this.subsFile, this.subs);
    return { removed: before - this.subs.length, count: this.subs.length };
  }

  /** Drops the push subscriptions registered by a device whose token was revoked. */
  removeDeviceSubscriptions(deviceId: string) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.deviceId !== deviceId);
    if (this.subs.length !== before) writePrivate(this.subsFile, this.subs);
    return before - this.subs.length;
  }

  /** Subscriptions without their keys; endpoints are shortened to the push service host. */
  listSubscriptions() {
    return this.subs.map((s) => ({ service: safeHost(s.endpoint), label: s.label, createdAt: s.createdAt, endpointHash: hashish(s.endpoint) }));
  }

  hasSubscription(endpoint: string) {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  getCapabilities(): Record<'inApp' | 'webPush' | 'androidFcm' | 'iosApns', PlatformCapability> {
    return {
      inApp: { status: 'available', background: false, detail: 'Banners and history while the app is open and connected to the gateway.' },
      webPush: {
        status: 'available',
        background: true,
        detail:
          'Standard Web Push (VAPID). Needs a secure origin (HTTPS, e.g. `tailscale serve`, or localhost). On iOS/iPadOS 16.4+ it only works from a PWA added to the Home Screen.',
      },
      androidFcm: {
        status: 'requires_external_setup',
        background: false,
        detail:
          'Not built in: native Android push needs a Firebase project, google-services.json in the APK, FCM service-account credentials on the gateway, and a Firebase Messaging plugin for Tauri. Android Chrome can use Web Push instead.',
      },
      iosApns: {
        status: 'blocked_by_signing',
        background: false,
        detail:
          'Not available in the unsigned IPA: APNs needs the aps-environment entitlement, which only a paid Apple Developer Program team can sign (free/personal teams and unsigned builds cannot). It also needs an App ID with Push, an APNs key (.p8) and a provisioning profile.',
      },
    };
  }

  // ---- watchers ------------------------------------------------------------

  /** Feed every session summary here; it notices running -> idle/error transitions. */
  onSessionState(s: { sessionId: string; harnessId?: string; title?: string | null; status: string; lastError?: string | null; cwd?: string | null }, notifyTurn = true) {
    const prev = this.sessionStatus.get(s.sessionId);
    this.sessionStatus.set(s.sessionId, s.status);
    const label = s.title || basename(s.cwd) || 'Session';
    if (s.status === 'running') this.armStall(s.sessionId, s.harnessId ?? null, label);
    else this.disarm(`stall:${s.sessionId}`);
    if (!notifyTurn || (prev !== 'running' && prev !== 'awaiting_permission')) return;
    if (s.status === 'idle') {
      this.notify({ type: 'task_completed', title: `${label} finished`, body: harnessLabel(s.harnessId) + ' finished its turn.', sessionId: s.sessionId, harnessId: s.harnessId ?? null, dedupKey: `task_completed:${s.sessionId}:${this.now()}` });
    } else if (s.status === 'error') {
      this.notify({ type: 'execution_failed', title: `${label} failed`, body: s.lastError ?? 'The run ended with an error.', sessionId: s.sessionId, harnessId: s.harnessId ?? null, dedupKey: `execution_failed:${s.sessionId}:${s.lastError ?? ''}` });
    }
  }

  /** Session activity resets the "stuck while running" timer. */
  onSessionActivity(sessionId: string, harnessId: string | null, title: string | null) {
    if (this.sessionStatus.get(sessionId) === 'running') this.armStall(sessionId, harnessId, title || 'Session');
  }

  onSessionForgotten(sessionId: string) {
    this.sessionStatus.delete(sessionId);
    this.disarm(`stall:${sessionId}`);
    for (const k of [...this.attentionTimers.keys()]) if (k.startsWith(`perm:${sessionId}:`)) this.disarm(k);
  }

  onPermissionRequested(p: { sessionId: string; harnessId?: string | null; title?: string | null; requestId: string; toolTitle?: string | null; command?: string | null }) {
    const label = p.title || 'A session';
    const what = p.command ? `Run: ${p.command}` : p.toolTitle || 'A tool call needs your approval.';
    this.notify({ type: 'approval_requested', title: `${label} needs approval`, body: what, sessionId: p.sessionId, harnessId: p.harnessId ?? null, dedupKey: `approval:${p.sessionId}:${p.requestId}` });
    const key = `perm:${p.sessionId}:${p.requestId}`;
    this.disarm(key);
    const t = setTimeout(() => {
      this.attentionTimers.delete(key);
      const mins = Math.round(this.prefs.attentionTimeoutMs / 60_000);
      this.notify({ type: 'attention_needed', title: `${label} is still waiting`, body: `An approval has been pending for ${mins >= 1 ? mins + ' min' : Math.round(this.prefs.attentionTimeoutMs / 1000) + ' s'}: ${what}`, sessionId: p.sessionId, harnessId: p.harnessId ?? null, dedupKey: `attention:${key}` });
    }, this.prefs.attentionTimeoutMs);
    t.unref?.();
    this.attentionTimers.set(key, t);
  }

  onPermissionResolved(sessionId: string, requestId: string) {
    this.disarm(`perm:${sessionId}:${requestId}`);
  }

  onTaskDone(run: { taskId: string; cwd: string; command: string; exitCode: number | null }) {
    const where = basename(run.cwd) || run.cwd;
    if (run.exitCode === 0) this.notify({ type: 'task_completed', title: `Task finished in ${where}`, body: run.command, safeBody: 'A task finished.', route: null, dedupKey: `task:${run.taskId}` });
    else this.notify({ type: 'execution_failed', title: `Task failed in ${where}`, body: `${run.command} exited with ${run.exitCode ?? 'a signal'}`, safeBody: 'A task failed.', route: null, dedupKey: `task:${run.taskId}` });
  }

  notifySubagentCompleted(t: { taskId: string; harnessId?: string | null; title?: string | null; parentSessionId?: string | null; ok?: boolean; summary?: string | null }) {
    const ok = t.ok !== false;
    return this.notify({
      type: ok ? 'subagent_completed' : 'execution_failed',
      title: `${harnessLabel(t.harnessId)} subagent ${ok ? 'finished' : 'failed'}${t.title ? `: ${t.title}` : ''}`,
      body: t.summary ?? '',
      safeBody: ok ? undefined : 'A subagent failed.',
      sessionId: t.parentSessionId ?? null,
      harnessId: t.harnessId ?? null,
      dedupKey: `subagent:${t.taskId}`,
    });
  }

  /** Called with git status results; fires once per new set of conflicted files in a repo. */
  notifyGitConflict(repo: string, conflicted: string[]) {
    if (!conflicted.length) {
      this.lastConflicts.delete(repo);
      return null;
    }
    const sig = [...conflicted].sort().join('\0');
    if (this.lastConflicts.get(repo) === sig) return null;
    this.lastConflicts.set(repo, sig);
    const n = conflicted.length;
    return this.notify({
      type: 'git_conflict',
      title: `Merge conflict in ${basename(repo) || repo}`,
      body: `${n} conflicted file${n === 1 ? '' : 's'}: ${conflicted.slice(0, 5).join(', ')}${n > 5 ? '…' : ''}`,
      route: null,
      dedupKey: `git_conflict:${repo}:${sig}`,
    });
  }
  private lastConflicts = new Map<string, string>();

  notifyGatewayShutdown(reason: string) {
    return this.notify({ type: 'gateway_disconnected', title: 'Gateway is going offline', body: reason, route: null, dedupKey: `gateway_down:${this.now()}` });
  }

  dispose() {
    for (const t of this.attentionTimers.values()) clearTimeout(t);
    this.attentionTimers.clear();
  }

  private armStall(sessionId: string, harnessId: string | null, label: string) {
    const key = `stall:${sessionId}`;
    this.disarm(key);
    const ms = this.prefs.attentionTimeoutMs * 2;
    const t = setTimeout(() => {
      this.attentionTimers.delete(key);
      this.notify({ type: 'attention_needed', title: `${label} has been quiet for a while`, body: `No activity for ${Math.round(ms / 60_000)} min while running.`, sessionId, harnessId, dedupKey: key });
    }, ms);
    t.unref?.();
    this.attentionTimers.set(key, t);
  }

  private disarm(key: string) {
    const t = this.attentionTimers.get(key);
    if (t) clearTimeout(t);
    this.attentionTimers.delete(key);
  }
}

function mergePrefs(base: NotificationPrefs, patch: Partial<NotificationPrefs>): NotificationPrefs {
  const out = structuredClone(base);
  for (const k of ['enabled', 'inApp', 'webPush', 'hideSensitiveDetails'] as const) if (typeof patch[k] === 'boolean') out[k] = patch[k];
  if (typeof patch.dedupWindowMs === 'number' && patch.dedupWindowMs >= 0) out.dedupWindowMs = Math.min(patch.dedupWindowMs, 86_400_000);
  if (typeof patch.attentionTimeoutMs === 'number' && patch.attentionTimeoutMs >= 1000) out.attentionTimeoutMs = Math.min(patch.attentionTimeoutMs, 86_400_000);
  if (patch.events && typeof patch.events === 'object') for (const e of NOTIFICATION_EVENTS) if (typeof patch.events[e] === 'boolean') out.events[e] = patch.events[e];
  return out;
}

function basename(p?: string | null) {
  return p ? p.replace(/\/+$/, '').split('/').pop() || '' : '';
}
function harnessLabel(id?: string | null) {
  const names: Record<string, string> = { devin: 'Devin', codex: 'Codex', claude: 'Claude Code', 'claude-code': 'Claude Code', kiro: 'Kiro', opencode: 'OpenCode' };
  return id ? (names[id] ?? id) : 'The agent';
}
function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}
function hashish(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
