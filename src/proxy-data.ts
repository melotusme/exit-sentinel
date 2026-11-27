// Proxy client node import & monitor data backup/clear sub-panel (`records:data`).

import { invoke } from '@tauri-apps/api/core';
import { confirmAction } from './confirm';
import type { AppShellApi } from './store';
import type { View } from './types';
import { esc, icon } from './ui';

interface Preview {
  id: number;
  nodes: number;
  records: number;
  skipped: number;
  format: string;
  warnings: string;
}

interface Availability {
  id: string;
  state: string;
  message: string;
  nodes: number;
}

interface LocalClientMeta {
  id: string;
  name: string;
  hint: string;
}

const LOCAL_CLIENTS: LocalClientMeta[] = [
  { id: 'clash_verge', name: 'Clash Verge Rev', hint: '支持 macOS / Windows / Linux 配置目录' },
  { id: 'shadowrocket', name: 'Shadowrocket', hint: '支持 macOS Group Containers 节点库' },
  { id: 'karing', name: 'Karing', hint: '支持 macOS 本机订阅配置' },
  { id: 'clash_mi', name: 'Clash Mi', hint: '支持 macOS 本机订阅配置' },
];

const SERVICE_OPTIONS: { id: 'both' | 'claude' | 'gemini'; label: string }[] = [
  { id: 'both', label: 'Claude 与 Gemini' },
  { id: 'claude', label: '仅 Claude' },
  { id: 'gemini', label: '仅 Gemini' },
];

let selectedService: 'both' | 'claude' | 'gemini' = 'both';
let activeClient = 'clash_verge';
let manualOnly = false;
let preview: Preview | undefined;
let previewSource = '';
let statusMessage = '';
let resultMessage = '';
let isError = false;
let busy = false;
let generation = 0;
let paused = false;
let counts = { ips: 0, nodes: 0, history: 0 };

let availability: Availability[] = [];
let discoveryBusy = false;
let discoveryError = '';
let boundPanel: HTMLElement | null = null;

export function proxyDataInProgress(): boolean {
  return busy;
}

export function updateProxyDataState(v: View): void {
  paused = v.paused;
  counts = {
    ips: v.claude_ips.length,
    nodes: v.ai_nodes.length,
    history: v.history.length,
  };
  const host = document.getElementById('proxy-data-settings');
  if (!host) return;
  const banner = host.querySelector<HTMLElement>('#data-paused');
  if (banner) banner.hidden = !paused;
  syncClearCounts(host);
}

function syncClearCounts(host: HTMLElement) {
  const histBadge = host.querySelector<HTMLElement>('[data-count="history"]');
  if (histBadge) histBadge.textContent = `${counts.history} 条日志`;
  const aiBadge = host.querySelector<HTMLElement>('[data-count="ai"]');
  if (aiBadge) aiBadge.textContent = `${counts.ips} IP · ${counts.nodes} 节点`;
  const allBadge = host.querySelector<HTMLElement>('[data-count="all"]');
  if (allBadge) allBadge.textContent = `全部记录与缓存`;
}

function availabilityBadge(item: Availability | undefined): { label: string; cls: string; detail: string } {
  if (discoveryBusy) {
    return { label: '检测中…', cls: '', detail: '正在扫描本机代理软件配置目录' };
  }
  if (discoveryError) {
    return { label: '待重检', cls: 'warn', detail: discoveryError };
  }
  if (!item) {
    return { label: '未检测', cls: '', detail: '点击右侧按钮可直接尝试读取' };
  }
  if (item.state === 'ready') {
    return {
      label: `可读 ${item.nodes} 节点`,
      cls: 'ok',
      detail: item.message || `已发现 ${item.nodes} 个可导入节点`,
    };
  }
  if (item.state === 'unsupported') {
    return { label: '仅支持手动导入', cls: '', detail: item.message };
  }
  if (item.state === 'permission_denied') {
    return { label: '权限受限', cls: 'risk', detail: item.message };
  }
  if (item.state === 'unconfigured') {
    return { label: '暂无节点', cls: 'warn', detail: item.message };
  }
  if (item.state === 'missing') {
    return { label: '未安装或未配置', cls: '', detail: item.message };
  }
  return { label: '需手动导入', cls: 'warn', detail: item.message };
}

