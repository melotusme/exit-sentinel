// 4-Section Settings Workspace:
// 1. `monitor-settings` (常规与监控)
// 2. `routing-settings` (代理与分流)
// 3. `webdav-settings`  (云同步)
// 4. `update-settings`  (更新与关于)

import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { confirmAction } from './confirm';
import { renderGuide } from './guide';
import type { AppShellApi } from './store';
import { discardUnsavedSync, hasUnsavedSync, loadSync, syncInProgress, syncSettings } from './sync';
import type { PanelHandle, Probe, Settings, SettingsSubTab } from './types';
import { esc, icon } from './ui';
import { getUpdatePreferences, refreshUpdateStatus, updateSettings } from './updater';

interface IgnorableItem {
  id: string;
  title: string;
  host: string;
}

const SITE_CHECKS: IgnorableItem[] = [
  { id: 'site:google', title: 'Google', host: 'www.google.com' },
  { id: 'site:claude', title: 'Claude', host: 'claude.ai' },
  { id: 'site:gemini', title: 'Gemini', host: 'gemini.google.com' },
  { id: 'site:antigravity', title: 'Antigravity', host: 'antigravity.google' },
];

const PROBE_CHECKS: IgnorableItem[] = [
  { id: 'probe:cn-ipip', title: '国内 · IPIP', host: 'myip.ipip.net' },
  { id: 'probe:cn-3322', title: '国内 · 3322', host: 'ip.3322.net' },
  { id: 'probe:global-cf', title: '国外 · Cloudflare', host: 'cloudflare.com/cdn-cgi/trace' },
  { id: 'probe:global-ipify', title: '国外 · ipify', host: 'api.ipify.org' },
  { id: 'probe:cn-v6', title: '国内 · IPv6', host: '6.ipw.cn' },
  { id: 'probe:global-v6', title: '国外 · IPv6', host: 'api6.ipify.org' },
];

const ALL_IGNORABLE_IDS: string[] = [...SITE_CHECKS, ...PROBE_CHECKS].map(item => item.id);

