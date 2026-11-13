import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';
import { initUpdates } from './updater';
import { hasUnsavedSync, discardUnsavedSync, syncInProgress } from './sync';
import { getVersion } from '@tauri-apps/api/app';
import { ListView } from './list';
import { proxyDataSettings, initProxyData, resetProxyDataUi, loadLocalProxyClients, proxyDataInProgress, updateProxyDataState } from './proxy-data';
import { confirmAction } from './confirm';
import { initSearchSelects, refreshSearchSelects, setSelectValue } from './select';
import { icon, esc, time, titles, safetyText } from './ui';
import type { Event, RouteSnapshot, IpRecord, View, Json } from './types';
import { geoCache, probeList, probeRow, recordSeries, renderOverview, series } from './overview';
import {
  aiList, nodeList, routeList, routeRow, renderIpRecords, renderNodeRecords, populateNodeChoices,
  captureDrafts, restoreDrafts, clearDrafts, fillIp, fillNode, ipRecordRow, nodeRecordRow,
} from './records';
import { selectSettingsSection, refreshPermissions, ignoreList, initSettings, permission, renderIgnoreList, renderSettings, setAutostart, settingsBusy, syncAutostart, paintSettingsDraft } from './settings-page';
import { initIpDetails, loadPlaces, showDetails, openIpLookup } from './ip-details';
import { findNear, nearList, renderNearList, renderNodeFinder } from './node-finder';
import {
  initDiagnostics,
  getDiagnosticsState,
  renderDiagnosticsTab,
  handleDiagnosticsClick,
} from './diagnostics';

const themeKey = 'sentinel.theme';
function getTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem(themeKey);
  return saved === 'dark' ? 'dark' : 'light';
}
function applyTheme(t: 'light' | 'dark') {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#090d16' : '#f1f5f9');
  localStorage.setItem(themeKey, t);
  const btn = document.querySelector<HTMLButtonElement>('#theme-toggle');
  if (btn) {
    btn.title = t === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    btn.setAttribute('aria-label', btn.title);
    const label = btn.querySelector('.theme-label');
    if (label) label.textContent = t === 'dark' ? '浅色' : '深色';
  }
}
applyTheme(getTheme());



// Four pages; records and diagnostics have sub pages. Old `mode` values still open the right place.
type Tab = 'overview' | 'records' | 'diagnostics' | 'settings';
const legacyModes: Record<string, [Tab, string?]> = {
  monitor: ['overview'], ai: ['overview'], overview: ['overview'],
  records: ['records'], data: ['records', 'data'],
  diagnostics: ['diagnostics', 'curl'], history: ['diagnostics', 'history'],
  settings: ['settings'], guide: ['settings'],
};
const subTabs: Record<string, [string, string][]> = {
  records: [['ips', 'IP 记录'], ['nodes', '节点记录'], ['find', '按地区找节点'], ['data', '导入与清理']],
  diagnostics: [['curl', '网站连通性'], ['history', '变化记录']],
};
const subKey = (t: string) => `sentinel.subtab.${t}`;
function readSub(t: string): string {
  const options = subTabs[t] || [];
  try {
    const saved = localStorage.getItem(subKey(t));
    if (options.some(([id]) => id === saved)) return saved!;
  } catch {}
  return options[0]?.[0] || '';
}
const wifiPermissionMessages: Record<string, string> = {
  requested: '已弹出定位权限申请。点“允许”后会自动显示 Wi-Fi 名称；出口哨兵不读取也不保存你的位置。',
  granted: '已有定位权限，正在重新读取 Wi-Fi 名称…',
  denied: '定位权限之前被拒绝，系统不会再弹窗。已打开 系统设置 → 隐私与安全性 → 定位服务，请打开 Exit Sentinel 的开关。',
  services_off: '这台 Mac 关闭了定位服务。已打开 系统设置 → 隐私与安全性 → 定位服务，请先打开总开关，再允许 Exit Sentinel。',
  settings: '已打开系统定位设置。请打开“定位服务”和“允许桌面应用访问你的位置”，用于读取 Wi-Fi 名称。',
};
const initialMode = legacyModes[new URLSearchParams(location.search).get('mode') || ''] || ['overview'];
let state: View | undefined,
  tab: Tab = initialMode[0];
const sub: Record<string, string> = { records: readSub('records'), diagnostics: readSub('diagnostics') };
if (initialMode[1]) sub[initialMode[0]] = initialMode[1];
function setSub(t: string, value: string) {
  sub[t] = value;
  try { localStorage.setItem(subKey(t), value); } catch {}
}
const busyLeaving = () => tab === 'records' && sub.records === 'data' && proxyDataInProgress();

