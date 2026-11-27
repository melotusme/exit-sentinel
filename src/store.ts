// Central reactive store & Tauri IPC bridge shared by the App Shell and all 4 feature workspaces.

import { invoke } from '@tauri-apps/api/core';
import type {
  GeoInfo,
  IpRecord,
  Safety,
  Settings,
  Tab,
  ThemePreference,
  ToastOptions,
  UpdateStatus,
  View,
} from './types';
import { safetyText, serviceName, showToast } from './ui';

export interface StoreSnapshot {
  view: View | undefined;
  tab: Tab;
  sub: Record<Tab, string>;
  themePref: ThemePreference;
  effectiveTheme: 'light' | 'dark';
  updateStatus: UpdateStatus | null;
}

export interface MarkIpOptions {
  service: string;
  ip: string;
  status: Safety | string;
  note?: string;
  attachCurrent?: boolean;
  withUndo?: boolean;
}

export interface MarkNodeOptions {
  service: string;
  key: string;
  status: Safety | string;
  note?: string;
  current: boolean;
  withUndo?: boolean;
}

export interface AppShellApi {
  // State & caches
  getState: () => View | undefined;
  getGeo: (ip: string | null | undefined) => GeoInfo | undefined;
  geoCache: Map<string, GeoInfo>;
  series: Map<string, { time: string; values: number[] }>;
  getUpdateState: () => UpdateStatus | null;
  getRoute: () => { tab: Tab; sub: string; allSubs: Record<Tab, string> };
  consumeNavPayload: <T = unknown>() => T | undefined;
  subscribe: (listener: (snap: StoreSnapshot) => void) => () => void;

  // Navigation & shared modals
  navigate: (target: Tab | string, subtab?: string, payload?: unknown) => Promise<boolean>;
  openIpModal: (ip?: string | null, opts?: { force?: boolean; trigger?: HTMLElement }) => Promise<void>;
  openProbeModal: (probeId: string, opts?: { force?: boolean; trigger?: HTMLElement }) => Promise<void>;
  openRouteModal: (record: IpRecord, trigger?: HTMLElement) => void;

  // Feedback
  showToast: (message: string, opts?: ToastOptions) => void;

  // Theme
  getThemePreference: () => ThemePreference;
  getEffectiveTheme: () => 'light' | 'dark';
  setThemePreference: (pref: ThemePreference) => void;

  // Typed Tauri IPC commands
  call: <T = void>(name: string, args?: Record<string, unknown>, opts?: { silent?: boolean }) => Promise<T>;
  checkNow: () => Promise<void>;
  acknowledgeChanges: () => Promise<void>;
  setPaused: (paused: boolean) => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  clearMonitorData: (scope: 'ai' | 'history' | 'all') => Promise<string>;
  testNotification: () => Promise<void>;
  markAiIp: (opts: MarkIpOptions) => Promise<void>;
  markAiNode: (opts: MarkNodeOptions) => Promise<void>;
  deleteClaudeIp: (service: string, ip: string, opts?: { withUndo?: boolean }) => Promise<void>;
  deleteAiIp: (service: string, ip: string, opts?: { withUndo?: boolean }) => Promise<void>;
  deleteAiNode: (service: string, key: string, opts?: { withUndo?: boolean }) => Promise<void>;
  copyAiRoute: (service: string, ip?: string | null) => Promise<void>;
  testAiServices: (service?: 'claude' | 'gemini' | null) => Promise<void>;
  syncGeography: (force?: boolean) => Promise<boolean>;
  lookupGeo: (ip: string, force?: boolean) => Promise<GeoInfo>;
  lookupNearby: (ip: string) => Promise<any>;
  findNodesNear: (query: string) => Promise<any>;
}

// --- Internal Store State ---

const THEME_STORAGE_KEY = 'sentinel.theme';
const subKey = (t: Tab) => `sentinel.subtab.${t}`;

export const DEFAULT_SUBTABS: Record<Tab, string[]> = {
  overview: ['main'],
  records: ['ips', 'nodes', 'history', 'data'],
  diagnostics: ['curl', 'ip-lookup', 'find'],
  settings: ['monitor-settings', 'routing-settings', 'webdav-settings', 'update-settings'],
};

const LEGACY_MODES: Record<string, [Tab, string?]> = {
  overview: ['overview'],
  monitor: ['overview'],
  ai: ['overview'],
  records: ['records'],
  ips: ['records', 'ips'],
  nodes: ['records', 'nodes'],
  history: ['records', 'history'],
  data: ['records', 'data'],
  diagnostics: ['diagnostics'],
  toolbox: ['diagnostics'],
  curl: ['diagnostics', 'curl'],
  'ip-lookup': ['diagnostics', 'ip-lookup'],
  find: ['diagnostics', 'find'],
  settings: ['settings'],
  guide: ['settings', 'update-settings'],
};

