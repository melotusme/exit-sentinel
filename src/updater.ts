// Software Updater UI (`#updater-card-host` in Settings -> 更新与关于 + `#software-update` global banner).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setUpdateState } from './store';
import type { UpdatePhase, UpdateStatus } from './types';
import { copyToClipboard, esc, icon } from './ui';

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

function phaseSummary(s: UpdateStatus | null): { label: string; pillClass: string } {
  if (!s) {
    return { label: loaded ? '状态未知' : '正在读取状态…', pillClass: 'pill' };
  }
  switch (s.phase) {
    case 'idle':
      if (s.error) return { label: '上次检查异常', pillClass: 'pill warn' };
      return {
        label: manualCheckFeedback ? '已是最新版本' : '已是最新 / 自动守护中',
        pillClass: 'pill ok',
      };
    case 'checking':
      return { label: '正在检查更新…', pillClass: 'pill' };
    case 'available':
      return { label: `发现新版本 ${formatVersion(s.latestVersion)}`, pillClass: 'pill ok' };
    case 'downloading': {
      const progress = formatProgress(s.received, s.total);
      return {
        label: progress ? `正在下载 ${progress}` : '正在下载新版本…',
        pillClass: 'pill',
      };
    }
    case 'verifying':
      return { label: '正在校验签名与完整性…', pillClass: 'pill' };
    case 'ready_deferred':
      return { label: `${formatVersion(s.latestVersion)} 已就绪，待重启完成`, pillClass: 'pill ok' };
    case 'installing':
      return { label: '正在安装并重启…', pillClass: 'pill ok' };
    case 'error':
      return { label: '更新未完成', pillClass: 'pill risk' };
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
  const summary = phaseSummary(s);
  const hasReadyUpdate = s?.phase === 'available' || s?.phase === 'ready_deferred';

  const progressText =
    s?.phase === 'downloading'
      ? `正在下载新版本 ${formatVersion(s.latestVersion)}${formatProgress(s.received, s.total) ? ` · ${formatProgress(s.received, s.total)}` : '…'}`
      : s?.phase === 'verifying'
        ? '安装包下载完成，正在校验数字签名与完整性…'
        : s?.phase === 'installing'
          ? '正在覆盖安装新版本，完成后将自动重启应用…'
          : '';

  return `<div class="update-app-hero">
      <div class="update-app-identity">
        <span class="update-app-icon">${icon('shield')}</span>
        <div class="update-app-text">
          <div class="update-app-title-row">
            <h2>版本与自动更新</h2>
            <span class="version-pill mono tabular">${esc(formatVersion(s?.currentVersion))}</span>
            <span class="${summary.pillClass} tabular">${esc(summary.label)}</span>
          </div>
          <p class="small muted">出口哨兵（Exit Sentinel）· 匿名读取公开 GitHub Release 并强制校验更新签名</p>
        </div>
      </div>
      <div class="update-hero-actions">
        ${
          hasReadyUpdate
            ? `<button type="button" id="install-software-update-settings" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>
                ${s?.phase === 'ready_deferred' ? '立即重启完成更新' : '立即下载并重启更新'}
              </button>`
            : ''
        }
        <button type="button" id="check-software-update" class="${hasReadyUpdate ? '' : 'primary'}" ${busy ? 'disabled' : ''}>
          ${icon('refresh')}<span>${checking ? '正在检查…' : '检查更新'}</span>
        </button>
      </div>
    </div>

    <div class="update-meta-grid">
      <div class="update-meta-cell">
        <span class="meta-label">当前版本</span>
        <span class="meta-val mono tabular">${esc(formatVersion(s?.currentVersion))}</span>
      </div>
      <div class="update-meta-cell">
        <span class="meta-label">通道状态</span>
        <span class="meta-val tabular">${esc(summary.label)}</span>
      </div>
      <div class="update-meta-cell">
        <span class="meta-label">上次检查时间</span>
        <span class="meta-val mono tabular">${esc(formatCheckedAt(s?.lastCheckedAt ?? null))}</span>
      </div>
    </div>

    ${
      s?.lastUpdatedFrom
        ? `<div class="update-note-box is-success" role="status">
            <div class="update-note-content">
              <strong>已完成后台更新</strong>
              <p class="small">已从 <span class="mono tabular">${esc(formatVersion(s.lastUpdatedFrom))}</span> 平滑升级至 <span class="mono tabular">${esc(formatVersion(s.currentVersion))}</span>，本机配置与记录完整保留。</p>
            </div>
          </div>`
        : ''
    }

    ${
      s && (s.phase === 'downloading' || s.phase === 'verifying' || s.phase === 'installing')
        ? `<div class="update-note-box is-progress" role="status" aria-live="polite">
            <div class="update-note-content is-full">
              <strong class="tabular">${esc(progressText)}</strong>
              ${progressBarHtml(s)}
            </div>
          </div>`
        : ''
    }

    ${
      s?.phase === 'ready_deferred'
        ? `<div class="update-note-box is-ready" role="status">
            <div class="update-note-content">
              <strong>新版本 <span class="mono tabular">${esc(formatVersion(s.latestVersion))}</span> 已下载并校验通过</strong>
              <p class="small muted">关闭主窗口回到托盘后将自动完成安装；你也可以点击“立即重启完成更新”。</p>
              ${s.notes ? `<div class="update-notes">${esc(s.notes)}</div>` : ''}
            </div>
          </div>`
        : ''
    }

    ${
      s?.phase === 'available'
        ? `<div class="update-note-box is-available" role="status">
            <div class="update-note-content">
              <strong>发现可用新版本 <span class="mono tabular">${esc(formatVersion(s.latestVersion))}</span>（当前 <span class="mono tabular">${esc(formatVersion(s.currentVersion))}</span>）</strong>
              ${s.notes ? `<div class="update-notes">${esc(s.notes)}</div>` : '<p class="small muted">该版本未附带详细更新说明。</p>'}
            </div>
          </div>`
        : ''
    }

    ${
      s && !s.canSilentInstall && s.autoUpdateCheck && s.autoUpdateInstall
        ? `<div class="warning update-warning" role="status">
            <span><strong>后台静默安装受限</strong>：${esc(s.silentBlockedReason || '当前安装目录需要管理员或交互权限，发现新版本后将提示你手动确认更新。')}</span>
          </div>`
        : ''
    }

    ${
      err
        ? `<div class="update-error-box" role="alert">
            <div class="update-note-content">
              <strong>${err.isManual ? '检查或安装更新失败' : '后台自动更新未完成'}</strong>
              <p class="update-error-text mono">${esc(err.text)}</p>
            </div>
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

    <div class="update-switches">
      <label class="toggle">
        <span>自动检查新版本<small>启动后及每 <span class="tabular">6</span> 小时检查一次新版本，无需登录 GitHub，不上传任何本机配置或网络记录。</small></span>
        <input name="auto_update_check" type="checkbox" role="switch" data-immediate="true" ${autoCheck ? 'checked' : ''} ${toggleDisabled ? 'disabled' : ''}>
      </label>
      <label class="toggle${!autoCheck ? ' is-disabled' : ''}">
        <span>发现更新后后台自动安装<small>后台下载并校验签名后自动完成覆盖升级；主窗口打开时会等待关闭到托盘后再执行，避免打断当前操作。</small></span>
        <input name="auto_update_install" type="checkbox" role="switch" data-immediate="true" ${autoCheck && autoInstall ? 'checked' : ''} ${toggleDisabled || !autoCheck ? 'disabled' : ''}>
      </label>
    </div>`;
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
          <strong>新版本 <span class="mono tabular">${esc(formatVersion(s.latestVersion))}</span> 已下载并校验，关闭窗口后将自动升级</strong>
        </div>
        <div class="form-actions">
          <button type="button" id="install-software-update" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>立即重启更新</button>
          <button type="button" id="dismiss-software-update">稍后</button>
        </div>
      </section>`;
    } else if (s?.phase === 'available') {
      const blockedSuffix =
        !s.canSilentInstall && s.autoUpdateCheck && s.autoUpdateInstall && s.silentBlockedReason
          ? ` · ${esc(s.silentBlockedReason)}`
          : '';
      html = `<section class="notice update-banner">
        <div class="update-banner-body">
          <strong>发现新版本 <span class="mono tabular">${esc(formatVersion(s.latestVersion))}</span>（当前 <span class="mono tabular">${esc(formatVersion(s.currentVersion))}</span>）</strong>
          ${blockedSuffix ? `<span class="small muted">${blockedSuffix}</span>` : ''}
        </div>
        <div class="form-actions">
          <button type="button" id="install-software-update" data-update-action="install" class="primary" ${busy ? 'disabled' : ''}>立即下载并重启更新</button>
          <button type="button" id="dismiss-software-update">稍后</button>
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
            ? '下载完成，正在验证更新包签名…'
            : '正在安装更新并准备重启…';
      html = `<section class="notice update-banner">
        <div class="update-banner-body is-full">
          <strong class="tabular">${esc(title)}</strong>
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
          <button type="button" id="dismiss-software-update">关闭</button>
        </div>
      </section>`;
    }
  }

  host.hidden = !html;
  host.innerHTML = html;
}

function paintSettingsPanel() {
  const host =
    document.querySelector<HTMLElement>('#updater-card-host') ||
    document.querySelector<HTMLElement>('#update-settings');
  if (!host) return;

  const active =
    document.activeElement instanceof HTMLElement && host.contains(document.activeElement)
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
  setUpdateState(next);
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
      manualCheckFeedback = '当前已是最新版本，无需更新。';
      paintAll();
      const settingsPanel = document.querySelector<HTMLElement>('#update-settings');
      if (!settingsPanel || settingsPanel.hidden) {
        notify?.('当前已是最新版本');
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
  const ok = await copyToClipboard(buildCopyableError(err.text));
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
        nextInstall ? '已开启后台自动安装更新' : '已关闭后台自动安装，发现新版本后将提醒你确认'
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
      // Retry migration next launch if backend is temporarily unavailable.
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