const historyList = new ListView<Event>(
  'history',
  {
    time: { label: '时间', value: r => r.time },
    title: { label: '事件', value: r => r.title },
  },
  r => `${r.title} ${r.detail}`,
  () => ''
);

let routeRows: RouteSnapshot[] = [];

async function switchTab(target: string, subTab?: string) {
  const [nextTab, legacySub] = legacyModes[target] || ['overview'];
  const nextSub = subTab || legacySub;
  if (nextTab === tab) {
    if (nextSub && nextSub !== sub[tab]) {
      if (busyLeaving()) { toast('节点操作正在进行，请等待完成后再切换。'); return; }
      setSub(tab, nextSub);
      render();
    }
    return;
  }
  if (busyLeaving()) { toast('节点操作正在进行，请等待完成后再切换页面。'); return; }
  if (tab === 'settings' && (settingsBusy() || syncInProgress())) {
    toast('设置操作正在进行，请等待完成后再切换页面。');
    return;
  }
  if (tab === 'settings' &&
      (content.querySelector<HTMLFormElement>('#settings-form')?.dataset.dirty === 'true' || hasUnsavedSync()) &&
      !await confirmAction({ title: '离开未保存的设置？', message: '离开后将丢失本页尚未保存的输入。', confirm: '放弃修改并离开' })) return;
  if (tab === 'settings') discardUnsavedSync();
  tab = nextTab;
  if (nextSub) setSub(tab, nextSub);
  const url = new URL(location.href); url.searchParams.set('mode', tab); history.replaceState(null, '', url);
  render();
  window.scrollTo({ top: 0 });
  document.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
  if (tab === 'settings') void syncAutostart();
}

document.querySelector('#app')!.innerHTML = `
  <a class="skip-link" href="#page-title">跳到主要内容</a>
  <aside>
    <div class="brand">
      <span class="brand-icon">${icon('shield')}</span>
      <div>
        <div class="brand-name">出口哨兵</div>
        <small>EXIT SENTINEL</small>
      </div>
    </div>
    <nav aria-label="主导航">
      <a href="?mode=overview" data-tab="overview">${icon('shield')}<span>概览</span><span id="overview-badge" class="nav-badge" hidden></span></a>
      <a href="?mode=records" data-tab="records">${icon('book')}<span>记录库</span><span id="ai-count" class="nav-badge">0</span></a>
      <a href="?mode=diagnostics" data-tab="diagnostics">${icon('terminal')}<span>诊断</span><span id="event-count" class="nav-badge">0</span></a>
      <a href="?mode=settings" data-tab="settings">${icon('settings')}<span>设置</span></a>
    </nav>
    <div class="sidebar-foot">
      <small>关闭窗口后在菜单栏继续监控。</small>
      <span class="version">macOS · Windows · Linux / <span id="app-version">读取版本…</span></span>
    </div>
  </aside>
  <main id="main-content">
    <header class="app-header">
      <div class="header-titles">
        <div class="header-title-row">
          <h1 id="page-title" tabindex="-1">概览</h1>
          <span id="top-status-pill" class="top-status-pill">等待检测</span>
        </div>
      </div>
      <div class="header-actions">
        <button id="ip-lookup" type="button">${icon('globe')}<span>IP 查询</span></button>
        <button id="theme-toggle" type="button" title="切换深浅色主题">
          ${icon('theme')}
          <span class="theme-label">${getTheme() === 'dark' ? '浅色' : '深色'}</span>
        </button>
        <button id="check" class="primary" type="button" title="刷新出口 IP 与网站连通性">${icon('refresh')}<span>刷新网络状态</span></button>
      </div>
    </header>
    <div id="pause-banner" class="pause-banner" role="status" hidden>
      <span>${icon('pulse')}<strong>监控已暂停</strong><span id="pause-reason">不会检测出口，也不会记录新变化。</span></span>
      <button type="button" id="resume" class="primary">恢复监控</button>
    </div>
    <div id="software-update" role="status" aria-live="polite"></div>
    <div id="content"></div>
  </main>
  <dialog id="route-details" class="route-dialog" aria-label="关联的节点记录"><div id="route-content"></div></dialog>
  <dialog id="details" aria-label="IP 位置与网络详情"><div id="detail-content"></div></dialog>
  <div id="toast" role="status" aria-live="polite"></div>
  <div id="mark-feedback" class="mark-feedback" hidden><span role="status" id="mark-message"></span><button type="button" id="undo-mark">撤销标记</button><button type="button" id="dismiss-mark">关闭</button></div>
  <div id="error-notice" role="alert" hidden><span id="error-message"></span><button type="button" id="dismiss-error">关闭提示</button></div>`;