function renderLocalClientsList(): string {
  return LOCAL_CLIENTS.map(meta => {
    const item = availability.find(a => a.id === meta.id);
    const badge = availabilityBadge(item);
    const unsupported = item?.state === 'unsupported';
    const isReady = item?.state === 'ready';
    return `<div class="proxy-client-row ${isReady ? 'is-ready' : ''}" title="${esc(badge.detail)}">
      <div class="proxy-client-info">
        <div class="proxy-client-title">
          <strong>${esc(meta.name)}</strong>
          <span class="pill tabular ${badge.cls}">${esc(badge.label)}</span>
        </div>
        <small>${esc(item ? badge.detail : meta.hint)}</small>
      </div>
      <button
        type="button"
        class="${isReady && !preview ? 'primary' : ''}"
        data-read-client="${esc(meta.id)}"
        ${busy || unsupported ? 'disabled' : ''}
      >读取本机配置</button>
    </div>`;
  }).join('');
}

function serviceTargetLabel(svc: 'both' | 'claude' | 'gemini'): string {
  if (svc === 'claude') return '仅 Claude';
  if (svc === 'gemini') return '仅 Gemini';
  return 'Claude 与 Gemini';
}

function renderPreviewBox(): string {
  if (!preview) {
    if (!statusMessage) {
      return '';
    }
    return `<div class="import-preview-empty ${isError ? 'is-error' : ''}">
      <span>${esc(statusMessage)}</span>
    </div>`;
  }

  return `<div class="import-preview-box">
    <div class="import-preview-head">
      <div>
        <strong>${esc(previewSource || '配置预览')}</strong>
        <span class="muted small">格式：${esc(preview.format)} · 目标：${esc(serviceTargetLabel(selectedService))}</span>
      </div>
      <span class="pill warn">待确认导入</span>
    </div>
    <table class="preview-summary-table" aria-label="节点导入预览汇总">
      <thead>
        <tr>
          <th scope="col">发现节点</th>
          <th scope="col">新增 / 合并记录</th>
          <th scope="col">跳过</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="mono tabular"><strong>${preview.nodes.toLocaleString('zh-CN')}</strong></td>
          <td class="mono tabular"><strong>${preview.records.toLocaleString('zh-CN')}</strong> <small class="inline-note">${selectedService === 'both' ? '双服务登记' : '单服务登记'}</small></td>
          <td class="mono tabular">${preview.skipped.toLocaleString('zh-CN')}</td>
        </tr>
      </tbody>
    </table>
    <p class="small muted preview-merge-note">新节点默认标为「待确认」；已存在的同名同服务器节点会自动合并来源，保留你原有的可用 / 风险标记与备注。</p>
    ${preview.warnings ? `<div class="preview-warning">${icon('alert')}<span>${esc(preview.warnings)}</span></div>` : ''}
    <label class="drawer-checkbox preview-manual-toggle">
      <input id="import-manual-only" name="import-manual-only" type="checkbox" ${manualOnly ? 'checked' : ''}>
      <span>导入后仅使用手动节点库（停用代理软件实时节点自动读取）</span>
    </label>
    <div class="preview-actions">
      <button type="button" id="cancel-proxy-preview" ${busy ? 'disabled' : ''}>取消</button>
      <button type="button" id="commit-proxy-import" class="primary" ${busy ? 'disabled' : ''}>
        ${icon('check')}<span>${busy ? '正在导入…' : '确认导入'}</span>
      </button>
    </div>
  </div>`;
}

