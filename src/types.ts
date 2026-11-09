// Shapes of the Rust `View` and related records sent over Tauri IPC.
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
}
export interface Probe {
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
  service_health: { id: string; name: string; status: 'reachable' | 'restricted' | 'unreachable'; confirmed: string | null; stable: boolean; checked: string; http_code: number | null; latency: number; detail: string }[];
  history: Event[];
  network: string;
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
  country_error: string | null;
  ip: string | null;
  source: string;
  error: string | null;
}
export type Json = Record<string, any>;
