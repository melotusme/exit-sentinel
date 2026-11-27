// Network Workbench (`网络工具`):
// Sub-tabs: `网站连通性` (`curl`) | `IP 归属查询` (`ip-lookup`) | `按地区找节点` (`find`).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createIpIntelController } from './ip-details';
import { findNear, renderNodeFinder, resetNodeFinder } from './node-finder';
import type { AppShellApi } from './store';
import type { PanelHandle, View } from './types';
import { copyToClipboard, esc, icon, time } from './ui';

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

interface SiteDef {
  id: string;
  label: string;
}

interface SiteGroup {
  title: string;
  items: SiteDef[];
}

const SITE_GROUPS: SiteGroup[] = [
  {
    title: 'AI 服务',
    items: [
      { id: 'claude', label: 'Claude' },
      { id: 'gemini', label: 'Gemini' },
    ],
  },
  {
    title: '海外站点',
    items: [
      { id: 'google', label: 'Google' },
      { id: 'cloudflare', label: 'Cloudflare' },
      { id: 'github', label: 'GitHub' },
      { id: 'apple', label: 'Apple' },
      { id: 'bing', label: 'Bing' },
    ],
  },
  {
    title: '国内站点',
    items: [{ id: 'baidu', label: 'Baidu' }],
  },
];

const ALL_SITE_IDS = SITE_GROUPS.flatMap(g => g.items.map(i => i.id));

type InspectorSection = 'trace' | 'headers' | 'body' | 'command';

const INSPECTOR_TABS: Array<[InspectorSection, string]> = [
  ['trace', '连接跟踪 Trace'],
  ['headers', '响应头 Headers'],
  ['body', '响应体预览 Body'],
  ['command', '等价 curl 命令'],
];

let state: DiagState = { running: false, selected: 'claude', reports: {}, error: null };
let selected = 'claude';
let family: 'auto' | '4' | '6' = 'auto';
let section: InspectorSection = 'trace';
let copyFeedback = '';

const secToMs = (s: unknown): number =>
  typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1000 : 0;

const fmtMs = (msVal: number | null): string =>
  msVal === null || !Number.isFinite(msVal) ? '—' : `${msVal.toFixed(1)} ms`;

function fmtBytes(n: unknown): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b < 0) return '—';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function isPublicLookupIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const s = ip.trim().toLowerCase();
  if (!s || s === '::1' || s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return false;
  if (
    s.startsWith('127.') ||
    s.startsWith('10.') ||
    s.startsWith('192.168.') ||
    s.startsWith('198.18.') ||
    s.startsWith('198.19.') ||
    s.startsWith('169.254.')
  ) {
    return false;
  }
  const m172 = /^172\.(\d+)\./.exec(s);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return false;
  }
  return true;
}