export function proxyDataSettings(v: View): string {
  paused = v.paused;
  counts = {
    ips: v.claude_ips.length,
    nodes: v.ai_nodes.length,
    history: v.history.length,
  };

  return `<div class="data-workspace" id="proxy-data-settings">
    <section class="pause-banner data-pause-banner" id="data-paused" ${paused ? '' : 'hidden'}>
      <span class="pause-banner-lead">
        ${icon('pause')}
        <span><strong>监控已暂停</strong> · 可先整理节点库或执行数据清理，就绪后再恢复后台轮询</span>
      </span>
      <button id="data-resume" type="button" class="primary">${icon('play')}<span>恢复监控</span></button>
    </section>

    <div
      id="proxy-data-result"
      class="data-result-banner ${isError ? 'is-error' : ''}"
      role="status"
      aria-live="polite"
      ${resultMessage ? '' : 'hidden'}
    >
      <span class="data-result-text">${esc(resultMessage)}</span>
      <button type="button" class="text-button" data-subtab="nodes">查看节点库 →</button>
    </div>

    <div class="data-two-col">
      <section class="panel data-card" aria-labelledby="import-title">
        <div class="data-card-head">
          <div>
            <h2 id="import-title">从代理客户端或订阅导入节点</h2>
            <p class="muted small">仅提取节点名称与服务器标识，不保存连接密码、UUID、订阅链接或控制器密钥。</p>
          </div>
          <button type="button" class="text-button" data-subtab="nodes">查看节点库 (${counts.nodes})</button>
        </div>

        <div class="import-target-bar">
          <span class="import-target-label">登记目标服务</span>
          <div class="seg-pills" role="group" aria-label="选择导入目标服务">
            ${SERVICE_OPTIONS.map(
              opt => `<button
                type="button"
                class="seg-pill"
                data-import-service="${opt.id}"
                aria-pressed="${selectedService === opt.id}"
              >${esc(opt.label)}</button>`
            ).join('')}
          </div>
        </div>

        <div id="proxy-import-preview" role="status" aria-live="polite" ${preview || statusMessage ? '' : 'hidden'}>
          ${renderPreviewBox()}
        </div>

        <div class="import-section">
          <div class="import-section-head">
            <h3>自动发现本机客户端</h3>
            <button type="button" id="refresh-proxy-clients" class="compact-btn" ${discoveryBusy || busy ? 'disabled' : ''}>
              ${icon('refresh')}<span>${discoveryBusy ? '检测中…' : '重新检测'}</span>
            </button>
          </div>
          <div class="proxy-clients-list" id="local-clients-list">
            ${renderLocalClientsList()}
          </div>
        </div>

        <div class="import-section">
          <div class="import-section-head">
            <h3>手动文件或粘贴导入</h3>
            <span class="muted small">支持 YAML / sing-box JSON / Surge / URI / Base64</span>
          </div>
          <div class="manual-import-row">
            <label class="file-upload-btn" for="proxy-import-file">
              ${icon('plus')}<span>选择配置文件…</span>
              <input
                id="proxy-import-file"
                name="proxy-import-file"
                type="file"
                accept=".yaml,.yml,.json,.conf,.txt,.list"
                ${busy ? 'disabled' : ''}
              >
            </label>
            <span class="muted small">单文件上限 8 MB，不支持加密备份包</span>
          </div>
          <details class="paste-import-details" id="paste-import-details">
            <summary>粘贴配置片段、节点 URI 链接或 Base64 订阅内容</summary>
            <div class="paste-import-body">
              <textarea
                id="proxy-import-paste"
                rows="3"
                autocomplete="off"
                spellcheck="false"
                placeholder="在此粘贴 Clash YAML、sing-box JSON、Surge [Proxy] 列表、vmess:// / vless:// / ss:// / trojan:// 链接或 Base64 订阅文本…"
              ></textarea>
              <div class="paste-import-foot">
                <small class="muted">内容仅在本机内存解析，不会写入日志或上传网络。</small>
                <button type="button" id="parse-proxy-paste" ${busy ? 'disabled' : ''}>解析并预览</button>
              </div>
            </div>
          </details>
        </div>
      </section>

      <section class="panel data-card" aria-labelledby="clear-title">
        <div class="data-card-head">
          <div>
            <h2 id="clear-title">监控数据备份与清理</h2>
            <p class="muted small">按范围安全清理历史日志或 AI 信任库，保留代理与同步设置。</p>
          </div>
          <span class="pill ok">自动本地备份</span>
        </div>

        <div class="backup-reassurance">
          <span class="backup-icon">${icon('shield')}</span>
          <div class="backup-copy">
            <strong>清理前自动生成本地快照备份</strong>
            <p class="small muted">每次执行清理前，都会自动在应用配置目录写入 <code class="mono">settings.before-clear-*.json</code> 备份文件；若备份失败将自动中止删除。监控周期、代理端口、开机自启与 WebDAV 配置均完整保留。</p>
          </div>
        </div>

        <div class="clear-actions-stack">
          <article class="clear-action-card">
            <div class="clear-action-copy">
              <div class="clear-action-title">
                <h3>仅清空变化历史</h3>
                <span class="pill tabular" data-count="history">${counts.history} 条日志</span>
              </div>
              <p class="small muted">仅清空「变化历史」时间线记录；已标记的 Claude / Gemini 出口 IP、代理节点库与当前监控运行状态全部保留。</p>
            </div>
            <button type="button" data-clear-scope="history" ${busy ? 'disabled' : ''}>仅清空变化历史</button>
          </article>

          <article class="clear-action-card">
            <div class="clear-action-copy">
              <div class="clear-action-title">
                <h3>清空 AI 记录库</h3>
                <span class="pill tabular" data-count="ai">${counts.ips} IP · ${counts.nodes} 节点</span>
              </div>
              <p class="small muted">清空已登记的全部 Claude / Gemini 出口 IP、代理节点库、AI 连通测试快照及关联变化历史；清理后自动暂停监控。</p>
            </div>
            <button type="button" class="danger" data-clear-scope="ai" ${busy ? 'disabled' : ''}>清空 AI 记录库</button>
          </article>

          <article class="clear-action-card">
            <div class="clear-action-copy">
              <div class="clear-action-title">
                <h3>清空全部监控记录</h3>
                <span class="pill" data-count="all">全部记录与缓存</span>
              </div>
              <p class="small muted">清空全部 AI 记录库、变化历史、各出口检测站上次记录、IP 归属与周边缓存及诊断历史，恢复空白初始数据并暂停监控。</p>
            </div>
            <button type="button" class="danger" data-clear-scope="all" ${busy ? 'disabled' : ''}>清空全部监控记录</button>
          </article>
        </div>
      </section>
    </div>
  </div>`;
}