const content = document.querySelector<HTMLElement>('#content')!;
const dialog = document.querySelector<HTMLDialogElement>('#details')!;

let toastTimer: ReturnType<typeof setTimeout> | undefined;
let undoMark: (() => Promise<void>) | undefined;
let marking = false;
function offerMarkUndo(message: string, action: () => Promise<void>, previouslyRegistered: boolean) {
  undoMark = action;
  document.querySelector('#mark-message')!.textContent = message;
  document.querySelector('#undo-mark')!.textContent = previouslyRegistered ? '撤销标记' : '撤回至待确认';
  document.querySelector<HTMLElement>('#mark-feedback')!.hidden = false;
}
function toast(message: string, persistent = false) {
  if (persistent) {
    document.querySelector('#error-message')!.textContent = message;
    document.querySelector<HTMLElement>('#error-notice')!.hidden = false;
    return;
  }
  const e = document.querySelector<HTMLElement>('#toast')!;
  e.textContent = message;
  clearTimeout(toastTimer);
  e.classList.add('visible');
  toastTimer = setTimeout(() => e.classList.remove('visible'), 5000);
}

async function call<T = void>(name: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(name, args);
  } catch (e) {
    toast(String(e), true);
    throw e;
  }
}

let deferredRender = false;
let scrollLock: { html: string; body: string } | undefined;
function lockDialogScroll() {
  if (!scrollLock) scrollLock = { html: document.documentElement.style.overflow, body: document.body.style.overflow };
  document.documentElement.style.overflow = 'hidden';
  document.body.style.overflow = 'hidden';
}
const dialogOpeners = new WeakMap<HTMLDialogElement, { id: string; data: [string, string][] }>();
function rememberDialogOpener(modal: HTMLDialogElement, trigger?: HTMLElement) {
  const button = trigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (button) dialogOpeners.set(modal, { id: button.id, data: Object.entries(button.dataset).filter((x): x is [string, string] => x[1] !== undefined) });
}
function findDialogOpener(modal: HTMLDialogElement): HTMLElement | null {
  const saved = dialogOpeners.get(modal);
  if (!saved) return null;
  if (saved.id) return document.getElementById(saved.id);
  if (!saved.data.length) return null;
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(b => saved.data.every(([k, v]) => b.dataset[k] === v)) || null;
}
function renderPreservingFocus() {
  const focused = document.activeElement;
  const button = focused instanceof HTMLButtonElement && content.contains(focused) ? focused : null;
  const id = button?.id;
  const data = button ? Object.entries(button.dataset) : [];
  const label = button?.textContent;
  render();
  if (!button) return;
  const replacement = id ? document.getElementById(id) : Array.from(content.querySelectorAll('button')).find(candidate =>
    data.length > 0 && data.every(([key, value]) => candidate.dataset[key] === value) && candidate.textContent === label);
  (replacement || document.querySelector<HTMLElement>('#page-title'))?.focus({ preventScroll: true });
}
for (const modal of document.querySelectorAll<HTMLDialogElement>('dialog')) {
  modal.addEventListener('close', () => {
    modal.dataset.ip = '';
    if (!document.querySelector('dialog[open]') && scrollLock) {
      document.documentElement.style.overflow = scrollLock.html;
      document.body.style.overflow = scrollLock.body;
      scrollLock = undefined;
    }
    if (deferredRender) { deferredRender = false; render(); }
    findDialogOpener(modal)?.focus();
  });
}

initSettings({
  content,
  toast,
  call,
  settings: () => state!.settings,
  historyCount: () => state?.history.length || 0,
  isActive: () => tab === 'settings',
});

initIpDetails({
  dialog,
  call: invoke,
  probeIp: id => state?.probes.find(p => p.id === id)?.ip || null,
  lockScroll: lockDialogScroll,
  rememberOpener: rememberDialogOpener,
  onGeoLoaded: () => { if (tab === 'overview') deferredRender = true; },
});

function showRoutes(r: IpRecord, trigger?: HTMLElement) {
  routeRows = r.routes || [];
  const modal = document.querySelector<HTMLDialogElement>('#route-details')!;
  document.querySelector('#route-content')!.innerHTML = `
    <div class="dialog-head">
      <div>
        <span class="eyebrow">ROUTE SNAPSHOT HISTORY</span>
        <h2>${esc(r.service)} · ${esc(r.ip)}</h2>
      </div>
      <button type="button" id="close-routes">关闭</button>
    </div>
    <p class="muted">这个 IP 出现时识别到的节点，按时间排列。</p>
    ${routeList.render(routeRows, routeRow)}`;
  rememberDialogOpener(modal, trigger);
  lockDialogScroll();
  modal.showModal();
}

