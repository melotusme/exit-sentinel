// WebDAV Cloud Sync section (`webdav-settings`) inside Settings.

import { invoke } from '@tauri-apps/api/core';
import { confirmAction } from './confirm';
import type { SyncConfig } from './types';
import { esc, icon, showToast, time } from './ui';

type FeedbackTone = 'neutral' | 'ok' | 'warn' | 'risk';

let config: SyncConfig | null = null;
let busy = false;
let dirty = false;
let loadGeneration = 0;
let lastFeedback: { text: string; tone: FeedbackTone } | null = null;
let eventsBound = false;

export function hasUnsavedSync(): boolean {
  return dirty;
}

export function discardUnsavedSync(): void {
  dirty = false;
}

export function syncInProgress(): boolean {
  return busy;
}

function formatSyncTimestamp(raw: string | undefined | null): string {
  if (!raw) return '尚未同步';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) {
    return time(raw);
  }
  return raw;
}

function stateBadge(c: SyncConfig | null): { label: string; cls: string } {
  if (c?.has_password && c?.last_sync) {
    return { label: '已连接 · 可同步', cls: 'pill ok' };
  }
  if (c?.has_password) {
    return { label: '已保存密钥', cls: 'pill ok' };
  }
  return { label: '未配置凭据', cls: 'pill' };
}

function defaultFeedback(c: SyncConfig | null): { text: string; tone: FeedbackTone } {
  if (c?.last_sync) {
    return {
      text: `上次云端同步已完成（${formatSyncTimestamp(c.last_sync)}）。可在多台设备间上传或拉取信任记录。`,
      tone: 'neutral',
    };
  }
  if (c?.has_password) {
    return {
      text: 'WebDAV 凭据已就绪。建议先点击“测试连接”，首次同步请在已有记录的主力设备上点击“上传本机配置到云端”。',
      tone: 'neutral',
    };
  }
  return {
    text: '尚未配置 WebDAV。可手动填写坚果云等 WebDAV 服务地址与应用密码，或一键从本机 Clash Verge 导入。',
    tone: 'neutral',
  };
}

export function syncSettings(): string {
  bindSyncEventsOnce();
  const badge = stateBadge(config);
  const hasSecret = Boolean(config?.has_password);
  const fb = lastFeedback || defaultFeedback(config);

  return `<div id="webdav-settings" class="settings-section">
    <section class="panel settings settings-card">
      <div class="card-head">
        <div>
          <h2>WebDAV 云端连接配置</h2>
          <p class="small muted">跨设备同步检测间隔、通知开关及已登记的 Claude / Gemini 出口 IP 与节点标记；本机代理端口与开机自启独立保留。</p>
        </div>
        <div class="card-head-actions">
          <span class="${badge.cls}" id="dav-state">${esc(badge.label)}</span>
          <button type="button" data-dav="import" title="读取本机 Clash Verge Rev 已保存的 WebDAV 地址与密钥">
            ${icon('cloud')}<span>从 Clash Verge 导入 WebDAV 配置</span>
          </button>
        </div>
      </div>

      <div class="settings-grid">
        <div class="field">
          <label for="dav-url">WebDAV 服务器地址</label>
          <input
            id="dav-url"
            class="mono"
            name="webdav-url"
            type="url"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            value="${esc(config?.url || 'https://dav.jianguoyun.com/dav/')}"
            placeholder="https://dav.jianguoyun.com/dav/"
          >
          <small>支持坚果云或自建 HTTPS WebDAV 目录，配置文件自动保存在 <code class="mono">ExitSentinel/exit-sentinel-v1.json</code>。</small>
        </div>

        <div class="field">
          <label for="dav-user">用户名</label>
          <input
            id="dav-user"
            name="webdav-user"
            type="text"
            autocomplete="username"
            autocorrect="off"
            autocapitalize="none"
            spellcheck="false"
            value="${esc(config?.username || '')}"
            placeholder="例如：name@example.com"
          >
          <small>填写 WebDAV 登录账号（坚果云为注册邮箱）。</small>
        </div>

        <div class="field field-full">
          <div class="field-label-row">
            <label for="dav-secret">应用密码 / 密钥</label>
            <span id="dav-secret-cue" class="pill ok" ${hasSecret ? '' : 'hidden'}>已保存密钥</span>
          </div>
          <div class="dav-secret-wrap">
            <input
              id="dav-secret"
              name="webdav-secret"
              type="password"
              autocomplete="new-password"
              placeholder="${hasSecret ? '已保存密钥（留空则继续使用现有密钥）' : '填写第三方应用专用密码或 WebDAV 密钥'}"
            >
            <button type="button" id="toggle-dav-secret" class="dav-secret-toggle" aria-pressed="false" aria-label="显示应用密码">显示</button>
          </div>
          <small>密钥仅加密保存在本机系统凭据库（Windows 凭据管理器 / macOS 钥匙串 / Linux Keyring），不会写入云端同步文件。</small>
        </div>
      </div>

      <div class="form-actions dav-save-row">
        <button type="button" class="primary" data-dav="save">保存同步配置</button>
        <span id="dav-dirty-note" class="small warn-text" ${dirty ? '' : 'hidden'}>连接信息有未保存修改</span>
      </div>
    </section>

    <section class="panel settings settings-card">
      <div class="card-head">
        <div>
          <h2>云端同步操作</h2>
          <p class="small muted">每次覆盖前均会自动备份旧版配置，防止多设备误操作丢失记录。</p>
        </div>
        <div class="dav-sync-meta">
          <span class="meta-label">上次同步时间</span>
          <span id="dav-last-sync" class="mono tabular">${esc(formatSyncTimestamp(config?.last_sync))}</span>
        </div>
      </div>

      <div class="form-actions dav-action-bar">
        <button type="button" data-dav="test">${icon('pulse')}<span>测试连接</span></button>
        <button type="button" class="primary" data-dav="push">${icon('cloud')}<span>上传本机配置到云端</span></button>
        <button type="button" data-dav="pull">${icon('refresh')}<span>从云端拉取覆盖本机</span></button>
      </div>

      <div id="dav-message" class="dav-feedback tone-${fb.tone}" role="status" aria-live="polite">
        ${esc(fb.text)}
      </div>
    </section>
  </div>`;
}

