import { conn, isTauri, onNotificationMessage, rpc, type NotificationMessage } from './api.svelte.ts';
import { getStorageItem, setStorageItem } from './storage.ts';
import { go } from './ui.svelte.ts';
import { notificationRoute } from './operations.ts';
import type { AppNotification, NotificationCapabilities, NotificationEventType, NotificationPrefs } from './types.ts';

export const EVENT_LABELS: Record<NotificationEventType, string> = {
  approval_requested: 'Approval requests',
  task_completed: 'Finished work',
  execution_failed: 'Failures',
  subagent_completed: 'Subagent finished',
  git_conflict: 'Git conflicts',
  gateway_disconnected: 'Gateway disconnected',
  attention_needed: 'Waiting too long / needs you'
};

type PushState = 'unsupported' | 'insecure' | 'denied' | 'off' | 'on';

export const notif = $state({
  items: [] as AppNotification[],
  unreadCount: 0,
  lastSeq: 0,
  prefs: readCachedPrefs(),
  capabilities: null as NotificationCapabilities | null,
  banner: null as AppNotification | null,
  centerOpen: false,
  push: { state: pushSupport(), busy: false, error: null as string | null, devices: 0 },
  permission: (typeof Notification === 'undefined' ? 'denied' : Notification.permission) as NotificationPermission
});

const shown = new Set<string>();
let bannerTimer: ReturnType<typeof setTimeout> | undefined;
let downTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

function readCachedPrefs(): NotificationPrefs | null {
  try {
    return JSON.parse(getStorageItem('notification-prefs') || 'null');
  } catch {
    return null;
  }
}

function pushSupport(): PushState {
  if (typeof window === 'undefined' || isTauri) return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (Notification.permission === 'denied') return 'denied';
  return 'off';
}

/** Why Web Push cannot run here, or null when it can. */
export function pushUnavailableReason(): string | null {
  switch (notif.push.state) {
    case 'unsupported':
      return isTauri
        ? 'The native app webview has no Web Push. Native push (FCM/APNs) needs external setup. Open the gateway in a browser or installed PWA for background push.'
        : 'This browser does not support Web Push. On iPhone/iPad, add uniharn to the Home Screen (iOS 16.4+) and open it from there.';
    case 'insecure':
      return 'Web Push needs HTTPS. Serve the gateway over HTTPS, for example `tailscale serve --bg 8787`, then open its https://<machine>.ts.net address (localhost also works).';
    case 'denied':
      return 'Notifications are blocked for this site in browser settings.';
    default:
      return null;
  }
}

function setPrefsLocal(p: NotificationPrefs) {
  notif.prefs = p;
  setStorageItem('notification-prefs', JSON.stringify(p));
}

function add(n: AppNotification) {
  if (notif.items.some((x) => x.id === n.id)) return false;
  notif.items.unshift(n);
  if (notif.items.length > 200) notif.items.length = 200;
  if (!n.local) notif.lastSeq = Math.max(notif.lastSeq, n.seq);
  notif.unreadCount = notif.items.filter((x) => !x.read).length;
  return true;
}

/** Surfaces a new notification on this device: banner when visible, system notification when hidden. */
function present(n: AppNotification) {
  if (shown.has(n.id)) return;
  shown.add(n.id);
  const p = notif.prefs;
  if (p && (!p.enabled || p.events?.[n.type] === false)) return;
  const visible = document.visibilityState === 'visible';
  if (visible) {
    if (p?.inApp === false) return;
    notif.banner = n;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => notif.banner?.id === n.id && (notif.banner = null), n.type === 'approval_requested' ? 10000 : 6000);
    return;
  }
  // Web Push already reaches the OS for gateway events; only fall back when it is not set up.
  if (!n.local && notif.push.state === 'on') return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const hide = p?.hideSensitiveDetails !== false;
  try {
    new Notification(hide ? 'uniharn' : n.title, { body: hide ? n.safeBody : n.body || n.safeBody, tag: n.dedupKey });
  } catch {
    // Some webviews do not allow page notifications.
  }
}

