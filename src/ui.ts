// Shared rendering helpers: icons, escaping and time formatting.
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
};

export const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.pulse}</svg>`;
export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const time = (s: string) => (s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '尚未检测');
export const titles: Record<string, string> = {
  starting: '等待首次检测',
  paused: '监控已暂停',
  offline: '所有检测站不可达',
  risk: '存在风险出口 · 请勿使用',
  degraded: '部分检测异常',
  usable: 'AI 出口已标记可用 · 辅助检测异常',
  changed: '发现变化，请确认',
  warn: 'AI 出口待确认',
  split: '正在监控多个出口',
  stable: '各站出口一致',
};

export function safetyText(s: string | null | undefined): string {
  return ({ pending: '待确认', safe: '可用', risk: '风险' } as Record<string, string>)[s || ''] || '未登记';
}

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

export const serviceName = (service: string): string => (service === 'claude' ? 'Claude' : 'Gemini');
