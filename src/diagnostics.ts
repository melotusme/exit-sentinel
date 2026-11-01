import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './diagnostics.css';

export type Report = {
  id: string;
  name: string;
  url: string;
  time: string;
  command: string;
  path: string;
  exit_code: number;
  metrics: Record<string, any>;
  trace: string;
  headers: string;
  body: string;
  body_bytes: number;
  truncated: boolean;
};

export type DiagState = {
  running: boolean;
  selected: string;
  reports: Record<string, Report>;
  error: string | null;
};

const sites: Array<[string, string, string]> = [
  ['baidu', '百度', '国内'],
  ['bing', '必应中国', '国内'],
  ['google', 'Google', '国外'],
  ['cloudflare', 'Cloudflare', '国外'],
  ['apple', 'Apple', '国外'],
  ['github', 'GitHub', '国外'],
  ['claude', 'Claude', '独立'],
  ['gemini', 'Gemini', '独立'],
];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let state: DiagState = { running: false, selected: 'baidu', reports: {}, error: null },
  selected = 'baidu',
  section = 'trace',
  message = '';

const ms = (s: unknown) => (typeof s === 'number' ? `${(s * 1000).toFixed(1)} ms` : '—');
const msNum = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? Math.max(0, s * 1000) : 0);

export function getDiagnosticsState() {
  return {
    state,
    selected,
    testedCount: Object.keys(state.reports || {}).length,
    totalCount: sites.length,
  };
}

export function renderDiagnosticsTab(): string {
  const r = state.reports[selected],
    m = r?.metrics || {};
  const status = !r
    ? '尚未测试'
    : r.exit_code === 63
      ? `HTTP ${m.http_code} · 已连接（正文超限截断）`
      : r.exit_code !== 0
        ? `curl 失败 · 退出码 ${r.exit_code}`
        : Number(m.http_code) >= 400
          ? `HTTP ${m.http_code} · 站点返回错误`
          : `HTTP ${m.http_code} · 响应正常`;
  const isBad = Boolean(r && (![0, 63].includes(r.exit_code) || Number(m.http_code) >= 400));
  const raw = r
    ? section === 'metrics'
      ? JSON.stringify(m, null, 2)
      : r[section as 'command' | 'trace' | 'headers' | 'body']
    : '';

  const totalMs = msNum(m.time_total);
  const dnsMs = msNum(m.time_namelookup);
  const tcpMs = typeof m.time_connect === 'number' ? Math.max(0, (m.time_connect - (m.time_namelookup || 0)) * 1000) : 0;
  const tlsMs = m.time_appconnect > 0 ? Math.max(0, (m.time_appconnect - (m.time_connect || 0)) * 1000) : 0;
  const ttfbMs = msNum(m.time_starttransfer);
  const baseMax = Math.max(totalMs, ttfbMs, 1);
  const pct = (v: number) => (r ? Math.min(100, Math.max(v > 0 ? 4 : 0, Math.round((v / baseMax) * 100))) : 0);

  return `<div class="curl-workspace">
    <section class="panel curl-toolbar">
      <div class="curl-sites" role="group" aria-label="测试站点">
        ${sites
          .map(([id, name, routeTag]) => {
            const rep = state.reports[id];
            const ok = rep && [0, 63].includes(rep.exit_code) && Number(rep.metrics?.http_code) < 400;
            return `<button type="button" data-site="${id}" class="chip-btn ${selected === id ? 'selected' : ''}">
              <span class="site-chip-name">${name}</span>
              <span class="site-route-tag">${routeTag}</span>
              ${rep ? `<span class="result-dot ${ok ? 'ok' : 'bad'}" title="${ok ? '连通正常' : '连接异常'}"></span>` : ''}
            </button>`;
          })
          .join('')}
      </div>
      <div class="curl-actions">
        <button type="button" id="curl-run" class="primary" ${state.running ? 'disabled' : ''}>${state.running ? '正在执行 curl…' : '测试当前站点'}</button>
        <button type="button" id="curl-all" ${state.running ? 'disabled' : ''}>全部测试 (8)</button>
      </div>
    </section>

    <div class="curl-main">
      <section class="panel curl-summary">
        <div class="curl-status-header">
          <div class="curl-status ${!r ? 'neutral' : isBad ? 'bad' : 'ok'}" role="status">
            <span class="status-dot"></span>
            <span>${state.running ? '测试进行中 · ' : ''}${esc(status)}</span>
          </div>
          ${r ? `<span class="curl-timestamp">${esc(new Date(r.time).toLocaleString('zh-CN', { hour12: false }))}</span>` : ''}
        </div>
        <div class="curl-target">${esc(r?.url || '选择上方预置站点（或点击“测试当前站点”）开始系统级 curl 诊断。')}</div>
        ${r ? `<p class="curl-note">${esc(r.path)} · GET · 最多 15 秒 · HTTPS 证书校验</p>` : ''}

        <div class="curl-waterfall">
          <div class="waterfall-title">阶段耗时分布</div>
          ${[
            ['DNS 解析', dnsMs, ms(m.time_namelookup)],
            ['TCP 握手', tcpMs, ms(typeof m.time_connect === 'number' ? Math.max(0, m.time_connect - m.time_namelookup) : null)],
            ['TLS 协商', tlsMs, ms(m.time_appconnect > 0 ? Math.max(0, m.time_appconnect - m.time_connect) : null)],
            ['首字节 TTFB', ttfbMs, ms(m.time_starttransfer)],
            ['总计耗时', totalMs, ms(m.time_total)],
          ]
            .map(
              ([label, val, textVal]) => `<div class="waterfall-row">
                <span class="waterfall-label">${label}</span>
                <div class="waterfall-track"><div class="waterfall-bar" style="width:${pct(val as number)}%"></div></div>
                <strong class="waterfall-val">${esc(textVal)}</strong>
              </div>`
            )
            .join('')}
        </div>

        <div class="curl-stats">
          ${[
            ['总耗时', ms(m.time_total)],
            ['DNS 解析', ms(m.time_namelookup)],
            ['TCP 建连', ms(typeof m.time_connect === 'number' ? Math.max(0, m.time_connect - m.time_namelookup) : null)],
            ['TLS 握手', ms(m.time_appconnect > 0 ? Math.max(0, m.time_appconnect - m.time_connect) : null)],
            ['首字节 TTFB', ms(m.time_starttransfer)],
            [/^198\.(18|19)\./.test(m.remote_ip || '') ? '远端 IP (Fake-IP)' : '连接对端 IP', m.remote_ip || '—'],
            ['本地连接 IP', m.local_ip || '—'],
            ['HTTP 版本', m.http_version || '—'],
            [
              'TLS 校验',
              r
                ? m.ssl_verify_result === 0 && m.time_appconnect > 0
                  ? '通过'
                  : m.ssl_verify_result === 0
                    ? '未完成 / 代理终止'
                    : `失败 ${m.ssl_verify_result}`
                : '—',
            ],
            ['跳转次数', m.num_redirects ?? '—'],
            ['下载字节', m.size_download ?? '—'],
            ['curl 退出码', r?.exit_code ?? '—'],
          ]
            .map(([k, v]) => `<div class="stat-item"><span>${k}</span><strong>${esc(v)}</strong></div>`)
            .join('')}
        </div>
        ${m.url_effective ? `<p class="curl-note"><strong>最终 URL：</strong>${esc(m.url_effective)}</p>` : ''}
        <p class="curl-note">远端 IP 是 curl 建立连接的对端（经代理或 TUN 时可能是代理地址或 Fake-IP）；本地连接 IP 不是公网出口 IP。</p>
        ${r?.truncated ? '<p class="curl-error">正文达到 256 KiB 限制，内容已截断；curl 63 为大小限制，不等于网络断开。</p>' : ''}
        ${state.error ? `<p class="curl-error">${esc(state.error)}</p>` : ''}
      </section>

      <section class="panel curl-raw">
        <div class="curl-raw-head">
          <div class="curl-tabs" role="group" aria-label="原始输出分区">
            ${[
              ['trace', '连接日志'],
              ['headers', '响应头'],
              ['body', '响应正文'],
              ['metrics', '完整指标'],
              ['command', 'curl 命令'],
            ]
              .map(([id, label]) => `<button type="button" data-section="${id}" class="tab-btn ${section === id ? 'selected' : ''}">${label}</button>`)
              .join('')}
          </div>
          <div class="curl-copy-group">
            <button type="button" id="curl-copy" ${!r || section === 'metrics' ? 'disabled' : ''}>复制当前</button>
            <button type="button" id="curl-copy-all" ${!r ? 'disabled' : ''}>复制全部 JSON</button>
          </div>
        </div>
        <p class="curl-note">
          ${
            section === 'trace'
              ? 'curl -v 原始 stderr：> 为发出的请求，< 为响应头，* 为 DNS / TCP / TLS / 代理握手过程。'
              : section === 'body'
                ? '正文仅作为纯文本显示，不执行返回的 HTML 或脚本；最多展示 256 KiB。'
                : section === 'command'
                  ? '可直接在终端重跑的等效命令；应用内部通过独立临时文件收集响应头和正文。'
                  : '展示当前所选分区的原始输出数据。'
          }
        </p>
        <pre tabindex="0" aria-label="原始 curl 输出">${esc(raw || '暂无输出内容，请先点击站点执行测试。')}</pre>
        <div class="curl-raw-foot">
          <span class="curl-feedback" aria-live="polite">${esc(message)}</span>
          <span class="small muted">不读浏览器 Cookie · 忽略 .curlrc · 仅内存保存 · 沿用分流代理设置</span>
        </div>
      </section>
    </div>
  </div>`;
}

