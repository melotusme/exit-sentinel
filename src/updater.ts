import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { esc } from './ui';
import type { UpdatePhase, UpdateStatus } from './types';

const LEGACY_AUTO_UPDATE_KEY = 'exit-sentinel.auto-update-check';

type ToastFn = (message: string, persistent?: boolean) => void;

let status: UpdateStatus | null = null;
let loaded = false;
let initialized = false;
let settingsBusy = false;
let actionBusy = false;
let manualInstallInFlight = false;
let lastAttempt: 'check' | 'install' = 'check';
let manualCheckFeedback: string | null = null;
let localError: { message: string; isManual: boolean } | null = null;
let bannerDismissedKey: string | null = null;
let copyFeedbackTarget: 'settings' | 'banner' | null = null;
let copyTimer: ReturnType<typeof setTimeout> | undefined;
let notify: ToastFn | undefined;

const isBusyPhase = (phase: UpdatePhase) =>
  phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'installing';

function formatVersion(v: string | null | undefined): string {
  if (!v) return '—';
  return v.startsWith('v') ? v : `v${v}`;
}

function formatCheckedAt(unixSeconds: number | null): string {
  if (unixSeconds === null || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return '尚未检查';
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

function formatProgress(received: number, total: number | null): string {
  if (total && total > 0) {
    const pct = Math.min(100, Math.round((received / total) * 100));
    const recvMb = (received / 1048576).toFixed(1);
    const totalMb = (total / 1048576).toFixed(1);
    return `${pct}%（${recvMb} / ${totalMb} MiB）`;
  }
  if (received > 0) {
    return `${(received / 1048576).toFixed(1)} MiB`;
  }
  return '';
}

function effectiveError(): { text: string; isManual: boolean } | null {
  if (localError) return { text: localError.message, isManual: localError.isManual };
  if (status?.error) return { text: status.error, isManual: status.errorIsManual };
  return null;
}

function buildCopyableError(errorText: string): string {
  const lines = [
    'Exit Sentinel 软件更新错误',
    status?.currentVersion ? `当前版本: ${formatVersion(status.currentVersion)}` : null,
    status?.latestVersion ? `目标版本: ${formatVersion(status.latestVersion)}` : null,
    `错误详情: ${errorText}`,
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

function phaseSummary(s: UpdateStatus | null): string {
  if (!s) return loaded ? '状态未知' : '正在读取状态…';
  switch (s.phase) {
    case 'idle':
      if (s.error) return '上次更新失败';
      return manualCheckFeedback ? '已是最新版本' : '空闲';
    case 'checking':
      return '正在检查更新…';
    case 'available':
      return `发现新版本 ${formatVersion(s.latestVersion)}`;
    case 'downloading': {
      const progress = formatProgress(s.received, s.total);
      return progress ? `正在下载更新 ${progress}` : '正在下载更新…';
    }
    case 'verifying':
      return '正在校验签名与完整性…';
    case 'ready_deferred':
      return `${formatVersion(s.latestVersion)} 已就绪，关闭窗口后更新`;
    case 'installing':
      return '正在安装更新并重启…';
    case 'error':
      return '更新未完成';
  }
}

function bannerKey(s: UpdateStatus | null, err: { text: string; isManual: boolean } | null): string {
  return [
    s?.phase ?? 'none',
    s?.latestVersion ?? '',
    err ? `${err.isManual ? 'm' : 'b'}:${err.text}` : '',
    manualInstallInFlight ? 'manual-install' : '',
  ].join('|');
}

function isActionDisabled(): boolean {
  return actionBusy || (status !== null && isBusyPhase(status.phase));
}

function progressBarHtml(s: UpdateStatus): string {
  if (s.phase === 'downloading' && s.total && s.total > 0) {
    const pct = Math.min(100, Math.round((s.received / s.total) * 100));
    return `<div class="update-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
      <div class="update-progress-fill" style="width:${pct}%"></div>
    </div>`;
  }
  return `<div class="update-progress-track is-indeterminate" role="progressbar" aria-label="更新处理中">
    <div class="update-progress-fill"></div>
  </div>`;
}

export function getUpdatePreferences(): { auto_update_check: boolean; auto_update_install: boolean } | null {
  if (!status) return null;
  return {
    auto_update_check: status.autoUpdateCheck,
    auto_update_install: status.autoUpdateInstall,
  };
}

export function updateSettings(): string {
  const s = status;
  const err = effectiveError();
  const autoCheck = s ? s.autoUpdateCheck : true;
  const autoInstall = s ? s.autoUpdateInstall : true;
  const busy = isActionDisabled();
  const checking = s?.phase === 'checking';
  const toggleDisabled = !loaded || settingsBusy;

  const progressText =
    s?.phase === 'downloading'
      ? `正在下载新版本 ${formatVersion(s.latestVersion)}${formatProgress(s.received, s.total) ? ` · ${formatProgress(s.received, s.total)}` : '…'}`
      : s?.phase === 'verifying'
        ? '下载完成，正在校验签名与完整性…'
        : s?.phase === 'installing'
          ? '正在安装更新，完成后将自动重启应用…'
          : '';

  return `<div class="card-header-block compact">
      <div>
        <span class="eyebrow">UPDATES</span>
        <h2>软件更新</h2>
      </div>
      <button type="button" id="check-software-update" ${busy ? 'disabled' : ''}>${checking ? '正在检查…' : '立即检查更新'}</button>
    </div>
    <div class="update-meta-grid">
      <div class="update-meta-cell">
        <span class="meta-label">当前版本</span>
        <span class="meta-val mono">${esc(formatVersion(s?.currentVersion))}</span>
      </div>
      <div class="update-meta-cell">
        <span class="meta-label">更新状态</span>
        <span class="meta-val">${esc(phaseSummary(s))}</span>
      </div>
      <div class="update-meta-cell">
        <span class="meta-label">上次检查</span>
        <span class="meta-val mono">${esc(formatCheckedAt(s?.lastCheckedAt ?? null))}</span>
      </div>
    </div>
    ${
      s?.lastUpdatedFrom
        ? `<div class="update-note-box is-success" role="status">
            <strong>已完成静默更新</strong>
            <p class="small">已在后台静默从 ${esc(formatVersion(s.lastUpdatedFrom))} 更新至 ${esc(formatVersion(s.currentVersion))}。</p>
          </div>`
        : ''
    }
    ${
      s && (s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing')
        ? `<div class="update-note-box is-progress" role="status" aria-live="polite">
            <strong>${esc(progressText)}</strong>
            ${progressBarHtml(s)}
          </div>`
        : ''
    }
    ${
      s?.phase === 'ready_deferred'
        ? `<div class="update-note-box is-ready" role="status">
            <div class="update-note-content">
              <strong>新版本 ${esc(formatVersion(s.latestVersion))} 已下载并校验，关闭窗口后自动更新</strong>
              <p class="small muted">关闭主窗口到托盘后将自动静默安装并重启；也可以立即重启更新。</p>
              ${s.notes ? `<p class="update-notes">${esc(s.notes)}</p>` : ''}
            </div>
            <div class="form-actions">
              <button type="button" id="install-software-update-settings" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>立即重启更新</button>
            </div>
          </div>`
        : ''
    }
    ${
      s?.phase === 'available'
        ? `<div class="update-note-box is-available" role="status">
            <div class="update-note-content">
              <strong>发现新版本 ${esc(formatVersion(s.latestVersion))}（当前 ${esc(formatVersion(s.currentVersion))}）</strong>
              ${s.notes ? `<p class="update-notes">${esc(s.notes)}</p>` : '<p class="small muted">此版本未提供更新说明。</p>'}
            </div>
            <div class="form-actions">
              <button type="button" id="install-software-update-settings" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>安装并重启</button>
            </div>
          </div>`
        : ''
    }
    ${
      s && !s.canSilentInstall && s.autoUpdateCheck && s.autoUpdateInstall
        ? `<div class="warning update-warning" role="status">
            自动静默安装当前受限：${esc(s.silentBlockedReason || '当前运行环境或安装目录不支持静默写入，发现新版本后需手动确认安装。')}
          </div>`
        : ''
    }
    ${
      err
        ? `<div class="update-error-box" role="alert">
            <div class="update-error-head">
              <strong>${err.isManual ? '软件更新失败' : '后台自动更新失败'}</strong>
            </div>
            <p class="update-error-text mono">${esc(err.text)}</p>
            <div class="form-actions">
              <button type="button" data-update-action="copy-error" data-copy-target="settings">${copyFeedbackTarget === 'settings' ? '已复制' : '复制错误信息'}</button>
              <button type="button" data-update-action="retry" class="primary" ${busy ? 'disabled' : ''}>重试</button>
            </div>
          </div>`
        : ''
    }
    ${
      !err && manualCheckFeedback && s?.phase === 'idle'
        ? `<p class="small muted status-note" role="status">${esc(manualCheckFeedback)}</p>`
        : ''
    }
    <label class="toggle">
      <span>自动检查新版本<small>从公开的 GitHub Release 匿名读取，无需登录；启动后及每 6 小时自动检查，不上传本机出口与节点记录。</small></span>
      <input name="auto_update_check" type="checkbox" role="switch" ${autoCheck ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''}>
    </label>
    <label class="toggle${!autoCheck ? ' is-disabled' : ''}">
      <span>发现新版本后自动静默安装并重启<small>在后台下载并校验签名后自动完成更新。若主窗口当前打开，会等待关闭窗口到托盘后再安装，避免打断操作。</small></span>
      <input name="auto_update_install" type="checkbox" role="switch" ${autoCheck && autoInstall ? 'checked' : ''} ${toggleDisabled || !autoCheck ? 'disabled' : ''}>
    </label>
    <p class="small muted status-note">更新偏好保存在本机并立即生效，无需保存监控设置；托盘菜单中的“自动静默更新”会同步此开关。</p>`;
}

function paintBanner() {
  const host = document.querySelector<HTMLElement>('#software-update');
  if (!host) return;

  const s = status;
  const err = effectiveError();
  const key = bannerKey(s, err);
  const busy = isActionDisabled();

  let html = '';

  if (bannerDismissedKey !== key) {
    if (s?.phase === 'ready_deferred') {
      html = `<section class="notice update-banner is-ready">
        <div class="update-banner-body">
          <strong>新版本 ${esc(formatVersion(s.latestVersion))} 已下载并校验，关闭窗口后将自动更新</strong>
          <p class="small muted">关闭主窗口到托盘后将在后台静默安装并重启，也可立即重启更新。</p>
          ${s.notes ? `<p class="update-notes">${esc(s.notes)}</p>` : ''}
        </div>
        <div class="form-actions">
          <button type="button" id="install-software-update" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>立即重启更新</button>
          <button type="button" id="dismiss-software-update">关闭提示</button>
        </div>
      </section>`;
    } else if (s?.phase === 'available') {
      const blockedNote =
        !s.canSilentInstall && s.autoUpdateCheck && s.autoUpdateInstall && s.silentBlockedReason
          ? `<p class="small muted">静默安装不可用：${esc(s.silentBlockedReason)}</p>`
          : '';
      html = `<section class="notice update-banner">
        <div class="update-banner-body">
          <strong>发现新版本 ${esc(formatVersion(s.latestVersion))}（当前 ${esc(formatVersion(s.currentVersion))}）</strong>
          ${blockedNote}
          ${s.notes ? `<p class="update-notes">${esc(s.notes)}</p>` : '<p class="update-notes">此版本未提供更新说明。</p>'}
        </div>
        <div class="form-actions">
          <button type="button" id="install-software-update" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>安装并重启</button>
          <button type="button" id="dismiss-software-update">关闭提示</button>
        </div>
      </section>`;
    } else if (
      s &&
      manualInstallInFlight &&
      (s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing')
    ) {
      const title =
        s.phase === 'downloading'
          ? `正在下载更新${formatProgress(s.received, s.total) ? ` ${formatProgress(s.received, s.total)}` : '…'}`
          : s.phase === 'verifying'
            ? '下载完成，正在验证签名…'
            : '正在安装更新，完成后将自动重启…';
      html = `<section class="notice update-banner">
        <div class="update-banner-body">
          <strong>${esc(title)}</strong>
          ${progressBarHtml(s)}
        </div>
      </section>`;
    } else if (err && err.isManual) {
      html = `<section class="notice update-banner is-error" role="alert">
        <div class="update-banner-body">
          <strong>软件更新未完成</strong>
          <p class="update-error-text mono">${esc(err.text)}</p>
        </div>
        <div class="form-actions">
          <button type="button" data-update-action="copy-error" data-copy-target="banner">${copyFeedbackTarget === 'banner' ? '已复制' : '复制错误信息'}</button>
          <button type="button" data-update-action="retry" class="primary" ${busy ? 'disabled' : ''}>重试</button>
          <button type="button" id="dismiss-software-update">关闭提示</button>
        </div>
      </section>`;
    }
  }

  host.hidden = !html;
  host.innerHTML = html;
}

function paintSettingsPanel() {
  const host = document.querySelector<HTMLElement>('#update-settings');
  if (!host) return;

  const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusSelector = active
    ? active.id
      ? `#${CSS.escape(active.id)}`
      : active instanceof HTMLInputElement && active.name
        ? `input[name="${CSS.escape(active.name)}"]`
        : active instanceof HTMLButtonElement && active.dataset.updateAction
          ? `button[data-update-action="${CSS.escape(active.dataset.updateAction)}"]`
          : null
    : null;

  host.innerHTML = updateSettings();

  if (focusSelector) {
    const replacement = host.querySelector<HTMLElement>(focusSelector);
    if (replacement && !(replacement as HTMLButtonElement | HTMLInputElement).disabled) {
      replacement.focus({ preventScroll: true });
    }
  }
}

function paintAll() {
  paintBanner();
  paintSettingsPanel();
}

function applyStatus(next: UpdateStatus) {
  loaded = true;
  status = next;
  localError = null;
  if (next.phase !== 'idle' || next.error || next.latestVersion) {
    manualCheckFeedback = null;
  }
  if (!isBusyPhase(next.phase)) {
    manualInstallInFlight = false;
  }
  paintAll();
}

export function revealUpdateUi() {
  bannerDismissedKey = null;
  paintBanner();
  void refreshUpdateStatus();
}

export async function refreshUpdateStatus() {
  try {
    const current = await invoke<UpdateStatus>('get_update_status');
    applyStatus(current);
  } catch (e) {
    loaded = true;
    localError = { message: `读取更新状态失败：${String(e)}`, isManual: false };
    paintAll();
  }
}

async function triggerManualCheck() {
  if (isActionDisabled()) return;
  lastAttempt = 'check';
  actionBusy = true;
  localError = null;
  manualCheckFeedback = null;
  bannerDismissedKey = null;
  paintAll();
  try {
    const result = await invoke<UpdateStatus>('check_update');
    applyStatus(result);
    if (result.phase === 'idle' && !result.error) {
      manualCheckFeedback = '当前已经是最新版本。';
      paintAll();
      const settingsPanel = document.querySelector<HTMLElement>('#update-settings');
      if (!settingsPanel || settingsPanel.hidden) {
        notify?.('当前已经是最新版本。');
      }
    }
  } catch (e) {
    const msg = String(e);
    if (status?.error !== msg || !status?.errorIsManual) {
      localError = { message: msg, isManual: true };
    }
    paintAll();
  } finally {
    actionBusy = false;
    paintAll();
  }
}

async function triggerInstall() {
  if (isActionDisabled()) return;
  lastAttempt = 'install';
  actionBusy = true;
  manualInstallInFlight = true;
  localError = null;
  bannerDismissedKey = null;
  paintAll();
  try {
    await invoke('install_update');
    // Rust handles restart on all platforms; keep state refreshed in case the process stays alive briefly.
  } catch (e) {
    manualInstallInFlight = false;
    const msg = String(e);
    if (status?.error !== msg || !status?.errorIsManual) {
      localError = { message: msg, isManual: true };
    }
    paintAll();
  } finally {
    actionBusy = false;
    paintAll();
  }
}

async function updatePreferences(autoUpdateCheck: boolean, autoUpdateInstall: boolean, feedbackLabel: string) {
  if (settingsBusy) return;
  settingsBusy = true;
  localError = null;
  paintSettingsPanel();
  try {
    const updated = await invoke<UpdateStatus>('set_update_settings', {
      autoUpdateCheck,
      autoUpdateInstall,
    });
    applyStatus(updated);
    notify?.(feedbackLabel);
  } catch (e) {
    const msg = `保存更新偏好失败：${String(e)}`;
    localError = { message: msg, isManual: true };
    notify?.(msg, true);
    paintAll();
  } finally {
    settingsBusy = false;
    paintSettingsPanel();
  }
}

async function copyError(target: 'settings' | 'banner') {
  const err = effectiveError();
  if (!err) return;
  const payload = buildCopyableError(err.text);
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      ok = true;
    }
  } catch {}
  if (!ok) {
    try {
      const area = document.createElement('textarea');
      area.value = payload;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      area.style.pointerEvents = 'none';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch {}
  }
  if (ok) {
    copyFeedbackTarget = target;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyFeedbackTarget = null;
      paintAll();
    }, 2000);
    paintAll();
  } else {
    notify?.('无法访问剪贴板，请手动选中错误信息复制。');
  }
}

function bindEvents() {
  document.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.id === 'check-software-update') {
      void triggerManualCheck();
      return;
    }
    if (button.id === 'dismiss-software-update') {
      bannerDismissedKey = bannerKey(status, effectiveError());
      paintBanner();
      return;
    }
    const action = button.dataset.updateAction;
    if (!action) return;
    if (action === 'install') {
      void triggerInstall();
    } else if (action === 'copy-error') {
      const target = button.dataset.copyTarget === 'banner' ? 'banner' : 'settings';
      void copyError(target);
    } else if (action === 'retry') {
      if (lastAttempt === 'install' && status?.latestVersion) {
        void triggerInstall();
      } else {
        void triggerManualCheck();
      }
    }
  });

  document.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.name === 'auto_update_check') {
      const nextCheck = input.checked;
      const currentInstall = status?.autoUpdateInstall ?? true;
      void updatePreferences(
        nextCheck,
        currentInstall,
        nextCheck ? '已开启自动检查新版本' : '已关闭自动检查新版本'
      );
      return;
    }
    if (input.name === 'auto_update_install') {
      const nextInstall = input.checked;
      void updatePreferences(
        true,
        nextInstall,
        nextInstall ? '已开启自动静默更新' : '已关闭自动静默安装，发现新版本后将提醒确认'
      );
    }
  });
}

async function migrateLegacyPreference() {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_AUTO_UPDATE_KEY);
  } catch {
    return;
  }
  if (legacy === 'false') {
    try {
      const migrated = await invoke<UpdateStatus>('set_update_settings', {
        autoUpdateCheck: false,
        autoUpdateInstall: false,
      });
      applyStatus(migrated);
      try {
        localStorage.removeItem(LEGACY_AUTO_UPDATE_KEY);
      } catch {}
    } catch {
      // Keep the legacy key so migration can retry on next launch if backend was unavailable.
    }
  } else if (legacy !== null) {
    try {
      localStorage.removeItem(LEGACY_AUTO_UPDATE_KEY);
    } catch {}
  }
}

export async function initUpdates(toast?: ToastFn) {
  notify = toast;
  if (!initialized) {
    initialized = true;
    bindEvents();
    await listen<UpdateStatus>('update-status', e => {
      applyStatus(e.payload);
    });
    await listen('check-update', () => {
      void triggerManualCheck();
    });
  }
  await migrateLegacyPreference();
  if (!loaded) {
    await refreshUpdateStatus();
  }
}
