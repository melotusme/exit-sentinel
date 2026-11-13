// Settings page: monitoring preferences, autostart, notification permission, sync and usage notes.
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { confirmAction } from './confirm';
import { renderGuide } from './guide';
import { loadSync, syncSettings } from './sync';
import { updateSettings } from './updater';
import { esc } from './ui';
import { ListView } from './list';
import { refreshSearchSelects } from './select';
import type { Settings } from './types';

export interface SettingsDeps {
  content: HTMLElement;
  toast: (message: string, persistent?: boolean) => void;
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
  settings: () => Settings;
  historyCount: () => number;
  /** The settings page is the one on screen. */
  isActive: () => boolean;
}
let deps: SettingsDeps;
/** Checks the user can ignore; must match IGNORABLE_CHECKS in src-tauri/src/model.rs. */
const IGNORABLE: [string, string][] = [
  ['site:google', 'Google 网站访问'],
  ['site:claude', 'Claude 网站访问'],
  ['site:gemini', 'Gemini 网站访问'],
  ['site:antigravity', 'Antigravity 网站访问'],
  ['probe:cn-ipip', '国内 · IPIP'],
  ['probe:cn-3322', '国内 · 3322'],
  ['probe:global-cf', '国外 · Cloudflare'],
  ['probe:global-ipify', '国外 · ipify'],
  ['probe:cn-v6', '国内 · IPv6'],
  ['probe:global-v6', '国外 · IPv6'],
];
interface IgnorableCheck { id: string; name: string; kind: string }
const kindOf = (id: string) => id.startsWith('site:') ? 'site' : id.startsWith('probe:cn-') ? 'domestic' : 'foreign';
const KINDS: Record<string, string> = { site: '网站访问', domestic: '国内出口', foreign: '国外出口' };
const CHECKS: IgnorableCheck[] = IGNORABLE.map(([id, name]) => ({ id, name, kind: kindOf(id) }));
/** Ticked items not yet saved. Kept outside the DOM so paging and filtering keep them. */
let ignoredDraft = new Set<string>();
export const ignoreList = new ListView<IgnorableCheck>(
  'ignored-checks',
  {
    name: { label: '检测项', value: r => r.name },
    kind: { label: '类别', value: r => KINDS[r.kind] },
    state: { label: '状态', value: r => (ignoredDraft.has(r.id) ? '1' : '0') },
  },
  r => `${r.name} ${KINDS[r.kind]} ${ignoredDraft.has(r.id) ? '已忽略' : '计入状态'}`,
  r => r.kind,
  KINDS
);
const ignoreRow = (r: IgnorableCheck) => {
  const on = ignoredDraft.has(r.id);
  return `<label class="ignore-row ${on ? 'is-ignored' : ''}">
    <input type="checkbox" name="ignored_checks" value="${esc(r.id)}" ${on ? 'checked' : ''}>
    <span class="ignore-name">${esc(r.name)}</span>
    <span class="ignore-kind">${esc(KINDS[r.kind])}</span>
    <span class="ignore-state">${on ? '已忽略' : '计入状态'}</span>
  </label>`;
};
export const renderIgnoreList = () => ignoreList.render(CHECKS, ignoreRow);
const ignoredChecks = (s: Settings) => {
  ignoredDraft = new Set(s.ignored_checks || []);
  return `
  <div id="ignored-checks" tabindex="-1" class="field field-full ignore-field">
    <span>忽略的检测项</span>
    <small>勾选的项目照常检测和显示，但不再让菜单栏变成“部分检测异常”。只保存在本机。</small>
    <div class="ignore-list panel">${renderIgnoreList()}</div>
  </div>`;
};
let auto: boolean | null = null,
  autoBusy = false,
  settingsSaving = false;
export function initSettings(d: SettingsDeps) {
  deps = d;
  const header = document.querySelector('.app-header');
  if (header) new ResizeObserver(() => {
    const nav = deps.content.querySelector<HTMLElement>('.settings-links');
    if (nav) nav.style.top = `${header.getBoundingClientRect().height}px`;
  }).observe(header);
}
export const settingsBusy = () => settingsSaving;
export function setAutostart(value: boolean | null) {
  auto = value;
  paintAutostart();
}