export async function handleDiagnosticsClick(
  b: HTMLButtonElement,
  onRender: () => void,
  onToast: (msg: string) => void
): Promise<boolean> {
  if (b.dataset.site) {
    selected = b.dataset.site;
    message = '';
    onRender();
    if (!state.running) await invoke('run_diagnostics', { site: selected });
    return true;
  }
  if (b.dataset.section) {
    section = b.dataset.section;
    message = '';
    onRender();
    return true;
  }
  if (b.id === 'curl-run' || b.id === 'curl-all') {
    message = '';
    await invoke('run_diagnostics', { site: b.id === 'curl-all' ? 'all' : selected });
    return true;
  }
  if (b.id === 'curl-copy' || b.id === 'curl-copy-all') {
    await invoke('copy_diagnostics', { site: selected, section: b.id === 'curl-copy-all' ? 'all' : section });
    message = '已复制到剪贴板';
    onToast('curl 诊断内容已复制到剪贴板');
    onRender();
    return true;
  }
  return false;
}

export async function initDiagnostics(onUpdate: (openTab?: boolean) => void) {
  await listen<DiagState>('diagnostics-state', e => {
    state = e.payload;
    if (state.running && state.selected) selected = state.selected;
    onUpdate(false);
  });
  await listen('open-diagnostics', () => {
    onUpdate(true);
  });
  try {
    state = await invoke<DiagState>('get_diagnostics');
    selected = state.selected || 'baidu';
  } catch {}
}
