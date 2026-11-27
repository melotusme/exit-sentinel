// Application Shell & Workspace Router — Exit Sentinel
// Owns global chrome (196px sidebar rail, 52px sticky header, modals, toasts), Tauri event wiring,
// and mounts the 4 isolated feature workspaces (#panel-overview, #panel-records, #panel-diagnostics, #panel-settings).

import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';

import { enableLightDismiss, openModal } from './confirm';
import { initDiagnosticsPanel } from './diagnostics';
import { initIpDetailsModal } from './ip-details';
import { ListView, initListViews } from './list';
import { initOverviewPanel } from './overview';
import { initRecordsPanel } from './records';
import { initSearchSelects, refreshSearchSelects } from './select';
import { initSettingsPanel } from './settings-page';
import {
  clearStoreCaches,
  emitStoreChange,
  registerShellHandlers,
  resolveRouteTarget,
  setRouteState,
  setViewState,
  store,
  updateClaudeHeartbeat,
} from './store';
import type { IpRecord, PanelHandle, RouteSnapshot, SubTabItem, Tab, ThemePreference, View } from './types';
import { copyToClipboard, esc, icon, initToastListeners, showToast, time, titles, toast } from './ui';
import { initUpdates, revealUpdateUi } from './updater';

const PAGE_TITLES: Record<Tab, string> = {
  overview: '概览',
  records: '记录与历史',
  diagnostics: '网络工具',
  settings: '设置',
};

const WIFI_PERMISSION_MESSAGES: Record<string, string> = {
  requested: '已发起定位权限申请。允许后将显示 Wi-Fi 名称；应用不读取或保存位置坐标。',
  granted: '定位权限已开启，正在刷新 Wi-Fi 名称…',
  denied: '定位权限此前已被拒绝，已打开系统定位设置，请允许 Exit Sentinel。',
  services_off: '系统定位服务已关闭，请先开启定位服务总开关再授权 Exit Sentinel。',
  settings: '已打开系统定位设置，请允许桌面应用读取 Wi-Fi 名称。',
};

// --- Mount Static Shell DOM ---

document.querySelector('#app')!.innerHTML = `
  <a class="skip-link" href="#page-title">跳到主要内容</a>
  <aside class="app-sidebar">
    <div class="brand">
      <span class="brand-icon">${icon('shield')}</span>
      <div class="brand-text">
        <div class="brand-name">出口哨兵</div>
        <div class="brand-sub">Exit Sentinel</div>
      </div>
    </div>
    <nav class="primary-nav" aria-label="主导航">
      <a href="?mode=overview" data-tab="overview">
        ${icon('shield')}<span>概览</span>
        <span id="badge-overview" class="nav-badge" hidden></span>
      </a>
      <a href="?mode=records" data-tab="records">
        ${icon('book')}<span>记录与历史</span>
        <span id="badge-records" class="nav-badge">0</span>
      </a>
      <a href="?mode=diagnostics" data-tab="diagnostics">
        ${icon('terminal')}<span>网络工具</span>
        <span id="badge-diagnostics" class="nav-badge" hidden></span>
      </a>
      <a href="?mode=settings" data-tab="settings">
        ${icon('settings')}<span>设置</span>
        <span id="badge-settings" class="nav-badge safe" hidden>新版本</span>
      </a>
    </nav>
    <div class="sidebar-foot">
      <div class="theme-switcher" role="group" aria-label="界面主题">
        <button type="button" data-theme-pref="system" title="跟随系统深浅色">${icon('monitor')}<span>系统</span></button>
        <button type="button" data-theme-pref="light" title="浅色模式">${icon('sun')}<span>浅色</span></button>
        <button type="button" data-theme-pref="dark" title="深色模式">${icon('moon')}<span>深色</span></button>
      </div>
      <div class="sidebar-meta">
        <span>驻留托盘监控</span>
        <span id="app-version" class="version">v…</span>
      </div>
    </div>
  </aside>

  <main id="main-content" class="app-main">
    <header class="app-header">
      <div class="header-lead">
        <div class="header-title-group">
          <h1 id="page-title" tabindex="-1">概览</h1>
          <span id="top-status-pill" class="top-status-pill paused">等待检测</span>
        </div>
        <div id="header-subtabs" class="header-subtabs" role="tablist" hidden></div>
      </div>
      <div class="header-actions">
        <button id="ip-lookup" type="button" title="查询任意公网 IPv4 / IPv6 归属与网络信息">
          ${icon('globe')}<span>IP 查询</span>
        </button>
        <button id="toggle-pause" type="button" title="暂停或恢复后台自动检测">
          ${icon('pause')}<span>暂停</span>
        </button>
        <button id="check" class="primary" type="button" title="立即检测出口 IP、节点与连通性">
          ${icon('refresh')}<span>立即检测</span>
        </button>
      </div>
    </header>

    <div class="workspace-banners">
      <div id="pause-banner" class="pause-banner" role="status" hidden>
        <span class="pause-banner-lead">
          ${icon('pause')}
          <span><strong>监控已暂停</strong> · 暂停期间不会轮询出口或写入新变化记录</span>
        </span>
        <button type="button" id="resume" class="primary">恢复监控</button>
      </div>
      <div id="software-update" role="status" aria-live="polite" hidden></div>
    </div>

    <div id="panel-overview" class="workspace-panel" data-panel="overview"></div>
    <div id="panel-records" class="workspace-panel" data-panel="records" hidden></div>
    <div id="panel-diagnostics" class="workspace-panel" data-panel="diagnostics" hidden></div>
    <div id="panel-settings" class="workspace-panel" data-panel="settings" hidden></div>
  </main>

  <dialog id="details" class="app-dialog ip-dialog" closedby="any" aria-label="IP 归属与网络详情">
    <div id="detail-content"></div>
  </dialog>
  <dialog id="route-details" class="app-dialog route-dialog" closedby="any" aria-label="关联的节点记录">
    <div id="route-content"></div>
  </dialog>
  <div id="toast-region" class="toast-region" role="status" aria-live="polite"></div>
  <div id="alert-region" class="alert-region" role="alert" hidden></div>
`;

