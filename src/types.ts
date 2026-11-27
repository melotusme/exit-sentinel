// Shapes of the Rust `View` and related records sent over Tauri IPC, plus shared UI shell contracts.

export interface Settings {
  manual_nodes_only: boolean;
  interval: number;
  claude_proxy: string;
  gemini_proxy: string;
  gemini_ip_url: string;
  notifications: boolean;
  retain_history: boolean;
  ipv6: boolean;
  ipv6_required: boolean;
  domestic_proxy: string;
  foreign_proxy: string;
  ignored_checks: string[];
  auto_update_check: boolean;
  auto_update_install: boolean;
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'ready_deferred'
  | 'installing'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  notes: string | null;
  received: number;
  total: number | null;
  lastCheckedAt: number | null;
  lastUpdatedFrom: string | null;
  error: string | null;
  errorIsManual: boolean;
  canSilentInstall: boolean;
  silentBlockedReason: string | null;
  autoUpdateCheck: boolean;
  autoUpdateInstall: boolean;
}

export interface Probe {
  source_ip?: string | null;
  source_interface?: string;
  source_dns?: string;
  isp?: string;
  id: string;
  label: string;
  group: string;
  url: string;
  ip: string | null;
  last_good_ip: string | null;
  detail: string;
  latency: number;
  checked: string;
  error: string | null;
  stable: boolean;
}

export interface Event {
  time: string;
  title: string;
  detail: string;
}

export interface RouteSnapshot {
  evidence?: string;
  observed_at?: string;
  subscription_id?: string;
  association: string;
  service: string;
  domain: string;
  config: string;
  mode: string;
  matched_rule: string;
  chain: string[];
  compiled_chain: string[];
  node_name: string;
  node_id: string;
  node_host: string;
  subscription: string;
  basis: string;
  error: string;
  consistent: boolean;
  stale?: boolean;
  fingerprint: string;
  first_seen: string;
  last_seen: string;
}

export interface IpRecord {
  routes: RouteSnapshot[];
  service: string;
  ip: string;
  status: string;
  note: string;
  added_at: string;
  first_open: string | null;
  last_open: string | null;
  source: string;
}

export interface AiTest {
  route: RouteSnapshot | null;
  path: string;
  service: string;
  time: string;
  ip: string | null;
  ip_basis: string;
  ipv6?: string | null;
  ipv6_basis?: string;
  http_code: number | null;
  latency: number;
  error: string | null;
}

export interface NodeRecord {
  key: string;
  service: string;
  route: RouteSnapshot;
  status: string;
  note: string;
  added_at: string;
  updated_at: string;
}

export interface ServiceHealth {
  id: string;
  name: string;
  status: 'reachable' | 'restricted' | 'unreachable';
  confirmed: string | null;
  stable: boolean;
  checked: string;
  http_code: number | null;
  latency: number;
  detail: string;
}

export interface Uplink {
  medium: 'wired' | 'wireless' | 'unknown';
  interface: string;
  port: string;
  ssid: string;
  ssid_hint: string;
}

export type Safety = 'pending' | 'safe' | 'risk';
export type Level = 'unknown' | 'safe' | 'warn' | 'risk';

export interface Verdict {
  service: string;
  name: string;
  level: Level;
  headline: string;
  ip: string | null;
  ip_source: string;
  ip_checked: string;
  ip_status: Safety | null;
  ip_hint: string;
  node_name: string;
  node_source: string;
  node_seen: string;
  node_stale: boolean;
  node_key: string;
  node_record: string | null;
  node_status: Safety | null;
  node_hint: string;
  health: 'reachable' | 'restricted' | 'unreachable' | null;
  health_detail: string;
  region_code: string;
  region_label: string;
  region_checked: string;
  region_source: string;
  region_hint: string;
}

export interface ExitMonitor {
  ipv6: string | null;
  ipv6_error: string | null;
  route: RouteSnapshot | null;
  running: boolean | null;
  checked: string;
  checked_ip: string;
  country: string;
  country_checked: string;
  country_source: string;
  country_error: string | null;
  ip: string | null;
  source: string;
  error: string | null;
}

