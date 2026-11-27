// Shared UI primitives: icons, HTML escaping, date/age formatting, Geo badge helpers, clipboard, and Toast / Undo bar.

import type { GeoInfo, ToastOptions } from './types';

export const icons: Record<string, string> = {
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c4.5 4.5 4.5 13.5 0 18-4.5-4.5-4.5-13.5 0-18Z"/>',
  pulse: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.77 1.02 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
  book: '<path d="M12 5v15M3 4.5c3.5-1 6.5-.2 9 2 2.5-2.2 5.5-3 9-2v14.5c-3.5-1-6.5-.2-9 2-2.5-2.2-5.5-3-9-2V4.5Z"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a8 8 0 0 1 14 5M18 17A8 8 0 0 1 4 12"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  theme:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="m10.29 3.86-8.17 14.14A2 2 0 0 0 3.85 21h16.3a2 2 0 0 0 1.73-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/>',
  danger: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6m0-6 6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/>',
  wired: '<rect x="2" y="4" width="6" height="6" rx="1"/><rect x="16" y="4" width="6" height="6" rx="1"/><rect x="9" y="14" width="6" height="6" rx="1"/><path d="M5 10v2h14v-2M12 12v2"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M7 17 17 7M9 7h8v8"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  nodes: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M8.5 7.5 10.5 15.5M15.5 7.5 13.5 15.5M9 6h6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};

export const icon = (name: string, className = '') =>
  `<svg${className ? ` class="${esc(className)}"` : ''} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.pulse}</svg>`;

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export const time = (s: string) =>
  s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '尚未检测';

export const titles: Record<string, string> = {
  starting: '等待首次检测',
  paused: '监控已暂停',
  offline: '所有检测站不可达',
  risk: '存在风险出口 · 请勿使用',
  degraded: '部分检测异常',
  usable: 'AI 出口可用 · 辅助检测异常',
  changed: '发现变化，请确认',
  warn: 'AI 出口待确认',
  split: '国内外分流正常',
  stable: '各站出口一致',
};

export function safetyText(s: string | null | undefined): string {
  return ({ pending: '待确认', safe: '可用', risk: '风险' } as Record<string, string>)[s || ''] || '未登记';
}

export function levelLabel(level: string | null | undefined): string {
  return (
    ({
      safe: '可以使用',
      warn: '需要确认',
      risk: '有风险',
      unknown: '待确认出口',
    } as Record<string, string>)[level || ''] || '待检测'
  );
}

export function healthLabel(health: string | null | undefined): string {
  return (
    ({
      reachable: '访问正常',
      restricted: '访问受限',
      unreachable: '连接失败',
    } as Record<string, string>)[health || ''] || '等待检测'
  );
}

export const serviceName = (service: string): string => (service === 'claude' ? 'Claude' : 'Gemini');

/** "3 分钟前" style age for evidence timestamps. */
export function ago(s: string): string {
  if (!s) return '';
  const minutes = Math.round((Date.now() - new Date(s).getTime()) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
}

/** Format cached IP geography into a compact human-readable line (e.g. "美国 · Oregon · 免州税"). */
export function formatGeoSummary(
  geo: GeoInfo | null | undefined,
  opts: { includeIsp?: boolean; includeTax?: boolean } = {}
): string {
  if (!geo) return '';
  const parts: string[] = [];
  const loc = [geo.country, geo.region, geo.city]
    .filter((v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx)
    .join(' · ');
  if (loc) parts.push(loc);
  if (opts.includeTax !== false && geo.country_code === 'US' && geo.sales_tax?.label) {
    parts.push(geo.sales_tax.label);
  }
  if (opts.includeIsp && (geo.connection?.asn || geo.connection?.isp)) {
    const asn = geo.connection?.asn ? `AS${geo.connection.asn}` : '';
    const isp = geo.connection?.isp || '';
    parts.push([asn, isp].filter(Boolean).join(' '));
  }
  return parts.join(' · ');
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

// --- Non-blocking Toast / Undo Bar & Persistent Error Notice ---

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let activeUndo: (() => void | Promise<void>) | undefined;
let undoBusy = false;

export function dismissToast() {
  clearTimeout(toastTimer);
  activeUndo = undefined;
  const region = document.querySelector<HTMLElement>('#toast-region');
  if (region) region.innerHTML = '';
}

export function dismissAlert() {
  const alertEl = document.querySelector<HTMLElement>('#alert-region');
  if (alertEl) {
    alertEl.hidden = true;
    alertEl.innerHTML = '';
  }
}

export function showToast(message: string, opts: ToastOptions = {}) {
  if (opts.persistent) {
    const alertEl = document.querySelector<HTMLElement>('#alert-region');
    if (alertEl) {
      alertEl.innerHTML = `
        <div class="alert-region-body">
          <strong>操作提示</strong>
          <span>${esc(message)}</span>
        </div>
        <button type="button" data-dismiss-alert>关闭</button>`;
      alertEl.hidden = false;
      return;
    }
  }

  const region = document.querySelector<HTMLElement>('#toast-region');
  if (!region) return;
  clearTimeout(toastTimer);
  activeUndo = opts.onUndo;

  const hasUndo = typeof opts.onUndo === 'function';
  region.innerHTML = `
    <div class="toast-card">
      <span>${esc(message)}</span>
      ${hasUndo ? `<button type="button" data-toast-undo>${esc(opts.undoLabel || '撤销')}</button>` : ''}
      ${hasUndo ? `<button type="button" data-toast-dismiss aria-label="关闭提示">关闭</button>` : ''}
    </div>`;

  // Per accessibility rules: action-bearing toasts stay until dismissed unless an explicit duration is set.
  if (!hasUndo || opts.durationMs) {
    const ms = opts.durationMs ?? 4200;
    toastTimer = setTimeout(() => {
      dismissToast();
    }, ms);
  }
}

/** Legacy 2-arg toast helper preserved for compatibility. */
export function toast(message: string, persistent = false) {
  showToast(message, { persistent, tone: persistent ? 'risk' : 'neutral' });
}

export function initToastListeners() {
  document.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-toast-undo], [data-toast-dismiss], [data-dismiss-alert]'
    );
    if (!btn || btn.disabled) return;
    if (btn.hasAttribute('data-dismiss-alert')) {
      dismissAlert();
      return;
    }
    if (btn.hasAttribute('data-toast-dismiss')) {
      dismissToast();
      return;
    }
    if (btn.hasAttribute('data-toast-undo')) {
      if (!activeUndo || undoBusy) return;
      const fn = activeUndo;
      undoBusy = true;
      btn.disabled = true;
      try {
        await fn();
        dismissToast();
        showToast('已撤销刚才的操作');
      } catch (e) {
        dismissToast();
        showToast(String(e), { persistent: true });
      } finally {
        undoBusy = false;
      }
    }
  });
}
