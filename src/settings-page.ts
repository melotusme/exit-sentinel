// Settings page: monitoring preferences, autostart, notification permission, sync and usage notes.
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { confirmAction } from './confirm';
import { renderGuide } from './guide';
import { loadSync, syncSettings } from './sync';
import { updateSettings } from './updater';
import { esc } from './ui';
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
  ['probe:cn-ipip', '国内 · IPIP'],
  ['probe:cn-3322', '国内 · 3322'],
  ['probe:global-cf', '国外 · Cloudflare'],
  ['probe:global-ipify', '国外 · ipify'],
  ['probe:cn-v6', '国内 · IPv6'],
  ['probe:global-v6', '国外 · IPv6'],
];
const ignoredChecks = (s: Settings) => `
  <div class="field field-full">
    <span>忽略的检测项</span>
    <div class="ignore-grid">
      ${IGNORABLE.map(([id, name]) => `<label class="ignore-item"><input type="checkbox" name="ignored_checks" value="${id}" ${(s.ignored_checks || []).includes(id) ? 'checked' : ''}> ${esc(name)}</label>`).join('')}
    </div>
    <small>勾选的项目照常检测和显示，但不再让菜单栏变成“部分检测异常”。只保存在本机。</small>
  </div>`;
let auto: boolean | null = null,
  autoBusy = false,
  settingsSaving = false;
export function initSettings(d: SettingsDeps) {
  deps = d;
}
export const settingsBusy = () => settingsSaving;
export function setAutostart(value: boolean | null) {
  auto = value;
  paintAutostart();
}

export function renderSettings(s: Settings) {
  deps.content.innerHTML = `
    <div class="settings-stack">
      <form id="settings-form" class="panel settings settings-card">
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
          <span>开机自启<small id="autostart-status">${auto === null ? '正在读取系统状态…' : '登录这台电脑后在托盘后台运行。切换立即生效，无需保存。'}</small></span>
          <input name="autostart" type="checkbox" role="switch" ${auto ? 'checked' : ''} ${auto === null || autoBusy ? 'disabled' : ''}>
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
        ${updateSettings()}
        <div class="settings-divider"></div>
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
        <div class="form-actions">
          <button class="primary" type="submit">保存设置</button>
          <button type="button" id="test-notification">发送测试通知</button>
        </div>
        <p id="permission" class="small muted status-note"></p>
      </form>
      ${syncSettings()}
      ${renderGuide()}
    </div>`;
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
  const controls = Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button'));
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
      ignored_checks: f.getAll('ignored_checks').map(String),
    };
    if (!s.retain_history && deps.settings().retain_history && deps.historyCount() &&
        !await confirmAction({ title: '停止保存并清空变化记录？', message: `已有的 ${deps.historyCount()} 条变化记录将删除，之后不再保存新记录。`, confirm: '清空并保存设置', danger: true })) return;
    if (s.notifications) await permission();
    await deps.call('save_settings', { settings: s });
    form.dataset.dirty = 'false';
    deps.toast('设置已保存');
  } catch (e) {
    deps.toast(String(e), true);
  } finally {
    settingsSaving = false;
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
  }
});