const LEGACY_SETTINGS_SECTIONS: Record<string, string> = {
  'monitor-settings': 'monitor-settings',
  'ignored-checks': 'monitor-settings',
  'permissions-settings': 'monitor-settings',
  'system-settings': 'monitor-settings',
  'routing-settings': 'routing-settings',
  'webdav-settings': 'webdav-settings',
  'update-settings': 'update-settings',
  'help-settings': 'update-settings',
};

function readInitialSub(t: Tab): string {
  const allowed = DEFAULT_SUBTABS[t];
  try {
    const raw =
      t === 'settings'
        ? localStorage.getItem(subKey(t)) || localStorage.getItem('sentinel.settings.section')
        : localStorage.getItem(subKey(t));
    if (raw) {
      const mapped = t === 'settings' ? LEGACY_SETTINGS_SECTIONS[raw] || raw : raw;
      if (allowed.includes(mapped)) return mapped;
    }
  } catch {}
  return allowed[0] || '';
}

export function resolveRouteTarget(target: string, explicitSub?: string): [Tab, string?] {
  const [tab, mappedSub] = LEGACY_MODES[target] || ['overview', undefined];
  let sub = explicitSub || mappedSub;
  if (tab === 'settings' && sub) {
    sub = LEGACY_SETTINGS_SECTIONS[sub] || sub;
  }
  return [tab, sub];
}

export const geoCache = new Map<string, GeoInfo>();
export const series = new Map<string, { time: string; values: number[] }>();

let currentView: View | undefined;
let currentUpdateStatus: UpdateStatus | null = null;
let navPayload: unknown;

const initialQueryMode = new URLSearchParams(location.search).get('mode') || 'overview';
const [initialTab, initialMappedSub] = resolveRouteTarget(initialQueryMode);

let activeTab: Tab = initialTab;
const activeSub: Record<Tab, string> = {
  overview: 'main',
  records: readInitialSub('records'),
  diagnostics: readInitialSub('diagnostics'),
  settings: readInitialSub('settings'),
};
if (initialMappedSub) activeSub[activeTab] = initialMappedSub;

const listeners = new Set<(snap: StoreSnapshot) => void>();

// --- Theme Management (`system` | `light` | `dark`) ---

const darkMedia = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function readThemePref(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {}
  return 'system';
}

let themePref: ThemePreference = readThemePref();

export function getThemePreference(): ThemePreference {
  return themePref;
}

export function getEffectiveTheme(): 'light' | 'dark' {
  if (themePref === 'light' || themePref === 'dark') return themePref;
  return darkMedia?.matches ? 'dark' : 'light';
}

function applyThemeToDom() {
  const effective = getEffectiveTheme();
  const root = document.documentElement;
  root.dataset.themeMode = themePref;
  if (themePref === 'system') {
    root.dataset.theme = effective;
  } else {
    root.dataset.theme = themePref;
  }
  root.style.colorScheme = effective;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', effective === 'dark' ? '#0b0f17' : '#f3f5f8');
}

export function setThemePreference(pref: ThemePreference) {
  themePref = pref;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {}
  applyThemeToDom();
  emitStoreChange();
}

applyThemeToDom();
darkMedia?.addEventListener('change', () => {
  if (themePref === 'system') {
    applyThemeToDom();
    emitStoreChange();
  }
});

// --- Snapshot & Subscription ---

export function getSnapshot(): StoreSnapshot {
  return {
    view: currentView,
    tab: activeTab,
    sub: { ...activeSub },
    themePref,
    effectiveTheme: getEffectiveTheme(),
    updateStatus: currentUpdateStatus,
  };
}

export function emitStoreChange() {
  const snap = getSnapshot();
  for (const fn of listeners) fn(snap);
}