function paint() {
  const host = document.getElementById('proxy-data-settings');
  if (!host) return;

  const pauseEl = host.querySelector<HTMLElement>('#data-paused');
  if (pauseEl) pauseEl.hidden = !paused;

  host.querySelectorAll<HTMLButtonElement>('[data-import-service]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.importService === selectedService));
    btn.disabled = busy;
  });

  const refreshBtn = host.querySelector<HTMLButtonElement>('#refresh-proxy-clients');
  if (refreshBtn) {
    refreshBtn.disabled = discoveryBusy || busy;
    refreshBtn.innerHTML = `${icon('refresh')}<span>${discoveryBusy ? '检测中…' : '重新检测'}</span>`;
  }

  const clientsHost = host.querySelector<HTMLElement>('#local-clients-list');
  if (clientsHost) {
    clientsHost.innerHTML = renderLocalClientsList();
  }

  const previewHost = host.querySelector<HTMLElement>('#proxy-import-preview');
  if (previewHost) {
    previewHost.hidden = !(preview || statusMessage);
    previewHost.innerHTML = renderPreviewBox();
  }

  const resultEl = host.querySelector<HTMLElement>('#proxy-data-result');
  if (resultEl) {
    resultEl.hidden = !resultMessage;
    resultEl.classList.toggle('is-error', isError);
    const textEl = resultEl.querySelector('.data-result-text');
    if (textEl) textEl.textContent = resultMessage;
  }

  const fileInput = host.querySelector<HTMLInputElement>('#proxy-import-file');
  if (fileInput) fileInput.disabled = busy;
  const parseBtn = host.querySelector<HTMLButtonElement>('#parse-proxy-paste');
  if (parseBtn) parseBtn.disabled = busy;
  host.querySelectorAll<HTMLButtonElement>('[data-clear-scope]').forEach(btn => {
    btn.disabled = busy;
  });

  syncClearCounts(host);
}