const SECTIONS = [
  ['monitor-settings', '监控与通知'], ['routing-settings', '代理路径'],
  ['permissions-settings', '权限'], ['system-settings', '系统启动'],
  ['webdav-settings', '配置同步'], ['update-settings', '软件更新'], ['help-settings', '使用说明'],
] as const;
let section = 'monitor-settings';
try { const saved = localStorage.getItem('sentinel.settings.section'); if (SECTIONS.some(([id]) => id === saved)) section = saved!; } catch {}

export function selectSettingsSection(id: string, focus = false) {
  if (!SECTIONS.some(([key]) => key === id)) return;
  section = id;
  try { localStorage.setItem('sentinel.settings.section', id); } catch {}
  const root = deps.content;
  root.querySelectorAll<HTMLButtonElement>('[data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === id;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    button.classList.toggle('active', active);
    if (active && focus) button.focus({ preventScroll: true });
  });
  for (const [key] of SECTIONS) {
    const panel = root.querySelector<HTMLElement>(`#${key}`);
    if (panel) {
      panel.hidden = key !== id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', `tab-${key}`);
    }
  }
  const form = root.querySelector<HTMLFormElement>('#settings-form');
  if (form) form.hidden = !['monitor-settings', 'routing-settings'].includes(id);
  const nav = root.querySelector<HTMLElement>('.settings-links');
  if (nav) nav.style.top = `${document.querySelector('.app-header')?.getBoundingClientRect().height || 80}px`;
  if (id === 'permissions-settings') void refreshPermissions();
}

export async function refreshPermissions() {
  const wifi = deps.content.querySelector('#wifi-permission-status');
  const notification = deps.content.querySelector('#notification-permission-status');
  if (!wifi || !notification) return;
  const messages: Record<string, string> = {
    granted: '已允许。若名称仍未显示，可刷新网络状态；这不代表权限被拒绝。',
    not_determined: '尚未申请。点击“申请 Wi-Fi 名称权限”后，在系统弹窗中允许。',
    denied: '已拒绝。系统不会重复弹窗，请在系统定位设置中允许 Exit Sentinel。',
    restricted: '受系统策略限制，请检查屏幕使用时间或设备管理策略。',
    services_off: '系统定位服务已关闭。请先打开总开关，再允许 Exit Sentinel。',
    settings: '请在 Windows 定位设置中检查定位服务和桌面应用访问权限。',
    not_required: '此系统无需申请定位权限；Wi-Fi 名称由系统网络服务提供。',
  };
  await Promise.all([
    invoke<string>('wifi_permission_status').then(status => {
      wifi.textContent = messages[status] || status;
      deps.content.querySelectorAll<HTMLButtonElement>('#wifi-name-permission,#location-settings').forEach(button => { button.disabled = status === 'not_required'; });
    })
      .catch(error => { wifi.textContent = `读取失败：${String(error)}`; }),
    isPermissionGranted().then(ok => { notification.textContent = ok ? '已允许（仍受勿扰模式和系统通知设置影响）。' : '尚未允许。点击“申请通知权限”；若曾拒绝，请到系统通知设置中开启。'; })
      .catch(error => { notification.textContent = `读取失败：${String(error)}`; }),
  ]);
}
window.setInterval(() => { if (deps?.isActive() && section === 'permissions-settings' && !document.hidden) void refreshPermissions(); }, 3000);
window.addEventListener('focus', () => { if (deps?.isActive() && section === 'permissions-settings') void refreshPermissions(); });
document.addEventListener('click', async event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-settings-tab],#refresh-permissions,#request-notifications');
  if (!target || !deps?.isActive()) return;
  if (target.dataset.settingsTab) { selectSettingsSection(target.dataset.settingsTab, true); window.scrollTo({ top: 0 }); }
  else if (target.id === 'refresh-permissions') await refreshPermissions();
  else {
    try { await permission(); await refreshPermissions(); }
    catch (error) { deps.toast(String(error), true); }
  }
});
document.addEventListener('keydown', event => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-settings-tab]');
  if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = SECTIONS.findIndex(([id]) => id === button.dataset.settingsTab);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + SECTIONS.length) % SECTIONS.length;
  selectSettingsSection(SECTIONS[next][0], true);
});