function historyRow(e: Event) {
  return `<article class="timeline-item">
    <span class="timeline-dot"></span>
    <div class="timeline-card">
      <div class="timeline-header">
        <h3>${esc(e.title)}</h3>
        <time>${time(e.time)}</time>
      </div>
      <p>${esc(e.detail).replace(/\n/g, '<br>')}</p>
    </div>
  </article>`;
}

const pageTitles: Record<Tab, string> = { overview: '概览', records: '记录库', diagnostics: '诊断', settings: '设置' };

function subBadge(t: string, id: string): string {
  if (!state && id !== 'curl') return '';
  const n = t === 'records'
    ? id === 'ips' ? String(state!.claude_ips.length) : id === 'nodes' ? String(state!.ai_nodes.length) : ''
    : id === 'history' ? String(state!.history.length)
      : `${getDiagnosticsState().testedCount}/${getDiagnosticsState().totalCount}`;
  return n ? `<span class="nav-badge">${n}</span>` : '';
}

function subNav(t: Tab): string {
  const options = subTabs[t];
  if (!options) return '';
  return `<div class="sub-tabs" role="tablist" aria-label="${pageTitles[t]}">${options
    .map(([id, label]) => `<button type="button" role="tab" data-subtab="${id}" aria-selected="${sub[t] === id}" class="${sub[t] === id ? 'active' : ''}">${label}${subBadge(t, id)}</button>`)
    .join('')}</div>`;
}

/** Sidebar, header and pause banner; cheap enough to run on every state update. */
function paintChrome() {
  document.querySelectorAll<HTMLElement>('aside [data-tab]').forEach(n => {
    const selected = n.dataset.tab === tab;
    n.classList.toggle('active', selected);
    if (selected) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current');
  });
  document.querySelector('#page-title')!.textContent = pageTitles[tab];
  const check = document.querySelector<HTMLButtonElement>('#check')!;
  check.hidden = tab !== 'overview';
  const v = state;
  if (!v) return;
  check.disabled = v.checking || v.paused;
  check.innerHTML = `${icon('refresh')}<span>${v.checking ? '正在刷新…' : '刷新网络状态'}</span>`;
  document.querySelector('#event-count')!.textContent = String(v.history.length);
  document.querySelector('#ai-count')!.textContent = String(v.claude_ips.length + v.ai_nodes.length);
  const worst = v.verdicts.some(x => x.level === 'risk') ? 'risk' : v.verdicts.some(x => x.level === 'warn') ? 'warn' : '';
  const badge = document.querySelector<HTMLElement>('#overview-badge')!;
  badge.hidden = !worst;
  badge.className = `nav-badge ${worst}`;
  badge.textContent = worst === 'risk' ? '风险' : '待确认';
  const topPill = document.querySelector<HTMLElement>('#top-status-pill')!;
  topPill.className = `top-status-pill ${v.status}`;
  topPill.textContent = titles[v.status] || v.status;
  document.querySelector<HTMLElement>('#pause-banner')!.hidden = !v.paused;
}

// These pages hold their own in-progress state and must not be rebuilt by background updates.
const selfManagedPage = () =>
  tab === 'settings' || (tab === 'records' && sub.records === 'data') || (tab === 'diagnostics' && sub.diagnostics === 'curl');

function renderRecords(v: View) {
  captureDrafts(content);
  const page = sub.records;
  const body = page === 'ips' ? renderIpRecords(v, ipSaving)
    : page === 'nodes' ? renderNodeRecords(v, nodeSaving)
      : page === 'find' ? renderNodeFinder()
        : proxyDataSettings(v.paused);
  content.innerHTML = subNav('records') + body;
  if (page === 'nodes') populateNodeChoices(content, v);
  if (page === 'data') void loadLocalProxyClients();
  restoreDrafts(content);
}

function renderHistory(v: View) {
  return `<section class="panel timeline">
    <div class="panel-toolbar-head">
      <div><h2>变化记录</h2><small class="muted">连续两次确认的出口变化、服务告警和手动操作，保留最近 200 条</small></div>
      <button type="button" id="clear">清空记录</button>
    </div>
    ${historyList.render(v.history, historyRow)}
  </section>`;
}

function render() {
  paintChrome();
  if (tab === 'diagnostics' && sub.diagnostics === 'curl') {
    content.innerHTML = subNav('diagnostics') + renderDiagnosticsTab();
    return;
  }
  if (!state) return;
  const v = state;
  if (tab === 'overview') content.innerHTML = renderOverview(v);
  if (tab === 'records') renderRecords(v);
  if (tab === 'diagnostics') content.innerHTML = subNav('diagnostics') + renderHistory(v);
  if (tab === 'settings') renderSettings(v.settings);
  refreshSearchSelects(content);
}