function syncDomFromConfig(c: SyncConfig | null, updateInputs: boolean) {
  const host = document.querySelector<HTMLElement>('#webdav-settings');
  if (!host || !host.isConnected) return;

  if (updateInputs) {
    const url = host.querySelector<HTMLInputElement>('#dav-url');
    const user = host.querySelector<HTMLInputElement>('#dav-user');
    const secret = host.querySelector<HTMLInputElement>('#dav-secret');
    const toggleBtn = host.querySelector<HTMLButtonElement>('#toggle-dav-secret');
    if (url) url.value = c?.url || 'https://dav.jianguoyun.com/dav/';
    if (user) user.value = c?.username || '';
    if (secret) {
      secret.value = '';
      secret.type = 'password';
      secret.placeholder = c?.has_password
        ? '已保存密钥（留空则继续使用现有密钥）'
        : '填写第三方应用专用密码或 WebDAV 密钥';
    }
    if (toggleBtn) {
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.setAttribute('aria-label', '显示应用密码');
      toggleBtn.textContent = '显示';
    }
  }

  const badgeEl = host.querySelector<HTMLElement>('#dav-state');
  if (badgeEl) {
    const b = stateBadge(c);
    badgeEl.className = b.cls;
    badgeEl.textContent = b.label;
  }

  const cueEl = host.querySelector<HTMLElement>('#dav-secret-cue');
  if (cueEl) cueEl.hidden = !c?.has_password;

  const lastSyncEl = host.querySelector<HTMLElement>('#dav-last-sync');
  if (lastSyncEl) lastSyncEl.textContent = formatSyncTimestamp(c?.last_sync);

  const dirtyNote = host.querySelector<HTMLElement>('#dav-dirty-note');
  if (dirtyNote) dirtyNote.hidden = !dirty;
}

function setFeedback(text: string, tone: FeedbackTone = 'neutral') {
  lastFeedback = { text, tone };
  const el = document.querySelector<HTMLElement>('#dav-message');
  if (el) {
    el.className = `dav-feedback tone-${tone}`;
    el.textContent = text;
  }
}

function setControlsDisabled(disabled: boolean) {
  document.querySelectorAll<HTMLButtonElement>('#webdav-settings [data-dav], #toggle-dav-secret').forEach(b => {
    b.disabled = disabled;
  });
  document.querySelectorAll<HTMLInputElement>('#webdav-settings input').forEach(input => {
    input.disabled = disabled;
  });
}

async function saveCurrentInputs(): Promise<boolean> {
  const url = document.querySelector<HTMLInputElement>('#dav-url')?.value.trim() || '';
  const username = document.querySelector<HTMLInputElement>('#dav-user')?.value.trim() || '';
  const secret = document.querySelector<HTMLInputElement>('#dav-secret')?.value || '';
  config = await invoke<SyncConfig>('save_sync_config', { url, username, secret });
  dirty = false;
  syncDomFromConfig(config, true);
  return true;
}