function onMessage(msg: NotificationMessage) {
  if (msg.type === 'notification') {
    if (add(msg.notification)) present(msg.notification);
  } else if (msg.type === 'notification_read') {
    for (const n of notif.items) if (msg.ids.includes(n.id)) n.read = true;
    notif.unreadCount = notif.items.filter((x) => !x.read).length;
  } else if (msg.type === 'notifications_cleared') {
    notif.items = notif.items.filter((n) => n.local);
    notif.unreadCount = notif.items.filter((x) => !x.read).length;
  }
}

let reconciledUrl: string | null = null;

/** After every (re)connect: resync history and read state, and surface what was missed while offline. */
async function reconcile() {
  try {
    const [list, prefs, caps] = await Promise.all([
      rpc('notifications.list', { limit: 200 }),
      rpc('notifications.prefs.get'),
      notif.capabilities ? Promise.resolve(null) : rpc('notifications.capabilities')
    ]);
    setPrefsLocal(prefs.prefs);
    if (caps) notif.capabilities = caps.capabilities;
    // A different gateway, or the same one restarted with a reset history, starts from scratch.
    const fresh = reconciledUrl !== conn.url || list.lastSeq < notif.lastSeq;
    const seenUpTo = fresh ? Infinity : notif.lastSeq;
    reconciledUrl = conn.url;
    const server = (list.notifications as AppNotification[]).sort((a, b) => b.seq - a.seq);
    notif.items = [...server, ...notif.items.filter((n) => n.local)].sort((a, b) => b.at - a.at).slice(0, 200);
    notif.lastSeq = list.lastSeq;
    notif.unreadCount = notif.items.filter((x) => !x.read).length;
    const missed = server.filter((n) => n.seq > seenUpTo && !n.read && !shown.has(n.id));
    for (const n of server) if (n !== missed[0]) shown.add(n.id);
    // Show only the newest unseen one so a long outage does not flood the screen.
    if (missed[0]) present(missed[0]);
    await syncPushSubscription();
  } catch {
    // Older gateways have no notification API; the in-app list just stays empty.
  }
}

function onStatus(status: string, prev: string | undefined) {
  if (status === 'online') {
    clearTimeout(downTimer);
    downTimer = undefined;
    return;
  }
  if (prev !== 'online' || (status !== 'connecting' && status !== 'offline') || downTimer) return;
  // Phones drop sockets briefly when switching networks; only report a lasting loss.
  downTimer = setTimeout(() => {
    downTimer = undefined;
    if (conn.status === 'online' || !conn.url) return;
    const at = Date.now();
    const n: AppNotification = {
      id: `local-${at}`,
      seq: 0,
      type: 'gateway_disconnected',
      severity: 'error',
      title: `Lost connection to ${conn.info?.host ?? 'the gateway'}`,
      body: 'Reconnecting automatically. Approvals and results will catch up once it is back.',
      safeBody: 'The gateway is unreachable.',
      sessionId: null,
      harnessId: null,
      route: null,
      dedupKey: 'gateway_disconnected:local',
      at,
      read: false,
      local: true
    };
    const p = notif.prefs;
    if (p && (!p.enabled || !p.events.gateway_disconnected)) return;
    const recent = notif.items.find((x) => x.local && x.type === 'gateway_disconnected');
    if (recent && at - recent.at < (p?.dedupWindowMs ?? 60000)) return;
    add(n);
    present(n);
  }, 2000);
}

export function initNotifications() {
  if (started || typeof window === 'undefined') return;
  started = true;
  onNotificationMessage(onMessage);
  let prevStatus: string | undefined;
  let prevGen = 0;
  $effect.root(() => {
    $effect(() => {
      const s = conn.status;
      onStatus(s, prevStatus);
      prevStatus = s;
    });
    $effect(() => {
      const g = conn.generation;
      if (g && g !== prevGen && conn.status === 'online') {
        prevGen = g;
        reconcile();
      }
    });
  });
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'uniharn:navigate') {
      if (e.data.id) markRead([e.data.id]);
      const known = notif.items.find((n) => n.id === e.data.id);
      const target = known ? notificationRoute(known) : e.data.route;
      if (target) go(target);
    }
  });
  refreshPushState();
}