let nodeSaving = false,
  ipSaving = false;
document.addEventListener('click', async event => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-tab]');
  if (link) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    await switchTab(link.dataset.tab!);
    return;
  }
  const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b || b.disabled) return;
  try {
    if (b.id === 'dismiss-mark') {
      undoMark = undefined;
      document.querySelector<HTMLElement>('#mark-feedback')!.hidden = true;
      document.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
      return;
    }
    if (b.id === 'undo-mark') {
      if (!undoMark || marking) return;
      marking = true;
      b.disabled = true;
      try {
        await undoMark();
        undoMark = undefined;
        document.querySelector<HTMLElement>('#mark-feedback')!.hidden = true;
        toast('人工标记已恢复');
        document.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
      } finally { marking = false; b.disabled = false; }
      return;
    }
    if (b.dataset.settingsSection) {
      await switchTab('settings');
      if (tab === 'settings') {
        selectSettingsSection(b.dataset.settingsSection, true);
        window.scrollTo({ top: 0 });
      }
      return;
    }
    if (b.id === 'show-probes') {
      const panel = content.querySelector<HTMLDetailsElement>('.probe-panel');
      if (panel) { panel.open = true; panel.scrollIntoView({ block: 'start' }); panel.querySelector('summary')?.focus(); }
      return;
    }
    if (b.dataset.testService) {
      await call('test_ai_services', { service: b.dataset.testService });
      toast(`${b.dataset.testService === 'claude' ? 'Claude' : 'Gemini'} 深入测试完成`);
      return;
    }
    if (b.id === 'enable-auto-nodes') {
      b.disabled = true;
      await invoke('save_settings', { settings: { ...state!.settings, manual_nodes_only: false } });
      update(await invoke<View>('get_state'));
      toast('已恢复自动节点识别，正在读取实际连接记录。');
      return;
    }
    if (b.id === 'wifi-name-permission') {
      const result = await invoke<string>('request_wifi_name');
      toast(wifiPermissionMessages[result] || wifiPermissionMessages.granted, result === 'denied' || result === 'services_off');
      void refreshPermissions();
      return;
    }
    if (b.id === 'location-settings') {
      await invoke('open_location_settings');
      toast('已打开系统定位设置，请允许 Exit Sentinel 使用定位服务（只用于读取 Wi-Fi 名称）。');
      return;
    }
    if (b.id === 'theme-toggle') {
      applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
      return;
    }
    if (tab === 'diagnostics' && (await handleDiagnosticsClick(b, render, toast))) {
      return;
    }
    const list = b.closest<HTMLElement>('[data-list]');
    if (b.dataset.listPage && list) {
      const l = listFor(list.dataset.list).list;
      l.page = Number(b.dataset.listPage);
      if (list.dataset.list === 'ip-routes' || list.dataset.list === 'ignored-checks') {
        // Re-render only this list: a full render would drop unsaved settings input.
        const id = list.dataset.list;
        list.outerHTML = listFor(id).html();
        const fresh = document.querySelector<HTMLElement>(`[data-list="${id}"]`);
        if (fresh) refreshSearchSelects(fresh);
        fresh?.querySelector<HTMLButtonElement>('[data-list-page]:not(:disabled)')?.focus();
      } else {
        render();
        document.querySelector<HTMLButtonElement>(`[data-list="${CSS.escape(l.id)}"] [data-list-page]:not(:disabled)`)?.focus();
      }
      return;
    }
    if (b.dataset.subtab && !b.dataset.tab) {
      await switchTab(tab, b.dataset.subtab);
      return;
    }
    if (b.dataset.markIp !== undefined && b.dataset.service) {
      if (marking) return;
      const { service, status, markIp: ip } = b.dataset;
      const previous = state?.claude_ips.find(r => r.service === service && r.ip === ip);
      if (previous?.status === status) return;
      const note = previous?.note || '';
      marking = true;
      try {
        await call('save_claude_ip', { service, ip, status, note, attachCurrent: false });
        offerMarkUndo(`${service === 'claude' ? 'Claude' : 'Gemini'} · IP 已人工标记为${safetyText(status)}`, async () => {
          const latest = await call<View>('get_state');
          const record = latest.claude_ips.find(r => r.service === service && r.ip === ip);
          if (!record || record.status !== status || record.note !== note) throw new Error('记录已变化，请到记录库检查后修改。');
          await call('save_claude_ip', { service, ip, status: previous?.status || 'pending', note, attachCurrent: false });
        }, !!previous);
      } finally { marking = false; }
      return;
    }
    if (b.dataset.markNode !== undefined && b.dataset.service) {
      if (marking) return;
      const { service, status, markNode: key } = b.dataset;
      const x = state?.verdicts.find(v => v.service === service);
      const previous = state?.ai_nodes.find(r => r.service === service && r.key === x?.node_record);
      if (previous?.status === status) return;
      const note = previous?.note || '';
      marking = true;
      try {
        await call('save_ai_node', { service, key, status, note, current: true });
        const recordKey = previous?.key || key;
        offerMarkUndo(`节点已人工标记为${safetyText(status)}`, async () => {
          const latest = await call<View>('get_state');
          const record = latest.ai_nodes.find(r => r.service === service && r.key === recordKey);
          if (!record || record.status !== status || record.note !== note) throw new Error('节点记录已变化，请到记录库检查后修改。');
          await call('save_ai_node', { service, key: record.key, status: previous?.status || 'pending', note, current: false });
        }, !!previous);
      } finally { marking = false; }
      return;
    }
    if (b.dataset.copyText) {
      await navigator.clipboard.writeText(b.dataset.copyText);
      toast(`已复制：${b.dataset.copyText}`);
      return;
    }
    if (b.dataset.fillIp) {
      fillIp(content, { service: b.dataset.fillService!, ip: b.dataset.fillIp, status: 'pending', note: '' });
      return;
    }
    if (b.dataset.editNode) {
      fillNode(content, state!, b.dataset.nodeService!, b.dataset.editNode, false);
      return;
    }
    if (b.dataset.copyService) {
      await call('copy_ai_route', { service: b.dataset.copyService, ip: b.dataset.copyIp || null });
      toast('配置、策略链和节点信息已复制');
      return;
    }
    if (b.dataset.routeIp) {
      const r = state?.claude_ips.find(r => r.ip === b.dataset.routeIp && r.service === b.dataset.routeService);
      if (r) showRoutes(r, b);
      return;
    }
    if (b.dataset.editIp) {
      const r = state?.claude_ips.find(r => r.ip === b.dataset.editIp && r.service === b.dataset.editService);
      if (r) fillIp(content, r);
      return;
    }
    if (b.dataset.tab) {
      await switchTab(b.dataset.tab, b.dataset.subtab);
      return;
    }
    if (b.dataset.url) {
      await openUrl(b.dataset.url);
      return;
    }
    if (b.dataset.detail) {
      await showDetails(b.dataset.detail, false, b);
      return;
    }
    switch (b.id) {
      case 'ip-lookup':
        openIpLookup(b);
        break;
      case 'test-ai':
        await call('test_ai_services');
        toast('Claude 与 Gemini 测试完成，结果已分别更新');
        break;
      case 'resume':
        await call('set_paused', { paused: false });
        break;
      case 'curl-panel':
        switchTab('diagnostics');
        break;
      case 'check':
      case 'retry-network':
        await call('check_now');
        break;
      case 'pause':
        await call('set_paused', { paused: !state?.paused });
        break;
      case 'ack':
        await call('acknowledge');
        break;
      case 'clear':
        if (!await confirmAction({ title: '清空变化记录？', message: '清空全部网络与出口变化日志。IP 和节点库将保留。', detail: '清空前自动生成本机恢复备份。', confirm: '备份并清空', danger: true })) break;
        await call('clear_monitor_data', { scope: 'history' });
        toast('记录已清空');
        break;
      case 'close-routes':
        document.querySelector<HTMLDialogElement>('#route-details')!.close();
        break;
      case 'close-dialog':
        dialog.close();
        break;
      case 'dismiss-error':
        document.querySelector<HTMLElement>('#error-notice')!.hidden = true;
        break;
      case 'test-notification':
        if (await permission()) {
          await call('test_notification');
          toast('已向系统提交通知，请确认通知是否出现。');
        }
        break;
      case 'nearby':
        await loadPlaces(dialog.dataset.ip!);
        break;
    }
  } catch (e) {
    if (b.id === 'enable-auto-nodes') b.disabled = false;
    toast(String(e), true);
  }
});

