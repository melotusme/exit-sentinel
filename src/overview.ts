// Live Safety & Exit Dashboard (概览) — Exit Sentinel
// Zero-scroll 1080×740 operational overview: unified alert strip, 2-col AI Verdict Deck,
// 4-col Network Exit & Uplink strip, Recent Changes feed, and collapsible Probe/Proxy snapshots.

import { ListView } from './list';
import { geoCache, series, type AppShellApi } from './store';
import type { Event, PanelHandle, Probe, RouteSnapshot, Safety, ServiceHealth, Uplink, Verdict, View } from './types';
import { ago, esc, formatGeoSummary, icon, safetyText, serviceName, time, titles } from './ui';

export { geoCache, series };

/** Operator belongs to the observed public IP, not the detection site's brand. */
export function operator(p: Probe): string {
  if (!p.ip) return '';
  return p.isp || geoCache.get(p.ip)?.connection?.isp || '';
}

export const lanRows = (v: View): Probe[] => v.probes.filter(p => Boolean(p.source_ip));

export const lanList = new ListView<Probe>(
  'lan-egress',
  {
    source: { label: '局域网源地址', value: p => p.source_ip || '' },
    interface: { label: '网卡', value: p => p.source_interface || '' },
    ip: { label: '公网出口', value: p => p.ip || '' },
    isp: { label: '运营商', value: operator },
    target: { label: '检测目标', value: p => p.url },
  },
  p => `${p.source_interface || ''} ${p.source_ip || ''} ${p.source_dns || ''} ${p.ip || ''} ${operator(p)} ${p.url} ${p.error || ''}`,
  p => (p.ip ? 'ok' : p.checked ? 'error' : 'waiting'),
  { ok: '已测得出口', error: '检测失败', waiting: '等待检测' },
  {
    defaultSize: 20,
    searchPlaceholder: '筛选网卡、源地址、出口 IP 或运营商…',
    emptyTitle: '尚无本机物理网卡 IPv4 出口对照记录',
    emptyHint: '连接有线或无线网络后将自动按已分配源地址探测国内出口',
  }
);

export function lanRow(p: Probe): string {
  let host = p.url;
  try {
    host = new URL(p.url).hostname;
  } catch {}
  return `<article class="lan-egress-row">
    <div class="lan-col">
      <strong class="truncate" title="${esc(p.source_interface || '')}">${esc(p.source_interface || '物理网卡')}</strong>
      <small class="mono tabular">${esc(p.source_ip || '')}${p.source_dns ? ` · ${esc(p.source_dns)}` : ''}</small>
    </div>
    <div class="lan-col">
      <strong class="mono tabular">${esc(p.ip || (p.checked ? '不可达' : '等待检测'))}</strong>
      <small class="truncate" title="${esc(p.ip ? `运营商：${operator(p) || '未查到'}` : p.error || '')}">${esc(
        p.ip ? `运营商：${operator(p) || '未查到'}` : p.error || '等待首轮探测'
      )}</small>
    </div>
    <div class="lan-col lan-col-end">
      <small class="tabular">${esc(host)}${p.checked ? ` · ${esc(ago(p.checked))}` : ''}</small>
      ${
        p.ip
          ? `<div class="tile-actions">
              <button type="button" class="text-button compact" data-copy-text="${esc(p.ip)}">复制</button>
              <button type="button" class="text-button compact" data-detail="${esc(p.id)}" aria-label="详情 ${esc(
                p.source_interface || ''
              )} ${esc(p.source_ip || '')} ${esc(host)}">详情</button>
            </div>`
          : ''
      }
    </div>
  </article>`;
}

const ISO3_TO_SHORT: Record<string, string> = {
  USA: 'US',
  GBR: 'UK',
  JPN: 'JP',
  SGP: 'SG',
  DEU: 'DE',
  FRA: 'FR',
  NLD: 'NL',
  CAN: 'CA',
  AUS: 'AU',
  KOR: 'KR',
  TWN: 'TW',
  HKG: 'HKG',
  MAC: 'MAC',
  CHN: 'CHN',
};

const PROBE_GROUP_SHORT: Record<string, string> = {
  domestic: '国内 IPv4',
  foreign: '国外 IPv4',
  domestic6: '国内 IPv6',
  foreign6: '国外 IPv6',
};

const SITE_ORDER: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'google', label: 'Google' },
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'antigravity', label: 'Antigravity' },
];

export function recordSeries(v: View) {
  for (const p of v.probes) {
    if (!p.checked) continue;
    const prev = series.get(p.id) || { time: '', values: [] };
    if (prev.time === p.checked) continue;
    const values = p.ip ? [...prev.values, p.latency].slice(-24) : prev.values;
    series.set(p.id, { time: p.checked, values });
  }
}