const DEFAULT_PROBES: Array<{ id: string; label: string; group: string; url: string }> = [
  { id: 'cn-ipip', label: '国内 · IPIP', group: '国内 IPv4', url: 'https://myip.ipip.net' },
  { id: 'cn-3322', label: '国内 · 3322', group: '国内 IPv4', url: 'https://ip.3322.net' },
  { id: 'global-cf', label: '国外 · Cloudflare', group: '国外 IPv4', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { id: 'global-ipify', label: '国外 · ipify', group: '国外 IPv4', url: 'https://api.ipify.org?format=json' },
  { id: 'cn-v6', label: '国内 · IPv6', group: '国内 IPv6', url: 'https://6.ipw.cn' },
  { id: 'global-v6', label: '国外 · IPv6', group: '国外 IPv6', url: 'https://api6.ipify.org?format=json' },
];

const FOREIGN_PROXY_PRESETS: Array<{ label: string; value: string }> = [
  { label: '跟随系统 / TUN', value: '' },
  { label: 'Clash 127.0.0.1:7890', value: 'http://127.0.0.1:7890' },
  { label: 'Shadowrocket 127.0.0.1:1082', value: 'socks5h://127.0.0.1:1082' },
  { label: 'v2rayN 127.0.0.1:10808', value: 'socks5h://127.0.0.1:10808' },
  { label: '直连不使用代理', value: 'direct' },
];

const DOMESTIC_PROXY_PRESETS: Array<{ label: string; value: string }> = [
  { label: '跟随系统 / TUN', value: '' },
  { label: '直连不使用代理', value: 'direct' },
  { label: 'Clash 127.0.0.1:7890', value: 'http://127.0.0.1:7890' },
  { label: 'Shadowrocket 127.0.0.1:1082', value: 'socks5h://127.0.0.1:1082' },
  { label: 'v2rayN 127.0.0.1:10808', value: 'socks5h://127.0.0.1:10808' },
];

const INTERVAL_PRESETS = [15, 30, 60, 120] as const;

const VALID_SUBTABS: SettingsSubTab[] = [
  'monitor-settings',
  'routing-settings',
  'webdav-settings',
  'update-settings',
];

function normalizeSubTab(sub: string): SettingsSubTab {
  if (VALID_SUBTABS.includes(sub as SettingsSubTab)) {
    return sub as SettingsSubTab;
  }
  return 'monitor-settings';
}

function comparableSettings(s: Settings) {
  return {
    manual_nodes_only: Boolean(s.manual_nodes_only),
    interval: Number(s.interval),
    claude_proxy: (s.claude_proxy || '').trim(),
    gemini_proxy: (s.gemini_proxy || '').trim(),
    gemini_ip_url: (s.gemini_ip_url || '').trim(),
    notifications: Boolean(s.notifications),
    retain_history: Boolean(s.retain_history),
    ipv6: Boolean(s.ipv6),
    ipv6_required: Boolean(s.ipv6_required),
    domestic_proxy: (s.domestic_proxy || '').trim(),
    foreign_proxy: (s.foreign_proxy || '').trim(),
    ignored_checks: ALL_IGNORABLE_IDS.filter(id => (s.ignored_checks || []).includes(id)),
  };
}

function renderCheckItem(item: IgnorableItem, ignored: Set<string>): string {
  const checked = ignored.has(item.id);
  return `<label class="ignore-check-card${checked ? ' is-ignored' : ''}">
    <input type="checkbox" name="ignored_checks" value="${esc(item.id)}" ${checked ? 'checked' : ''}>
    <span class="ignore-check-main">
      <span class="ignore-check-title">${esc(item.title)}</span>
      <span class="ignore-check-host mono">${esc(item.host)}</span>
    </span>
    <span class="ignore-check-badge">${checked ? '已忽略' : '计入'}</span>
  </label>`;
}

function renderPresetChips(
  targetField: 'foreign_proxy' | 'domestic_proxy',
  currentValue: string,
  presets: Array<{ label: string; value: string }>
): string {
  const trimmed = currentValue.trim();
  return `<div class="preset-chips" role="group" aria-label="${targetField === 'foreign_proxy' ? '国外代理常用预设' : '国内代理常用预设'}">
    ${presets
      .map(preset => {
        const active = trimmed === preset.value;
        return `<button type="button" class="preset-chip${active ? ' is-active' : ''}" data-proxy-target="${targetField}" data-proxy-preset="${esc(preset.value)}" aria-pressed="${active}">
          ${esc(preset.label)}
        </button>`;
      })
      .join('')}
  </div>`;
}

function groupLabelForProbe(group: string): string {
  if (group === 'domestic') return '国内 IPv4';
  if (group === 'foreign') return '国外 IPv4';
  if (group === 'domestic6') return '国内 IPv6';
  if (group === 'foreign6') return '国外 IPv6';
  return group;
}

function renderProbeEndpoints(probes: Probe[] | undefined): string {
  const items =
    probes && probes.length
      ? probes.map(p => ({
          id: p.id,
          label: p.label,
          group: groupLabelForProbe(p.group),
          url: p.url,
        }))
      : DEFAULT_PROBES;

  return `<div class="probe-endpoints-grid">
    ${items
      .map(
        item => `<div class="probe-endpoint-item">
          <div class="probe-endpoint-head">
            <strong>${esc(item.label)}</strong>
            <span class="pill">${esc(item.group)}</span>
          </div>
          <div class="probe-endpoint-url-row">
            <code class="mono">${esc(item.url)}</code>
            <button type="button" class="ghost-btn compact" data-copy-text="${esc(item.url)}">复制</button>
          </div>
        </div>`
      )
      .join('')}
  </div>`;
}

export function initSettingsPanel(panel: HTMLElement, app: AppShellApi): PanelHandle {
  let mounted = false;
  let activeSection: SettingsSubTab = 'monitor-settings';
  let autostart: boolean | null = null;
  let autostartBusy = false;
  let settingsSaving = false;
  let ignoredDraft = new Set<string>();
  let ipv6RequiredDraft = false;
  let lastSyncedSignature = '';

  const showToast = (msg: string, persistent = false, tone: 'neutral' | 'safe' | 'warn' | 'risk' = 'neutral') => {
    app.showToast(msg, { persistent, tone: persistent ? 'risk' : tone });
  };

  async function ensureNotificationPermission(): Promise<boolean> {
    try {
      let ok = await isPermissionGranted();
      if (!ok) {
        ok = (await requestPermission()) === 'granted';
      }
      if (!ok) {
        showToast('系统尚未授予通知权限，请在操作系统通知设置中允许 Exit Sentinel。', false, 'warn');
      }
      return ok;
    } catch (e) {
      showToast(`检查通知权限失败：${String(e)}`, true, 'risk');
      return false;
    }
  }

  function readFormSettings(): Settings | null {
    const form = panel.querySelector<HTMLFormElement>('#settings-form');
    const base = app.getState()?.settings;
    if (!form || !base) return null;
    const f = new FormData(form);
    const updatePrefs = getUpdatePreferences();
    const rawInterval = Number(f.get('interval'));

    return {
      manual_nodes_only: f.get('manual_nodes_only') === 'true',
      claude_proxy: String(f.get('claude_proxy') || '').trim(),
      gemini_proxy: String(f.get('gemini_proxy') || '').trim(),
      gemini_ip_url: String(f.get('gemini_ip_url') || '').trim(),
      interval: Number.isFinite(rawInterval) ? rawInterval : base.interval,
      notifications: f.has('notifications'),
      retain_history: f.has('retain_history'),
      ipv6: base.ipv6,
      ipv6_required: ipv6RequiredDraft,
      domestic_proxy: String(f.get('domestic_proxy') || '').trim(),
      foreign_proxy: String(f.get('foreign_proxy') || '').trim(),
      ignored_checks: ALL_IGNORABLE_IDS.filter(id => ignoredDraft.has(id)),
      auto_update_check: updatePrefs?.auto_update_check ?? base.auto_update_check ?? true,
      auto_update_install: updatePrefs?.auto_update_install ?? base.auto_update_install ?? true,
    };
  }

  function isSettingsDirty(): boolean {
    const saved = app.getState()?.settings;
    const draft = readFormSettings();
    if (!saved || !draft) return false;
    return JSON.stringify(comparableSettings(saved)) !== JSON.stringify(comparableSettings(draft));
  }

  function paintDraftState() {
    const dirty = isSettingsDirty();
    const form = panel.querySelector<HTMLFormElement>('#settings-form');
    if (form) form.dataset.dirty = String(dirty);

    const bar = panel.querySelector<HTMLElement>('#settings-draft-bar');
    if (bar) {
      bar.hidden = !dirty;
    }

    const inlineState = panel.querySelector<HTMLElement>('#settings-inline-dirty-hint');
    if (inlineState) {
      inlineState.textContent = dirty
        ? '当前有未保存的监控与代理修改'
        : '所有监控与分流设置已与本机配置同步';
      inlineState.classList.toggle('is-dirty', dirty);
    }
  }

  function paintIgnoredSummaryAndV6Switches() {
    const count = ignoredDraft.size;
    const pill = panel.querySelector<HTMLElement>('#ignored-count-pill');
    if (pill) {
      pill.textContent = `已忽略 ${count} / ${ALL_IGNORABLE_IDS.length} 项`;
      pill.className = count > 0 ? 'pill warn tabular' : 'pill tabular';
    }
    const clearBtn = panel.querySelector<HTMLButtonElement>('#clear-ignored-checks');
    if (clearBtn) {
      clearBtn.hidden = count === 0;
    }

    // Sync checkboxes in the 2-column grid
    panel.querySelectorAll<HTMLInputElement>('input[name="ignored_checks"]').forEach(box => {
      const checked = ignoredDraft.has(box.value);
      box.checked = checked;
      const card = box.closest('.ignore-check-card');
      card?.classList.toggle('is-ignored', checked);
      const badge = card?.querySelector('.ignore-check-badge');
      if (badge) badge.textContent = checked ? '已忽略' : '计入';
    });

    // Sync directional IPv6 requirement switches
    const cnV6Switch = panel.querySelector<HTMLInputElement>('#require-cn-v6');
    const globalV6Switch = panel.querySelector<HTMLInputElement>('#require-global-v6');
    if (cnV6Switch) {
      cnV6Switch.checked = ipv6RequiredDraft && !ignoredDraft.has('probe:cn-v6');
    }
    if (globalV6Switch) {
      globalV6Switch.checked = ipv6RequiredDraft && !ignoredDraft.has('probe:global-v6');
    }
  }

  function paintProxyAndIntervalChips() {
    const form = panel.querySelector<HTMLFormElement>('#settings-form');
    if (!form) return;

    const intervalVal = Number(form.querySelector<HTMLInputElement>('[name="interval"]')?.value || 0);
    form.querySelectorAll<HTMLButtonElement>('[data-interval-preset]').forEach(chip => {
      const active = Number(chip.dataset.intervalPreset) === intervalVal;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });

    for (const target of ['foreign_proxy', 'domestic_proxy'] as const) {
      const val = form.querySelector<HTMLInputElement>(`[name="${target}"]`)?.value.trim() ?? '';
      form.querySelectorAll<HTMLButtonElement>(`[data-proxy-target="${target}"]`).forEach(chip => {
        const active = (chip.dataset.proxyPreset ?? '') === val;
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-pressed', String(active));
      });
    }
  }

  function populateFormFromSettings(s: Settings) {
    const form = panel.querySelector<HTMLFormElement>('#settings-form');
    if (!form) return;

    const setInput = (name: string, val: string) => {
      const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
      if (el) el.value = val;
    };
    const setCheck = (name: string, checked: boolean) => {
      const el = form.querySelector<HTMLInputElement>(`[name="${name}"]`);
      if (el) el.checked = checked;
    };

    setInput('interval', String(s.interval));
    setCheck('notifications', Boolean(s.notifications));
    setCheck('retain_history', Boolean(s.retain_history));
    setInput('foreign_proxy', s.foreign_proxy || '');
    setInput('domestic_proxy', s.domestic_proxy || '');
    setInput('manual_nodes_only', String(Boolean(s.manual_nodes_only)));
    setInput('claude_proxy', s.claude_proxy || '');
    setInput('gemini_proxy', s.gemini_proxy || '');
    setInput('gemini_ip_url', s.gemini_ip_url || '');

    ipv6RequiredDraft = Boolean(s.ipv6_required);
    ignoredDraft = new Set(s.ignored_checks || []);
    lastSyncedSignature = JSON.stringify(comparableSettings(s));

    paintIgnoredSummaryAndV6Switches();
    paintProxyAndIntervalChips();
    paintDraftState();
  }

  function paintAutostart(customMessage?: string) {
    const input = panel.querySelector<HTMLInputElement>('#setting-autostart');
    if (input) {
      input.checked = autostart === true;
      input.disabled = autostart === null || autostartBusy;
      input.setAttribute('aria-busy', String(autostartBusy));
    }
    const pill = panel.querySelector<HTMLElement>('#autostart-pill');
    if (pill) {
      if (autostart === null) {
        pill.className = 'pill';
        pill.textContent = '读取中';
      } else if (autostart) {
        pill.className = 'pill ok';
        pill.textContent = '已开启';
      } else {
        pill.className = 'pill';
        pill.textContent = '未开启';
      }
    }
    const note = panel.querySelector<HTMLElement>('#autostart-status');
    if (note) {
      note.textContent =
        customMessage ||
        (autostartBusy
          ? '正在同步操作系统启动项…'
          : autostart === null
            ? '暂无法读取系统开机启动项状态，切换页面后将自动重试。'
            : '登录系统后自动在托盘后台运行监控，切换后立即生效。');
    }
  }

  async function syncAutostart() {
    if (autostartBusy) return;
    try {
      autostart = await invoke<boolean>('get_autostart');
      paintAutostart();
    } catch (e) {
      autostart = null;
      paintAutostart(`读取开机自启状态失败：${String(e)}`);
    }
  }

  async function refreshPermissions() {
    const wifiBadge = panel.querySelector<HTMLElement>('#wifi-permission-badge');
    const wifiText = panel.querySelector<HTMLElement>('#wifi-permission-status');
    const wifiActions = panel.querySelector<HTMLElement>('#wifi-permission-actions');
    const notifyBadge = panel.querySelector<HTMLElement>('#notification-permission-badge');
    const notifyText = panel.querySelector<HTMLElement>('#notification-permission-status');
    const reqNotifyBtn = panel.querySelector<HTMLButtonElement>('#request-notifications');

    if (!wifiText || !notifyText) return;

    await Promise.all([
      invoke<string>('wifi_permission_status')
        .then(status => {
          if (status === 'not_required') {
            if (wifiBadge) {
              wifiBadge.className = 'pill ok';
              wifiBadge.textContent = '当前系统可直接读取网卡与 Wi-Fi 名称';
            }
            wifiText.textContent = '无需申请额外定位权限，物理链路与当前 Wi-Fi 名称由系统网络接口直接提供。';
            if (wifiActions) wifiActions.hidden = true;
            return;
          }

          if (wifiActions) wifiActions.hidden = false;
          const meta: Record<string, { pill: string; cls: string; desc: string }> = {
            granted: {
              pill: '已授权',
              cls: 'pill ok',
              desc: '已允许读取当前连接的 Wi-Fi 名称；应用仅读取 SSID，不获取或存储地理位置坐标。',
            },
            not_determined: {
              pill: '待申请授权',
              cls: 'pill warn',
              desc: 'macOS 需要定位权限才能读取 Wi-Fi 名称；未授权不影响公网出口 IP 检测。',
            },
            denied: {
              pill: '已在系统中拒绝',
              cls: 'pill warn',
              desc: '请在系统定位隐私设置中允许 Exit Sentinel，以便区分不同 Wi-Fi 网络下的出口变化。',
            },
            restricted: {
              pill: '受策略限制',
              cls: 'pill warn',
              desc: '当前受系统屏幕使用时间或设备管理策略限制，无法读取 Wi-Fi 名称。',
            },
            services_off: {
              pill: '系统定位已关闭',
              cls: 'pill warn',
              desc: '请先在系统设置中开启定位服务总开关，再允许 Exit Sentinel。',
            },
            settings: {
              pill: '需检查系统设置',
              cls: 'pill warn',
              desc: '请在系统定位设置中确认已开启定位服务及桌面应用读取权限。',
            },
          };
          const picked = meta[status] || {
            pill: status,
            cls: 'pill',
            desc: '请在系统隐私设置中检查定位授权状态。',
          };
          if (wifiBadge) {
            wifiBadge.className = picked.cls;
            wifiBadge.textContent = picked.pill;
          }
          wifiText.textContent = picked.desc;
          const requestBtn = panel.querySelector<HTMLButtonElement>('#wifi-name-permission');
          if (requestBtn) requestBtn.hidden = status === 'granted';
        })
        .catch(err => {
          if (wifiBadge) {
            wifiBadge.className = 'pill risk';
            wifiBadge.textContent = '读取失败';
          }
          wifiText.textContent = `无法读取权限状态：${String(err)}`;
        }),

      isPermissionGranted()
        .then(granted => {
          if (notifyBadge) {
            notifyBadge.className = granted ? 'pill ok' : 'pill warn';
            notifyBadge.textContent = granted ? '已允许通知' : '尚未授权';
          }
          notifyText.textContent = granted
            ? '系统通知权限已开启（实际横幅展现仍遵循系统专注 / 勿扰模式）。'
            : '尚未授予通知权限；点击“申请通知权限”或“发送测试通知”可发起系统授权。';
          if (reqNotifyBtn) reqNotifyBtn.hidden = granted;
        })
        .catch(err => {
          if (notifyBadge) {
            notifyBadge.className = 'pill risk';
            notifyBadge.textContent = '读取失败';
          }
          notifyText.textContent = `无法读取通知权限：${String(err)}`;
        }),
    ]);
  }

  function applyActiveSection(sub: SettingsSubTab) {
    activeSection = sub;
    try {
      localStorage.setItem('sentinel.settings.section', sub);
    } catch {}

    const form = panel.querySelector<HTMLFormElement>('#settings-form');
    const monitorSec = panel.querySelector<HTMLElement>('#monitor-settings');
    const routingSec = panel.querySelector<HTMLElement>('#routing-settings');
    const webdavSec = panel.querySelector<HTMLElement>('#webdav-settings');
    const updateSec = panel.querySelector<HTMLElement>('#update-settings');

    const isFormSection = sub === 'monitor-settings' || sub === 'routing-settings';
    if (form) form.hidden = !isFormSection;
    if (monitorSec) monitorSec.hidden = sub !== 'monitor-settings';
    if (routingSec) routingSec.hidden = sub !== 'routing-settings';
    if (webdavSec) webdavSec.hidden = sub !== 'webdav-settings';
    if (updateSec) updateSec.hidden = sub !== 'update-settings';

    if (sub === 'monitor-settings') {
      void refreshPermissions();
      void syncAutostart();
    } else if (sub === 'webdav-settings') {
      void loadSync();
    } else if (sub === 'update-settings') {
      void refreshUpdateStatus();
    }
  }

  function mountDom(s: Settings, probes: Probe[] | undefined) {
    ipv6RequiredDraft = Boolean(s.ipv6_required);
    ignoredDraft = new Set(s.ignored_checks || []);
    lastSyncedSignature = JSON.stringify(comparableSettings(s));

    const requireCnV6 = ipv6RequiredDraft && !ignoredDraft.has('probe:cn-v6');
    const requireGlobalV6 = ipv6RequiredDraft && !ignoredDraft.has('probe:global-v6');
    const ignoredCount = ignoredDraft.size;

    panel.innerHTML = `<div class="settings-workspace">
      <form id="settings-form" class="settings-form" novalidate>
        <div id="monitor-settings" class="settings-section">
          <section class="panel settings settings-card">
            <div class="card-head">
              <div>
                <h2>系统与权限</h2>
                <p class="small muted">管理开机托盘自启、操作系统通知与物理网卡 Wi-Fi 名称读取状态。</p>
              </div>
              <button type="button" class="ghost-btn" id="refresh-permissions">
                ${icon('refresh')}<span>刷新状态</span>
              </button>
            </div>

            <div class="perm-list">
              <label class="toggle perm-toggle" for="setting-autostart">
                <span>
                  <span class="perm-title-line">
                    <strong>开机自动启动</strong>
                    <span id="autostart-pill" class="pill">${autostart === null ? '读取中' : autostart ? '已开启' : '未开启'}</span>
                  </span>
                  <small id="autostart-status">登录系统后自动在托盘后台运行监控，切换后立即生效。</small>
                </span>
                <input id="setting-autostart" name="autostart" type="checkbox" role="switch" data-immediate="true" ${autostart ? 'checked' : ''} ${autostart === null || autostartBusy ? 'disabled' : ''}>
              </label>

              <div class="perm-row">
                <div class="perm-info">
                  <div class="perm-title-line">
                    <strong>桌面通知</strong>
                    <span id="notification-permission-badge" class="pill">正在检查…</span>
                  </div>
                  <small id="notification-permission-status" role="status">正在读取操作系统通知授权状态…</small>
                </div>
                <div class="perm-actions">
                  <button type="button" id="request-notifications">申请通知权限</button>
                  <button type="button" id="test-notification">发送测试通知</button>
                </div>
              </div>

              <div class="perm-row">
                <div class="perm-info">
                  <div class="perm-title-line">
                    <strong>Wi-Fi 名称读取权限</strong>
                    <span id="wifi-permission-badge" class="pill">正在检查…</span>
                  </div>
                  <small id="wifi-permission-status" role="status">正在检测当前系统网卡与 Wi-Fi 名称读取方式…</small>
                </div>
                <div class="perm-actions" id="wifi-permission-actions" hidden>
                  <button type="button" class="primary" id="wifi-name-permission">申请读取权限</button>
                  <button type="button" id="location-settings">打开定位设置</button>
                </div>
              </div>
            </div>
          </section>

          <section class="panel settings settings-card">
            <div class="card-head">
              <div>
                <h2>监控周期与通知策略</h2>
                <p class="small muted">所有出口与连通性变化均经过连续两次观测确认，过滤偶发网络抖动。</p>
              </div>
            </div>

            <div class="setting-inline-row">
              <div class="setting-inline-copy">
                <label for="setting-interval">后台轮询间隔</label>
                <small>默认 <span class="tabular">30</span> 秒（支持 <span class="tabular">10–3600</span> 秒）；本机 Wi-Fi 或网卡切换时约 <span class="tabular">6</span> 秒快速复检。</small>
              </div>
              <div class="interval-controls">
                <div class="preset-chips" role="group" aria-label="常用轮询间隔">
                  ${INTERVAL_PRESETS.map(
                    sec => `<button type="button" class="preset-chip tabular${s.interval === sec ? ' is-active' : ''}" data-interval-preset="${sec}" aria-pressed="${s.interval === sec}">${sec} 秒</button>`
                  ).join('')}
                </div>
                <div class="interval-input-wrap">
                  <input id="setting-interval" class="mono tabular" name="interval" type="number" min="10" max="3600" step="1" value="${s.interval}" required>
                  <span class="unit-suffix">秒</span>
                </div>
              </div>
            </div>

            <div class="settings-switches-block">
              <label class="toggle">
                <span>出口变化与故障恢复通知<small>出口 IP 变更、Google / Claude / Gemini 连接失败、访问受限或恢复正常时发送系统通知；持续故障不重复打扰。</small></span>
                <input name="notifications" type="checkbox" role="switch" ${s.notifications ? 'checked' : ''}>
              </label>

              <label class="toggle">
                <span>保存状态变化历史<small>在本机保留最近 <span class="tabular">200</span> 条出口与连通性变更记录；关闭保存时将清空现有历史记录。</small></span>
                <input name="retain_history" type="checkbox" role="switch" ${s.retain_history ? 'checked' : ''}>
              </label>

              <label class="toggle" for="require-cn-v6">
                <span>要求国内 IPv6 可用<small>开启后，国内 IPv6 探测无可用地址时将计入整体异常状态并提醒。</small></span>
                <input id="require-cn-v6" type="checkbox" role="switch" data-v6-direction="cn" ${requireCnV6 ? 'checked' : ''}>
              </label>

              <label class="toggle" for="require-global-v6">
                <span>要求国外 IPv6 可用<small>开启后，国外 IPv6 探测无可用地址时将计入整体异常状态并提醒。</small></span>
                <input id="require-global-v6" type="checkbox" role="switch" data-v6-direction="global" ${requireGlobalV6 ? 'checked' : ''}>
              </label>
            </div>
          </section>

          <section id="ignored-checks" tabindex="-1" class="panel settings settings-card">
            <div class="card-head">
              <div>
                <h2>忽略的检测项</h2>
                <p class="small muted">勾选的项目仍照常探测并显示实时结果，但失败或受限时不会将托盘图标标黄或触发异常告警。</p>
              </div>
              <div class="card-head-actions">
                <span id="ignored-count-pill" class="${ignoredCount > 0 ? 'pill warn tabular' : 'pill tabular'}">已忽略 ${ignoredCount} / ${ALL_IGNORABLE_IDS.length} 项</span>
                <button type="button" class="ghost-btn" id="clear-ignored-checks" ${ignoredCount === 0 ? 'hidden' : ''}>全部恢复计入</button>
              </div>
            </div>

            <div class="ignore-groups-grid">
              <fieldset class="ignore-group">
                <legend class="tabular">AI 与网站访问 (4)</legend>
                <div class="ignore-grid">
                  ${SITE_CHECKS.map(item => renderCheckItem(item, ignoredDraft)).join('')}
                </div>
              </fieldset>

              <fieldset class="ignore-group">
                <legend class="tabular">出口检测站 (6)</legend>
                <div class="ignore-grid">
                  ${PROBE_CHECKS.map(item => renderCheckItem(item, ignoredDraft)).join('')}
                </div>
              </fieldset>
            </div>
          </section>
        </div>

        <div id="routing-settings" class="settings-section" hidden>
          <div class="proxy-cards-grid">
            <section class="panel settings settings-card proxy-card">
              <div class="card-head">
                <div>
                  <h2>国外与 AI 检测代理</h2>
                  <p class="small muted">用于国外 IPv4 / IPv6 检测站、国际网站连通性及 IP 归属查询。支持一键填入本地无认证端口或自定义 URL。</p>
                </div>
              </div>
              ${renderPresetChips('foreign_proxy', s.foreign_proxy, FOREIGN_PROXY_PRESETS)}
              <div class="field">
                <label for="setting-foreign-proxy">国外检测代理地址</label>
                <input
                  id="setting-foreign-proxy"
                  class="mono"
                  name="foreign_proxy"
                  type="text"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  value="${esc(s.foreign_proxy)}"
                  placeholder="留空走系统路由 / TUN，或填 http:// / socks5h://127.0.0.1:端口"
                >
                <small>支持 <code class="mono">http://</code>、<code class="mono">https://</code>、<code class="mono">socks5://</code>、<code class="mono">socks5h://</code> 或 <code class="mono">direct</code>；不保存带密码的代理地址。</small>
              </div>
            </section>

            <section class="panel settings settings-card proxy-card">
              <div class="card-head">
                <div>
                  <h2>国内检测代理</h2>
                  <p class="small muted">仅用于国内两个 IPv4 检测站与国内 IPv6 检测站。开启全局代理时建议选“直连不使用代理”以观测真实本机国内出口。</p>
                </div>
              </div>
              ${renderPresetChips('domestic_proxy', s.domestic_proxy, DOMESTIC_PROXY_PRESETS)}
              <div class="field">
                <label for="setting-domestic-proxy">国内检测代理地址</label>
                <input
                  id="setting-domestic-proxy"
                  class="mono"
                  name="domestic_proxy"
                  type="text"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  value="${esc(s.domestic_proxy)}"
                  placeholder="留空走系统路由 / TUN，或填 direct 绕过进程代理"
                >
                <small><code class="mono">direct</code> 仅忽略系统进程代理变量，若开启了全局网卡级 TUN 仍遵循系统路由表。</small>
              </div>
            </section>
          </div>

          <section class="panel settings settings-card">
            <div class="card-head">
              <div>
                <h2>AI 服务独立分流与节点来源</h2>
                <p class="small muted">默认留空以沿用系统或 TUN 真实分流路径（不会自动继承上方“国外检测代理”）；仅在多端口隔离分流时单独指定。</p>
              </div>
              <div class="card-head-actions">
                <button type="button" class="ghost-btn" id="copy-foreign-to-ai">填入当前国外代理</button>
                <button type="button" class="ghost-btn" id="clear-ai-proxies">清空独立代理</button>
              </div>
            </div>

            <div class="settings-grid">
              <div class="field field-full">
                <label for="setting-node-source">代理节点数据来源</label>
                <select id="setting-node-source" name="manual_nodes_only">
                  <option value="false" ${!s.manual_nodes_only ? 'selected' : ''}>自动读取本机客户端（Windows / Linux：Clash Verge；macOS：Shadowrocket）</option>
                  <option value="true" ${s.manual_nodes_only ? 'selected' : ''}>仅使用手动导入的节点记录（Clash Verge / Shadowrocket / Karing / Clash Mi）</option>
                </select>
                <small>自动读取仅以只读方式观测近期同域名连接快照或活动策略，绝不修改客户端规则。</small>
              </div>

              <div class="field">
                <label for="setting-claude-proxy">Claude 独立检测代理（可选）</label>
                <input
                  id="setting-claude-proxy"
                  class="mono"
                  name="claude_proxy"
                  type="text"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  value="${esc(s.claude_proxy)}"
                  placeholder="默认留空，或填独立本地代理端口 URL"
                >
              </div>

              <div class="field">
                <label for="setting-gemini-proxy">Gemini 独立检测代理（可选）</label>
                <input
                  id="setting-gemini-proxy"
                  class="mono"
                  name="gemini_proxy"
                  type="text"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  value="${esc(s.gemini_proxy)}"
                  placeholder="默认留空，或填独立本地代理端口 URL"
                >
              </div>
            </div>
          </section>

          <details class="panel settings-details" ${s.gemini_ip_url ? 'open' : ''}>
            <summary>
              <span class="guide-summary-title">高级：自定义出口检测站地址</span>
              <span class="guide-summary-sub">自定义 Gemini HTTPS 出口回显地址与查看 <span class="tabular">6</span> 个内置探测源</span>
            </summary>
            <div class="settings-details-body">
              <div class="details-toolbar">
                <span class="small muted">当本机代理未转发 UDP（导致默认 Google STUN 回显不走代理）时，可指定与 Gemini 同分流规则的 HTTPS IP 回显地址。</span>
                <button type="button" id="reset-probe-urls">重置默认地址</button>
              </div>

              <div class="field">
                <label for="setting-gemini-ip-url">Gemini 参考出口回显地址（无认证 HTTPS，可选）</label>
                <input
                  id="setting-gemini-ip-url"
                  class="mono"
                  name="gemini_ip_url"
                  type="url"
                  autocomplete="off"
                  autocorrect="off"
                  autocapitalize="none"
                  spellcheck="false"
                  value="${esc(s.gemini_ip_url)}"
                  placeholder="默认留空（使用 Google STUN UDP 自动回显出口 IP）"
                >
                <small>填写示例：<code class="mono">https://api.ipify.org?format=json</code>。Google 判定的服务地区始终直接从 <code class="mono">gemini.google.com</code> 页面读取。</small>
              </div>

              <div class="probe-endpoints-section">
                <div class="probe-endpoints-title">
                  <strong class="tabular">内置出口检测站地址（6 个探测源）</strong>
                  <span class="small muted">国内与国外双源交叉核验，支持一键复制地址用于终端排查</span>
                </div>
                <div id="probe-endpoints-host">
                  ${renderProbeEndpoints(probes)}
                </div>
              </div>
            </div>
          </details>
        </div>

        <div class="panel settings-inline-footer">
          <span id="settings-inline-dirty-hint" class="small muted">所有监控与分流设置已与本机配置同步</span>
          <div class="settings-inline-actions">
            <button type="button" data-restore-draft>还原</button>
            <button type="submit" class="primary">保存并生效</button>
          </div>
        </div>
      </form>

      <div id="settings-draft-bar" class="settings-draft-bar" role="region" aria-label="未保存设置提示" hidden>
        <span class="draft-bar-status" role="status">
          <span class="dot amber"></span>
          <strong>有未保存的监控与代理设置</strong>
        </span>
        <div class="draft-bar-actions">
          <button type="button" id="restore-settings" data-restore-draft>还原</button>
          <button type="submit" form="settings-form" class="primary">保存并生效</button>
        </div>
      </div>

      ${syncSettings()}

      <div id="update-settings" class="settings-section" hidden>
        <section id="updater-card-host" class="panel settings settings-card">${updateSettings()}</section>
        ${renderGuide()}
      </div>
    </div>`;

    applyActiveSection(activeSection);
    paintDraftState();
  }

  // --- Scoped Event Listeners on `panel` ---

  panel.addEventListener('input', e => {
    const target = e.target as HTMLElement;
    if (!target.closest('#settings-form')) return;
    if ((target as HTMLInputElement).dataset.immediate === 'true') return;
    if (target instanceof HTMLInputElement) {
      target.setCustomValidity('');
    }
    paintProxyAndIntervalChips();
    paintDraftState();
  });

  panel.addEventListener('change', async e => {
    const target = e.target as HTMLInputElement;

    // 1. Immediate Autostart Switch
    if (target.id === 'setting-autostart') {
      if (autostartBusy) return;
      const wanted = target.checked;
      autostartBusy = true;
      paintAutostart();
      try {
        autostart = await invoke<boolean>('set_autostart', { enabled: wanted });
        showToast(autostart ? '已开启开机自动启动' : '已关闭开机自动启动', false, 'safe');
      } catch (err) {
        try {
          autostart = await invoke<boolean>('get_autostart');
        } catch {
          autostart = null;
        }
        showToast(`设置开机自动启动失败：${String(err)}`, true, 'risk');
      } finally {
        autostartBusy = false;
        paintAutostart();
      }
      return;
    }

    if (!target.closest('#settings-form')) return;
    if (target.dataset.immediate === 'true') return;

    // 2. Directional IPv6 Requirement Toggles (`require-cn-v6` / `require-global-v6`)
    if (target.dataset.v6Direction) {
      const cnSwitch = panel.querySelector<HTMLInputElement>('#require-cn-v6');
      const globalSwitch = panel.querySelector<HTMLInputElement>('#require-global-v6');
      const wantCn = Boolean(cnSwitch?.checked);
      const wantGlobal = Boolean(globalSwitch?.checked);

      if (!wantCn && !wantGlobal) {
        ipv6RequiredDraft = false;
      } else {
        ipv6RequiredDraft = true;
        if (wantCn) ignoredDraft.delete('probe:cn-v6');
        else ignoredDraft.add('probe:cn-v6');

        if (wantGlobal) ignoredDraft.delete('probe:global-v6');
        else ignoredDraft.add('probe:global-v6');
      }
      paintIgnoredSummaryAndV6Switches();
      paintDraftState();
      return;
    }

    // 3. Ignored Check Grid Checkboxes
    if (target.name === 'ignored_checks') {
      if (target.checked) ignoredDraft.add(target.value);
      else ignoredDraft.delete(target.value);
      if (ignoredDraft.has('probe:cn-v6') && ignoredDraft.has('probe:global-v6')) {
        ipv6RequiredDraft = false;
      }
      paintIgnoredSummaryAndV6Switches();
      paintDraftState();
      return;
    }

    paintProxyAndIntervalChips();
    paintDraftState();
  });

  // Sync Expand/Collapse All button when individual FAQ `<details>` toggle
  panel.addEventListener(
    'toggle',
    e => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement) || !d.classList.contains('guide-card')) return;
      const allCards = Array.from(panel.querySelectorAll<HTMLDetailsElement>('.guide-card'));
      const toggleBtn = panel.querySelector<HTMLButtonElement>('#toggle-all-guides');
      if (!toggleBtn || !allCards.length) return;
      const everyOpen = allCards.every(card => card.open);
      toggleBtn.setAttribute('aria-expanded', String(everyOpen));
      toggleBtn.textContent = everyOpen ? '收起全部' : '展开全部';
    },
    { capture: true }
  );

  panel.addEventListener('click', async e => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;

    // Interval preset chip
    if (btn.dataset.intervalPreset) {
      const input = panel.querySelector<HTMLInputElement>('#setting-interval');
      if (input) {
        input.value = btn.dataset.intervalPreset;
        input.setCustomValidity('');
        paintProxyAndIntervalChips();
        paintDraftState();
      }
      return;
    }

    // Proxy preset chip
    if (btn.dataset.proxyTarget) {
      const fieldName = btn.dataset.proxyTarget as 'foreign_proxy' | 'domestic_proxy';
      const input = panel.querySelector<HTMLInputElement>(`#settings-form [name="${fieldName}"]`);
      if (input) {
        input.value = btn.dataset.proxyPreset ?? '';
        input.setCustomValidity('');
        paintProxyAndIntervalChips();
        paintDraftState();
      }
      return;
    }

    // Restore draft
    if (btn.hasAttribute('data-restore-draft')) {
      if (settingsSaving) return;
      const s = app.getState()?.settings;
      if (s) {
        populateFormFromSettings(s);
        showToast('已还原未保存的监控与代理设置');
      }
      return;
    }

    switch (btn.id) {
      case 'refresh-permissions':
        await Promise.all([refreshPermissions(), syncAutostart()]);
        showToast('已刷新系统启动与权限状态');
        break;

      case 'request-notifications':
        await ensureNotificationPermission();
        await refreshPermissions();
        break;

      case 'test-notification':
        if (await ensureNotificationPermission()) {
          await app.testNotification();
          await refreshPermissions();
          showToast('已发送测试通知，请查看系统右上角或通知中心。', false, 'safe');
        }
        break;

      case 'wifi-name-permission':
      case 'location-settings':
        // `src/main.ts` invokes the Tauri command; refresh local permission pill right after.
        setTimeout(() => {
          void refreshPermissions();
        }, 450);
        break;

      case 'clear-ignored-checks':
        ignoredDraft.clear();
        paintIgnoredSummaryAndV6Switches();
        paintDraftState();
        break;

      case 'copy-foreign-to-ai': {
        const foreignVal = panel.querySelector<HTMLInputElement>('#setting-foreign-proxy')?.value.trim() || '';
        const claudeInput = panel.querySelector<HTMLInputElement>('#setting-claude-proxy');
        const geminiInput = panel.querySelector<HTMLInputElement>('#setting-gemini-proxy');
        if (claudeInput) claudeInput.value = foreignVal;
        if (geminiInput) geminiInput.value = foreignVal;
        paintDraftState();
        showToast(foreignVal ? `已将 Claude 与 Gemini 代理设为 ${foreignVal}` : '国外检测代理当前为空，已同步清空');
        break;
      }

      case 'clear-ai-proxies': {
        const claudeInput = panel.querySelector<HTMLInputElement>('#setting-claude-proxy');
        const geminiInput = panel.querySelector<HTMLInputElement>('#setting-gemini-proxy');
        if (claudeInput) claudeInput.value = '';
        if (geminiInput) geminiInput.value = '';
        paintDraftState();
        break;
      }

      case 'reset-probe-urls': {
        const geminiUrlInput = panel.querySelector<HTMLInputElement>('#setting-gemini-ip-url');
        if (geminiUrlInput) {
          geminiUrlInput.value = '';
          geminiUrlInput.setCustomValidity('');
        }
        paintDraftState();
        showToast('已恢复默认出口检测地址（Gemini 使用 Google STUN 回显）');
        break;
      }

      case 'toggle-all-guides': {
        const expand = btn.getAttribute('aria-expanded') !== 'true';
        panel.querySelectorAll<HTMLDetailsElement>('.guide-card').forEach(card => {
          card.open = expand;
        });
        btn.setAttribute('aria-expanded', String(expand));
        btn.textContent = expand ? '收起全部' : '展开全部';
        break;
      }
    }
  });

  panel.addEventListener('submit', async e => {
    const form = e.target as HTMLFormElement;
    if (form.id !== 'settings-form') return;
    e.preventDefault();
    if (settingsSaving) return;

    // Validate interval & URLs across both `monitor-settings` and `routing-settings`,
    // switching to the subtab containing any invalid input before calling `reportValidity()`.
    const intervalInput = form.querySelector<HTMLInputElement>('#setting-interval');
    if (intervalInput) {
      const v = Number(intervalInput.value);
      if (!Number.isFinite(v) || v < 10 || v > 3600) {
        intervalInput.setCustomValidity('轮询间隔须在 10 到 3600 秒之间。');
      } else {
        intervalInput.setCustomValidity('');
      }
    }

    const firstInvalid = form.querySelector<HTMLInputElement | HTMLSelectElement>(':invalid');
    if (firstInvalid) {
      const inRouting = Boolean(firstInvalid.closest('#routing-settings'));
      const neededTab: SettingsSubTab = inRouting ? 'routing-settings' : 'monitor-settings';
      if (activeSection !== neededTab) {
        await app.navigate('settings', neededTab);
      }
      firstInvalid.focus({ preventScroll: false });
      firstInvalid.reportValidity();
      return;
    }

    const nextSettings = readFormSettings();
    const currentSettings = app.getState()?.settings;
    if (!nextSettings || !currentSettings) return;

    const historyLen = app.getState()?.history.length || 0;
    if (
      !nextSettings.retain_history &&
      currentSettings.retain_history &&
      historyLen > 0 &&
      !(await confirmAction({
        title: '关闭并清空变化历史记录？',
        message: `关闭后将删除本机已保存的 ${historyLen} 条变化记录，且后续不再保存新记录。`,
        confirm: '清空记录并保存',
        danger: true,
      }))
    ) {
      return;
    }

    settingsSaving = true;
    const controls = Array.from(
      panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
        '#settings-form input:not([data-immediate="true"]), #settings-form select, #settings-form button, #settings-draft-bar button'
      )
    );
    const prevDisabled = controls.map(c => c.disabled);
    controls.forEach(c => {
      c.disabled = true;
    });

    try {
      if (nextSettings.notifications) {
        await ensureNotificationPermission();
      }
      await app.saveSettings(nextSettings);
      lastSyncedSignature = JSON.stringify(comparableSettings(nextSettings));
      controls.forEach((c, idx) => {
        c.disabled = prevDisabled[idx];
      });
      paintDraftState();
      showToast('监控与分流设置已保存并生效', false, 'safe');
    } catch (err) {
      controls.forEach((c, idx) => {
        c.disabled = prevDisabled[idx];
      });
      showToast(String(err), true, 'risk');
    } finally {
      settingsSaving = false;
    }
  });

  // Keep clean form in sync if `view.settings` updates externally (e.g. WebDAV pull)
  app.subscribe(snap => {
    if (!mounted || !snap.view || settingsSaving) return;
    const incomingSig = JSON.stringify(comparableSettings(snap.view.settings));
    if (incomingSig !== lastSyncedSignature && !isSettingsDirty()) {
      populateFormFromSettings(snap.view.settings);
    }
  });

  return {
    getSubTabs() {
      const upd = app.getUpdateState();
      const hasUpd = upd?.phase === 'available' || upd?.phase === 'ready_deferred';
      return [
        { id: 'monitor-settings', label: '常规与监控' },
        { id: 'routing-settings', label: '代理与分流' },
        { id: 'webdav-settings', label: '云同步' },
        {
          id: 'update-settings',
          label: '更新与关于',
          badge: hasUpd ? '新版本' : null,
          tone: hasUpd ? 'safe' : 'neutral',
        },
      ];
    },

    render(view, activeSub) {
      const resolved = normalizeSubTab(activeSub);
      if (!view) return;
      if (!mounted || !panel.children.length) {
        mounted = true;
        activeSection = resolved;
        mountDom(view.settings, view.probes);
        void loadSync();
        return;
      }
      const probeHost = panel.querySelector<HTMLElement>('#probe-endpoints-host');
      if (probeHost && view.probes?.length) {
        probeHost.innerHTML = renderProbeEndpoints(view.probes);
      }
      const incomingSig = JSON.stringify(comparableSettings(view.settings));
      if (incomingSig !== lastSyncedSignature && !isSettingsDirty() && !settingsSaving) {
        populateFormFromSettings(view.settings);
      }
      applyActiveSection(resolved);
      paintDraftState();
    },

    async canLeave(nextTab) {
      if (nextTab === 'settings') {
        return true;
      }
      if (settingsSaving || syncInProgress() || autostartBusy) {
        showToast('设置正在保存或同步中，请稍候再切换页面。');
        return false;
      }
      const dirtyForm = isSettingsDirty();
      const dirtyDav = hasUnsavedSync();
      if (dirtyForm || dirtyDav) {
        const ok = await confirmAction({
          title: '放弃未保存的设置修改？',
          message: dirtyForm && dirtyDav
            ? '监控与代理设置、WebDAV 连接配置均有未保存的修改，离开后将还原为已保存状态。'
            : dirtyForm
              ? '当前有未保存的监控与代理设置修改，离开后将还原为已保存状态。'
              : '当前有未保存的 WebDAV 连接输入，离开后将放弃修改。',
          confirm: '放弃修改并离开',
          danger: true,
        });
        if (!ok) return false;
      }
      discardUnsavedSync();
      mounted = false;
      return true;
    },

    hasUnsavedWork() {
      return settingsSaving || syncInProgress() || autostartBusy || hasUnsavedSync() || isSettingsDirty();
    },

    onActivate(activeSub) {
      const resolved = normalizeSubTab(activeSub);
      if (resolved === 'monitor-settings') {
        void syncAutostart();
        void refreshPermissions();
      } else if (resolved === 'webdav-settings') {
        void loadSync();
      } else if (resolved === 'update-settings') {
        void refreshUpdateStatus();
      }
    },

    onAutostartChanged(enabled) {
      autostart = enabled;
      paintAutostart();
    },

    onDataCleared() {
      const s = app.getState()?.settings;
      if (mounted && s && !settingsSaving) {
        populateFormFromSettings(s);
      }
    },

    onNavigatePayload(sub, payload) {
      const resolved = normalizeSubTab(sub);
      applyActiveSection(resolved);
      if (payload && typeof payload === 'object' && 'scrollTo' in (payload as Record<string, unknown>)) {
        const id = String((payload as Record<string, unknown>).scrollTo || '');
        if (id) {
          const el = panel.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
          el?.scrollIntoView({ block: 'start' });
          el?.focus({ preventScroll: true });
        }
      }
    },
  };
}