export function subscribe(listener: (snap: StoreSnapshot) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getState(): View | undefined {
  return currentView;
}

export function getGeo(ip: string | null | undefined): GeoInfo | undefined {
  return ip ? geoCache.get(ip) : undefined;
}

export function getUpdateState(): UpdateStatus | null {
  return currentUpdateStatus;
}

export function setUpdateState(next: UpdateStatus | null) {
  currentUpdateStatus = next;
  emitStoreChange();
}

export function getRoute() {
  return { tab: activeTab, sub: activeSub[activeTab], allSubs: { ...activeSub } };
}

export function setRouteState(tab: Tab, sub?: string, payload?: unknown) {
  activeTab = tab;
  if (sub) {
    activeSub[tab] = sub;
    try {
      localStorage.setItem(subKey(tab), sub);
    } catch {}
  }
  if (payload !== undefined) {
    navPayload = payload;
  }
}

export function consumeNavPayload<T = unknown>(): T | undefined {
  const val = navPayload as T | undefined;
  navPayload = undefined;
  return val;
}

export function recordProbeSeries(v: View) {
  for (const p of v.probes) {
    if (!p.checked) continue;
    const prev = series.get(p.id) || { time: '', values: [] };
    if (prev.time === p.checked) continue;
    const values = p.ip ? [...prev.values, p.latency].slice(-24) : prev.values;
    series.set(p.id, { time: p.checked, values });
  }
}

export function setViewState(v: View) {
  currentView = v;
  recordProbeSeries(v);
}

export function updateClaudeHeartbeat(checked: string) {
  if (currentView) {
    currentView = { ...currentView, claude: { ...currentView.claude, checked } };
  }
}

export function clearStoreCaches(scope: string) {
  if (scope === 'all') {
    geoGeneration++;
    geoCache.clear();
    series.clear();
    geoLastAt = 0;
  }
}

// --- Shell Handler Hooks (wired by src/main.ts at boot) ---

interface ShellHandlers {
  navigate: (target: Tab | string, subtab?: string, payload?: unknown) => Promise<boolean>;
  openIpModal: (ip?: string | null, opts?: { force?: boolean; trigger?: HTMLElement }) => Promise<void>;
  openProbeModal: (probeId: string, opts?: { force?: boolean; trigger?: HTMLElement }) => Promise<void>;
  openRouteModal: (record: IpRecord, trigger?: HTMLElement) => void;
  onGeoUpdated: () => void;
}

let shellHandlers: ShellHandlers = {
  navigate: async (target, sub, payload) => {
    const [tab, resolvedSub] = resolveRouteTarget(String(target), sub);
    setRouteState(tab, resolvedSub, payload);
    emitStoreChange();
    return true;
  },
  openIpModal: async () => {},
  openProbeModal: async () => {},
  openRouteModal: () => {},
  onGeoUpdated: () => emitStoreChange(),
};

export function registerShellHandlers(handlers: ShellHandlers) {
  shellHandlers = handlers;
}

// --- Tauri IPC Wrapper & Domain Actions ---

export async function call<T = void>(
  name: string,
  args?: Record<string, unknown>,
  opts?: { silent?: boolean }
): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    if (!opts?.silent) {
      showToast(String(e), { persistent: true, tone: 'risk' });
    }
    throw e;
  }
}

let geoLoading = false;
let geoGeneration = 0;
let geoLastAt = 0;

export async function syncGeography(force = false): Promise<boolean> {
  if (geoLoading) return false;
  if (!force && Date.now() - geoLastAt < 15000) return false;
  geoLoading = true;
  geoLastAt = Date.now();
  const gen = geoGeneration;
  try {
    const all = await invoke<Record<string, GeoInfo>>('get_cached_geography');
    if (gen !== geoGeneration) return false;
    let changed = false;
    for (const [ip, g] of Object.entries(all)) {
      if (JSON.stringify(geoCache.get(ip)) !== JSON.stringify(g)) {
        geoCache.set(ip, g);
        changed = true;
      }
    }
    if (changed) {
      shellHandlers.onGeoUpdated();
    }
    return changed;
  } catch {
    return false;
  } finally {
    geoLoading = false;
  }
}

let marking = false;

export async function markAiIp(opts: MarkIpOptions): Promise<void> {
  if (marking) return;
  const { service, ip, status } = opts;
  const previous = currentView?.claude_ips.find(r => r.service === service && r.ip === ip);
  const note = opts.note !== undefined ? opts.note : previous?.note || '';
  if (previous?.status === status && previous?.note === note && !opts.attachCurrent) return;

  marking = true;
  try {
    await call('save_claude_ip', {
      service,
      ip,
      status,
      note,
      attachCurrent: Boolean(opts.attachCurrent),
    });
    if (opts.withUndo !== false) {
      showToast(`${serviceName(service)} · IP ${ip} 已标为${safetyText(status)}`, {
        tone: status === 'safe' ? 'safe' : status === 'risk' ? 'risk' : 'neutral',
        undoLabel: previous ? '撤销修改' : '撤回至待确认',
        onUndo: async () => {
          await call('save_claude_ip', {
            service,
            ip,
            status: previous?.status || 'pending',
            note: previous?.note ?? note,
            attachCurrent: false,
          });
        },
      });
    }
  } finally {
    marking = false;
  }
}