// Each ListView on screen, by its data-list id, with how to re-render it.
function listFor(id: string | undefined): { list: { id: string; page: number; change: (a: string, v: string) => void }; html: () => string } {
  switch (id) {
    case 'ai-nodes': return { list: nodeList, html: () => nodeList.render(state!.ai_nodes || [], nodeRecordRow) };
    case 'ai-ips': return { list: aiList, html: () => aiList.render(state!.claude_ips, ipRecordRow) };
    case 'probes': return { list: probeList, html: () => probeList.render(state!.probes, probeRow) };
    case 'ip-routes': return { list: routeList, html: () => routeList.render(routeRows, routeRow) };
    case 'near-nodes': return { list: nearList, html: renderNearList };
    case 'ignored-checks': return { list: ignoreList, html: renderIgnoreList };
    default: return { list: historyList, html: () => historyList.render(state!.history, historyRow) };
  }
}

function listInput(event: globalThis.Event) {
  const input = event.target as HTMLInputElement;
  const root = input.closest<HTMLElement>('[data-list]');
  if (!root || !input.dataset.listAction) return;
  const { list: l, html } = listFor(root.dataset.list);
  l.change(input.dataset.listAction, input.value);
  const fresh = document.createElement('div');
  fresh.innerHTML = html();
  root.querySelector('.list-rows')!.replaceChildren(...Array.from(fresh.querySelector('.list-rows')!.childNodes));
  root.querySelector('.list-footer')!.replaceWith(fresh.querySelector('.list-footer')!);
  refreshSearchSelects(root);
}