// --- Element Handles ---

const panelElements: Record<Tab, HTMLElement> = {
  overview: document.querySelector<HTMLElement>('#panel-overview')!,
  records: document.querySelector<HTMLElement>('#panel-records')!,
  diagnostics: document.querySelector<HTMLElement>('#panel-diagnostics')!,
  settings: document.querySelector<HTMLElement>('#panel-settings')!,
};

const ipDialog = document.querySelector<HTMLDialogElement>('#details')!;
const routeDialog = document.querySelector<HTMLDialogElement>('#route-details')!;

let deferredRender = false;
let renderPending = false;

enableLightDismiss(routeDialog, () => {
  if (deferredRender) {
    deferredRender = false;
    renderActiveWorkspace();
  }
});

const ipModal = initIpDetailsModal(ipDialog, store, () => {
  if (deferredRender) {
    deferredRender = false;
    renderActiveWorkspace();
  }
});

// --- Initialize Isolated Workspace Controllers ---

const panels: Record<Tab, PanelHandle> = {
  overview: initOverviewPanel(panelElements.overview, store),
  records: initRecordsPanel(panelElements.records, store),
  diagnostics: initDiagnosticsPanel(panelElements.diagnostics, store),
  settings: initSettingsPanel(panelElements.settings, store),
};

const shellRouteList = new ListView<RouteSnapshot>(
  'ip-routes',
  {
    last_seen: { label: '最近观测', value: r => r.last_seen },
    first_seen: { label: '首次观测', value: r => r.first_seen },
    node_name: { label: '节点名称', value: r => r.node_name },
    config: { label: '配置名称', value: r => r.config },
  },
  r => `${r.config} ${r.chain.join(' ')} ${r.node_name} ${r.node_host}`,
  r => (r.consistent && !r.error && r.node_name ? 'configured' : 'unknown'),
  { configured: '已识别节点', unknown: '节点未确认' }
);

function renderShellRouteRow(r: RouteSnapshot): string {
  const summary =
    r.error && !r.node_name
      ? `<div class="route-snapshot"><strong>节点未确认</strong><p class="small muted">${esc(r.error)}</p></div>`
      : `<div class="route-snapshot">
          <div class="snapshot-header"><strong>${esc(r.node_name || '未确认')}</strong>${r.mode ? `<span class="pill">${esc(r.mode)}</span>` : ''}</div>
          <p class="small mono muted">${esc([r.config, ...r.chain].filter(Boolean).join(' → '))}</p>
          ${r.node_host ? `<small>${esc(r.node_host)}${r.subscription ? ` · ${esc(r.subscription)}` : ''}</small>` : ''}
          ${r.error ? `<p class="warning">${esc(r.error)}</p>` : ''}
        </div>`;
  return `<article class="route-history-row">
    ${summary}
    <div class="route-history-meta">
      <small>${esc(r.basis)}</small>
      <small class="tabular">首次关联：${time(r.first_seen)} · 最近关联：${time(r.last_seen)}</small>
    </div>
  </article>`;
}