export interface View {
  ai_nodes: NodeRecord[];
  current_routes: RouteSnapshot[];
  verdicts: Verdict[];
  claude: ExitMonitor;
  gemini: ExitMonitor;
  claude_ips: IpRecord[];
  ai_tests: AiTest[];
  ai_testing: boolean;
  settings: Settings;
  probes: Probe[];
  service_health: ServiceHealth[];
  history: Event[];
  network: string;
  uplink: Uplink;
  paused: boolean;
  checking: boolean;
  unacknowledged: boolean;
  status: string;
  issues: string[];
  pending_changes: string[];
  last_check: string;
  notification_error: string | null;
  storage_error: string | null;
}

export interface GeoInfo {
  ip?: string;
  country?: string;
  country_code?: string;
  region?: string;
  city?: string;
  postal?: string;
  type?: string;
  latitude?: number;
  longitude?: number;
  cached_at?: string;
  timezone?: { id?: string; utc?: string };
  connection?: { asn?: number | string; isp?: string; org?: string; domain?: string };
  sales_tax?: { label?: string; note?: string; state_rate?: string };
  network_type?: {
    label?: string;
    idc?: string;
    residential?: string;
    mobile?: string;
    other?: string;
    basis?: string;
    source?: string;
  };
  [key: string]: any;
}

export interface SyncConfig {
  url: string;
  username: string;
  has_password: boolean;
  etag: string | null;
  remote_hash?: string | null;
  last_sync: string;
}

export type Json = Record<string, any>;

// --- App Shell & Panel Module Contracts ---

export type Tab = 'overview' | 'records' | 'diagnostics' | 'settings';
export type RecordsSubTab = 'ips' | 'nodes' | 'history' | 'data';
export type DiagnosticsSubTab = 'curl' | 'ip-lookup' | 'find';
export type SettingsSubTab = 'monitor-settings' | 'routing-settings' | 'webdav-settings' | 'update-settings';
export type ThemePreference = 'system' | 'light' | 'dark';

export interface SubTabItem {
  id: string;
  label: string;
  badge?: string | number | null;
  tone?: 'neutral' | 'safe' | 'warn' | 'risk';
}

export interface ToastOptions {
  tone?: 'neutral' | 'safe' | 'warn' | 'risk';
  /** Keeps the notice in the persistent alert slot until dismissed. */
  persistent?: boolean;
  durationMs?: number;
  undoLabel?: string;
  onUndo?: () => void | Promise<void>;
}

export interface PanelHandle {
  /** Sub-tabs shown in the sticky header bar while this workspace is active. */
  getSubTabs?: (view: View | undefined, activeSub: string) => SubTabItem[];
  /** Render or update this workspace's `#panel-*` container. */
  render: (view: View | undefined, activeSub: string) => void;
  /** Optional guard before leaving this workspace or sub-tab (return false to stay). */
  canLeave?: (nextTab: Tab, nextSub?: string) => boolean | Promise<boolean>;
  /** Optional synchronous check used by `beforeunload` when work or drafts are unsaved. */
  hasUnsavedWork?: () => boolean;
  /** Called when Rust emits `monitor-data-cleared` ('ai' | 'history' | 'all'). */
  onDataCleared?: (scope: string) => void;
  /** Called when `navigate(tab, sub, payload)` or a Tauri event delivers a one-shot payload. */
  onNavigatePayload?: (sub: string, payload: unknown) => void;
  /** Called when this workspace becomes active or the window regains focus while active. */
  onActivate?: (activeSub: string) => void;
  /** Optional hook when Tauri emits `autostart-changed`. */
  onAutostartChanged?: (enabled: boolean | null) => void;
}

export interface IpModalHandle {
  openLookup: (trigger?: HTMLElement) => void;
  openIp: (ip: string, force?: boolean, trigger?: HTMLElement) => Promise<void>;
  openProbe: (probeId: string, force?: boolean, trigger?: HTMLElement) => Promise<void>;
}