export async function loadSync(): Promise<void> {
  const generation = ++loadGeneration;
  try {
    const loaded = await invoke<SyncConfig>('get_sync_config');
    if (generation !== loadGeneration) return;
    config = loaded;
    if (!dirty) {
      syncDomFromConfig(loaded, true);
      if (!lastFeedback) {
        const fb = defaultFeedback(loaded);
        setFeedback(fb.text, fb.tone);
      }
    } else {
      syncDomFromConfig(loaded, false);
    }
  } catch (e) {
    if (generation === loadGeneration) {
      setFeedback(String(e), 'risk');
    }
  }
}

function bindSyncEventsOnce() {
  if (eventsBound) return;
  eventsBound = true;

  document.addEventListener('input', e => {
    const target = e.target as HTMLElement;
    if (!target.matches('#dav-url, #dav-user, #dav-secret')) return;
    dirty = true;
    const dirtyNote = document.querySelector<HTMLElement>('#dav-dirty-note');
    if (dirtyNote) dirtyNote.hidden = false;
  });

  document.addEventListener('click', async e => {
    const toggleSecret = (e.target as HTMLElement).closest<HTMLButtonElement>('#toggle-dav-secret');
    if (toggleSecret && !toggleSecret.disabled) {
      const secretInput = document.querySelector<HTMLInputElement>('#dav-secret');
      if (!secretInput) return;
      const nextShow = secretInput.type === 'password';
      secretInput.type = nextShow ? 'text' : 'password';
      toggleSecret.setAttribute('aria-pressed', String(nextShow));
      toggleSecret.setAttribute('aria-label', nextShow ? '隐藏应用密码' : '显示应用密码');
      toggleSecret.textContent = nextShow ? '隐藏' : '显示';
      return;
    }

    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dav]');
    const action = btn?.dataset.dav;
    if (!action || busy || btn?.disabled) return;

    if (
      action === 'import' &&
      dirty &&
      !(await confirmAction({
        title: '覆盖未保存的 WebDAV 输入？',
        message: '从 Clash Verge 导入将替换当前尚未保存的服务器地址与账号输入。',
        confirm: '继续导入',
      }))
    ) {
      return;
    }

    if (
      (action === 'test' || action === 'push' || action === 'pull') &&
      dirty &&
      !(await confirmAction({
        title: '先保存当前连接配置？',
        message: '检测到 WebDAV 地址、用户名或密钥有未保存修改，需先保存后再执行此同步操作。',
        confirm: '保存并继续',
      }))
    ) {
      return;
    }

    if (
      action === 'pull' &&
      !(await confirmAction({
        title: '从云端拉取并覆盖本机配置？',
        message: '云端的检测间隔、通知开关及已登记的 AI 出口 IP 与节点记录将替换本机对应数据。',
        detail: '覆盖前会自动在本机生成备份文件；本机代理端口、忽略项与开机自启设置保持不变。',
        confirm: '备份并覆盖本机',
        danger: true,
      }))
    ) {
      return;
    }

    busy = true;
    ++loadGeneration;
    setControlsDisabled(true);
    setFeedback('正在与 WebDAV 服务通信，请稍候…', 'neutral');

    try {
      if (action === 'save') {
        await saveCurrentInputs();
        const msg = 'WebDAV 同步配置已保存，密钥已存入系统凭据库。';
        setFeedback(msg, 'ok');
        showToast('已保存 WebDAV 同步配置', { tone: 'safe' });
      } else if (action === 'import') {
        config = await invoke<SyncConfig>('import_verge_webdav');
        dirty = false;
        syncDomFromConfig(config, true);
        const msg = '已从本机 Clash Verge 导入 WebDAV 配置与密钥（未修改 Clash Verge 原配置）。';
        setFeedback(msg, 'ok');
        showToast('已从 Clash Verge 导入 WebDAV 配置', { tone: 'safe' });
      } else {
        if (dirty) {
          await saveCurrentInputs();
        }
        const resultText = await invoke<string>('sync_action', { action });
        config = await invoke<SyncConfig>('get_sync_config');
        syncDomFromConfig(config, false);
        setFeedback(resultText, 'ok');
        showToast(resultText, { tone: 'safe' });
      }
    } catch (err) {
      const errMsg = String(err);
      setFeedback(errMsg, 'risk');
      showToast(errMsg, { persistent: true, tone: 'risk' });
    } finally {
      busy = false;
      setControlsDisabled(false);
    }
  });
}