function openRouteModal(record: IpRecord, trigger?: HTMLElement) {
  const routes = record.routes || [];
  document.querySelector('#route-content')!.innerHTML = `
    <div class="dialog-head">
      <div>
        <h2>${esc(record.service === 'claude' ? 'Claude' : 'Gemini')} · <span class="mono">${esc(record.ip)}</span></h2>
      </div>
      <button type="button" id="close-routes">关闭</button>
    </div>
    <p class="muted small">该出口 IP 观测期间匹配到的代理节点与分流规则快照。</p>
    ${shellRouteList.render(routes, renderShellRouteRow)}`;
  openModal(routeDialog, trigger);
}

// --- Shell Chrome & Panel Rendering ---

function paintSubTabs(tab: Tab, activeSub: string, items: SubTabItem[]) {
  const host = document.querySelector<HTMLElement>('#header-subtabs')!;
  if (!items.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  host.setAttribute('aria-label', `${PAGE_TITLES[tab]}分区`);
  host.innerHTML = items
    .map(item => {
      const selected = item.id === activeSub;
      const showBadge = item.badge !== undefined && item.badge !== null && item.badge !== '';
      const toneClass = item.tone && item.tone !== 'neutral' ? ` ${item.tone}` : '';
      return `<button type="button" role="tab" data-subtab="${esc(item.id)}" aria-selected="${selected}" class="${selected ? 'active' : ''}">
        <span>${esc(item.label)}</span>
        ${showBadge ? `<span class="nav-badge${toneClass}">${esc(item.badge)}</span>` : ''}
      </button>`;
    })
    .join('');
}

function paintChrome() {
  const { tab, sub } = store.getRoute();
  const v = store.getState();
  const pref = store.getThemePreference();
  const upd = store.getUpdateState();

  document.querySelectorAll<HTMLAnchorElement>('.primary-nav a[data-tab]').forEach(link => {
    const selected = link.dataset.tab === tab;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-theme-pref]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.themePref === pref));
  });

  const titleEl = document.querySelector<HTMLElement>('#page-title')!;
  titleEl.textContent = PAGE_TITLES[tab];

  for (const key of Object.keys(panelElements) as Tab[]) {
    panelElements[key].hidden = key !== tab;
  }

  const subItems = panels[tab].getSubTabs?.(v, sub) || [];
  paintSubTabs(tab, sub, subItems);

  // Settings update badge
  const settingsBadge = document.querySelector<HTMLElement>('#badge-settings')!;
  settingsBadge.hidden = !(upd?.phase === 'available' || upd?.phase === 'ready_deferred');

  if (!v) return;

  // Header status pill
  const topPill = document.querySelector<HTMLElement>('#top-status-pill')!;
  topPill.className = `top-status-pill ${v.status}`;
  topPill.textContent = titles[v.status] || v.status;

  // Header pause & check buttons
  const pauseBtn = document.querySelector<HTMLButtonElement>('#toggle-pause')!;
  pauseBtn.classList.toggle('primary', v.paused);
  pauseBtn.innerHTML = v.paused
    ? `${icon('play')}<span>恢复监控</span>`
    : `${icon('pause')}<span>暂停</span>`;

  const checkBtn = document.querySelector<HTMLButtonElement>('#check')!;
  checkBtn.disabled = v.checking || v.paused;
  checkBtn.classList.toggle('is-spinning', v.checking);
  checkBtn.innerHTML = `${icon('refresh')}<span>${v.checking ? '检测中…' : '立即检测'}</span>`;

  // Pause banner (compact; hidden on records:data where proxy-data shows its own notice)
  const pauseBanner = document.querySelector<HTMLElement>('#pause-banner')!;
  pauseBanner.hidden = !v.paused || (tab === 'records' && sub === 'data');

  // Sidebar live badges
  const worst = v.verdicts.some(x => x.level === 'risk')
    ? 'risk'
    : v.verdicts.some(x => x.level === 'warn') || v.unacknowledged
      ? 'warn'
      : '';
  const overviewBadge = document.querySelector<HTMLElement>('#badge-overview')!;
  overviewBadge.hidden = !worst;
  overviewBadge.className = `nav-badge ${worst}`;
  overviewBadge.textContent =
    worst === 'risk'
      ? '风险'
      : v.unacknowledged && v.pending_changes?.length
        ? `${v.pending_changes.length} 变`
        : '待确认';

  const recordsBadge = document.querySelector<HTMLElement>('#badge-records')!;
  recordsBadge.textContent = String(v.claude_ips.length + v.ai_nodes.length);
}