export function renderSettings(s: Settings) {
  deps.content.innerHTML = `
    <div class="settings-stack">
      <nav class="settings-links" role="tablist" aria-label="设置分区">${SECTIONS.map(([id, name]) => `<button type="button" role="tab" id="tab-${id}" aria-controls="${id}" data-settings-tab="${id}">${name}</button>`).join('')}</nav>
      <form id="settings-form" class="settings-form">
      <section id="monitor-settings" class="panel settings settings-card">
        <div class="card-header-block">
          <div>
            <span class="eyebrow">MONITORING & ALERTS</span>
            <h2>检测策略与系统提醒</h2>
          </div>
        </div>
        <label class="field">
          <span>出口检测间隔（秒）</span>
          <input name="interval" type="number" min="10" max="3600" value="${s.interval}" required>
          <small>默认 30 秒。出口 IP 与 Google / Claude / Gemini 连通性均自动检测，变化、失败、恢复连续两次确认；本机网络变化约 6 秒确认。</small>
        </label>
        <label class="toggle">
          <span>网络与服务异常时发送系统通知<small>通知出口 IP 变化、Google / Claude / Gemini 连接失败或访问受限及恢复；持续故障不重复提醒，菜单栏同时显示异常。</small></span>
          <input name="notifications" type="checkbox" ${s.notifications ? 'checked' : ''}>
        </label>
        <label class="toggle">
          <span>保存变化记录<small>只保留最近 200 条；关闭后清除已保存的记录。</small></span>
          <input name="retain_history" type="checkbox" ${s.retain_history ? 'checked' : ''}>
        </label>
        <label class="toggle">
          <span>要求 IPv6 出口可用<small>始终检测国内与国外 IPv6；开启后检测失败影响整体状态。本设置仅保存在本机。</small></span>
          <input name="ipv6_required" type="checkbox" ${s.ipv6_required ? 'checked' : ''}>
        </label>
        ${ignoredChecks(s)}
      </section>
      <section id="routing-settings" class="panel settings settings-card">
        <div class="card-header-block compact">
          <div>
            <span class="eyebrow">ROUTING & PROXIES</span>
            <h2>分流代理路径</h2>
          </div>
        </div>
        <p class="muted">留空：遵循本机路由 / TUN 和进程代理变量。不会自动读取系统代理或执行 PAC。direct：仅忽略进程代理变量，仍遵循 TUN。</p>
        <div class="settings-grid">
          <label class="field">
            <span>国内检测代理</span>
            <input autocomplete="off" spellcheck="false" name="domestic_proxy" value="${esc(s.domestic_proxy)}" placeholder="留空，或 direct，或 http://127.0.0.1:端口">
            <small>只影响国内两个检测站。</small>
          </label>
          <label class="field">
            <span>国外检测与详情查询代理</span>
            <input autocomplete="off" spellcheck="false" name="foreign_proxy" value="${esc(s.foreign_proxy)}" placeholder="留空，或 socks5h://127.0.0.1:端口">
            <small>推荐使用代理客户端的本地无认证端口；不保存代理密码。</small>
          </label>
        </div>
        <div class="settings-divider"></div>
        <div class="card-header-block compact">
          <div>
            <span class="eyebrow">AI SERVICE ROUTES</span>
            <h2>AI 服务独立路径</h2>
          </div>
        </div>
        <p class="muted">默认留空，各自域名沿现有 TUN 分流；不会继承“国外检测代理”。不修改代理客户端规则。</p>
        <label class="field"><span>节点数据来源</span><select name="manual_nodes_only"><option value="false" ${!s.manual_nodes_only ? 'selected' : ''}>自动读取本机（macOS：Shadowrocket；Windows / Linux：Clash Verge）</option><option value="true" ${s.manual_nodes_only ? 'selected' : ''}>仅手动导入（Shadowrocket / Clash Verge / Karing / Clash Mi 等）</option></select><small>macOS 优先读取近期同域名实际连接日志；没有日志时仅提供配置候选，不能证明某个进程的路径。手动导入节点可在节点库登记，不自动关联 IP。</small></label>
        <div class="settings-grid">
          <label class="field">
            <span>Claude 检测代理</span>
            <input autocomplete="off" spellcheck="false" name="claude_proxy" value="${esc(s.claude_proxy)}" placeholder="留空，或独立本地代理 URL">
          </label>
          <label class="field">
            <span>Gemini 检测代理</span>
            <input autocomplete="off" spellcheck="false" name="gemini_proxy" value="${esc(s.gemini_proxy)}" placeholder="留空，或独立本地代理 URL">
          </label>
          <label class="field field-full">
            <span>Gemini 参考出口检测 URL（可选）</span>
            <input autocomplete="off" spellcheck="false" name="gemini_ip_url" type="url" value="${esc(s.gemini_ip_url)}" placeholder="https://…">
            <small>留空时用 Google STUN 服务器回显 Gemini 出口（UDP，走 google.com 分流）。只有 UDP 不经代理时才需要填写：必须回显公网 IP，并且和 Gemini 命中同一策略 / 节点。Google 判定的地区始终从 Gemini 页面读取。</small>
          </label>
        </div>
      </section>
        <div class="form-actions settings-save-actions">
          <button class="primary" type="submit">保存设置</button>

        </div>
        <p id="permission" class="small muted status-note"></p>
      </form>
      <div id="settings-draft-bar" class="settings-draft-bar" hidden>
        <span role="status">监控与代理设置有未保存修改</span>
        <button type="button" id="restore-settings">还原修改</button>
        <button type="submit" form="settings-form" class="primary">保存监控与代理设置</button>
      </div>
      <section id="permissions-settings" class="panel settings settings-card">
        <h2>权限</h2>
        <p class="muted">权限由操作系统管理。返回应用时自动刷新授权状态。</p>
        <h3>Wi-Fi 名称 · 定位权限</h3>
        <p>macOS 需要定位权限才能读取 Wi-Fi 名称。应用只读取网络名称，不请求位置坐标，也不保存位置。未授权不影响出口 IP 检测。</p>
        <p id="wifi-permission-status" role="status">正在读取授权状态…</p>
        <div class="form-actions"><button type="button" class="primary" id="wifi-name-permission">申请 Wi-Fi 名称权限</button><button type="button" id="location-settings">打开系统定位设置</button></div>
        <p class="small muted">若升级后再次提示，请重新检查授权。本应用当前使用临时签名，macOS 可能将新版视为不同代码；稳定保留授权需要正式开发者签名。</p>
        <div class="settings-divider"></div>
        <h3>系统通知</h3>
        <p id="notification-permission-status" role="status">正在读取授权状态…</p>
        <div class="form-actions"><button type="button" id="request-notifications">申请通知权限</button><button type="button" id="test-notification">发送测试通知</button></div>
        <div class="settings-divider"></div>
        <button type="button" id="refresh-permissions">刷新权限状态</button>
      </section>
      <section id="system-settings" class="panel settings settings-card">
        <h2>系统启动</h2>
        <label class="toggle">
          <span>开机自启<small id="autostart-status">${auto === null ? '正在读取系统状态…' : '登录这台电脑后在托盘后台运行。切换立即生效，无需保存。'}</small></span>
          <input name="autostart" type="checkbox" role="switch" ${auto ? 'checked' : ''} ${auto === null || autoBusy ? 'disabled' : ''}>
        </label>
      </section>
      ${syncSettings()}
      <section id="update-settings" class="panel settings settings-card">${updateSettings()}<p class="small muted">更新偏好立即生效，无需保存监控设置。</p></section>
      <section id="help-settings">${renderGuide()}</section>
    </div>`;
  selectSettingsSection(section);
  void loadSync();
  isPermissionGranted()
    .then(ok => {
      const e = document.querySelector('#permission');
      if (e)
        e.textContent = ok
          ? '通知授权：已允许（仍受勿扰模式和系统通知设置影响）'
          : '通知授权：尚未允许；保存并启用通知或发送测试通知时会请求授权。';
    })
    .catch(() => {});
}

