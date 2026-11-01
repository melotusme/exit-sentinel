import { invoke } from '@tauri-apps/api/core';

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
  busy = false;

export function syncSettings() {
  return `<section id="webdav-settings" class="panel settings settings-card">
    <div class="card-header-block">
      <div>
        <span class="eyebrow">CLOUD SYNC</span>
        <h2>WebDAV 配置同步 · 坚果云</h2>
      </div>
      <span class="pill">${config?.last_sync ? '已配置' : '手动同步'}</span>
    </div>
    <p class="muted">同步检测偏好、AI 服务 IP／节点及人工标记。各台电脑的代理端口、开机自启、缓存、检测历史和密码独立保留。手动上传／下载；下载前自动备份，上传前检查云端版本并备份。云端文件以 JSON 保存，请使用私有目录。</p>
    <div class="settings-grid">
      <label class="field">
        <span>WebDAV 目录</span>
        <input id="dav-url" type="url" value="${esc(config?.url || 'https://dav.jianguoyun.com/dav/')}" placeholder="https://dav.jianguoyun.com/dav/">
      </label>
      <label class="field">
        <span>坚果云账号</span>
        <input id="dav-user" autocomplete="username" value="${esc(config?.username || '')}" placeholder="输入坚果云邮箱或账号">
      </label>
      <label class="field field-full">
        <span>应用密码</span>
        <input id="dav-secret" type="password" autocomplete="new-password" placeholder="${config?.has_password ? '已保存在系统凭据库；留空保留现有密码' : '坚果云安全选项 → 第三方应用管理 → 应用密码'}">
        <small>请使用第三方应用密码。密码仅保存在本机 macOS 钥匙串／Windows 凭据管理器，不同步。</small>
      </label>
    </div>
    <div class="form-actions">
      <button type="button" class="primary" data-dav="save">保存连接</button>
      <button type="button" data-dav="import">从本机 Clash Verge 导入</button>
      <button type="button" data-dav="test">测试连接</button>
      <button type="button" data-dav="push">上传本机配置</button>
      <button type="button" data-dav="pull">下载并应用云端配置</button>
    </div>
    <p id="dav-message" class="small muted status-note">${config?.last_sync ? '最近同步：' + esc(config.last_sync) : '尚未同步。先保存或导入连接，再测试。首次使用在已有配置的设备上传。'}</p>
  </section>`;
}

export async function loadSync() {
  try {
    config = await invoke<Config>('get_sync_config');
    const host = document.querySelector('#webdav-settings');
    if (host) host.outerHTML = syncSettings();
  } catch (e) {
    message(String(e));
  }
}

function message(s: string) {
  const host = document.querySelector('#dav-message');
  if (host) host.textContent = s;
}

document.addEventListener('click', async e => {
  const action = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-dav]')?.dataset.dav;
  if (!action || busy) return;
  if (
    action === 'pull' &&
    !window.confirm('使用云端检测偏好、IP 和节点记录替换本机对应配置？应用会先备份本机完整配置。代理端口和开机自启保留。')
  )
    return;
  busy = true;
  document.querySelectorAll<HTMLButtonElement>('[data-dav]').forEach(b => (b.disabled = true));
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
      message('连接已保存到本机；应用密码保存在系统凭据库。');
    } else if (action === 'import') {
      config = await invoke<Config>('import_verge_webdav');
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
  }
});