document.addEventListener('input', e => {
  const field = e.target as HTMLInputElement;
  const form = field.closest<HTMLFormElement>('#settings-form');
  if (form && !field.dataset.listAction) { form.dataset.dirty = 'true'; paintSettingsDraft(); }
  if ((e.target as HTMLElement).dataset.listAction === 'query' && !(e as InputEvent).isComposing) listInput(e);
});
document.addEventListener('compositionend', e => {
  if ((e.target as HTMLElement).dataset.listAction === 'query') listInput(e);
});
document.addEventListener('change', e => {
  const field = e.target as HTMLInputElement;
  const form = field.closest<HTMLFormElement>('#settings-form');
  if (form && !field.dataset.listAction) { form.dataset.dirty = 'true'; paintSettingsDraft(); }
  if ((e.target as HTMLElement).dataset.listAction && (e.target as HTMLElement).dataset.listAction !== 'query') listInput(e);
});

document.addEventListener('submit', e => {
  if ((e.target as HTMLElement).id !== 'near-form') return;
  e.preventDefault();
  const text = String(new FormData(e.target as HTMLFormElement).get('near-query') || '');
  void findNear(text, () => { if (tab === 'records' && sub.records === 'find') render(); });
});

document.addEventListener('submit', async e => {
  if ((e.target as HTMLElement).id !== 'ai-node-form') return;
  e.preventDefault();
  if (nodeSaving) return;
  nodeSaving = true;
  const form = e.target as HTMLFormElement,
    f = new FormData(form),
    button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  button.disabled = true;
  const [kind, service, ...keyParts] = String(f.get('target')).split(':');
  const key = keyParts.join(':');
  try {
    await call('save_ai_node', {
      service,
      key,
      status: String(f.get('status')),
      note: String(f.get('note')).trim(),
      current: kind === 'current',
    });
    toast('节点状态已保存，无需出口 IP');
    if (tab === 'records') render();
  } catch {
  } finally {
    nodeSaving = false;
    button.disabled = false;
    if (tab === 'records' && !button.isConnected) render();
  }
});

document.addEventListener('submit', async e => {
  if ((e.target as HTMLElement).id !== 'ai-ip-form') return;
  e.preventDefault();
  if (ipSaving) return;
  ipSaving = true;
  const form = e.target as HTMLFormElement,
    f = new FormData(form),
    button = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  button.disabled = true;
  try {
    await call('save_claude_ip', {
      service: String(f.get('service')),
      ip: String(f.get('ip')).trim(),
      status: String(f.get('status')),
      note: String(f.get('note')).trim(),
      attachCurrent: f.has('attach_current'),
    });
    toast('IP 状态已保存');
    if (tab === 'records') render();
  } catch {
  } finally {
    ipSaving = false;
    button.disabled = false;
    if (tab === 'records' && !button.isConnected) render();
  }
});

let geoLoading = false,
  geoGeneration = 0,
  geoLast = 0;
async function syncGeography() {
  if (geoLoading || Date.now() - geoLast < 15000) return;
  geoLoading = true;
  geoLast = Date.now();
  const generation = geoGeneration;
  try {
    const all = await invoke<Record<string, Json>>('get_cached_geography');
    if (generation !== geoGeneration) return;
    let changed = false;
    for (const [ip, g] of Object.entries(all)) {
      if (JSON.stringify(geoCache.get(ip)) !== JSON.stringify(g)) {
        geoCache.set(ip, g);
        changed = true;
      }
    }
    if (changed && tab === 'overview') {
      if (document.querySelector('dialog[open]')) deferredRender = true;
      else renderPreservingFocus();
    }
  } catch {
  } finally {
    geoLoading = false;
  }
}

let renderPending = false;

