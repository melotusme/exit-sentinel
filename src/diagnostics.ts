import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import './diagnostics.css';

type Report = {
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

type State = {
  running: boolean;
  selected: string;
  reports: Record<string, Report>;
  error: string | null;
};

const sites = [
  ['baidu', '百度'],
  ['bing', '必应中国'],
  ['google', 'Google'],
  ['cloudflare', 'Cloudflare'],
  ['apple', 'Apple'],
  ['github', 'GitHub'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

let state: State = { running: false, selected: 'baidu', reports: {}, error: null },
  selected = 'baidu',
  section = 'trace',
  message = '';

const ms = (s: unknown) => (typeof s === 'number' ? `${(s * 1000).toFixed(1)} ms` : '—');

function render() {
  const r = state.reports[selected],
    m = r?.metrics || {};
  const status = !r
    ? '尚未测试'
    : r.exit_code === 63
      ? `HTTP ${m.http_code} · 已连接，正文超过限制`
      : r.exit_code !== 0
        ? `curl 失败 · 退出码 ${r.exit_code}`
        : Number(m.http_code) >= 400
          ? `HTTP ${m.http_code} · 站点返回错误`
          : `HTTP ${m.http_code} · 已收到响应`;
  const isBad = Boolean(r && (![0, 63].includes(r.exit_code) || Number(m.http_code) >= 400));
  const raw = r
    ? section === 'metrics'
      ? JSON.stringify(m, null, 2)
      : r[section as 'command' | 'trace' | 'headers' | 'body']
    : '';

  document.querySelector('#app')!.innerHTML = `<div class="curl-shell">
    <header class="curl-head">
      <div class="curl-title-group">
        <span class="eyebrow">QUICK NETWORK CHECK</span>
        <h1>网站连通性 <span class="curl-badge">系统 curl</span></h1>
      </div>
      <button id="curl-close" aria-label="关闭测试面板">关闭窗口</button>
    </header>
    <div class="curl-toolbar">
      <div class="curl-sites" role="group" aria-label="测试站点">
        ${sites
          .map(
            ([id, name]) =>
              `<button data-site="${id}" class="chip-btn ${selected === id ? 'selected' : ''}">
                <span>${name}</span>
                ${
                  state.reports[id]
                    ? `<span class="result-dot ${[0, 63].includes(state.reports[id].exit_code) && Number(state.reports[id].metrics?.http_code) < 400 ? 'ok' : 'bad'}"></span>`
                    : ''
                }
              </button>`
          )
          .join('')}
      </div>
      <div class="curl-actions">
        <button id="curl-run" class="primary" ${state.running ? 'disabled' : ''}>${state.running ? '正在测试…' : '测试当前站点'}</button>
        <button id="curl-all" ${state.running ? 'disabled' : ''}>全部测试</button>
      </div>
    </div>
    <main class="curl-main">
      <section class="curl-summary">
        <div class="curl-status-header">
          <div class="curl-status ${!r ? 'neutral' : isBad ? 'bad' : 'ok'}" role="status">
            <span class="status-dot"></span>
            <span>${state.running ? '测试进行中 · ' : ''}${esc(status)}</span>
          </div>
          ${r ? `<span class="curl-timestamp">${esc(new Date(r.time).toLocaleString('zh-CN', { hour12: false }))}</span>` : ''}
        </div>
        <div class="curl-target">${esc(r?.url || '从上方选择站点，或在菜单栏直接点击站点开始测试。')}</div>
        ${r ? `<p class="curl-note">${esc(r.path)} · GET · 最多 15 秒 · HTTPS 校验证书</p>` : ''}
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
        <p class="curl-note">远端 IP 是 curl 建立连接的对端，使用代理时可能是代理服务器；本地连接 IP 不是公网出口 IP。阶段耗时是 curl 测量值，跳转 / 代理会影响含义。</p>
        ${r?.truncated ? '<p class="curl-error">正文达到 256 KiB 限制，内容不完整；curl 63 为大小限制，不等于网络断开。</p>' : ''}
        ${state.error ? `<p class="curl-error">${esc(state.error)}</p>` : ''}
      </section>
      <section class="curl-raw">
        <div class="curl-raw-head">
          <div class="curl-tabs" role="group" aria-label="原始输出分区">
            ${[
              ['command', 'curl 命令'],
              ['trace', '连接日志'],
              ['headers', '响应头'],
              ['body', '响应正文'],
              ['metrics', '完整指标'],
            ]
              .map(([id, label]) => `<button data-section="${id}" class="tab-btn ${section === id ? 'selected' : ''}">${label}</button>`)
              .join('')}
          </div>
          <div class="curl-copy-group">
            <button id="curl-copy" ${!r || section === 'metrics' ? 'disabled' : ''}>复制当前</button>
            <button id="curl-copy-all" ${!r ? 'disabled' : ''}>复制全部</button>
          </div>
        </div>
        <p class="curl-note">
          ${
            section === 'trace'
              ? 'curl -v 原始 stderr：> 为发出的请求，< 为响应头，* 为 DNS / TCP / TLS / 代理日志。'
              : section === 'body'
                ? '正文仅作为文本显示，不执行返回的 HTML 或脚本；压缩正文由 curl 解压，最多展示 256 KiB。'
                : section === 'command'
                  ? '可直接在终端重跑的等效命令；应用实际使用独立文件收集响应头和正文。'
                  : '展示当前所选分区的原始输出数据。'
          }
        </p>
        <pre tabindex="0" aria-label="原始 curl 输出">${esc(raw || '暂无内容')}</pre>
        <p class="curl-feedback" aria-live="polite">${esc(message)}</p>
      </section>
    </main>
    <footer class="curl-foot">仅手动运行 · 不读取浏览器 Cookie · 不加载 .curlrc · 结果仅内存保存 · 沿用国内 / 国外检测代理设置</footer>
  </div>`;
}

export async function startDiagnostics() {
  const savedTheme = localStorage.getItem('sentinel.theme') || 'light';
  document.documentElement.dataset.theme = savedTheme;
  document.body.classList.add('diagnostics');
  await listen<State>('diagnostics-state', e => {
    state = e.payload;
    if (state.running && state.selected) selected = state.selected;
    render();
  });
  state = await invoke<State>('get_diagnostics');
  selected = state.selected || 'baidu';
  render();
  document.addEventListener('click', async e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b || b.disabled) return;
    try {
      if (b.dataset.site) {
        selected = b.dataset.site;
        render();
        if (!state.running) await invoke('run_diagnostics', { site: selected });
        return;
      }
      if (b.dataset.section) {
        section = b.dataset.section;
        message = '';
        render();
        return;
      }
      if (b.id === 'curl-close') {
        await getCurrentWindow().hide();
        return;
      }
      if (b.id === 'curl-run' || b.id === 'curl-all') {
        await invoke('run_diagnostics', { site: b.id === 'curl-all' ? 'all' : selected });
        return;
      }
      if (b.id === 'curl-copy' || b.id === 'curl-copy-all') {
        await invoke('copy_diagnostics', { site: selected, section: b.id === 'curl-copy-all' ? 'all' : section });
        message = '已复制到剪贴板';
        render();
      }
    } catch (e) {
      message = String(e);
      render();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') void getCurrentWindow().hide();
  });
}