function isEditingInActivePanel(): boolean {
  const { tab } = store.getRoute();
  const activePanel = panelElements[tab];
  const focused = document.activeElement;
  return Boolean(
    focused &&
      activePanel.contains(focused) &&
      focused.matches('input:not([type="checkbox"]):not([type="radio"]), select, textarea')
  );
}

function canBackgroundRender(): boolean {
  const { tab, sub } = store.getRoute();
  if (document.querySelector('dialog[open]')) return false;
  if (isEditingInActivePanel()) return false;
  // Self-managed interactive forms/views preserve their own DOM during background state ticks
  if (tab === 'settings') return false;
  if (tab === 'diagnostics' && sub === 'curl') return false;
  return true;
}

function renderActiveWorkspace(preserveFocus = true) {
  paintChrome();
  const { tab, sub } = store.getRoute();
  const activePanel = panelElements[tab];
  const v = store.getState();

  const focused =
    preserveFocus && document.activeElement instanceof HTMLButtonElement && activePanel.contains(document.activeElement)
      ? document.activeElement
      : null;
  const savedId = focused?.id;
  const savedData = focused ? Object.entries(focused.dataset) : [];
  const savedText = focused?.textContent;

  panels[tab].render(v, sub);
  refreshSearchSelects(activePanel);

  if (focused) {
    const replacement = savedId
      ? document.getElementById(savedId)
      : Array.from(activePanel.querySelectorAll('button')).find(
          c =>
            savedData.length > 0 &&
            savedData.every(([k, val]) => c.dataset[k] === val) &&
            c.textContent === savedText
        );
    replacement?.focus({ preventScroll: true });
  }
}

async function navigateTo(target: Tab | string, explicitSub?: string, payload?: unknown): Promise<boolean> {
  const [nextTab, mappedSub] = resolveRouteTarget(String(target), explicitSub);
  const current = store.getRoute();
  const nextSub = mappedSub || store.getRoute().allSubs[nextTab];

  if (nextTab === current.tab && nextSub === current.sub && payload === undefined) {
    return true;
  }

  const allowed = await panels[current.tab].canLeave?.(nextTab, nextSub);
  if (allowed === false) return false;

  const tabChanged = nextTab !== current.tab;
  setRouteState(nextTab, nextSub, payload);

  const url = new URL(location.href);
  url.searchParams.set('mode', nextTab);
  history.replaceState(null, '', url);

  renderActiveWorkspace(false);
  if (tabChanged) {
    window.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>('#page-title')?.focus({ preventScroll: true });
    panels[nextTab].onActivate?.(store.getRoute().sub);
  }
  if (payload !== undefined) {
    const consumed = store.consumeNavPayload();
    panels[nextTab].onNavigatePayload?.(store.getRoute().sub, consumed);
  }
  emitStoreChange();
  return true;
}

registerShellHandlers({
  navigate: navigateTo,
  openIpModal: async (ip, opts) => {
    if (ip) await ipModal.openIp(ip, opts?.force, opts?.trigger);
    else ipModal.openLookup(opts?.trigger);
  },
  openProbeModal: async (probeId, opts) => {
    await ipModal.openProbe(probeId, opts?.force, opts?.trigger);
  },
  openRouteModal,
  onGeoUpdated: () => {
    const { tab } = store.getRoute();
    if (tab === 'overview' || tab === 'records') {
      if (document.querySelector('dialog[open]')) deferredRender = true;
      else if (!isEditingInActivePanel()) renderActiveWorkspace(true);
    }
    emitStoreChange();
  },
});

store.subscribe(() => {
  paintChrome();
});

// --- View Signature & Reactive State Ingestion ---

function viewSignature(v: View | undefined): string {
  return v ? JSON.stringify({ ...v, claude: { ...v.claude, checked: '' } }) : '';
}