export function paintSettingsDraft() {
  const form = deps.content.querySelector<HTMLFormElement>('#settings-form');
  const bar = deps.content.querySelector<HTMLElement>('#settings-draft-bar');
  if (bar) bar.hidden = form?.dataset.dirty !== 'true';
}

document.addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('#restore-settings') || settingsSaving) return;
  const form = deps.content.querySelector<HTMLFormElement>('#settings-form');
  if (!form) return;
  const s = deps.settings();
  for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) {
    if (!(field.name in s)) continue;
    const value = s[field.name as keyof Settings];
    if (field instanceof HTMLInputElement && field.type === 'checkbox') field.checked = value === true;
    else field.value = String(value);
  }
  ignoredDraft = new Set(s.ignored_checks || []);
  form.querySelector('.ignore-list')!.innerHTML = renderIgnoreList();
  refreshSearchSelects(form);
  form.dataset.dirty = 'false';
  paintSettingsDraft();
  deps.toast('已还原监控与代理设置；系统启动、同步和更新偏好保持各自状态。');
  form.querySelector<HTMLInputElement>('[name=interval]')?.focus();
});

export async function permission() {
  let ok = await isPermissionGranted();
  if (!ok) ok = (await requestPermission()) === 'granted';
  if (!ok) deps.toast('通知尚未获允许，请在系统设置 → 通知 → Exit Sentinel 中启用。');
  return ok;
}