export async function loadLocalProxyClients(force = false): Promise<void> {
  if (discoveryBusy || (availability.length && !force)) {
    paint();
    return;
  }
  discoveryBusy = true;
  discoveryError = '';
  paint();
  try {
    availability = await invoke<Availability[]>('discover_proxy_clients');
  } catch (error) {
    availability = [];
    discoveryError = `检测失败：${String(error)}`;
  } finally {
    discoveryBusy = false;
    paint();
  }
}

export function resetProxyDataUi(): void {
  generation++;
  preview = undefined;
  previewSource = '';
  statusMessage = '';
  isError = false;
  const paste = document.querySelector<HTMLTextAreaElement>('#proxy-import-paste');
  if (paste) paste.value = '';
  paint();
}

const CLEAR_CONFIRM_META: Record<
  'history' | 'ai' | 'all',
  { title: string; message: string; confirm: string }
> = {
  history: {
    title: '仅清空变化历史？',
    message: '将删除「变化历史」中的全部时间线日志；已标记的出口 IP 与代理节点库不会受影响。',
    confirm: '备份并清空历史',
  },
  ai: {
    title: '清空 AI 记录库？',
    message: '将删除全部已标记的 Claude / Gemini 出口 IP、代理节点库、AI 测试快照及变化历史，并自动暂停监控。',
    confirm: '备份并清空 AI 记录库',
  },
  all: {
    title: '清空全部监控记录？',
    message: '将删除全部 AI 记录库、变化历史、出口检测缓存、IP 地理位置缓存及诊断历史，并自动暂停监控。',
    confirm: '备份并清空全部记录',
  },
};