function ingestView(v: View) {
  const prev = store.getState();
  const initial = !prev;
  const changed = viewSignature(prev) !== viewSignature(v);
  setViewState(v);
  void store.syncGeography(false);

  if (changed && document.querySelector('dialog[open]')) {
    deferredRender = true;
  }
  if (changed) {
    renderPending = true;
  }

  if (initial || (renderPending && canBackgroundRender())) {
    renderPending = false;
    renderActiveWorkspace(true);
  } else {
    paintChrome();
  }
  emitStoreChange();
}

function flushPendingRender() {
  if (!renderPending || !canBackgroundRender()) return;
  renderPending = false;
  renderActiveWorkspace(true);
}

// Refresh relative evidence timestamps ("3 分钟前") once per minute on Overview
setInterval(() => {
  if (store.getRoute().tab === 'overview' && store.getState() && canBackgroundRender()) {
    renderActiveWorkspace(true);
  }
}, 60_000);

// --- Global Declarative Event Delegation ---

document.addEventListener('click', async event => {
  const navLink = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-tab]');
  if (navLink) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    await store.navigate(navLink.dataset.tab!, navLink.dataset.subtab);
    return;
  }

  const b = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (!b || b.disabled) return;

  try {
    if (b.dataset.themePref) {
      store.setThemePreference(b.dataset.themePref as ThemePreference);
      return;
    }
    if (b.dataset.tab) {
      await store.navigate(b.dataset.tab, b.dataset.subtab);
      return;
    }
    if (b.dataset.subtab) {
      await store.navigate(store.getRoute().tab, b.dataset.subtab);
      return;
    }
    if (b.dataset.settingsSection) {
      await store.navigate('settings', b.dataset.settingsSection, { scrollTo: b.dataset.settingsSection });
      return;
    }
    if (b.dataset.copyText !== undefined && b.dataset.copyText !== '') {
      const ok = await copyToClipboard(b.dataset.copyText);
      showToast(ok ? `已复制：${b.dataset.copyText}` : '复制失败，请手动选中复制');
      return;
    }
    if (b.dataset.copyService) {
      await store.copyAiRoute(b.dataset.copyService, b.dataset.copyIp || null);
      showToast('配置、策略链和节点信息已复制');
      return;
    }
    if (b.dataset.url) {
      await openUrl(b.dataset.url);
      return;
    }
    if (b.dataset.ipModal) {
      await store.openIpModal(b.dataset.ipModal, { trigger: b });
      return;
    }
    if (b.dataset.detail) {
      await store.openProbeModal(b.dataset.detail, { trigger: b });
      return;
    }
    if (b.dataset.routeIp && b.dataset.routeService) {
      const rec = store
        .getState()
        ?.claude_ips.find(r => r.ip === b.dataset.routeIp && r.service === b.dataset.routeService);
      if (rec) store.openRouteModal(rec, b);
      return;
    }
    if (b.dataset.markIp && b.dataset.service && b.dataset.status) {
      await store.markAiIp({
        service: b.dataset.service,
        ip: b.dataset.markIp,
        status: b.dataset.status,
        attachCurrent: b.dataset.attachCurrent === 'true',
      });
      return;
    }
    if (b.dataset.markNode && b.dataset.service && b.dataset.status) {
      await store.markAiNode({
        service: b.dataset.service,
        key: b.dataset.markNode,
        status: b.dataset.status,
        current: b.dataset.markCurrent !== 'false',
      });
      return;
    }
    if (b.dataset.deleteIp && b.dataset.service) {
      await store.deleteClaudeIp(b.dataset.service, b.dataset.deleteIp);
      return;
    }
    if (b.dataset.deleteNode && b.dataset.service) {
      await store.deleteAiNode(b.dataset.service, b.dataset.deleteNode);
      return;
    }
    if (b.dataset.testService) {
      const svc = b.dataset.testService === 'all' ? null : (b.dataset.testService as 'claude' | 'gemini');
      await store.testAiServices(svc);
      showToast(svc ? `${svc === 'claude' ? 'Claude' : 'Gemini'} 深入测试完成` : 'Claude 与 Gemini 测试完成');
      return;
    }

    switch (b.id) {
      case 'ip-lookup':
        await store.openIpModal(null, { trigger: b });
        break;
      case 'check':
      case 'retry-network':
        await store.checkNow();
        break;
      case 'toggle-pause':
      case 'pause':
        await store.setPaused(!store.getState()?.paused);
        break;
      case 'resume':
        await store.setPaused(false);
        break;
      case 'ack':
        await store.acknowledgeChanges();
        break;
      case 'test-ai':
        await store.testAiServices(null);
        showToast('Claude 与 Gemini 测试完成，结果已更新');
        break;
      case 'wifi-name-permission': {
        const res = await invoke<string>('request_wifi_name');
        showToast(WIFI_PERMISSION_MESSAGES[res] || WIFI_PERMISSION_MESSAGES.granted, {
          persistent: res === 'denied' || res === 'services_off',
        });
        break;
      }
      case 'location-settings':
        await invoke('open_location_settings');
        showToast('已打开系统定位设置，请允许 Exit Sentinel 读取 Wi-Fi 名称。');
        break;
      case 'close-routes':
        routeDialog.close();
        break;
    }
  } catch (e) {
    showToast(String(e), { persistent: true, tone: 'risk' });
  }
});

