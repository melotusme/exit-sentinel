import { invoke } from '@tauri-apps/api/core';
import { confirmAction } from './confirm';

interface Config {
  url: string;
  username: string;
  has_password: boolean;
  etag: string | null;
  last_sync: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let config: Config | null = null,
  busy = false,
  dirty = false,
  loadGeneration = 0;

export function hasUnsavedSync() { return dirty; }
export function discardUnsavedSync() { dirty = false; }
export function syncInProgress() { return busy; }

export function syncSettings() {
  return `<section id="webdav-settings" class="panel settings settings-card">
    <div class="card-header-block">
      <div>
        <span class="eyebrow">CLOUD SYNC</span>
        <h2>WebDAV 配置同步 · 坚果云</h2>
      </div>
      <span class="pill" id="dav-state">${config?.last_sync ? '已配置' : '手动同步'}</span>
    </div>
    <p class="muted">同步检测偏好、AI 服务 IP／节点及人工标记。各台电脑的代理端口、开机自启、缓存、检测历史和密码独立保留。手动上传／下载；下载前自动备份，上传前检查云端版本并备份。云端文件以 JSON 保存，请使用私有目录。</p>
    <div class="settings-grid">
      <label class="field">
        <span>WebDAV 目录</span>
        <input id="dav-url" name="webdav-url" type="url" autocomplete="off" spellcheck="false" value="${esc(config?.url || 'https://dav.jianguoyun.com/dav/')}" placeholder="https://dav.jianguoyun.com/dav/">
      </label>
      <label class="field">
        <span>坚果云账号</span>
        <input id="dav-user" name="webdav-user" autocomplete="username" spellcheck="false" value="${esc(config?.username || '')}" placeholder="例如：name@example.com…">
      </label>
      <label class="field field-full">
        <span>应用密码</span>
        <input id="dav-secret" name="webdav-secret" type="password" autocomplete="new-password" placeholder="${config?.has_password ? '已保存在系统凭据库；留空保留现有密码' : '坚果云安全选项 → 第三方应用管理 → 应用密码'}">
        <small>请使用第三方应用密码。密码仅保存在本机 macOS 钥匙串／Windows 凭据管理器，不同步。</small>
      </label>
    </div>
    <div class="form-actions">
      <button type="button" class="primary" data-dav="save">保存连接</button>
      <button type="button" data-dav="import">从本机 Clash Verge 导入</button>
      <button type="button" data-dav="test">测试连接</button>
    </div>
    <div class="settings-divider"></div>
    <h3>手动同步配置与记录</h3>
    <p class="small muted">首次使用时，在已有配置的设备上传，再到其他设备下载。</p>
    <div class="form-actions">
      <button type="button" data-dav="push">上传本机配置</button>
      <button type="button" data-dav="pull">下载并应用云端配置</button>
    </div>
    <p id="dav-message" class="small muted status-note" role="status" aria-live="polite">${config?.last_sync ? '最近同步：' + esc(config.last_sync) : '尚未同步。先保存或导入连接，再测试。首次使用在已有配置的设备上传。'}</p>
  </section>`;
}

export async function loadSync() {
  const host = document.querySelector('#webdav-settings');
  const generation = ++loadGeneration;
  try {
    const loaded = await invoke<Config>('get_sync_config');
    if (generation !== loadGeneration) return;
    config = loaded;
    if (host && host.isConnected && !dirty) {
      const url = host.querySelector<HTMLInputElement>('#dav-url');
      const user = host.querySelector<HTMLInputElement>('#dav-user');
      const secret = host.querySelector<HTMLInputElement>('#dav-secret');
      const state = host.querySelector('#dav-state');
      if (url) url.value = loaded?.url || 'https://dav.jianguoyun.com/dav/';
      if (user) user.value = loaded?.username || '';
      if (secret) {
        secret.value = '';
        secret.placeholder = loaded?.has_password ? '已保存在系统凭据库；留空保留现有密码' : '坚果云安全选项 → 第三方应用管理 → 应用密码';
      }
      if (state) state.textContent = loaded?.last_sync ? '已配置' : '手动同步';
      message(loaded?.last_sync ? `最近同步：${loaded.last_sync}` : '尚未同步。先保存或导入连接，再测试。首次使用在已有配置的设备上传。');
    }
  } catch (e) {
    if (generation === loadGeneration) message(String(e));
  }
}

document.addEventListener('input', e => {
  if ((e.target as HTMLElement).closest('#webdav-settings')?.querySelector('#dav-secret') &&
      (e.target as HTMLElement).matches('#dav-url, #dav-user, #dav-secret')) dirty = true;
});

function message(s: string) {
  const host = document.querySelector('#dav-message');
  if (host) host.textContent = s;
}

document.addEventListener('click', async e => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dav]')?.dataset.dav;
  if (!action || busy) return;
  if (action === 'import' && dirty && !await confirmAction({ title: '替换连接输入？', message: '导入会替换尚未保存的 WebDAV 账号和连接输入。', confirm: '导入连接' })) return;
  if (
    action === 'pull' &&
    !await confirmAction({ title: '应用云端配置？', message: '云端检测偏好、IP 和节点记录将替换本机对应数据。', detail: '应用前自动备份本机完整配置。各台电脑的代理端口和开机自启保留。', confirm: '备份并应用' })
  )
    return;
  busy = true;
  ++loadGeneration;
  document.querySelectorAll<HTMLButtonElement>('[data-dav]').forEach(b => (b.disabled = true));
  document.querySelectorAll<HTMLInputElement>('#webdav-settings input').forEach(input => (input.disabled = true));
  message('正在处理…');
  try {
    if (action === 'save') {
      const value = (id: string) => document.querySelector<HTMLInputElement>(id)?.value || '';
      config = await invoke<Config>('save_sync_config', {
        url: value('#dav-url'),
        username: value('#dav-user'),
        secret: value('#dav-secret'),
      });
      document.querySelector<HTMLInputElement>('#dav-secret')!.value = '';
      dirty = false;
      message('连接已保存到本机；应用密码保存在系统凭据库。');
    } else if (action === 'import') {
      config = await invoke<Config>('import_verge_webdav');
      dirty = false;
      await loadSync();
      message('已导入本机 Clash Verge 的 WebDAV 连接；未修改 Clash Verge。');
    } else {
      message(await invoke<string>('sync_action', { action }));
      config = await invoke<Config>('get_sync_config');
    }
  } catch (e) {
    message(String(e));
  } finally {
    busy = false;
    document.querySelectorAll<HTMLButtonElement>('[data-dav]').forEach(b => (b.disabled = false));
    document.querySelectorAll<HTMLInputElement>('#webdav-settings input').forEach(input => (input.disabled = false));
  }
});