export function paintAutostart(message?: string) {
  const input = deps.content.querySelector<HTMLInputElement>('[name=autostart]');
  if (input) {
    input.checked = auto === true;
    input.disabled = auto === null || autoBusy;
    input.setAttribute('aria-busy', String(autoBusy));
  }
  const status = deps.content.querySelector('#autostart-status');
  if (status)
    status.textContent =
      message ||
      (autoBusy
        ? '正在更新系统设置…'
        : auto === null
          ? '无法读取系统状态，请重新进入设置页重试。'
          : '登录这台电脑后在托盘后台运行。切换立即生效，无需保存。');
}

export async function syncAutostart() {
  if (autoBusy) return;
  try {
    auto = await invoke<boolean>('get_autostart');
    paintAutostart();
  } catch (e) {
    auto = null;
    paintAutostart();
    deps.toast(`开机自启状态读取失败：${e}`);
  }
}

document.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.name !== 'ignored_checks') return;
  if (input.checked) ignoredDraft.add(input.value);
  else ignoredDraft.delete(input.value);
  const row = input.closest('.ignore-row');
  row?.classList.toggle('is-ignored', input.checked);
  const state = row?.querySelector('.ignore-state');
  if (state) state.textContent = input.checked ? '已忽略' : '计入状态';
});

// Enter in the list's keyword box filters; it must not submit the settings form.
document.addEventListener('keydown', event => {
  const input = event.target as HTMLElement;
  if (event.key === 'Enter' && input.matches('#settings-form [data-list-action]')) event.preventDefault();
});

document.addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  if (input.name !== 'autostart' || autoBusy) return;
  const wanted = input.checked;
  autoBusy = true;
  paintAutostart();
  try {
    auto = await invoke<boolean>('set_autostart', { enabled: wanted });
    deps.toast(auto ? '已开启开机自启' : '已关闭开机自启');
  } catch (e) {
    try {
      auto = await invoke<boolean>('get_autostart');
    } catch {
      auto = null;
    }
    deps.toast(`开机自启设置失败：${e}`, true);
  } finally {
    autoBusy = false;
    paintAutostart();
  }
});

window.setInterval(() => { if (deps?.isActive() && section === 'permissions-settings' && !document.hidden) void refreshPermissions(); }, 3000);
window.addEventListener('focus', () => {
  if (deps.isActive()) void syncAutostart();
});

document.addEventListener('submit', async event => {
  if ((event.target as HTMLElement).id !== 'settings-form') return;
  event.preventDefault();
  if (settingsSaving) return;
  settingsSaving = true;
  const form = event.target as HTMLFormElement;
  const f = new FormData(form);
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!;
  const controls = Array.from(deps.content.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#settings-form input, #settings-form select, #settings-form button, #settings-draft-bar button'));
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => { control.disabled = true; });
  submit.disabled = true;
  try {
    const s: Settings = {
      manual_nodes_only: f.get('manual_nodes_only') === 'true',
      claude_proxy: String(f.get('claude_proxy') || '').trim(),
      gemini_proxy: String(f.get('gemini_proxy') || '').trim(),
      gemini_ip_url: String(f.get('gemini_ip_url') || '').trim(),
      interval: Number(f.get('interval')),
      notifications: f.has('notifications'),
      retain_history: f.has('retain_history'),
      ipv6: deps.settings().ipv6,
      ipv6_required: f.has('ipv6_required'),
      domestic_proxy: String(f.get('domestic_proxy') || '').trim(),
      foreign_proxy: String(f.get('foreign_proxy') || '').trim(),
      ignored_checks: IGNORABLE.map(([id]) => id).filter(id => ignoredDraft.has(id)),
    };
    if (!s.retain_history && deps.settings().retain_history && deps.historyCount() &&
        !await confirmAction({ title: '停止保存并清空变化记录？', message: `已有的 ${deps.historyCount()} 条变化记录将删除，之后不再保存新记录。`, confirm: '清空并保存设置', danger: true })) return;
    if (s.notifications) await permission();
    await deps.call('save_settings', { settings: s });
    form.dataset.dirty = 'false';
    paintSettingsDraft();
    deps.toast('设置已保存');
  } catch (e) {
    deps.toast(String(e), true);
  } finally {
    settingsSaving = false;
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
  }
});

