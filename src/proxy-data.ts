import { invoke } from '@tauri-apps/api/core';
import { escapeHtml as esc } from './list';
import { confirmAction } from './confirm';

interface Preview { id: number; nodes: number; records: number; skipped: number; format: string; warnings: string }
interface Availability { id: string; state: string; message: string; nodes: number }
let client = 'shadowrocket', service = 'both', manualOnly = false, clearScope = 'all';
let preview: Preview | undefined, fileName = '', message = '', resultMessage = '', errorMessage = false;
let busy = false, generation = 0, paused = false;
let availability: Availability[] = [], discoveryBusy = false, discoveryError = '';
const clients: Record<string, string> = {
  shadowrocket: 'Shadowrocket', clash_verge: 'Clash Verge / Clash Verge Rev',
  karing: 'Karing', clash_mi: 'Clash Mi', other: '其他（配置文件）',
};
export function proxyDataInProgress() { return busy; }
export function updateProxyDataState(value: boolean) {
  paused = value;
  const banner = document.getElementById('data-paused');
  if (banner) banner.hidden = !paused;
}
export function proxyDataSettings(isPaused: boolean) {
  paused = isPaused;
  return `<div class="data-stack" id="proxy-data-settings">
    <section class="notice data-paused" id="data-paused" ${paused ? '' : 'hidden'}><div><strong>监控已暂停</strong><p>可以先整理节点，准备好后再恢复出口检测。</p></div><button id="data-resume" type="button">恢复监控</button></section>
    <section class="panel settings settings-card import-card" aria-labelledby="import-title">
      <div class="card-header-block"><div><span class="eyebrow">节点导入</span><h2 id="import-title">从代理软件读取节点</h2></div><button type="button" data-tab="ai">查看节点库</button></div>
      <p class="muted">选择这台电脑上的代理软件，自动查找节点库，无需知道文件位置。</p>
      <div class="import-step"><span class="step-number" aria-hidden="true">1</span><h3>选择软件与服务</h3></div>
      <div class="settings-grid">
        <label class="field"><span>代理软件</span><select id="import-client" name="import-client">${Object.entries(clients).map(([key, label]) => `<option value="${key}" ${key === client ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="field"><span>登记到</span><select id="import-service" name="import-service"><option value="both" ${service === 'both' ? 'selected' : ''}>Claude 和 Gemini</option><option value="claude" ${service === 'claude' ? 'selected' : ''}>仅 Claude</option><option value="gemini" ${service === 'gemini' ? 'selected' : ''}>仅 Gemini</option></select><small>每个服务单独保存状态和备注。</small></label>
      </div>
      <div id="local-import-controls" ${client === 'other' ? 'hidden' : ''}>
        <div class="local-discovery"><span class="dot" id="discovery-dot" aria-hidden="true"></span><p id="local-proxy-status" role="status" aria-live="polite">${esc(localStatus())}</p></div>
        <div class="form-actions"><button id="read-local-proxy" type="button" class="${preview ? '' : 'primary'}">读取本机节点</button><button id="refresh-proxy-clients" type="button">重新检测</button></div>
      </div>
      <details id="file-import-fallback" class="import-fallback" ${client === 'other' ? 'open' : ''}><summary>${client === 'other' ? '选择配置文件' : '读取不到？导入配置文件'}</summary><label class="field"><span>配置 / 节点文件</span><input id="proxy-import-file" name="proxy-import-file" type="file" accept=".yaml,.yml,.json,.conf,.txt,.list"><small>支持 YAML、JSON、CONF、分享链接和 Base64 节点列表，最大 8 MB。不支持加密备份。</small></label></details>
      <div class="import-step"><span class="step-number" aria-hidden="true">2</span><h3>预览并确认导入</h3></div>
      <div id="proxy-import-preview" role="status" aria-live="polite">${previewMarkup()}</div>
      <div id="import-confirm-options" ${preview ? '' : 'hidden'}>
        <label class="toggle"><span>导入后关闭自动节点读取<small>默认保留当前自动读取设置。勾选后只显示手动节点库，无法自动识别 Claude / Gemini 实际节点。</small></span><input id="import-manual-only" name="import-manual-only" type="checkbox" ${manualOnly ? 'checked' : ''}></label>
        <div class="form-actions"><button id="commit-proxy-import" type="button" class="primary">确认导入节点</button></div>
      </div>
      <details class="import-help"><summary>读取范围与数据说明</summary><p class="small muted">读取软件已保存的全部节点。macOS 支持上面四款软件；Windows 当前支持读取 Clash Verge。其他情况可使用配置文件。</p><p class="small muted">新节点标为待确认，重复节点合并并保留原有标记。导入仅登记节点，不代表当前选中、出口 IP 或可用性。仅保存识别信息，不保存连接密码、订阅地址或控制器密钥。</p></details>
    </section>
    <p id="proxy-data-result" class="operation-result ${errorMessage ? 'is-error' : ''}" role="status" aria-live="polite" ${resultMessage ? '' : 'hidden'}>${esc(resultMessage)}</p>
    <section class="panel settings settings-card danger-zone" aria-labelledby="clear-title">
      <div class="card-header-block"><div><span class="eyebrow">数据维护</span><h2 id="clear-title">清空本机数据</h2></div><span class="pill">清空前自动备份</span></div>
      <label class="field"><span>清空范围</span><select id="clear-data-scope" name="clear-data-scope"><option value="all" ${clearScope === 'all' ? 'selected' : ''}>全部监测数据</option><option value="ai" ${clearScope === 'ai' ? 'selected' : ''}>AI 数据和变化日志</option><option value="history" ${clearScope === 'history' ? 'selected' : ''}>仅变化日志</option></select><small id="clear-scope-help">${scopeHelp()}</small></label>
      <p class="small muted">检测设置、开机自启和 WebDAV 连接保留。云端副本不受影响，再次下载可能恢复旧记录。</p>
      <div class="form-actions"><button id="clear-monitor-data" type="button" class="danger">清空所选数据…</button></div>
    </section>
  </div>`;
}
function scopeHelp() {
  return clearScope === 'history' ? '仅删除变化日志，监控继续保持当前状态。' : `${clearScope === 'all' ? '删除 IP、节点、测试、日志和位置缓存。' : '删除 AI IP、节点、AI 测试和变化日志。'}清空后暂停监控，手动恢复前不会新增记录。`;
}
function previewMarkup() {
  if (!preview) return `<p class="import-empty ${errorMessage ? 'is-error' : ''}">${esc(message || '先读取本机节点，或选择配置文件。预览后再保存。')}</p>`;
  return `<div class="import-preview-card"><div class="preview-count"><strong>${preview.nodes.toLocaleString('zh-CN')}</strong><span>个节点</span><span class="pill">尚未保存</span></div><p>${esc(fileName)} · ${esc(preview.format)}</p><p>将登记 <strong>${preview.records.toLocaleString('zh-CN')}</strong> 条服务记录${service === 'both' ? '（每个节点分别登记到 Claude 和 Gemini）' : ''}。</p>${preview.skipped ? `<p class="small muted">已跳过 ${preview.skipped} 条无效或重复定义。</p>` : ''}${preview.warnings ? `<p class="small warning">${esc(preview.warnings)}</p>` : ''}</div>`;
}
function localStatus() {
  if (discoveryBusy) return '正在检测本机代理软件…';
  return discoveryError || availability.find(a => a.id === client)?.message || '选择软件后可直接读取，或点击重新检测。';
}
export async function loadLocalProxyClients(force = false) {
  if (discoveryBusy || availability.length && !force) { paint(); return; }
  discoveryBusy = true; discoveryError = ''; paint();
  try { availability = await invoke<Availability[]>('discover_proxy_clients'); }
  catch (error) { availability = []; discoveryError = `检测失败：${String(error)}。可重新检测，或直接读取节点。`; }
  finally { discoveryBusy = false; paint(); }
}
function paint() {
  const host = document.getElementById('proxy-data-settings'); if (!host) return;
  const local = host.querySelector('#local-proxy-status'); if (local) local.textContent = localStatus();
  const status = availability.find(a => a.id === client);
  const dot = host.querySelector('#discovery-dot'); if (dot) dot.className = `dot ${!discoveryError && status?.state === 'ready' ? 'green' : 'amber'}`;
  const controls = host.querySelector<HTMLElement>('#local-import-controls'); if (controls) controls.hidden = client === 'other';
  const fallback = host.querySelector<HTMLDetailsElement>('#file-import-fallback');
  if (fallback) { if (client === 'other') fallback.open = true; fallback.querySelector('summary')!.textContent = client === 'other' ? '选择配置文件' : '读取不到？导入配置文件'; }
  host.querySelector('#proxy-import-preview')!.innerHTML = previewMarkup();
  host.querySelector<HTMLElement>('#import-confirm-options')!.hidden = !preview;
  const output = host.querySelector<HTMLElement>('#proxy-data-result')!;
  output.textContent = resultMessage; output.hidden = !resultMessage; output.classList.toggle('is-error', errorMessage);
  host.querySelector('#clear-scope-help')!.textContent = scopeHelp();
  for (const control of host.querySelectorAll<HTMLInputElement>('input,select,button')) control.disabled = busy || control.id === 'refresh-proxy-clients' && discoveryBusy;
  const read = host.querySelector<HTMLButtonElement>('#read-local-proxy')!;
  read.classList.toggle('primary', !preview); read.textContent = busy && !preview ? '正在处理…' : preview ? '重新读取节点' : '读取本机节点';
  const commit = host.querySelector<HTMLButtonElement>('#commit-proxy-import')!;
  commit.disabled = !preview || busy; commit.textContent = busy && preview ? '正在导入…' : '确认导入节点';
}
export function resetProxyDataUi() {
  generation++; preview = undefined; fileName = ''; message = '数据已清空，可以重新读取或导入节点。'; errorMessage = false; paint();
}
export function initProxyData(toast: (message: string, error?: boolean) => void, changed: () => Promise<void>) {
  document.addEventListener('change', async e => {
    const input = e.target as HTMLInputElement;
    if (input.id === 'import-manual-only') { manualOnly = input.checked; return; }
    if (input.id === 'clear-data-scope') { clearScope = input.value; paint(); return; }
    if (input.id === 'import-client' || input.id === 'import-service') {
      if (input.id === 'import-client') client = input.value; else service = input.value;
      generation++; preview = undefined; message = '选择已更改，请重新读取节点或选择文件。'; errorMessage = false; resultMessage = '';
      paint(); return;
    }
    if (input.id !== 'proxy-import-file' || busy) return;
    const file = input.files?.[0]; if (!file) return;
    const current = ++generation;
    busy = true; preview = undefined; fileName = file.name; message = '正在解析配置…'; resultMessage = ''; errorMessage = false; paint();
    try {
      if (file.size === 0 || file.size > 8 * 1024 * 1024) throw new Error('请选择非空且不超过 8 MB 的配置文件');
      const content = await file.text();
      if (current !== generation) return;
      // Never store the original file content in browser storage or logs.
      const result = await invoke<Preview>('preview_proxy_import', { client, service, content });
      if (current === generation) preview = result;
    } catch (error) { if (current === generation) { message = `无法解析：${String(error)}。请检查格式后重新选择文件。`; errorMessage = true; } }
    finally { busy = false; input.value = ''; paint(); }
  });
  document.addEventListener('click', async e => {
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const id = button?.id;
    if (!['commit-proxy-import', 'clear-monitor-data', 'data-resume', 'read-local-proxy', 'refresh-proxy-clients'].includes(id || '') || button?.disabled || busy) return;
    if (id === 'refresh-proxy-clients') { await loadLocalProxyClients(true); return; }
    if (id === 'clear-monitor-data') {
      const scope = clearScope;
      const label = document.querySelector<HTMLSelectElement>('#clear-data-scope')!.selectedOptions[0].textContent || '';
      if (!await confirmAction({ title: `清空${label}？`, message: scopeHelp(), detail: '清空前自动生成本机恢复备份。WebDAV 云端副本不会删除。', confirm: '备份并清空', danger: true })) return;
      clearScope = scope;
    }
    busy = true; resultMessage = ''; errorMessage = false; paint();
    try {
      if (id === 'read-local-proxy') {
        const current = ++generation;
        preview = undefined; fileName = clients[client]; message = '正在从本机读取节点…'; paint();
        const result = await invoke<Preview>('preview_local_proxy_import', { client, service });
        if (current === generation) preview = result;
      } else {
        if (id === 'commit-proxy-import') {
          if (!preview) return;
          const added = await invoke<number>('commit_proxy_import', { id: preview.id, manualOnly });
          preview = undefined; message = '导入完成，可前往节点库查看并登记状态。';
          resultMessage = `已新增 ${added} 条服务节点记录；重复记录已更新机场来源，保留原有状态和备注。`;
        } else if (id === 'clear-monitor-data') {
          const backup = await invoke<string>('clear_monitor_data', { scope: clearScope });
          resetProxyDataUi();
          resultMessage = `已清空。${clearScope === 'history' ? '' : '监控已暂停。'}恢复备份：${backup}`;
        } else {
          await invoke('set_paused', { paused: false }); resultMessage = '监控已恢复，将重新检测出口。';
        }
        await changed();
        toast(id === 'clear-monitor-data' ? '数据已清空，恢复备份已保存。' : resultMessage);
      }
    } catch (error) {
      errorMessage = true;
      if (id === 'read-local-proxy') { preview = undefined; message = `无法读取：${String(error)}。请检查软件权限，或使用配置文件导入。`; }
      else resultMessage = `操作失败：${String(error)}。请重试。`;
    }
    finally { busy = false; paint(); }
  });
}