// The Claude process heartbeat is shown in place; it must not trigger a full page render.
function viewSignature(v: View | undefined) {
  return v ? JSON.stringify({ ...v, claude: { ...v.claude, checked: '' } }) : '';
}

const isEditing = () =>
  content.contains(document.activeElement) && !!document.activeElement?.matches('input,select,textarea');

function canRender() {
  return !isEditing() && !document.querySelector('dialog[open]') && !selfManagedPage();
}

function flushPendingRender() {
  if (!renderPending || !canRender()) return;
  renderPending = false;
  renderPreservingFocus();
}

function updateClaudeChecked(checked: string) {
  if (state) state = { ...state, claude: { ...state.claude, checked } };
}

function update(v: View) {
  const initial = !state;
  const changed = viewSignature(state) !== viewSignature(v);
  state = v;
  updateProxyDataState(v.paused);
  void syncGeography();
  recordSeries(v);
  if (changed && document.querySelector('dialog[open]')) deferredRender = true;
  if (changed) renderPending = true;
  // Typing in a filter or form keeps focus; the render waits until focus leaves (see focusout).
  if (initial || (renderPending && canRender())) {
    renderPending = false;
    renderPreservingFocus();
  } else {
    paintChrome();
  }
}

// Evidence ages ("3 分钟前") on the overview drift without a state change.
setInterval(() => {
  if (tab === 'overview' && state && canRender()) renderPreservingFocus();
}, 60_000);

async function start() {
  try {
    initSearchSelects();
    document.addEventListener('search-select-closed', () => {
      if (!document.querySelector('dialog[open]') && (deferredRender || renderPending)) {
        deferredRender = false; renderPending = false; renderPreservingFocus();
      }
    });
    initProxyData(toast, async () => {
      update(await invoke<View>('get_state'));
      // Import explicitly changes the source; keep the rest of the draft intact.
      const form = content.querySelector<HTMLFormElement>('#settings-form');
      if (form) {
        const source = form.elements.namedItem('manual_nodes_only') as HTMLSelectElement;
        setSelectValue(source, String(state!.settings.manual_nodes_only));
      }
    });
    await listen<string>('monitor-data-cleared', e => {
      if (e.payload !== 'history') {
        clearDrafts(); routeRows = [];
        for (const form of content.querySelectorAll<HTMLFormElement>('#ai-ip-form, #ai-node-form')) form.reset();
      }
      if (e.payload === 'all') { geoGeneration++; geoCache.clear(); series.clear(); geoLast = 0; }
      resetProxyDataUi();
    });
    await listen('open-data-settings', () => { void switchTab('records', 'data'); });
    await initUpdates();
    await initDiagnostics(openTab => {
      if (openTab) void switchTab('diagnostics', 'curl');
      else if (tab === 'diagnostics') render();
    });
    getVersion().then(v => {
      const e = document.querySelector('#app-version');
      if (e) e.textContent = `v${v}`;
    });
    await listen<View>('monitor-state', e => update(e.payload));
    if (tab === 'settings') void syncAutostart();
    await listen<string>('claude-checked', e => updateClaudeChecked(e.payload));
    // Defer the leave check until the next element has focus.
    content.addEventListener('focusout', () => setTimeout(flushPendingRender, 0));
    update(await invoke<View>('get_state'));
    await listen<Pick<IpRecord, 'service' | 'ip' | 'status' | 'note'>>('open-ai-ip', async e => {
      await switchTab('records', 'ips');
      if (tab === 'records') fillIp(content, e.payload);
    });
    await listen<string>('ai-status-saved', e => toast(e.payload));
    await listen('open-ai-monitor', () => {
      void switchTab('overview');
    });
    await listen<string>('open-ip-detail', e => {
      void showDetails(e.payload);
    });
    await listen<boolean | null>('autostart-changed', e => {
      setAutostart(e.payload);
    });
    await listen<string>('autostart-error', e => toast(`开机自启设置失败：${e.payload}`));
  } catch (e) {
    content.innerHTML = `<section class="panel empty">
      <div class="empty-icon">${icon('shield')}</div>
      <h2>需要在桌面应用中运行</h2>
      <p>请使用 Tauri 启动出口哨兵，浏览器预览不能读取本机检测服务。</p>
      <p class="mono small">${esc(String(e))}</p>
    </section>`;
  }
}
void start();

window.addEventListener('beforeunload', e => {
  if (proxyDataInProgress() || settingsBusy() || syncInProgress() || hasUnsavedSync() ||
      content.querySelector<HTMLFormElement>('#settings-form')?.dataset.dirty === 'true') {
    e.preventDefault(); e.returnValue = '';
  }
});