function shortClock(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const rel = ago(iso);
  if (rel && (rel === '刚刚' || rel.endsWith('分钟前'))) return rel;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function resolveRouteForService(v: View, service: string): RouteSnapshot | null {
  const monitor = service === 'claude' ? v.claude : v.gemini;
  if (monitor?.route) return monitor.route;
  return v.current_routes.find(r => r.service === service) || null;
}

function formatRouteClient(route: RouteSnapshot | null, x: Verdict): string {
  const raw = `${route?.config || ''} ${route?.basis || ''}`;
  let client = '';
  if (/clash|mihomo|verge/i.test(raw)) client = 'Clash';
  else if (/shadowrocket/i.test(raw)) client = 'Shadowrocket';
  else if (/surge/i.test(raw)) client = 'Surge';
  else if (/v2ray|sing-box|xray/i.test(raw)) client = '本地代理';

  const mode =
    route?.evidence === 'connection-log' || x.node_source === '最近连接'
      ? '实时'
      : x.node_source || '配置规则';
  return client ? `${client} ${mode}` : mode;
}

/**
 * 1. Single Contextual Alert Strip
 * Completely omitted when monitoring is active, healthy, and acknowledged.
 */
function renderAlertStrip(v: View): string {
  const storageErr = v.storage_error ? `配置保存失败：${v.storage_error}` : '';
  const notifyErr = v.notification_error ? `系统通知异常：${v.notification_error}` : '';
  const hasSystemErr = Boolean(storageErr || notifyErr);
  const hasIssues = Boolean(v.issues && v.issues.length > 0);
  const hasUnack = Boolean(v.unacknowledged);

  if (!v.paused && !hasUnack && !hasIssues && !hasSystemErr) {
    return '';
  }

  if (v.paused) {
    const extra = [storageErr, notifyErr].filter(Boolean).join('；');
    return `<section class="overview-alert tone-paused" role="status">
      <div class="overview-alert-main">
        <span class="overview-alert-icon">${icon('pause')}</span>
        <div class="overview-alert-copy">
          <strong>监控已暂停</strong>
          <span>暂停期间不会轮询出口或记录新变化${extra ? ` · ${esc(extra)}` : ''}</span>
        </div>
      </div>
      <div class="overview-alert-actions">
        <button type="button" id="resume" class="primary compact-action">${icon('play')}<span>恢复监控</span></button>
      </div>
    </section>`;
  }

  if (hasUnack) {
    const tone = v.status === 'risk' ? 'risk' : 'warn';
    const count = v.pending_changes?.length || 1;
    const changeSummary = v.pending_changes?.length
      ? v.pending_changes.join('；')
      : v.history[0]?.detail?.replace(/\s+/g, ' ') || '检测到出口或节点切换，请核对当前状态';
    const issueSuffix = hasIssues ? ` · 异常：${v.issues.join('；')}` : '';
    const errSuffix = hasSystemErr ? ` · ${[storageErr, notifyErr].filter(Boolean).join('；')}` : '';
    return `<section class="overview-alert tone-${tone}" role="alert">
      <div class="overview-alert-main">
        <span class="overview-alert-icon">${icon(tone === 'risk' ? 'danger' : 'alert')}</span>
        <div class="overview-alert-copy">
          <strong class="tabular">待确认变化（${count} 项）</strong>
          <span title="${esc(changeSummary + issueSuffix + errSuffix)}">${esc(changeSummary + issueSuffix + errSuffix)}</span>
        </div>
      </div>
      <div class="overview-alert-actions">
        <button type="button" class="ghost-btn" data-tab="records" data-subtab="history">查看历史</button>
        <button type="button" id="ack" class="primary compact-action">${icon('check')}<span>确认已知变化</span></button>
      </div>
    </section>`;
  }

  if (hasIssues) {
    const tone = v.status === 'offline' || v.status === 'risk' ? 'risk' : 'warn';
    const headline = `${titles[v.status] || '部分检测异常'}（${v.issues.length} 项）`;
    const detail = [v.issues.join('；'), storageErr, notifyErr].filter(Boolean).join(' · ');
    return `<section class="overview-alert tone-${tone}" role="status">
      <div class="overview-alert-main">
        <span class="overview-alert-icon">${icon(tone === 'risk' ? 'danger' : 'alert')}</span>
        <div class="overview-alert-copy">
          <strong class="tabular">${esc(headline)}</strong>
          <span title="${esc(detail)}">${esc(detail)}</span>
        </div>
      </div>
      <div class="overview-alert-actions">
        <button type="button" class="ghost-btn" id="show-probes">查看检测站</button>
        <button type="button" class="ghost-btn" data-settings-section="monitor-settings">忽略项</button>
        <button type="button" id="retry-network" class="primary compact-action" ${v.checking ? 'disabled' : ''}>
          ${icon('refresh')}<span>${v.checking ? '重试中…' : '立即重试'}</span>
        </button>
      </div>
    </section>`;
  }

  const errTone = storageErr ? 'risk' : 'warn';
  const errTitle = storageErr ? '配置保存异常' : '系统通知未就绪';
  const errBody = [storageErr, notifyErr].filter(Boolean).join('；');
  return `<section class="overview-alert tone-${errTone}" role="alert">
    <div class="overview-alert-main">
      <span class="overview-alert-icon">${icon('alert')}</span>
      <div class="overview-alert-copy">
        <strong>${esc(errTitle)}</strong>
        <span>${esc(errBody)}</span>
      </div>
    </div>
    <div class="overview-alert-actions">
      ${notifyErr ? '<button type="button" class="ghost-btn" data-settings-section="monitor-settings">通知权限设置</button>' : ''}
      <button type="button" id="retry-network" class="primary compact-action" ${v.checking ? 'disabled' : ''}>
        ${icon('refresh')}<span>立即重试</span>
      </button>
    </div>
  </section>`;
}

function verdictPillMeta(v: View, x: Verdict): { tone: 'safe' | 'warn' | 'risk' | 'paused'; iconName: string; label: string } {
  if (v.paused || x.headline === '监控已暂停') {
    return { tone: 'paused', iconName: 'pause', label: '监控已暂停' };
  }
  if (x.level === 'risk') {
    return { tone: 'risk', iconName: 'danger', label: '有风险' };
  }
  if (x.health === 'unreachable') {
    return { tone: 'risk', iconName: 'alert', label: '无法访问' };
  }
  if (x.level === 'safe') {
    return { tone: 'safe', iconName: 'check', label: '可以使用' };
  }
  if (x.level === 'unknown' || (!x.ip && !x.node_name)) {
    return { tone: 'paused', iconName: 'globe', label: '出口未确认' };
  }
  return { tone: 'warn', iconName: 'alert', label: '需要确认' };
}

function renderServiceContextPill(v: View, x: Verdict): string {
  if (x.service === 'claude') {
    const running = v.claude?.running;
    if (running === true) {
      return `<span class="ctx-pill is-active" title="本机检测到 Claude 桌面客户端正在运行"><span class="dot green" aria-hidden="true"></span>桌面端运行中</span>`;
    }
    if (running === false) {
      return `<span class="ctx-pill" title="本机未检测到 Claude 桌面进程">桌面端未打开</span>`;
    }
    return `<span class="ctx-pill" title="等待进程检测">进程待检测</span>`;
  }

  const blocked = ['CHN', 'HKG', 'MAC'].includes(x.region_code);
  if (blocked) {
    const tip = [x.region_label, x.region_source ? `来源：${x.region_source}` : '', x.region_checked ? ago(x.region_checked) : '']
      .filter(Boolean)
      .join(' · ');
    return `<span class="ctx-pill is-risk" title="${esc(tip)}">${icon('alert')}<span>${esc(x.region_code)} · 地区受限</span></span>`;
  }
  if (x.region_code || x.region_label) {
    const shortCode = ISO3_TO_SHORT[x.region_code] || x.region_code || x.region_label;
    const tip = [
      `Google 判定地区：${x.region_label || shortCode}`,
      x.region_source ? `来源：${x.region_source}` : '',
      x.region_checked ? ago(x.region_checked) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<span class="ctx-pill is-ok" title="${esc(tip)}">Google 地区: <strong class="mono">${esc(shortCode)}</strong></span>`;
  }
  return `<span class="ctx-pill" title="${esc(x.region_hint || '等待读取 Gemini 页面地区')}">Google 地区: 待确认</span>`;
}

function renderHttpConnectivityPill(v: View, x: Verdict): string {
  const sh: ServiceHealth | undefined = v.service_health?.find(h => h.id === x.service);
  const manual = v.ai_tests?.find(t => t.service === x.service);

  if (sh && sh.checked) {
    if (sh.status === 'unreachable' || sh.http_code === null) {
      const errText = sh.detail || x.health_detail || '连接失败';
      return `<span class="http-pill is-bad" title="${esc(errText)}">${esc(errText.length > 18 ? '连接失败' : errText)}</span>`;
    }
    const toneClass = sh.status === 'reachable' ? 'is-ok' : 'is-warn';
    const msPart = sh.latency > 0 ? ` · ${sh.latency} ms` : '';
    return `<span class="http-pill ${toneClass} tabular" title="${esc(sh.detail || '')}">HTTP ${sh.http_code}${esc(msPart)}</span>`;
  }

  if (manual && manual.time) {
    if (manual.http_code !== null) {
      const msPart = manual.latency > 0 ? ` · ${manual.latency} ms` : '';
      return `<span class="http-pill is-ok tabular" title="来自手动深入测试">HTTP ${manual.http_code}${esc(msPart)}</span>`;
    }
    return `<span class="http-pill is-bad" title="${esc(manual.error || '')}">测试连接失败</span>`;
  }

  if (x.health === 'unreachable') {
    return `<span class="http-pill is-bad">${esc(x.health_detail || '连接失败')}</span>`;
  }
  if (x.health === 'restricted') {
    return `<span class="http-pill is-warn">${esc(x.health_detail || '访问受限')}</span>`;
  }
  return `<span class="http-pill">连通待检</span>`;
}

function renderGeoAndTaxBadges(ip: string): string {
  const geo = geoCache.get(ip);
  if (!geo) return `<span class="evidence-sub-item muted">归属地查询中…</span>`;
  const shortParts = [geo.country, geo.region || geo.city].filter(
    (v, idx, arr) => Boolean(v) && arr.indexOf(v) === idx
  );
  const locShort = shortParts.join(' · ');
  const fullTip = formatGeoSummary(geo, { includeIsp: true, includeTax: true });
  const isUs = geo.country_code === 'US';
  const taxLabel = isUs ? geo.sales_tax?.label || '' : '';
  const isTaxFree = taxLabel.includes('免');
  return `${locShort ? `<span class="geo-chip" title="${esc(fullTip)}">${esc(locShort)}</span>` : ''}
    ${
      taxLabel
        ? `<span class="tax-chip ${isTaxFree ? 'is-free' : 'is-taxed'}" title="${esc(geo.sales_tax?.note || taxLabel)}">${esc(
            isTaxFree ? '免州税' : taxLabel
          )}</span>`
        : ''
    }`;
}

function renderAdvancedMarkGroup(
  kind: 'ip' | 'node',
  x: Verdict,
  currentStatus: Safety | null
): string {
  const statuses: Safety[] = ['pending', 'safe', 'risk'];
  if (kind === 'ip') {
    if (!x.ip) {
      return `<div class="adv-mark-row">
        <span class="adv-mark-label">仅标记 IP</span>
        <span class="muted small">当前无已确认出口 IP</span>
      </div>`;
    }
    return `<div class="adv-mark-row">
      <div class="adv-mark-head">
        <span class="adv-mark-label">仅标记当前 IP</span>
        <span class="mono tabular adv-mark-target">${esc(x.ip)}</span>
      </div>
      <div class="adv-seg" role="group" aria-label="单独设置 ${esc(x.name)} 当前出口 IP 状态">
        ${statuses
          .map(st => {
            const active = currentStatus === st;
            return `<button type="button" class="adv-seg-btn ${st} ${active ? 'is-selected' : ''}" data-mark-ip="${esc(
              x.ip!
            )}" data-service="${esc(x.service)}" data-status="${st}" data-attach-current="true" aria-pressed="${active}">${safetyText(
              st
            )}</button>`;
          })
          .join('')}
      </div>
    </div>`;
  }

  if (!x.node_key) {
    return `<div class="adv-mark-row">
      <span class="adv-mark-label">仅标记节点</span>
      <span class="muted small">${esc(x.node_hint || '当前节点暂不可登记')}</span>
    </div>`;
  }
  return `<div class="adv-mark-row">
    <div class="adv-mark-head">
      <span class="adv-mark-label">仅标记当前节点</span>
      <span class="adv-mark-target truncate" title="${esc(x.node_name)}">${esc(x.node_name)}</span>
    </div>
    <div class="adv-seg" role="group" aria-label="单独设置 ${esc(x.name)} 当前代理节点状态">
      ${statuses
        .map(st => {
          const active = currentStatus === st;
          return `<button type="button" class="adv-seg-btn ${st} ${active ? 'is-selected' : ''}" data-mark-node="${esc(
            x.node_key
          )}" data-service="${esc(x.service)}" data-status="${st}" data-mark-current="true" aria-pressed="${active}">${safetyText(
            st
          )}</button>`;
        })
        .join('')}
    </div>
  </div>`;
}

/**
 * 2. 2-Column AI Verdict Card (`Claude` | `Gemini`)
 */
function renderVerdictCard(v: View, x: Verdict, openFolds: ReadonlySet<string>): string {
  const pill = verdictPillMeta(v, x);
  const route = resolveRouteForService(v, x.service);
  const ipRecord = x.ip ? v.claude_ips.find(r => r.service === x.service && r.ip === x.ip) : undefined;
  const nodeRecord = x.node_record
    ? v.ai_nodes.find(r => r.service === x.service && r.key === x.node_record)
    : undefined;
  const savedNote = ipRecord?.note || nodeRecord?.note || '';

  const canQuickMark = Boolean(x.ip || x.node_key) && !v.paused;
  const effectiveSafety: Safety | null = x.ip ? x.ip_status : x.node_status;
  const isSafeMarked = effectiveSafety === 'safe';
  const isRiskMarked = effectiveSafety === 'risk';
  const markTargetHint = x.ip ? `当前 IP ${x.ip}` : x.node_name ? `节点 ${x.node_name}` : '当前无可登记目标';

  const ipAge = x.ip_checked ? ago(x.ip_checked) : '';
  const ipMeta = [
    x.ip_source,
    ipAge,
    x.ip_status ? `已标${safetyText(x.ip_status)}` : '未登记',
    savedNote ? `备注：${savedNote}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const routeSource = formatRouteClient(route, x);
  const nodeAge = x.node_seen ? ago(x.node_seen) : '';
  const nodeMeta = [
    routeSource,
    nodeAge,
    x.node_stale ? '较早记录' : '',
    x.node_status ? `节点${safetyText(x.node_status)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const nodeTooltip = [
    x.node_name,
    route?.chain?.length ? `策略链：${[route.config, ...route.chain].filter(Boolean).join(' → ')}` : '',
    route?.node_host ? `入口：${route.node_host}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const foldId = `adv-${x.service}`;
  const isAdvOpen = openFolds.has(foldId);

  return `<section class="verdict-card tone-${pill.tone}" aria-labelledby="verdict-title-${esc(x.service)}">
    <header class="verdict-head">
      <div class="verdict-brand-group">
        <span id="verdict-title-${esc(x.service)}" class="service-badge ${esc(x.service)}">${esc(x.name)}</span>
        ${renderServiceContextPill(v, x)}
      </div>
      <span class="verdict-pill tone-${pill.tone}">${icon(pill.iconName)}<span>${esc(pill.label)}</span></span>
    </header>

    <div class="verdict-summary">
      <p class="verdict-headline" title="${esc(x.headline)}">${esc(x.headline)}</p>
    </div>

    <div class="verdict-evidence">
      <div class="evidence-row">
        <span class="evidence-label">当前出口</span>
        <div class="evidence-body">
          ${
            x.ip
              ? `<div class="evidence-primary">
                  <strong class="mono tabular evidence-ip ${x.ip.length > 22 ? 'is-ipv6' : ''}" title="${esc(x.ip)}">${esc(x.ip)}</strong>
                  ${renderGeoAndTaxBadges(x.ip)}
                </div>
                <div class="evidence-sub tabular" title="${esc(ipMeta)}">${esc(ipMeta)}</div>`
              : `<div class="evidence-primary"><span class="evidence-empty">尚未确认出口 IP</span></div>
                <div class="evidence-sub">${esc(x.ip_hint || '等待实时流量或点击下方重测主动探测')}</div>`
          }
        </div>
        <div class="evidence-actions">
          ${
            x.ip
              ? `<button type="button" class="text-button compact" data-copy-text="${esc(x.ip)}" aria-label="复制 ${esc(x.name)} 出口 IP">复制</button>
                 <button type="button" class="text-button compact" data-ip-modal="${esc(x.ip)}" aria-label="查看 ${esc(x.name)} 出口 IP 详情">详情</button>`
              : ''
          }
        </div>
      </div>

      <div class="evidence-row">
        <span class="evidence-label">代理节点</span>
        <div class="evidence-body">
          ${
            x.node_name
              ? `<div class="evidence-primary">
                  <strong class="evidence-node" title="${esc(nodeTooltip)}">${esc(x.node_name)}</strong>
                </div>
                <div class="evidence-sub-row">
                  <span class="evidence-sub tabular" title="${esc(nodeMeta)}">${esc(nodeMeta)}</span>
                  ${renderHttpConnectivityPill(v, x)}
                </div>`
              : `<div class="evidence-primary">
                  <span class="evidence-empty">未识别代理节点</span>
                </div>
                <div class="evidence-sub-row">
                  <span class="evidence-sub">${esc(x.node_hint || '尚未读取代理客户端连接日志')}</span>
                  ${renderHttpConnectivityPill(v, x)}
                </div>`
          }
        </div>
        <div class="evidence-actions">
          <button type="button" class="text-button compact" data-copy-service="${esc(x.service)}" ${
            x.node_name ? '' : 'disabled'
          } title="复制配置文件、策略链与节点信息">复制路由</button>
        </div>
      </div>
    </div>

    <footer class="verdict-foot">
      <div class="verdict-quick-actions">
        <button
          type="button"
          class="quick-mark-btn mark-safe ${isSafeMarked ? 'is-selected' : ''}"
          data-quick-mark="safe"
          data-verdict-service="${esc(x.service)}"
          aria-pressed="${isSafeMarked}"
          ${canQuickMark ? '' : 'disabled'}
          title="将${esc(markTargetHint)}标为可用（支持撤销）"
        >${icon('check')}<span>标为可用</span></button>
        <button
          type="button"
          class="quick-mark-btn mark-risk ${isRiskMarked ? 'is-selected' : ''}"
          data-quick-mark="risk"
          data-verdict-service="${esc(x.service)}"
          aria-pressed="${isRiskMarked}"
          ${canQuickMark ? '' : 'disabled'}
          title="将${esc(markTargetHint)}标为风险（支持撤销）"
        >${icon('close')}<span>标为风险</span></button>
        <button
          type="button"
          class="quick-retest-btn"
          data-test-service="${esc(x.service)}"
          ${v.ai_testing || v.paused ? 'disabled' : ''}
          title="主动请求 ${esc(x.name)} 验证出口 IP 与地区判定"
        >${icon('refresh')}<span>${v.ai_testing ? '测试中…' : '重测'}</span></button>
      </div>

      <details class="adv-popover-details" data-fold="${esc(foldId)}" ${isAdvOpen ? 'open' : ''}>
        <summary class="adv-summary" aria-label="${esc(x.name)} 高级标记与备注">
          <span>高级标记</span>
          ${icon('chevronDown', 'adv-chevron')}
        </summary>
        <div class="adv-popover-card">
          ${renderAdvancedMarkGroup('ip', x, x.ip_status)}
          ${renderAdvancedMarkGroup('node', x, x.node_status)}
          <div class="adv-popover-foot">
            <button
              type="button"
              class="ghost-btn compact"
              data-edit-note-service="${esc(x.service)}"
            >${icon('edit')}<span>${x.ip ? '去记录库编辑 IP 备注' : '去节点库管理备注'}</span></button>
          </div>
        </div>
      </details>
    </footer>
  </section>`;
}

/**
 * 3. Physical Uplink Chip & 4-Column Network Exits
 */
export function uplinkChip(u: Uplink | undefined, network: string): string {
  if (!u || (!u.interface && !network)) {
    return `<span class="uplink-chip is-muted">${icon('pulse')}<span>链路读取中…</span></span>`;
  }
  if (!u.interface) {
    return `<span class="uplink-chip is-muted">未连接物理网卡</span>`;
  }
  const device = u.port && u.port !== u.interface ? `${u.port} (${u.interface})` : u.interface;

  if (u.medium === 'wired') {
    const label = u.port || u.interface;
    return `<span class="uplink-chip wired" title="物理链路：有线网卡 ${esc(device)}">${icon('wired')}<strong>有线</strong><span class="sep">·</span><span class="mono">${esc(label)}</span></span>`;
  }

  if (u.medium === 'wireless') {
    const isMac = /Mac/i.test(navigator.userAgent);
    const isWin = /Windows/i.test(navigator.userAgent);
    const needsPerm = !u.ssid && (/定位权限/.test(u.ssid_hint || '') || (isMac && !/已获定位权限/.test(u.ssid_hint || '')));

    const ssidNode = u.ssid
      ? `<span class="mono">${esc(u.ssid)}</span>`
      : `<span class="muted">${esc(u.ssid_hint ? '名称需定位授权' : u.interface)}</span>`;

    let permActions = '';
    if (needsPerm && isMac) {
      permActions = `<button type="button" class="text-button compact" id="wifi-name-permission" title="申请 macOS 定位权限以读取当前 Wi-Fi 名称（不采集地理坐标）">允许读取 Wi-Fi</button>
        <button type="button" class="text-button compact" id="location-settings" title="打开系统定位设置">定位设置</button>`;
    } else if (needsPerm && isWin) {
      permActions = `<button type="button" class="text-button compact" id="location-settings" title="打开系统定位权限设置以读取 Wi-Fi 名称">定位权限</button>`;
    }

    return `<span class="uplink-chip wireless" title="${esc(u.ssid_hint || `无线网卡 ${device}`)}">${icon('wifi')}<strong>Wi-Fi</strong><span class="sep">·</span>${ssidNode}</span>${permActions}`;
  }

  return `<span class="uplink-chip" title="${esc(device)}"><strong>链路</strong><span class="sep">·</span><span class="mono">${esc(device)}</span></span>`;
}

function primaryProbe(v: View, group: string): Probe | undefined {
  return v.probes.find(p => p.group === group && p.ip) || v.probes.find(p => p.group === group);
}

function renderExitTile(v: View, group: string, title: string): string {
  const p = primaryProbe(v, group);
  const isIpv6 = group.endsWith('6');
  const ipv6Disabled = isIpv6 && !v.settings.ipv6;
  const optionalIpv6 = isIpv6 && !v.settings.ipv6_required;

  if (ipv6Disabled) {
    return `<article class="exit-tile is-muted">
      <div class="exit-tile-head">
        <span class="exit-tile-title">${esc(title)}</span>
        <span class="exit-tag">已关闭</span>
      </div>
      <strong class="exit-ip is-placeholder">未启用 IPv6</strong>
      <div class="exit-geo"><span class="muted">可在常规设置中开启</span></div>
      <div class="exit-tile-foot">
        <span class="probe-source muted">不参与监控</span>
      </div>
    </article>`;
  }

  if (!p?.ip) {
    const stateLabel = v.paused ? '已暂停' : p?.checked ? (isIpv6 && optionalIpv6 ? '无 IPv6 出口' : '不可达') : '等待检测';
    const subHint = v.paused
      ? '恢复监控后自动刷新'
      : isIpv6 && optionalIpv6
        ? '可选链路 · 不影响判定'
        : p?.error || '检测站连接失败';
    return `<article class="exit-tile ${isIpv6 && optionalIpv6 ? 'is-muted' : 'is-warn'}">
      <div class="exit-tile-head">
        <span class="exit-tile-title">${esc(title)}</span>
        ${optionalIpv6 ? '<span class="exit-tag">可选</span>' : '<span class="exit-tag is-warn">异常</span>'}
      </div>
      <strong class="exit-ip is-placeholder">${esc(stateLabel)}</strong>
      <div class="exit-geo"><span class="truncate" title="${esc(subHint)}">${esc(subHint)}</span></div>
      <div class="exit-tile-foot">
        <span class="probe-source truncate">${esc(p?.label || '—')}</span>
        ${p ? `<div class="tile-actions"><button type="button" class="text-button compact" data-detail="${esc(p.id)}">详情</button></div>` : ''}
      </div>
    </article>`;
  }

  const g = geoCache.get(p.ip);
  const isp = operator(p);
  const locParts = g
    ? [g.country, g.region, g.city].filter((val, idx, arr) => Boolean(val) && arr.indexOf(val) === idx).join(' · ')
    : '';
  const loc = locParts
    ? `${locParts} · ${isp || '运营商未查到'}`
    : isp
      ? `运营商：${isp}`
      : g
        ? '运营商：未查到'
        : '归属地查询中…';
  const locTip = [
    locParts || (g ? '未知归属地' : '归属地待查询'),
    `运营商：${isp || '未查到'}`,
  ].join(' · ');
  const isUs = g?.country_code === 'US';
  const taxLabel = isUs ? g?.sales_tax?.label || '' : '';
  const isTaxFree = taxLabel.includes('免');
  const multiDomestic =
    group === 'domestic' && new Set(v.probes.filter(x => x.group === 'domestic' && x.ip).map(x => x.ip)).size > 1;

  return `<article class="exit-tile ${v.paused ? 'is-paused' : ''} ${multiDomestic ? 'is-warn' : ''}">
    <div class="exit-tile-head">
      <span class="exit-tile-title">${esc(title)}</span>
      ${
        multiDomestic
          ? `<span class="exit-tag is-warn" title="国内检测站观测到不同公网出口，请展开下方检测站明细核对">多出口 · ${p.latency} ms</span>`
          : `<span class="exit-latency tabular">${p.latency} ms</span>`
      }
    </div>
    <strong class="exit-ip mono tabular ${p.ip.length > 20 ? 'is-ipv6' : ''}" title="${esc(p.ip)}">${esc(p.ip)}</strong>
    <div class="exit-geo">
      <span class="exit-loc truncate" title="${esc(locTip)}">${esc(loc)}</span>
      ${
        taxLabel
          ? `<span class="tax-chip ${isTaxFree ? 'is-free' : 'is-taxed'}" title="${esc(g?.sales_tax?.note || taxLabel)}">${esc(
              isTaxFree ? '免州税' : taxLabel
            )}</span>`
          : ''
      }
    </div>
    <div class="exit-tile-foot">
      <span class="probe-source truncate" title="${esc(p.url)}">${esc(p.label)}</span>
      <div class="tile-actions">
        <button type="button" class="text-button compact" data-copy-text="${esc(p.ip)}" aria-label="复制 ${esc(title)} IP">复制</button>
        <button type="button" class="text-button compact" data-detail="${esc(p.id)}" aria-label="查看 ${esc(title)} 详情">详情</button>
      </div>
    </div>
  </article>`;
}

/**
 * 4A. Left Bottom Card: 最近变化 (latest 3–4 history items)
 */
function classifyEventTag(e: Event): { label: string; cls: string } {
  const hay = `${e.title} ${e.detail}`;
  if (/Claude/i.test(hay)) return { label: 'Claude', cls: 'claude' };
  if (/Gemini|Google/i.test(hay)) return { label: 'Gemini', cls: 'gemini' };
  if (/风险|受限|不可达|失败|断开/.test(hay)) return { label: '异常', cls: 'risk' };
  if (/恢复|正常/.test(hay)) return { label: '恢复', cls: 'safe' };
  if (/节点|路由|代理/.test(hay)) return { label: '节点', cls: 'route' };
  return { label: '出口', cls: 'exit' };
}

function renderRecentChangesCard(v: View): string {
  const items = v.history.slice(0, 4);
  const total = v.history.length;

  return `<section class="panel bottom-card recent-card" aria-labelledby="recent-changes-heading">
    <div class="bottom-card-head">
      <h3 id="recent-changes-heading">最近变化</h3>
      <button type="button" class="ghost-btn compact tabular" data-tab="records" data-subtab="history">
        <span>全部记录 (${total})</span>${icon('arrow')}
      </button>
    </div>
    ${
      items.length === 0
        ? `<div class="recent-empty">
            <span class="muted">暂无出口变化记录 · 监控运行期间的 IP、节点与连通性变化将实时汇总于此</span>
          </div>`
        : `<ul class="recent-list">
            ${items
              .map(item => {
                const tag = classifyEventTag(item);
                const oneLine = item.detail ? `${item.title} · ${item.detail.replace(/\s+/g, ' ')}` : item.title;
                return `<li class="recent-row">
                  <time class="recent-time tabular" datetime="${esc(item.time)}" title="${esc(time(item.time))}">${esc(
                    shortClock(item.time)
                  )}</time>
                  <span class="event-tag ${tag.cls}">${esc(tag.label)}</span>
                  <span class="recent-text truncate" title="${esc(`${item.title}\n${item.detail}`)}">${esc(oneLine)}</span>
                </li>`;
              })
              .join('')}
          </ul>`
    }
  </section>`;
}

/**
 * 4B. Right Bottom Collapsible Cards:
 * - 检测站实时延迟 (6)
 * - 连通性与代理配置快照
 */
function renderSparkline(p: Probe): string {
  const vals = series.get(p.id)?.values || [];
  if (vals.length < 2) {
    return `<span class="spark-empty">${p.ip ? '采集中' : '—'}</span>`;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals, min + 1);
  const span = Math.max(max - min, 1);
  const points = vals.map((val, idx) => {
    const x = Number(((idx / (vals.length - 1)) * 56 + 4).toFixed(1));
    const y = Number((17 - ((val - min) / span) * 13).toFixed(1));
    return [x, y] as const;
  });
  const polyline = points.map(([x, y]) => `${x},${y}`).join(' ');
  const [lastX, lastY] = points[points.length - 1];
  return `<svg viewBox="0 0 64 20" class="probe-spark" role="img" aria-label="最近 ${vals.length} 次延迟趋势">
    <polyline points="${polyline}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${lastX}" cy="${lastY}" r="1.8" fill="currentColor"/>
  </svg>`;
}

export function probeRow(p: Probe): string {
  const dotCls = p.ip ? (p.stable ? 'green' : 'amber') : 'red';
  const groupName = PROBE_GROUP_SHORT[p.group] || p.group;
  const ipText = p.ip || (p.checked ? '不可达' : '待检测');
  const isp = operator(p);
  const ipTip = p.ip ? `点击查看 ${p.ip} 详情${isp ? ` · 运营商：${isp}` : ''}` : p.error || '';
  return `<tr>
    <th scope="row" class="probe-col-name" title="${esc(`${p.label} (${groupName})`)}">
      <span class="probe-name-text">${esc(p.label)}</span>
    </th>
    <td class="probe-col-ip">
      <span class="dot ${dotCls}" aria-hidden="true"></span>
      ${
        p.ip
          ? `<button type="button" class="probe-ip-btn mono tabular" data-detail="${esc(p.id)}" title="${esc(ipTip)}">${esc(
              p.ip
            )}</button>`
          : `<span class="muted" title="${esc(ipTip)}">${esc(ipText)}</span>`
      }
    </td>
    <td class="probe-col-spark">${renderSparkline(p)}</td>
    <td class="probe-col-ms mono tabular align-right">${p.ip ? `${p.latency} ms` : '—'}</td>
  </tr>`;
}

function renderProbeLatencyCard(v: View, openFolds: ReadonlySet<string>): string {
  const coreProbes = v.probes.filter(p => !p.source_ip);
  const total = coreProbes.length;
  const reachable = coreProbes.filter(p => Boolean(p.ip));
  const avgMs = reachable.length
    ? Math.round(reachable.reduce((acc, p) => acc + p.latency, 0) / reachable.length)
    : null;
  const isOpen = openFolds.has('probes');

  return `<details class="panel overview-fold probe-panel" data-fold="probes" ${isOpen ? 'open' : ''}>
    <summary class="fold-summary">
      ${icon('chevronRight', 'fold-chevron')}
      <span class="fold-title tabular">检测站实时延迟 (${total})</span>
      <span class="fold-meta tabular">${reachable.length}/${total} 可达${avgMs !== null ? ` · 均值 ${avgMs} ms` : ''}</span>
    </summary>
    <div class="fold-body probe-table-wrap">
      <table class="probe-compact-table">
        <thead>
          <tr>
            <th scope="col">检测站</th>
            <th scope="col">出口 IP</th>
            <th scope="col">趋势</th>
            <th scope="col" class="align-right">延迟</th>
          </tr>
        </thead>
        <tbody>
          ${coreProbes.map(probeRow).join('')}
        </tbody>
      </table>
    </div>
  </details>`;
}

function renderLanEgressCard(v: View, openFolds: ReadonlySet<string>): string {
  const rows = lanRows(v);
  const okRows = rows.filter(p => Boolean(p.ip));
  const distinctIps = new Set(okRows.map(p => p.ip));
  const isOpen = openFolds.has('lan-egress');
  const metaLabel =
    rows.length === 0
      ? '等待读取网卡'
      : distinctIps.size > 1
        ? `观测到 ${distinctIps.size} 个不同出口`
        : `${okRows.length}/${rows.length} 已测得`;

  return `<details class="panel overview-fold lan-egress-fold" data-fold="lan-egress" ${isOpen ? 'open' : ''}>
    <summary class="fold-summary">
      ${icon('chevronRight', 'fold-chevron')}
      <span class="fold-title tabular">局域网出口对照 · IPv4 (${rows.length})</span>
      <span class="fold-meta tabular ${distinctIps.size > 1 ? 'is-warn-meta' : ''}">${esc(metaLabel)}</span>
    </summary>
    <div class="fold-body lan-egress-body">
      <p class="lan-egress-note">按本机物理网卡已分配源地址分别直连请求国内检测站（不经过应用 HTTP/SOCKS 代理；遇 Fake-IP 仅对该请求用 AliDNS 真实解析，不改系统 DNS；失败不影响总体状态）。${
        distinctIps.size > 1
          ? '<strong>本轮观测到多个公网出口，请对照源地址、检测目标与运营商。</strong>'
          : '结果仅代表本机已检测的源地址和目标；同一出口不能证明网关无分流，其他电脑需分别检测。'
      }${v.paused ? ' 监控已暂停，以下为上次检测。' : ''}</p>
      ${lanList.render(rows, lanRow)}
    </div>
  </details>`;
}

function summarizeProxySetting(raw: string, fallback: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return fallback;
  if (trimmed === 'direct' || trimmed === 'none') return '强制直连';
  return trimmed.replace(/^https?:\/\//i, '');
}

function renderConnectivitySnapshotCard(v: View, openFolds: ReadonlySet<string>): string {
  const isOpen = openFolds.has('snapshot');
  const ignored = new Set(v.settings.ignored_checks || []);

  const okSites = SITE_ORDER.filter(({ id }) => {
    const r = v.service_health?.find(h => h.id === id);
    return r?.status === 'reachable';
  }).length;

  const chipsHtml = SITE_ORDER.map(({ id, label }) => {
    const r = v.service_health?.find(h => h.id === id);
    const isIgnored = ignored.has(`site:${id}`);
    if (isIgnored && !r) {
      return `<span class="site-chip is-muted" title="已在设置中忽略此检测项"><span class="dot" aria-hidden="true"></span><strong>${esc(label)}</strong><small class="tabular">已忽略</small></span>`;
    }
    if (!r || !r.checked) {
      return `<span class="site-chip is-muted"><span class="dot amber" aria-hidden="true"></span><strong>${esc(label)}</strong><small>待检测</small></span>`;
    }
    const dot = r.status === 'reachable' ? 'green' : r.status === 'restricted' ? 'amber' : 'red';
    const cls = r.status === 'reachable' ? 'is-ok' : r.status === 'restricted' ? 'is-warn' : 'is-bad';
    const metric =
      r.status === 'unreachable'
        ? '不可达'
        : r.http_code !== null
          ? `HTTP ${r.http_code}${r.latency > 0 ? ` · ${r.latency} ms` : ''}`
          : '可达';
    return `<span class="site-chip ${cls}" title="${esc(`${label} · ${r.detail || ''}${isIgnored ? '（已忽略告警）' : ''}`)}">
      <span class="dot ${dot}" aria-hidden="true"></span>
      <strong>${esc(label)}</strong>
      <small class="tabular">${esc(metric)}</small>
    </span>`;
  }).join('');

  const domesticSummary = summarizeProxySetting(v.settings.domestic_proxy, '直连');
  const foreignSummary = summarizeProxySetting(v.settings.foreign_proxy, '系统代理');
  const overrides = [
    v.settings.claude_proxy ? 'Claude 独立端口' : '',
    v.settings.gemini_proxy ? 'Gemini 独立端口' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return `<details class="panel overview-fold snapshot-panel" data-fold="snapshot" ${isOpen ? 'open' : ''}>
    <summary class="fold-summary">
      ${icon('chevronRight', 'fold-chevron')}
      <span class="fold-title">连通性与代理配置快照</span>
      <span class="fold-meta tabular">${okSites}/${SITE_ORDER.length} 站点正常</span>
    </summary>
    <div class="fold-body snapshot-body">
      <div class="site-chips-grid" aria-label="关键站点连通性">
        ${chipsHtml}
      </div>
      <div class="proxy-snapshot-row">
        <div class="proxy-snapshot-items">
          <span class="proxy-kv" title="${esc(v.settings.domestic_proxy || '直连（不走代理）')}"><span class="muted">国内：</span><code class="mono">${esc(domesticSummary)}</code></span>
          <span class="proxy-kv" title="${esc(v.settings.foreign_proxy || '跟随系统代理 / TUN')}"><span class="muted">国外/AI：</span><code class="mono">${esc(foreignSummary)}</code></span>
          ${overrides ? `<span class="proxy-kv muted">（${esc(overrides)}）</span>` : ''}
        </div>
        <button type="button" class="ghost-btn compact" data-settings-section="routing-settings">
          <span>代理设置</span>${icon('arrow')}
        </button>
      </div>
    </div>
  </details>`;
}

export function renderOverview(v: View, openFolds: ReadonlySet<string> = new Set(['snapshot'])): string {
  const lastCheckLabel = v.last_check
    ? `上次检测 ${ago(v.last_check) || shortClock(v.last_check)} · 每 ${v.settings.interval} 秒`
    : '等待首次检测';

  return `<div class="overview-dashboard">
    ${renderAlertStrip(v)}

    <section class="overview-section" aria-labelledby="ai-verdict-heading">
      <div class="overview-section-head">
        <div class="overview-title-pair">
          <h2 id="ai-verdict-heading">AI 服务安全判定</h2>
          <span class="overview-meta tabular" title="${esc(v.last_check ? time(v.last_check) : '')}">${esc(lastCheckLabel)}</span>
        </div>
        <div class="overview-head-actions">
          ${
            v.settings.manual_nodes_only
              ? `<button type="button" class="ghost-btn compact" id="enable-auto-nodes" title="当前已关闭自动节点识别，仅按 IP 判定；点击恢复">恢复自动节点识别</button>`
              : ''
          }
          <button type="button" class="ghost-btn compact" id="test-ai" ${v.ai_testing || v.paused ? 'disabled' : ''}>
            ${icon('pulse')}<span>${v.ai_testing ? '正在深入测试…' : '深入测试全部'}</span>
          </button>
        </div>
      </div>
      <div class="verdict-grid">
        ${v.verdicts.map(x => renderVerdictCard(v, x, openFolds)).join('')}
      </div>
    </section>

    <section class="overview-section" aria-labelledby="network-exits-heading">
      <div class="overview-section-head">
        <div class="overview-title-pair">
          <h2 id="network-exits-heading">网络出口</h2>
          <div class="uplink-group">${uplinkChip(v.uplink, v.network)}</div>
        </div>
      </div>
      <div class="exit-tiles">
        ${renderExitTile(v, 'domestic', '国内 IPv4 · 默认路径')}
        ${renderExitTile(v, 'foreign', '国外 IPv4')}
        ${renderExitTile(v, 'domestic6', '国内 IPv6')}
        ${renderExitTile(v, 'foreign6', '国外 IPv6')}
      </div>
    </section>

    <div class="overview-bottom-grid">
      ${renderRecentChangesCard(v)}
      <div class="overview-folds-stack">
        ${renderProbeLatencyCard(v, openFolds)}
        ${renderLanEgressCard(v, openFolds)}
        ${renderConnectivitySnapshotCard(v, openFolds)}
      </div>
    </div>
  </div>`;
}

export function initOverviewPanel(panel: HTMLElement, app: AppShellApi): PanelHandle {
  // Keep all 3 right-hand telemetry folds compact by default so 1080×740 stays zero-scroll while showing live summaries
  const openFolds = new Set<string>();
  let hasRenderedOnce = false;

  const syncFoldsFromDom = () => {
    if (!hasRenderedOnce) return;
    panel.querySelectorAll<HTMLDetailsElement>('details[data-fold]').forEach(el => {
      const key = el.dataset.fold;
      if (!key) return;
      if (el.open) openFolds.add(key);
      else openFolds.delete(key);
    });
  };

  panel.addEventListener(
    'toggle',
    event => {
      const details = event.target;
      if (!(details instanceof HTMLDetailsElement)) return;
      const key = details.dataset.fold;
      if (!key) return;
      if (details.open) {
        openFolds.add(key);
        // Close sibling advanced popovers so at most one popover stays open
        if (key.startsWith('adv-')) {
          panel.querySelectorAll<HTMLDetailsElement>('details.adv-popover-details[open]').forEach(other => {
            if (other !== details) {
              other.open = false;
              if (other.dataset.fold) openFolds.delete(other.dataset.fold);
            }
          });
        }
      } else {
        openFolds.delete(key);
      }
    },
    { capture: true }
  );

  // Light-dismiss open `高级标记` popover on outside click or Escape
  document.addEventListener('click', event => {
    const target = event.target as Node | null;
    if (!target) return;
    panel.querySelectorAll<HTMLDetailsElement>('details.adv-popover-details[open]').forEach(openAdv => {
      if (!openAdv.contains(target)) {
        openAdv.open = false;
        if (openAdv.dataset.fold) openFolds.delete(openAdv.dataset.fold);
      }
    });
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    panel.querySelectorAll<HTMLDetailsElement>('details.adv-popover-details[open]').forEach(openAdv => {
      openAdv.open = false;
      if (openAdv.dataset.fold) openFolds.delete(openAdv.dataset.fold);
      openAdv.querySelector('summary')?.focus({ preventScroll: true });
    });
  });

  panel.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '#show-probes, #enable-auto-nodes, [data-quick-mark], [data-edit-note-service]'
    );
    if (!btn || btn.disabled) return;

    if (btn.id === 'show-probes') {
      const details = panel.querySelector<HTMLDetailsElement>('.probe-panel');
      if (details) {
        details.open = true;
        openFolds.add('probes');
        details.scrollIntoView({ block: 'nearest' });
        details.querySelector('summary')?.focus();
      }
      return;
    }

    if (btn.id === 'enable-auto-nodes') {
      const state = app.getState();
      if (!state) return;
      btn.disabled = true;
      try {
        await app.saveSettings({ ...state.settings, manual_nodes_only: false });
        app.showToast('已恢复自动节点识别，正在读取实际连接记录。');
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (btn.dataset.quickMark && btn.dataset.verdictService) {
      const service = btn.dataset.verdictService;
      const status = btn.dataset.quickMark as Safety;
      const state = app.getState();
      const verdict = state?.verdicts.find(v => v.service === service);
      if (!verdict) return;

      btn.disabled = true;
      try {
        if (verdict.ip) {
          await app.markAiIp({
            service,
            ip: verdict.ip,
            status,
            attachCurrent: true,
            withUndo: true,
          });
        } else if (verdict.node_key) {
          await app.markAiNode({
            service,
            key: verdict.node_key,
            status,
            current: true,
            withUndo: true,
          });
        } else {
          app.showToast(`${serviceName(service)} 当前暂无可登记的出口 IP 或节点`);
        }
      } finally {
        btn.disabled = false;
      }
      return;
    }

    if (btn.dataset.editNoteService) {
      const service = btn.dataset.editNoteService;
      const state = app.getState();
      const verdict = state?.verdicts.find(v => v.service === service);
      // Close the popover before navigating
      btn.closest<HTMLDetailsElement>('details.adv-popover-details')?.removeAttribute('open');
      openFolds.delete(`adv-${service}`);

      if (verdict?.ip) {
        const existing = state?.claude_ips.find(r => r.service === service && r.ip === verdict.ip);
        await app.navigate('records', 'ips', {
          service,
          ip: verdict.ip,
          status: existing?.status || verdict.ip_status || 'pending',
          note: existing?.note || '',
        });
      } else {
        await app.navigate('records', 'nodes', {
          service,
          key: verdict?.node_record || verdict?.node_key || '',
        });
      }
    }
  });

  return {
    render(view) {
      if (!view) return;
      syncFoldsFromDom();
      panel.innerHTML = renderOverview(view, openFolds);
      hasRenderedOnce = true;
    },
  };
}