function summarizeProxyPath(rawPath: string | undefined): string {
  if (!rawPath) return '默认分流策略';
  if (rawPath.startsWith('显式代理：')) {
    const raw = rawPath.replace('显式代理：', '').trim();
    return raw
      .replace(/^http:\/\//i, 'HTTP ')
      .replace(/^https:\/\//i, 'HTTPS ')
      .replace(/^socks5h?:\/\//i, 'SOCKS5 ');
  }
  if (rawPath.startsWith('direct：')) return '直连 (Direct)';
  if (rawPath.includes('本机路由 / TUN')) return '系统路由 / TUN';
  return rawPath;
}

function findMatchingPublicExit(siteId: string, v: View | undefined): string | null {
  if (!v) return null;
  if (siteId === 'claude') return v.verdicts.find(x => x.service === 'claude')?.ip || v.claude.ip || null;
  if (siteId === 'gemini' || siteId === 'google') {
    return v.verdicts.find(x => x.service === 'gemini')?.ip || v.gemini.ip || null;
  }
  if (siteId === 'baidu' || siteId === 'bing') {
    return v.probes.find(p => p.group === 'domestic' && p.ip)?.ip || null;
  }
  return v.probes.find(p => p.group === 'foreign' && p.ip)?.ip || null;
}

export function getDiagnosticsState() {
  const reportKey = (id: string) => (family === 'auto' ? id : `${id}@${family}`);
  return {
    state,
    selected,
    testedCount: ALL_SITE_IDS.filter(id => Boolean(state.reports[reportKey(id)])).length,
    totalCount: ALL_SITE_IDS.length,
  };
}

function isReportOk(rep: Report | undefined): boolean {
  if (!rep) return false;
  const code = Number(rep.metrics?.http_code || 0);
  return [0, 63].includes(rep.exit_code) && code > 0 && code < 400;
}

export function renderDiagnosticsTab(v?: View): string {
  const key = family === 'auto' ? selected : `${selected}@${family}`;
  const r = state.reports[key];
  const m = r?.metrics || {};
  const siteLabel = SITE_GROUPS.flatMap(g => g.items).find(s => s.id === selected)?.label || selected;

  const httpCode = Number(m.http_code || 0);
  const ok = isReportOk(r);
  const statusText = !r
    ? `${siteLabel} · 尚未测试`
    : r.exit_code === 63 && httpCode > 0 && httpCode < 400
      ? `HTTP ${httpCode} · 连通正常（正文超 256 KiB 截断）`
      : r.exit_code !== 0
        ? `连接失败 · curl 退出码 ${r.exit_code}`
        : httpCode >= 400
          ? `HTTP ${httpCode} · 响应受限或异常`
          : `HTTP ${httpCode} · 连通正常`;

  // Timing breakdown (waterfall offsets + stage durations in ms)
  const tDnsEnd = secToMs(m.time_namelookup);
  const tTcpEnd = Math.max(tDnsEnd, secToMs(m.time_connect));
  const hasTls = typeof m.time_appconnect === 'number' && m.time_appconnect > 0;
  const tTlsEnd = hasTls ? Math.max(tTcpEnd, secToMs(m.time_appconnect)) : tTcpEnd;
  const hasTtfb = typeof m.time_starttransfer === 'number' && m.time_starttransfer > 0;
  const tTtfbEnd = hasTtfb ? Math.max(tTlsEnd, secToMs(m.time_starttransfer)) : tTlsEnd;
  const tTotal = Math.max(tTtfbEnd, secToMs(m.time_total));

  const dnsDur = r ? tDnsEnd : null;
  const tcpDur = r && m.time_connect > 0 ? Math.max(0, tTcpEnd - tDnsEnd) : null;
  const tlsDur = r ? (hasTls ? Math.max(0, tTlsEnd - tTcpEnd) : 0) : null;
  const ttfbWaitDur = r && hasTtfb ? Math.max(0, tTtfbEnd - tTlsEnd) : null;
  const transferDur = r && tTotal > 0 ? Math.max(0, tTotal - tTtfbEnd) : null;

  const scaleMax = Math.max(tTotal, 1);
  const barStyle = (startMs: number, durMs: number | null) => {
    if (!r || durMs === null || durMs <= 0) return 'left:0%;width:0%';
    const left = Math.min(96, Math.max(0, (startMs / scaleMax) * 100));
    const rawW = Math.max(2.5, (durMs / scaleMax) * 100);
    const width = Math.min(100 - left, rawW);
    return `left:${left.toFixed(1)}%;width:${width.toFixed(1)}%`;
  };

  const waterfallStages: Array<{ label: string; start: number; dur: number | null; tone: string }> = [
    { label: 'DNS 解析', start: 0, dur: dnsDur, tone: 'dns' },
    { label: 'TCP 握手', start: tDnsEnd, dur: tcpDur, tone: 'tcp' },
    { label: 'TLS 握手', start: tTcpEnd, dur: tlsDur, tone: 'tls' },
    { label: '首字节等待 (TTFB)', start: tTlsEnd, dur: ttfbWaitDur, tone: 'ttfb' },
    { label: '内容传输', start: tTtfbEnd, dur: transferDur, tone: 'transfer' },
  ];

  // Remote IP & Click-to-Lookup
  const remoteIp = String(m.remote_ip || '');
  const remoteIsPublic = isPublicLookupIp(remoteIp);
  const remoteIsFakeIp = /^198\.(18|19)\./.test(remoteIp);
  const remoteIsLoopback = remoteIp.startsWith('127.') || remoteIp === '::1';
  const fallbackPublicExit = !remoteIsPublic ? findMatchingPublicExit(selected, v) : null;

  const remoteCellHtml = !r || !remoteIp
    ? '<strong class="mono tabular">—</strong>'
    : remoteIsPublic
      ? `<div class="stat-ip-row">
          <strong class="mono tabular nowrap">${esc(remoteIp)}</strong>
          <button type="button" class="text-button compact" data-ip-modal="${esc(remoteIp)}" title="查看该远端 IP 归属详情">查归属 ↗</button>
        </div>`
      : `<div class="stat-ip-row">
          <strong class="mono tabular nowrap">${esc(remoteIp)}</strong>
          <span class="stat-subtag">${remoteIsFakeIp ? 'Fake-IP' : remoteIsLoopback ? '本机代理' : '内网对端'}</span>
          ${
            fallbackPublicExit
              ? `<button type="button" class="text-button compact" data-ip-modal="${esc(fallbackPublicExit)}" title="连接经本机代理转发；点击查看实测公网出口 ${esc(fallbackPublicExit)}">查出口 ↗</button>`
              : ''
          }
        </div>`;

  const httpCellText = !r
    ? '—'
    : httpCode > 0
      ? `${httpCode}${m.http_version ? ` (HTTP/${m.http_version})` : ''}`
      : `未响应 (exit ${r.exit_code})`;

  const tlsVerifyText = !r
    ? '—'
    : m.ssl_verify_result === 0 && hasTls
      ? '证书有效'
      : m.ssl_verify_result === 0
        ? '代理解密/未建连'
        : `校验异常 (${m.ssl_verify_result})`;

  const rawContent = r ? r[section] || '' : '';
  const inspectorHint =
    section === 'trace'
      ? 'curl -v 握手跟踪：* 为 DNS/TCP/TLS/代理阶段，> 为请求头，< 为响应头。'
      : section === 'headers'
        ? '服务端返回的完整 HTTP 响应头（含重定向链路）。'
        : section === 'body'
          ? '纯文本安全预览（不执行任何 HTML 或脚本，单次上限 256 KiB）。'
          : '可在系统终端独立复现的等价 curl 命令。';

  return `<div class="curl-workspace">
    <!-- Top Control Bar -->
    <section class="panel curl-toolbar">
      <div class="curl-site-groups" role="group" aria-label="预设检测站点">
        ${SITE_GROUPS.map(
          group => `<div class="curl-site-group">
            <span class="site-group-label">${esc(group.title)}</span>
            <div class="site-group-chips">
              ${group.items
                .map(item => {
                  const rep = state.reports[family === 'auto' ? item.id : `${item.id}@${family}`];
                  const itemOk = isReportOk(rep);
                  const isSel = selected === item.id;
                  return `<button
                    type="button"
                    data-site="${item.id}"
                    aria-pressed="${isSel}"
                    class="chip-btn site-chip ${isSel ? 'selected' : ''}"
                  >
                    ${rep ? `<span class="result-dot ${itemOk ? 'ok' : 'bad'}" aria-hidden="true"></span>` : ''}
                    <span>${esc(item.label)}</span>
                  </button>`;
                })
                .join('')}
            </div>
          </div>`
        ).join('')}
      </div>

      <div class="curl-actions-row">
        <div class="segmented-control" role="group" aria-label="IP 地址族">
          ${(
            [
              ['auto', '自动'],
              ['4', 'IPv4'],
              ['6', 'IPv6'],
            ] as const
          )
            .map(
              ([id, label]) =>
                `<button type="button" data-family="${id}" aria-pressed="${family === id}" ${state.running ? 'disabled' : ''}>${label}</button>`
            )
            .join('')}
        </div>

        <div class="curl-run-buttons">
          <button type="button" id="curl-run" class="primary" ${state.running ? 'disabled' : ''}>
            ${icon('play')}<span>${state.running ? '正在执行…' : '测试当前站点'}</span>
          </button>
          <button type="button" id="curl-ai" ${state.running ? 'disabled' : ''}>
            <span>测试 AI 服务</span>
          </button>
          <button type="button" id="curl-all" ${state.running ? 'disabled' : ''}>
            <span>全部测试</span>
          </button>
        </div>
      </div>
    </section>

    <!-- 2-Column Diagnostics Workspace -->
    <div class="curl-main">
      <!-- Left: Status + Timing Waterfall + 2x4 Summary Grid -->
      <section class="panel curl-summary" aria-label="连接耗时与摘要指标">
        <div class="curl-status-header">
          <div class="curl-status ${!r ? 'neutral' : ok ? 'ok' : 'bad'}" role="status">
            <span class="status-dot"></span>
            <span>${state.running ? '测试运行中 · ' : ''}${esc(statusText)}</span>
          </div>
          ${r ? `<span class="curl-timestamp tabular">${esc(time(r.time))}</span>` : ''}
        </div>

        <div class="curl-target mono">${esc(r?.url || `已选择 ${siteLabel}，点击「测试当前站点」或「测试 AI 服务」开始诊断`)}</div>

        ${state.error ? `<div class="curl-error" role="alert">${esc(state.error)}</div>` : ''}
        ${r?.truncated ? `<div class="ip-inline-alert warn">响应体达到 256 KiB 安全读取上限并截断（curl 退出码 63 属正常截断保护，并非断网）。</div>` : ''}

        <div class="curl-waterfall" aria-label="HTTP 阶段耗时瀑布图">
          <div class="waterfall-head">
            <h3>HTTP 阶段耗时瀑布图</h3>
            <span class="mono tabular muted small">总计 ${esc(r ? fmtMs(tTotal) : '—')}</span>
          </div>
          ${waterfallStages
            .map(
              st => `<div class="waterfall-row">
                <span class="waterfall-label">${esc(st.label)}</span>
                <div class="waterfall-track">
                  <div class="waterfall-bar tone-${st.tone}" style="${barStyle(st.start, st.dur)}"></div>
                </div>
                <strong class="waterfall-val mono tabular">${esc(fmtMs(st.dur))}</strong>
              </div>`
            )
            .join('')}
        </div>

        <!-- 2x4 Summary Grid (8 Crisp Cells) -->
        <div class="curl-stats-grid">
          <div class="stat-item">
            <span>HTTP 状态码</span>
            <strong class="mono tabular">${esc(httpCellText)}</strong>
          </div>
          <div class="stat-item">
            <span>总耗时</span>
            <strong class="mono tabular">${esc(r ? fmtMs(tTotal) : '—')}</strong>
          </div>
          <div class="stat-item">
            <span>远端出口 / 对端 IP</span>
            ${remoteCellHtml}
          </div>
          <div class="stat-item">
            <span>实际代理通道</span>
            <strong class="tabular" title="${esc(r?.path || '沿用分流代理设置')}">${esc(r ? summarizeProxyPath(r.path) : '沿用分流代理设置')}</strong>
          </div>
          <div class="stat-item">
            <span>首字节响应 (累计)</span>
            <strong class="mono tabular">${esc(r && hasTtfb ? fmtMs(tTtfbEnd) : '—')}</strong>
          </div>
          <div class="stat-item">
            <span>TLS 证书校验</span>
            <strong>${esc(tlsVerifyText)}</strong>
          </div>
          <div class="stat-item">
            <span>下载大小 / 重定向</span>
            <strong class="mono tabular">${esc(r ? `${fmtBytes(m.size_download)} · ${m.num_redirects ?? 0} 次` : '—')}</strong>
          </div>
          <div class="stat-item">
            <span>地址族 / 退出码</span>
            <strong class="mono tabular">${esc(r ? `${family === 'auto' ? '自动' : `IPv${family}`} · exit ${r.exit_code}` : family === 'auto' ? '自动双栈' : `仅 IPv${family}`)}</strong>
          </div>
        </div>

        ${
          m.url_effective && r && m.url_effective !== r.url
            ? `<p class="curl-note"><strong>最终跳转地址：</strong><span class="mono">${esc(m.url_effective)}</span></p>`
            : ''
        }
      </section>

      <!-- Right: Clean Dark Code / Inspector Pane -->
      <section class="panel curl-raw" aria-label="原始报文与跟踪日志">
        <div class="curl-raw-head">
          <div class="curl-tabs" role="tablist" aria-label="诊断输出分区">
            ${INSPECTOR_TABS.map(
              ([id, label]) =>
                `<button type="button" role="tab" data-section="${id}" aria-selected="${section === id}" class="tab-btn ${section === id ? 'selected' : ''}">${esc(label)}</button>`
            ).join('')}
          </div>
          <div class="curl-copy-group">
            <button type="button" id="curl-copy" ${!r ? 'disabled' : ''}>
              ${icon('copy')}<span>复制当前内容</span>
            </button>
            <button type="button" id="curl-copy-all" ${!r ? 'disabled' : ''}>
              <span>复制完整报告</span>
            </button>
          </div>
        </div>

        <p class="curl-note">${esc(inspectorHint)}</p>

        <pre class="curl-code-viewer" tabindex="0" aria-label="${esc(INSPECTOR_TABS.find(([id]) => id === section)?.[1] || '诊断输出')}">${esc(
          rawContent || (state.running ? '正在执行系统 curl 并采集握手日志，请稍候…' : '尚未生成报文记录。在上方选择目标站点并点击测试后，此处将展示原始连接跟踪日志、响应头与命令。')
        )}</pre>

        <div class="curl-raw-foot">
          <span class="curl-feedback" aria-live="polite">${esc(copyFeedback)}</span>
          <span class="small muted">独立无痕请求 · 忽略浏览器 Cookie 与 .curlrc · 结果仅驻留内存</span>
        </div>
      </section>
    </div>
  </div>`;
}

async function handleCurlClick(
  b: HTMLButtonElement,
  app: AppShellApi,
  onRender: () => void
): Promise<boolean> {
  if (b.dataset.family) {
    family = b.dataset.family as 'auto' | '4' | '6';
    copyFeedback = '';
    onRender();
    return true;
  }
  if (b.dataset.site) {
    selected = b.dataset.site;
    copyFeedback = '';
    onRender();
    return true;
  }
  if (b.dataset.section) {
    section = b.dataset.section as InspectorSection;
    copyFeedback = '';
    onRender();
    return true;
  }
  if (b.id === 'curl-run' || b.id === 'curl-ai' || b.id === 'curl-all') {
    copyFeedback = '';
    const target = b.id === 'curl-all' ? 'all' : b.id === 'curl-ai' ? 'ai' : selected;
    const arg = family === 'auto' ? target : `${target}@${family}`;
    await app.call('run_diagnostics', { site: arg });
    return true;
  }
  if (b.id === 'curl-copy' || b.id === 'curl-copy-all') {
    const key = family === 'auto' ? selected : `${selected}@${family}`;
    const sec = b.id === 'curl-copy-all' ? 'all' : section;
    try {
      await invoke('copy_diagnostics', { site: key, section: sec });
    } catch {
      const rep = state.reports[key];
      if (!rep) return true;
      const fallbackText = sec === 'all' ? JSON.stringify(rep, null, 2) : rep[section];
      await copyToClipboard(fallbackText);
    }
    copyFeedback = sec === 'all' ? '完整 JSON 报告已复制' : '当前分区内容已复制';
    app.showToast(copyFeedback);
    onRender();
    return true;
  }
  return false;
}

let listenersInitialized = false;

export async function initDiagnostics(onUpdate: (openTab?: boolean) => void) {
  if (!listenersInitialized) {
    listenersInitialized = true;
    await listen<DiagState>('diagnostics-state', e => {
      state = e.payload;
      if (state.running && state.selected && ALL_SITE_IDS.includes(state.selected)) {
        selected = state.selected;
      }
      onUpdate(false);
    });
    await listen('open-diagnostics', () => {
      onUpdate(true);
    });
  }
  try {
    state = await invoke<DiagState>('get_diagnostics');
    if (state.selected && ALL_SITE_IDS.includes(state.selected)) {
      selected = state.selected;
    }
  } catch {}
}

export function initDiagnosticsPanel(panel: HTMLElement, app: AppShellApi): PanelHandle {
  let currentSub = 'curl';

  const inlineIpIntel = createIpIntelController(app, {
    mode: 'inline',
    getContainer: () => (currentSub === 'ip-lookup' ? panel : null),
    isActive: () => app.getRoute().tab === 'diagnostics' && currentSub === 'ip-lookup',
  });

  inlineIpIntel.bindEvents(panel);

  const repaint = (v = app.getState()) => {
    if (currentSub === 'find') {
      panel.innerHTML = renderNodeFinder(app);
    } else if (currentSub === 'ip-lookup') {
      panel.innerHTML = inlineIpIntel.renderView(v);
    } else {
      panel.innerHTML = renderDiagnosticsTab(v);
    }
  };

  panel.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;
    if (currentSub === 'curl') {
      await handleCurlClick(btn, app, () => repaint());
    } else if (currentSub === 'find' && btn.dataset.nearPreset) {
      await findNear(app, btn.dataset.nearPreset, () => {
        if (currentSub === 'find') repaint();
      });
    }
  });

  panel.addEventListener('submit', event => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'near-form') {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>('#near-query-input');
      const text = String(input?.value || '').trim();
      if (!text) {
        input?.setAttribute('aria-invalid', 'true');
        input?.focus();
        return;
      }
      input?.setAttribute('aria-invalid', 'false');
      void findNear(app, text, () => {
        if (currentSub === 'find') repaint();
      });
    }
  });

  void initDiagnostics(openTab => {
    if (openTab) {
      void app.navigate('diagnostics', 'curl');
    } else if (app.getRoute().tab === 'diagnostics') {
      // Refresh header subtab tested badge (`N/8`) and repaint curl view if visible.
      if (currentSub === 'curl') repaint();
    }
  });

  return {
    getSubTabs() {
      const { testedCount, totalCount } = getDiagnosticsState();
      return [
        { id: 'curl', label: '网站连通性', badge: `${testedCount}/${totalCount}` },
        { id: 'ip-lookup', label: 'IP 归属查询' },
        { id: 'find', label: '按地区找节点' },
      ];
    },
    render(view, activeSub) {
      currentSub = activeSub || 'curl';
      repaint(view);
    },
    onDataCleared(scope) {
      if (scope === 'all') {
        inlineIpIntel.reset();
        resetNodeFinder();
        copyFeedback = '';
        void initDiagnostics(() => {
          if (app.getRoute().tab === 'diagnostics') repaint();
        });
      }
    },
    onNavigatePayload(sub, payload) {
      if (!payload || typeof payload !== 'object') return;
      const p = payload as Record<string, unknown>;
      if (sub === 'ip-lookup' && typeof p.ip === 'string' && p.ip.trim()) {
        void inlineIpIntel.inspectIp(p.ip.trim(), Boolean(p.force));
      } else if (sub === 'find' && typeof p.query === 'string' && p.query.trim()) {
        void findNear(app, p.query.trim(), () => {
          if (currentSub === 'find') repaint();
        });
      }
    },
  };
}