export async function markAiNode(opts: MarkNodeOptions): Promise<void> {
  if (marking) return;
  const { service, key, status, current } = opts;
  const verdict = currentView?.verdicts.find(v => v.service === service);
  const lookupKey = current ? verdict?.node_record || key : key;
  const previous = currentView?.ai_nodes.find(r => r.service === service && r.key === lookupKey);
  const note = opts.note !== undefined ? opts.note : previous?.note || '';
  if (previous?.status === status && previous?.note === note) return;

  marking = true;
  try {
    await call('save_ai_node', {
      service,
      key,
      status,
      note,
      current,
    });
    if (opts.withUndo !== false) {
      const targetKey = previous?.key || key;
      showToast(`${serviceName(service)} · 节点已标为${safetyText(status)}`, {
        tone: status === 'safe' ? 'safe' : status === 'risk' ? 'risk' : 'neutral',
        undoLabel: previous ? '撤销修改' : '撤回至待确认',
        onUndo: async () => {
          const latest = await call<View>('get_state');
          const saved =
            latest.ai_nodes.find(r => r.service === service && r.key === targetKey) ||
            latest.ai_nodes.find(
              r =>
                r.service === service &&
                verdict?.node_name &&
                r.route.node_name === verdict.node_name
            );
          if (!saved) return;
          await call('save_ai_node', {
            service,
            key: saved.key,
            status: previous?.status || 'pending',
            note: previous?.note ?? note,
            current: false,
          });
        },
      });
    }
  } finally {
    marking = false;
  }
}

export async function deleteClaudeIp(
  service: string,
  ip: string,
  opts: { withUndo?: boolean } = {}
): Promise<void> {
  const snapshot = currentView?.claude_ips.find(r => r.service === service && r.ip === ip);
  await call('delete_claude_ip', { service, ip });
  if (opts.withUndo !== false && snapshot) {
    showToast(`已删除 ${serviceName(service)} IP 记录 ${ip}`, {
      undoLabel: '撤销删除',
      onUndo: async () => {
        await call('save_claude_ip', {
          service: snapshot.service,
          ip: snapshot.ip,
          status: snapshot.status,
          note: snapshot.note || '',
          attachCurrent: false,
        });
      },
    });
  } else {
    showToast(`已删除 ${serviceName(service)} IP 记录 ${ip}`);
  }
}

export const deleteAiIp = deleteClaudeIp;

export async function deleteAiNode(
  service: string,
  key: string,
  opts: { withUndo?: boolean } = {}
): Promise<void> {
  const snapshot = currentView?.ai_nodes.find(r => r.service === service && r.key === key);
  await call('delete_ai_node', { service, key });
  const label = snapshot?.route.node_name || key;
  if (opts.withUndo !== false) {
    showToast(`已删除 ${serviceName(service)} 节点记录 ${label}`);
  }
}

export async function lookupGeo(ip: string, force = false): Promise<GeoInfo> {
  const g = await call<GeoInfo>('lookup_geo', { ip, force }, { silent: true });
  const canonical = g.ip || ip;
  geoCache.set(canonical, g);
  shellHandlers.onGeoUpdated();
  return g;
}

export const store: AppShellApi = {
  getState,
  getGeo,
  geoCache,
  series,
  getUpdateState,
  getRoute,
  consumeNavPayload,
  subscribe,

  navigate: (target, subtab, payload) => shellHandlers.navigate(target, subtab, payload),
  openIpModal: (ip, opts) => shellHandlers.openIpModal(ip, opts),
  openProbeModal: (probeId, opts) => shellHandlers.openProbeModal(probeId, opts),
  openRouteModal: (record, trigger) => shellHandlers.openRouteModal(record, trigger),

  showToast,

  getThemePreference,
  getEffectiveTheme,
  setThemePreference,

  call,
  checkNow: () => call('check_now'),
  acknowledgeChanges: () => call('acknowledge'),
  setPaused: paused => call('set_paused', { paused }),
  saveSettings: settings => call('save_settings', { settings }),
  clearMonitorData: scope => call<string>('clear_monitor_data', { scope }),
  testNotification: () => call('test_notification'),
  markAiIp,
  markAiNode,
  deleteClaudeIp,
  deleteAiIp,
  deleteAiNode,
  copyAiRoute: (service, ip = null) => call('copy_ai_route', { service, ip }),
  testAiServices: (service = null) =>
    call('test_ai_services', service ? { service } : undefined),
  syncGeography,
  lookupGeo,
  lookupNearby: ip => call('lookup_nearby', { ip }, { silent: true }),
  findNodesNear: query => call('find_nodes_near', { query }, { silent: true }),
};