// --- Boot & Wire All Tauri Events ---

async function boot() {
  initToastListeners();
  initListViews();
  initSearchSelects();

  document.addEventListener('search-select-closed', () => {
    if (!document.querySelector('dialog[open]') && (deferredRender || renderPending)) {
      deferredRender = false;
      renderPending = false;
      renderActiveWorkspace(true);
    }
  });

  document.querySelector('#main-content')?.addEventListener('focusout', () => {
    setTimeout(flushPendingRender, 0);
  });

  window.addEventListener('focus', () => {
    const { tab, sub } = store.getRoute();
    panels[tab].onActivate?.(sub);
  });

  try {
    await listen<string>('monitor-data-cleared', e => {
      clearStoreCaches(e.payload);
      for (const k of Object.keys(panels) as Tab[]) {
        panels[k].onDataCleared?.(e.payload);
      }
      renderActiveWorkspace(false);
    });

    await listen('geography-updated', () => {
      void store.syncGeography(true);
    });

    await listen('open-data-settings', () => {
      void store.navigate('records', 'data');
    });

    await listen('open-diagnostics', () => {
      void store.navigate('diagnostics', 'curl');
    });

    await listen('open-update-settings', async () => {
      await store.navigate('settings', 'update-settings');
      revealUpdateUi();
    });

    await listen<Pick<IpRecord, 'service' | 'ip' | 'status' | 'note'>>('open-ai-ip', e => {
      void store.navigate('records', 'ips', e.payload);
    });

    await listen('open-ai-monitor', () => {
      void store.navigate('overview');
    });

    await listen<string>('open-ip-detail', e => {
      void store.openProbeModal(e.payload);
    });

    await listen<string>('ai-status-saved', e => {
      showToast(e.payload);
    });

    await listen<string>('clipboard-error', e => {
      showToast(`剪贴板操作失败：${e.payload}`, { persistent: true, tone: 'risk' });
    });

    await listen<boolean | null>('autostart-changed', e => {
      for (const k of Object.keys(panels) as Tab[]) {
        panels[k].onAutostartChanged?.(e.payload);
      }
    });

    await listen<string>('autostart-error', e => {
      showToast(`开机自启设置失败：${e.payload}`, { persistent: true, tone: 'risk' });
    });

    await listen<string>('claude-checked', e => {
      updateClaudeHeartbeat(e.payload);
    });

    await listen<View>('monitor-state', e => {
      ingestView(e.payload);
    });

    await initUpdates(toast);

    getVersion()
      .then(v => {
        const el = document.querySelector('#app-version');
        if (el) el.textContent = `v${v}`;
      })
      .catch(() => {});

    const initial = await invoke<View>('get_state');
    ingestView(initial);
    panels[store.getRoute().tab].onActivate?.(store.getRoute().sub);
  } catch (e) {
    paintChrome();
    panelElements.overview.hidden = false;
    panelElements.overview.innerHTML = `
      <section class="panel empty">
        <div class="empty-icon">${icon('shield')}</div>
        <strong>需要在桌面应用中运行</strong>
        <p>请通过 Tauri 启动出口哨兵客户端；独立浏览器环境无法访问本机网络监测后台。</p>
        <p class="mono small muted">${esc(String(e))}</p>
      </section>`;
  }
}

void boot();

window.addEventListener('beforeunload', e => {
  const busy = (Object.keys(panels) as Tab[]).some(k => panels[k].hasUnsavedWork?.());
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