export function openNotification(n: AppNotification) {
  markRead([n.id]);
  if (notif.banner?.id === n.id) notif.banner = null;
  notif.centerOpen = false;
  const target = notificationRoute(n);
  if (target) go(target);
}

export async function markRead(ids?: string[]) {
  const local = notif.items.filter((n) => n.local && (!ids || ids.includes(n.id)));
  for (const n of local) n.read = true;
  notif.unreadCount = notif.items.filter((x) => !x.read).length;
  const remote = ids ? ids.filter((id) => !id.startsWith('local-')) : null;
  if (remote && !remote.length) return;
  await rpc('notifications.read', remote ? { ids: remote } : {}).catch(() => {});
}

export async function clearNotifications() {
  notif.items = [];
  notif.unreadCount = 0;
  await rpc('notifications.clear').catch(() => {});
}

export async function savePrefs(patch: Partial<NotificationPrefs>) {
  const r = await rpc('notifications.prefs.set', { prefs: patch });
  setPrefsLocal(r.prefs);
}

export async function sendTest() {
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') await requestPermission();
  return rpc('notifications.test');
}

async function requestPermission() {
  if (typeof Notification === 'undefined') return 'denied';
  notif.permission = await Notification.requestPermission();
  return notif.permission;
}

function vapidKey(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('./')) ?? navigator.serviceWorker.register('./sw.js', { scope: './' });
}

async function refreshPushState() {
  const base = pushSupport();
  if (base !== 'off') return void (notif.push.state = base);
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = await reg?.pushManager.getSubscription();
    notif.push.state = sub ? 'on' : 'off';
  } catch {
    notif.push.state = 'off';
  }
}

/** Re-registers this browser with the gateway after reconnects so a reset gateway still reaches it. */
async function syncPushSubscription() {
  if (pushSupport() !== 'off') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const { publicKey } = await rpc('notifications.push.publicKey');
    const current = sub.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    if (current && current !== publicKey) {
      // Subscribed to a different gateway's key: start over with this one.
      await sub.unsubscribe();
      notif.push.state = 'off';
      return enablePush();
    }
    const r = await rpc('notifications.push.subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    notif.push.devices = r.count;
    notif.push.state = 'on';
  } catch {
    // Leave the state as is; Settings shows the error when the user retries.
  }
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

export async function enablePush() {
  notif.push.error = null;
  if (pushSupport() !== 'off') return void (notif.push.state = pushSupport());
  notif.push.busy = true;
  try {
    if ((await requestPermission()) !== 'granted') {
      notif.push.state = pushSupport();
      throw new Error('Notification permission was not granted.');
    }
    const reg = await registration();
    await navigator.serviceWorker.ready;
    const { publicKey } = await rpc('notifications.push.publicKey');
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey(publicKey) }));
    const r = await rpc('notifications.push.subscribe', { subscription: sub.toJSON(), label: deviceLabel() });
    notif.push.devices = r.count;
    notif.push.state = 'on';
    if (notif.prefs && !notif.prefs.webPush) await savePrefs({ webPush: true });
  } catch (e) {
    notif.push.error = e instanceof Error ? e.message : String(e);
  } finally {
    notif.push.busy = false;
  }
}

export async function disablePush() {
  notif.push.busy = true;
  notif.push.error = null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('./');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await rpc('notifications.push.unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
    notif.push.state = 'off';
  } catch (e) {
    notif.push.error = e instanceof Error ? e.message : String(e);
  } finally {
    notif.push.busy = false;
  }
}

/** Ask for the OS notification permission used when the app is in the background without Web Push. */
export async function enableSystemNotifications() {
  await requestPermission();
}
