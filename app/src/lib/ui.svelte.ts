import { getStorageItem, setStorageItem } from './storage.ts';
import { OPERATION_SCREENS, operationScreen, type OperationScreen } from './operations.ts';
import { readThemePrefs, writeThemePrefs, normalizeAccent } from './theme-prefs.ts';
import { DEFAULT_THEME_PREFS, getTheme, resolveThemeId, themeVars } from './themes.ts';

// Tiny hash router and UI preferences.
export interface Route {
  name: 'home' | 'session' | 'settings' | 'accounts' | 'subagents' | 'terminal' | OperationScreen;
  id?: string;
  tab?: string;
  login?: boolean;
  install?: string;
}

function parse(): Route {
  const h = typeof location === 'undefined' ? '' : location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = h.split('?');
  const [name, ...rest] = pathPart.split('/');
  if (name === 's' && rest[0]) return { name: 'session', id: decodeURIComponent(rest[0]), tab: rest[1] || 'chat' };
  if (name === 'settings') return { name: 'settings' };
  if (name === 'accounts') return { name: 'accounts' };
  if (name === 'subagents') return { name: 'subagents' };
  const screen = OPERATION_SCREENS.find((s) => s === name);
  // `?session=<id>` narrows an operations screen to one session.
  if (screen) return { name: screen, id: new URLSearchParams(query).get('session') ?? undefined };
  if (name === 'terminal') {
    const params = new URLSearchParams(query);
    return { name: 'terminal', login: params.has('login'), install: params.get('install') ?? undefined };
  }
  return { name: 'home' };
}

export function installSetupKey(id: string) {
  return `uniharn.install.${id}`;
}

export const route = $state<Route>(parse());
function loadThemePrefs() {
  try {
    return readThemePrefs({ getItem: getStorageItem });
  } catch {
    return { ...DEFAULT_THEME_PREFS };
  }
}

const systemAppearance = typeof window === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)');
export const prefs = $state(loadThemePrefs());
let systemDark = $state(systemAppearance?.matches ?? true);
const resolvedTheme = $derived(getTheme(resolveThemeId(prefs, systemDark)));
export const activeTheme = () => resolvedTheme;

// Tablet layout: at this width the session list stays in a sidebar next to the open session.
const WIDE = '(min-width: 768px)';
export const layout = $state({
  wide: typeof window !== 'undefined' && matchMedia(WIDE).matches,
  sidebar: getStorageItem('sidebar') !== 'hidden'
});
if (typeof window !== 'undefined') {
  matchMedia(WIDE).addEventListener('change', (e) => (layout.wide = e.matches));
}
export const sidebarShown = () => layout.wide && layout.sidebar;
export function toggleSidebar() {
  layout.sidebar = !layout.sidebar;
  setStorageItem('sidebar', layout.sidebar ? 'shown' : 'hidden');
}

// Requests from keyboard shortcuts to the home screen, which may be in the sidebar or not mounted yet.
// Each holds the time it was made; the home screen acts on requests younger than a second.
export const requests = $state({ newSession: 0, search: 0 });
export const fresh = (at: number) => Date.now() - at < 1000;

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const r = parse();
    Object.assign(route, { id: undefined, tab: undefined, login: undefined, install: undefined }, r);
  });
  // `uniharn:operations` with a screen name (`'tasks'` or `{ open: 'tasks', sessionId? }`) opens that screen;
  // the data pushes sent under the same name carry collections instead and are ignored here.
  window.addEventListener('uniharn:operations', (e) => {
    const detail = (e as CustomEvent).detail;
    const screen = operationScreen(detail);
    const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId : null;
    if (screen) go('#/' + screen + (sessionId ? '?session=' + encodeURIComponent(sessionId) : ''));
  });
}

export function go(hash: string, replace = false) {
  if (replace) location.replace(hash);
  else location.hash = hash;
}

export function back(fallback = '#/') {
  if (history.length > 1 && document.referrer !== undefined && history.state !== 'root') history.back();
  else go(fallback, true);
}

function saveTheme() {
  try {
    writeThemePrefs({ setItem: setStorageItem }, prefs);
  } catch {
    // Appearance still works if localStorage is unavailable.
  }
  applyTheme();
}

export function setTheme(id: string) {
  const theme = getTheme(id);
  if (prefs.followSystem) {
    if (theme.appearance === 'light') prefs.lightTheme = theme.id;
    else prefs.darkTheme = theme.id;
  } else {
    prefs.theme = theme.id;
  }
  saveTheme();
}

export function setFollowSystem(follow: boolean) {
  if (!follow) prefs.theme = activeTheme().id;
  prefs.followSystem = follow;
  saveTheme();
}

export function setAccent(accent: string) {
  prefs.accent = normalizeAccent(accent);
  saveTheme();
}

export function applyTheme() {
  const root = document.documentElement;
  const theme = activeTheme();
  const { bg } = theme.tokens;
  const vars = themeVars(theme, prefs.accent);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  try {
    setStorageItem('themeBoot', JSON.stringify({ vars, appearance: theme.appearance }));
  } catch {
    // Only the pre-paint cache is lost; the theme itself is already applied.
  }
  root.dataset.theme = theme.id;
  root.dataset.appearance = theme.appearance;
  root.dataset.accent = prefs.accent === 'theme' ? 'theme' : 'customized';
  root.style.colorScheme = theme.appearance;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', bg));

  // Android shell only (src-tauri/android/MainActivity.kt). Keep the legacy bridge name working.
  const androidWin = window as {
    UniharnAndroid?: { setBars(color: string, dark: boolean): void };
    DevinMobileAndroid?: { setBars(color: string, dark: boolean): void };
  };
  (androidWin.UniharnAndroid ?? androidWin.DevinMobileAndroid)?.setBars(bg, theme.appearance === 'dark');
}

systemAppearance?.addEventListener('change', (event) => {
  systemDark = event.matches;
  if (prefs.followSystem) applyTheme();
});

export const toasts = $state<{ id: number; text: string; kind: 'info' | 'error' }[]>([]);
export function toast(text: string, kind: 'info' | 'error' = 'info') {
  const t = { id: Math.random(), text, kind };
  toasts.push(t);
  setTimeout(() => {
    const i = toasts.findIndex((x) => x.id === t.id);
    if (i >= 0) toasts.splice(i, 1);
  }, 3200);
}

/** Copies text; falls back to execCommand where the Clipboard API is missing (plain-HTTP origins). */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.setAttribute('readonly', '');
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}