export function initProxyData(panel: HTMLElement, app: AppShellApi): void {
  if (boundPanel === panel) return;
  boundPanel = panel;

  panel.addEventListener('change', async event => {
    const input = event.target as HTMLInputElement;
    if (input.id === 'import-manual-only') {
      manualOnly = input.checked;
      return;
    }
    if (input.id !== 'proxy-import-file' || busy) return;
    const file = input.files?.[0];
    if (!file) return;

    const current = ++generation;
    busy = true;
    preview = undefined;
    previewSource = file.name;
    statusMessage = `正在解析文件 ${file.name}…`;
    resultMessage = '';
    isError = false;
    paint();

    try {
      if (file.size === 0 || file.size > 8 * 1024 * 1024) {
        throw new Error('请选择非空且不超过 8 MB 的配置文件');
      }
      const content = await file.text();
      if (current !== generation) return;
      // Never store the original file content in browser storage or logs.
      const res = await invoke<Preview>('preview_proxy_import', {
        client: 'other',
        service: selectedService,
        content,
      });
      if (current === generation) {
        preview = res;
        statusMessage = '';
      }
    } catch (error) {
      if (current === generation) {
        isError = true;
        statusMessage = `无法解析文件：${String(error)}`;
      }
    } finally {
      busy = false;
      input.value = '';
      paint();
    }
  });

  panel.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;
    if (!panel.querySelector('#proxy-data-settings')) return;

    if (btn.dataset.importService) {
      const next = btn.dataset.importService as 'both' | 'claude' | 'gemini';
      if (next !== selectedService && !busy) {
        selectedService = next;
        generation++;
        if (preview) {
          preview = undefined;
          statusMessage = '导入目标服务已切换，请重新点击读取或解析以更新预览。';
        }
        resultMessage = '';
        isError = false;
        paint();
      }
      return;
    }

    if (btn.id === 'refresh-proxy-clients') {
      await loadLocalProxyClients(true);
      return;
    }

    if (btn.id === 'cancel-proxy-preview') {
      generation++;
      preview = undefined;
      previewSource = '';
      statusMessage = '';
      isError = false;
      paint();
      return;
    }

    if (btn.dataset.readClient && !busy) {
      const clientId = btn.dataset.readClient;
      activeClient = clientId;
      const clientLabel = LOCAL_CLIENTS.find(c => c.id === clientId)?.name || clientId;
      const current = ++generation;
      busy = true;
      preview = undefined;
      previewSource = `${clientLabel} 本机配置`;
      statusMessage = `正在从 ${clientLabel} 读取节点…`;
      resultMessage = '';
      isError = false;
      paint();
      try {
        const res = await invoke<Preview>('preview_local_proxy_import', {
          client: activeClient,
          service: selectedService,
        });
        if (current === generation) {
          preview = res;
          statusMessage = '';
        }
      } catch (error) {
        if (current === generation) {
          isError = true;
          statusMessage = `读取失败：${String(error)}`;
        }
      } finally {
        busy = false;
        paint();
      }
      return;
    }

    if (btn.id === 'parse-proxy-paste' && !busy) {
      const textarea = panel.querySelector<HTMLTextAreaElement>('#proxy-import-paste');
      const content = textarea?.value.trim() || '';
      if (!content) {
        isError = true;
        statusMessage = '请先在文本框中粘贴代理配置或订阅内容。';
        paint();
        textarea?.focus();
        return;
      }
      if (new Blob([content]).size > 8 * 1024 * 1024) {
        isError = true;
        statusMessage = '粘贴内容超过 8 MB 上限，请精简后重试。';
        paint();
        return;
      }
      const current = ++generation;
      busy = true;
      preview = undefined;
      previewSource = '手动粘贴内容';
      statusMessage = '正在解析粘贴的节点配置…';
      resultMessage = '';
      isError = false;
      paint();
      try {
        // Never persist raw pasted subscription/config content.
        const res = await invoke<Preview>('preview_proxy_import', {
          client: 'other',
          service: selectedService,
          content,
        });
        if (current === generation) {
          preview = res;
          statusMessage = '';
        }
      } catch (error) {
        if (current === generation) {
          isError = true;
          statusMessage = `解析失败：${String(error)}`;
        }
      } finally {
        busy = false;
        paint();
      }
      return;
    }

    if (btn.id === 'commit-proxy-import' && preview && !busy) {
      busy = true;
      resultMessage = '';
      isError = false;
      paint();
      try {
        const added = await invoke<number>('commit_proxy_import', {
          id: preview.id,
          manualOnly,
        });
        preview = undefined;
        previewSource = '';
        statusMessage = '';
        const paste = panel.querySelector<HTMLTextAreaElement>('#proxy-import-paste');
        if (paste) paste.value = '';
        const details = panel.querySelector<HTMLDetailsElement>('#paste-import-details');
        if (details) details.open = false;
        resultMessage = `导入完成：新增 ${added} 条服务节点记录；已有节点已合并订阅来源并保留原标记。`;
        await app.call('get_state', undefined, { silent: true });
        app.showToast(`已成功导入节点（新增 ${added} 条记录）`, { tone: 'safe' });
      } catch (error) {
        isError = true;
        resultMessage = `导入失败：${String(error)}`;
        app.showToast(resultMessage, { persistent: true, tone: 'risk' });
      } finally {
        busy = false;
        paint();
      }
      return;
    }

    if (btn.dataset.clearScope && !busy) {
      const scope = btn.dataset.clearScope as 'history' | 'ai' | 'all';
      const meta = CLEAR_CONFIRM_META[scope];
      if (!meta) return;
      const ok = await confirmAction({
        title: meta.title,
        message: meta.message,
        detail: '清理前会自动生成本机 settings.before-clear-*.json 恢复备份；WebDAV 云端副本不受影响。',
        confirm: meta.confirm,
        danger: true,
      });
      if (!ok) return;

      busy = true;
      resultMessage = '';
      isError = false;
      paint();
      try {
        const backup = await app.clearMonitorData(scope);
        resetProxyDataUi();
        isError = false;
        resultMessage = `清理完成${scope === 'history' ? '' : '（监控已自动暂停）'} · 本地备份已保存为 ${backup}`;
        app.showToast(`已清理并保存本地备份：${backup}`);
      } catch (error) {
        isError = true;
        resultMessage = `清理失败：${String(error)}`;
      } finally {
        busy = false;
        paint();
      }
      return;
    }

    if (btn.id === 'data-resume' && !busy) {
      busy = true;
      paint();
      try {
        await app.setPaused(false);
        app.showToast('监控已恢复，正在重新检测出口');
      } finally {
        busy = false;
        paint();
      }
    }
  });
}
