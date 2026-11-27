// Records & History Workspace (`记录与历史`):
// High-density IP trust DB (`ips`), proxy node DB (`nodes`), change history (`history`), and data import/clear (`data`).

import { confirmAction } from './confirm';
import { ListView } from './list';
import {
  initProxyData,
  loadLocalProxyClients,
  proxyDataInProgress,
  proxyDataSettings,
  resetProxyDataUi,
  updateProxyDataState,
} from './proxy-data';
import { refreshSearchSelects, setSelectChoices, setSelectValue, type Choice } from './select';
import type { AppShellApi } from './store';
import type { Event, GeoInfo, IpRecord, NodeRecord, PanelHandle, RouteSnapshot, View } from './types';
import { ago, esc, formatGeoSummary, icon, safetyText, serviceName, time } from './ui';

type FilterService = '' | 'claude' | 'gemini';
type FilterStatus = '' | 'safe' | 'pending' | 'risk';

interface RecordFilterState {
  query: string;
  service: FilterService;
  status: FilterStatus;
}

const ipFilter: RecordFilterState = { query: '', service: '', status: '' };
const nodeFilter: RecordFilterState = { query: '', service: '', status: '' };

const IP_SORT_FIELDS: Record<string, { label: string; value: (r: IpRecord) => string }> = {
  last_open: { label: '最近观测', value: r => r.last_open || r.added_at || '' },
  added_at: { label: '添加时间', value: r => r.added_at || '' },
  ip: { label: 'IP 地址', value: r => r.ip },
  service: { label: '所属服务', value: r => r.service },
  status: { label: '安全标记', value: r => r.status },
};

const NODE_SORT_FIELDS: Record<string, { label: string; value: (r: NodeRecord) => string }> = {
  updated_at: { label: '更新时间', value: r => r.updated_at || r.added_at || '' },
  node: { label: '节点名称', value: r => r.route.node_name || '' },
  service: { label: '所属服务', value: r => r.service },
  status: { label: '安全标记', value: r => r.status },
};

export const aiList = new ListView<IpRecord>(
  'ai-ips',
  IP_SORT_FIELDS,
  r =>
    `${r.service} ${serviceName(r.service)} ${r.ip} ${r.note} ${r.source} ${(r.routes || [])
      .map(x => `${x.config} ${x.subscription} ${x.node_name} ${x.node_host} ${x.chain.join(' ')}`)
      .join(' ')}`,
  r => `${r.service}:${r.status}`,
  {},
  {
    defaultSize: 20,
    hideToolbar: true,
    emptyTitle: '暂无已登记的出口 IP',
    emptyHint: '可在概览页一键标记当前出口，或点击上方「+ 登记 IP」与「填入当前出口」添加记录。',
  }
);

export const nodeList = new ListView<NodeRecord>(
  'ai-nodes',
  NODE_SORT_FIELDS,
  r =>
    `${r.service} ${serviceName(r.service)} ${r.route.config} ${r.route.subscription} ${r.route.node_host} ${r.route.node_name} ${r.route.chain.join(' ')} ${r.note}`,
  r => `${r.service}:${r.status}`,
  {},
  {
    defaultSize: 20,
    hideToolbar: true,
    emptyTitle: '暂无已登记的代理节点',
    emptyHint: '可前往「导入与清理」从代理软件一键读取节点，或点击上方「+ 登记节点」手动添加。',
  }
);

type HistoryCategory = 'exit' | 'link' | 'ai' | 'manual';

function classifyHistoryEvent(e: Event): HistoryCategory {
  const title = e.title || '';
  const detail = e.detail || '';
  if (title.includes('手动') || title.includes('删除 AI') || title.includes('人工')) {
    return 'manual';
  }
  if (
    title.includes('本机网络') ||
    title.includes('链路') ||
    title.includes('检测路径设置') ||
    detail.includes('Wi-Fi') ||
    detail.includes('SSID') ||
    detail.includes('网卡')
  ) {
    return 'link';
  }
  if (
    title.includes('Claude') ||
    title.includes('Gemini') ||
    title.includes('AI') ||
    ((detail.includes('Claude') || detail.includes('Gemini')) &&
      !detail.includes('国内') &&
      !detail.includes('国外'))
  ) {
    return 'ai';
  }
  return 'exit';
}

const HISTORY_CATEGORY_META: Record<HistoryCategory, { label: string; cls: string }> = {
  exit: { label: '出口变化', cls: 'cat-exit' },
  link: { label: '链路切换', cls: 'cat-link' },
  ai: { label: 'AI 路径', cls: 'cat-ai' },
  manual: { label: '人工标记', cls: 'cat-manual' },
};

const historyList = new ListView<Event>(
  'history',
  {
    time: { label: '发生时间', value: r => r.time },
    title: { label: '事件标题', value: r => r.title },
  },
  r => `${r.title} ${r.detail} ${HISTORY_CATEGORY_META[classifyHistoryEvent(r)].label}`,
  r => classifyHistoryEvent(r),
  {},
  {
    defaultSize: 20,
    searchPlaceholder: '搜索 IP、节点、服务名称或变化内容…',
    emptyTitle: '暂无变化历史',
    emptyHint: '连续确认的公网出口切换、物理链路变更、AI 路径告警与人工标记操作都会记录在此。',
    pillFilters: {
      exit: '出口变化',
      link: '链路切换',
      ai: 'AI 路径',
      manual: '人工标记',
    },
  }
);

const STATUS_OPTIONS_HTML = `
  <option value="pending">待确认</option>
  <option value="safe">可用</option>
  <option value="risk">风险</option>
`;

const STATUS_SEGMENTS: { value: 'pending' | 'safe' | 'risk'; label: string; glyph: string }[] = [
  { value: 'pending', label: '待确认', glyph: '•' },
  { value: 'safe', label: '可用', glyph: '✓' },
  { value: 'risk', label: '风险', glyph: '✕' },
];

function formatShortTimestamp(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function compactGeoLine(geo: GeoInfo | undefined): string {
  if (!geo) return '';
  const loc = [geo.country, geo.region || geo.city].filter(Boolean).join(' · ');
  const asn = geo.connection?.asn ? `AS${geo.connection.asn}` : '';
  const isp = geo.connection?.isp ? geo.connection.isp.split(/[ ,]/)[0] : '';
  const net = [asn, isp].filter(Boolean).join(' ');
  return [loc, net, geo.network_type?.label].filter(Boolean).join(' · ');
}

function buildIpSubtitle(r: IpRecord, geo: GeoInfo | undefined, latestRoute: RouteSnapshot | undefined): string {
  const parts: string[] = [];
  const geoShort = compactGeoLine(geo);
  if (geoShort) {
    parts.push(esc(geoShort));
  } else if (r.source) {
    parts.push(`来源：${esc(r.source)}`);
  } else {
    parts.push('点击 IP 查看归属地');
  }
  if (latestRoute?.node_name) {
    parts.push(esc(latestRoute.node_name));
  }
  const seenIso = r.last_open || r.added_at;
  if (seenIso) {
    const rel = ago(seenIso) || formatShortTimestamp(seenIso);
    parts.push(`<span class="tabular" title="${esc(time(seenIso))}">${esc(rel)}</span>`);
  }
  return parts.join('<span class="meta-sep">·</span>');
}

function fullIpTooltip(r: IpRecord, geo: GeoInfo | undefined, latestRoute: RouteSnapshot | undefined): string {
  const fullGeo = formatGeoSummary(geo, { includeIsp: true, includeTax: true });
  return [fullGeo, latestRoute?.node_name ? `最近节点：${latestRoute.node_name}` : '', r.note].filter(Boolean).join(' | ');
}

function buildNodeSubtitle(r: NodeRecord): string {
  const parts: string[] = [];
  if (r.route.node_host) {
    parts.push(`<span class="mono tabular">${esc(r.route.node_host)}</span>`);
  }
  const source = r.route.subscription || r.route.config;
  if (source) {
    parts.push(esc(source));
  }
  if (r.route.chain?.length) {
    const chainPreview = r.route.chain.slice(0, 3).join(' → ');
    if (chainPreview && chainPreview !== r.route.node_name) {
      parts.push(esc(chainPreview));
    }
  }
  if (r.updated_at) {
    const rel = ago(r.updated_at) || formatShortTimestamp(r.updated_at);
    parts.push(`<span class="tabular" title="${esc(time(r.updated_at))}">更新于 ${esc(rel)}</span>`);
  }
  return parts.length ? parts.join('<span class="meta-sep">·</span>') : '手动登记节点';
}

function renderIpRow(r: IpRecord, v: View, app: AppShellApi): string {
  const routes = r.routes || [];
  const latest = [...routes].sort((a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''))[0];
  const geo = app.getGeo(r.ip);
  const isLiveExit = v.verdicts.some(vd => vd.service === r.service && vd.ip === r.ip);
  const taxLabel = geo?.country_code === 'US' ? geo.sales_tax?.label : '';
  const isTaxFree = Boolean(taxLabel && taxLabel.includes('免'));

  return `<article class="record-row">
    <div class="record-lead">
      <div class="record-primary-line">
        <span class="service-badge ${esc(r.service)}">${serviceName(r.service)}</span>
        <button
          type="button"
          class="record-ip-trigger mono tabular"
          data-ip-modal="${esc(r.ip)}"
          title="查看 ${esc(r.ip)} 的归属地、ASN 与周边详情"
        >${esc(r.ip)}</button>
        ${isLiveExit ? '<span class="record-live-pill">当前</span>' : ''}
        ${taxLabel ? `<span class="record-tax-pill ${isTaxFree ? 'is-free' : ''}">${esc(taxLabel)}</span>` : ''}
        ${
          routes.length
            ? `<button
                type="button"
                class="route-assoc-btn tabular"
                data-route-service="${esc(r.service)}"
                data-route-ip="${esc(r.ip)}"
                title="查看该出口 IP 关联的代理节点快照"
              >${icon('nodes')}<span>关联节点 (${routes.length})</span></button>`
            : ''
        }
        ${r.note ? `<span class="record-note-chip" title="${esc(r.note)}">${esc(r.note)}</span>` : ''}
      </div>
      <div class="record-sub-line" title="${esc(fullIpTooltip(r, geo, latest))}">
        ${buildIpSubtitle(r, geo, latest)}
      </div>
    </div>
    <div class="record-controls">
      <div class="status-seg" role="group" aria-label="设置 ${esc(r.ip)} 安全状态">
        ${STATUS_SEGMENTS.map(seg => {
          const active = r.status === seg.value;
          return `<button
            type="button"
            class="status-seg-btn seg-${seg.value} ${active ? 'is-active' : ''}"
            aria-pressed="${active}"
            data-mark-ip="${esc(r.ip)}"
            data-service="${esc(r.service)}"
            data-status="${seg.value}"
          ><span class="seg-glyph" aria-hidden="true">${seg.glyph}</span><span>${seg.label}</span></button>`;
        }).join('')}
      </div>
      <div class="row-icon-actions">
        <button
          type="button"
          class="row-action-btn"
          data-edit-service="${esc(r.service)}"
          data-edit-ip="${esc(r.ip)}"
          title="编辑备注或状态"
        >${icon('edit')}<span>编辑</span></button>
        <button
          type="button"
          class="row-action-btn"
          data-copy-text="${esc(r.ip)}"
          title="复制 IP 地址"
        >${icon('copy')}<span>复制</span></button>
        <button
          type="button"
          class="row-action-btn is-danger"
          data-record-delete-ip="${esc(r.ip)}"
          data-record-service="${esc(r.service)}"
          title="删除此 IP 记录（可撤销）"
        >${icon('trash')}<span>删除</span></button>
      </div>
    </div>
  </article>`;
}

function renderNodeRow(r: NodeRecord, v: View): string {
  const isLiveNode = v.verdicts.some(
    vd => vd.service === r.service && (vd.node_record === r.key || vd.node_key === r.key)
  );

  return `<article class="record-row">
    <div class="record-lead">
      <div class="record-primary-line">
        <span class="service-badge ${esc(r.service)}">${serviceName(r.service)}</span>
        <strong class="record-node-name" title="${esc(r.route.node_name)}">${esc(r.route.node_name || '未命名节点')}</strong>
        ${isLiveNode ? '<span class="record-live-pill">当前节点</span>' : ''}
        ${r.route.mode ? `<span class="record-mode-pill">${esc(r.route.mode)}</span>` : ''}
        ${r.note ? `<span class="record-note-chip" title="${esc(r.note)}">${esc(r.note)}</span>` : ''}
      </div>
      <div class="record-sub-line">
        ${buildNodeSubtitle(r)}
      </div>
    </div>
    <div class="record-controls">
      <div class="status-seg" role="group" aria-label="设置节点 ${esc(r.route.node_name)} 安全状态">
        ${STATUS_SEGMENTS.map(seg => {
          const active = r.status === seg.value;
          return `<button
            type="button"
            class="status-seg-btn seg-${seg.value} ${active ? 'is-active' : ''}"
            aria-pressed="${active}"
            data-mark-node="${esc(r.key)}"
            data-service="${esc(r.service)}"
            data-status="${seg.value}"
            data-mark-current="false"
          ><span class="seg-glyph" aria-hidden="true">${seg.glyph}</span><span>${seg.label}</span></button>`;
        }).join('')}
      </div>
      <div class="row-icon-actions">
        <button
          type="button"
          class="row-action-btn"
          data-edit-node="${esc(r.key)}"
          data-node-service="${esc(r.service)}"
          title="编辑节点状态与备注"
        >${icon('edit')}<span>编辑</span></button>
        <button
          type="button"
          class="row-action-btn"
          data-copy-text="${esc(r.route.node_name)}"
          title="复制节点名称"
        >${icon('copy')}<span>复制</span></button>
        <button
          type="button"
          class="row-action-btn is-danger"
          data-confirm-delete-node="${esc(r.key)}"
          data-node-service="${esc(r.service)}"
          title="删除此节点记录"
        >${icon('trash')}<span>删除</span></button>
      </div>
    </div>
  </article>`;
}

function formatDiffLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return '';

  const arrowMatch = trimmed.match(/^(.*?)\s*(?:→|->)\s*(.+)$/);
  if (!arrowMatch) {
    return `<div class="history-detail-line">${esc(trimmed)}</div>`;
  }

  const [, leftRaw, rightRaw] = arrowMatch;
  let prefix = '';
  let oldVal = leftRaw.trim();

  const colonIdx = Math.max(oldVal.lastIndexOf('：'), oldVal.lastIndexOf(': '));
  const dotIdx = oldVal.lastIndexOf(' · ');
  if (colonIdx > 0 && !oldVal.slice(0, colonIdx).match(/^\d+$/) && !oldVal.includes('::')) {
    prefix = oldVal.slice(0, colonIdx + 1).trim();
    oldVal = oldVal.slice(colonIdx + 1).trim();
  } else if (dotIdx > 0) {
    prefix = `${oldVal.slice(0, dotIdx).trim()} ·`;
    oldVal = oldVal.slice(dotIdx + 3).trim();
  }

  const newVal = rightRaw.trim();
  return `<div class="history-diff-line">
    ${prefix ? `<span class="diff-prefix">${esc(prefix)}</span>` : ''}
    <code class="diff-val is-old mono tabular">${esc(oldVal || '空')}</code>
    <span class="diff-arrow" aria-hidden="true">→</span>
    <code class="diff-val is-new mono tabular">${esc(newVal)}</code>
  </div>`;
}

function renderHistoryRow(e: Event): string {
  const cat = classifyHistoryEvent(e);
  const meta = HISTORY_CATEGORY_META[cat];
  const rel = ago(e.time);
  const lines = (e.detail || '')
    .split('\n')
    .map(formatDiffLine)
    .filter(Boolean)
    .join('');

  return `<article class="history-row">
    <div class="history-time-col tabular" title="${esc(time(e.time))}">
      <time class="mono tabular" datetime="${esc(e.time)}">${esc(formatShortTimestamp(e.time))}</time>
      ${rel ? `<small class="tabular">${esc(rel)}</small>` : ''}
    </div>
    <div class="history-main-col">
      <div class="history-head-line">
        <span class="history-cat-badge ${meta.cls}">${meta.label}</span>
        <strong class="history-title">${esc(e.title)}</strong>
      </div>
      ${lines ? `<div class="history-diff-stack">${lines}</div>` : ''}
    </div>
  </article>`;
}

function countByStatus(items: { status: string }[]) {
  let safe = 0;
  let pending = 0;
  let risk = 0;
  for (const x of items) {
    if (x.status === 'safe') safe++;
    else if (x.status === 'risk') risk++;
    else pending++;
  }
  return { total: items.length, safe, pending, risk };
}

function renderFilterToolbar<T>(
  kind: 'ips' | 'nodes',
  state: RecordFilterState,
  list: ListView<T>,
  sortFields: Record<string, { label: string }>,
  placeholder: string
): string {
  const dirLabel = list.options.direction === 'asc' ? '↑ 正序' : '↓ 逆序';
  return `<div class="records-filter-bar">
    <div class="records-search input-with-icon">
      ${icon('search')}
      <input
        name="${kind}-search"
        type="search"
        autocomplete="off"
        data-records-query="${kind}"
        aria-label="搜索记录"
        value="${esc(state.query)}"
        placeholder="${esc(placeholder)}"
      >
    </div>
    <div class="seg-pills" role="group" aria-label="按服务筛选">
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-service="" aria-pressed="${state.service === ''}">全部</button>
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-service="claude" aria-pressed="${state.service === 'claude'}">Claude</button>
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-service="gemini" aria-pressed="${state.service === 'gemini'}">Gemini</button>
    </div>
    <div class="seg-pills" role="group" aria-label="按状态筛选">
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-status="" aria-pressed="${state.status === ''}">全部</button>
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-status="safe" aria-pressed="${state.status === 'safe'}">可用</button>
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-status="pending" aria-pressed="${state.status === 'pending'}">待确认</button>
      <button type="button" class="seg-pill" data-filter-kind="${kind}" data-filter-status="risk" aria-pressed="${state.status === 'risk'}">风险</button>
    </div>
    <div class="records-sort-group">
      <select name="${kind}-sort" data-records-sort="${kind}" aria-label="排序方式">
        ${Object.entries(sortFields)
          .map(
            ([k, f]) =>
              `<option value="${esc(k)}" ${list.options.sort === k ? 'selected' : ''}>按${esc(f.label)}</option>`
          )
          .join('')}
      </select>
      <button
        type="button"
        class="sort-dir-btn tabular"
        data-records-dir="${kind}"
        title="切换正序或逆序"
        aria-label="排序方向：${dirLabel}"
      >${dirLabel}</button>
    </div>
  </div>`;
}

function renderFilteredListSection<T extends { service: string; status: string }>(
  kind: 'ips' | 'nodes',
  allRecords: T[],
  state: RecordFilterState,
  list: ListView<T>,
  rowFn: (r: T) => string
): string {
  list.query = state.query;
  const prefiltered = allRecords.filter(r => {
    if (state.service && r.service !== state.service) return false;
    if (state.status && r.status !== state.status) return false;
    return true;
  });

  const hasAnyFilter = Boolean(state.query.trim() || state.service || state.status);
  if (allRecords.length > 0 && prefiltered.length === 0 && hasAnyFilter) {
    return `<div class="records-list-host" data-records-host="${kind}">
      <div class="empty">
        <div class="empty-icon">${icon('search')}</div>
        <strong>没有匹配的记录</strong>
        <p>当前筛选条件下未找到结果（库内共 ${allRecords.length} 条记录）。</p>
        <button type="button" data-records-reset="${kind}">重置全部筛选条件</button>
      </div>
    </div>`;
  }

  return `<div class="records-list-host" data-records-host="${kind}">
    ${list.render(prefiltered, rowFn)}
  </div>`;
}

function renderIpSubPanel(
  v: View,
  app: AppShellApi,
  drawerOpen: boolean,
  drawerMode: 'add' | 'edit',
  saving: boolean
): string {
  const stats = countByStatus(v.claude_ips);
  const claudeVerdict = v.verdicts.find(x => x.service === 'claude');
  const geminiVerdict = v.verdicts.find(x => x.service === 'gemini');

  const fillButtons = [claudeVerdict, geminiVerdict]
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .map(vd => {
      const hasIp = Boolean(vd.ip);
      return `<button
        type="button"
        class="fill-current-btn"
        data-fill-service="${esc(vd.service)}"
        ${hasIp ? `data-fill-ip="${esc(vd.ip!)}"` : 'disabled'}
        title="${hasIp ? `填入 ${vd.name} 当前出口 ${vd.ip}` : `${vd.name} 当前暂无可用出口 IP`}"
      >
        <span>填入 ${esc(vd.name)} 当前出口</span>
        ${hasIp ? `<code class="mono tabular">${esc(vd.ip!)}</code>` : ''}
      </button>`;
    })
    .join('');

  return `<section class="panel records-card">
    <div class="records-top-bar">
      <div class="records-summary tabular">
        <strong>共 ${stats.total} 条 IP</strong>
        <span class="summary-dot safe">可用 ${stats.safe}</span>
        <span class="summary-dot warn">待确认 ${stats.pending}</span>
        <span class="summary-dot risk">风险 ${stats.risk}</span>
      </div>
      <div class="records-top-actions">
        ${fillButtons}
        <button
          type="button"
          class="${drawerOpen ? '' : 'primary'}"
          data-toggle-drawer="ips"
          aria-expanded="${drawerOpen}"
        >${icon(drawerOpen ? 'close' : 'plus')}<span>${drawerOpen ? '收起表单' : '登记 IP'}</span></button>
      </div>
    </div>

    ${
      drawerOpen
        ? `<div class="records-drawer" id="ip-drawer">
      <div class="drawer-head">
        <h3>${drawerMode === 'edit' ? '编辑出口 IP 记录' : '登记出口 IP 记录'}</h3>
        <button type="button" class="compact-btn" data-close-drawer="ips">收起</button>
      </div>
      <form id="ai-ip-form" class="records-drawer-form ip-form-grid">
        <label class="drawer-field">
          <span>所属服务</span>
          <select name="service">
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
          </select>
        </label>
        <label class="drawer-field">
          <span>公网 IP 地址</span>
          <input
            class="mono tabular"
            autocomplete="off"
            spellcheck="false"
            name="ip"
            required
            placeholder="例如 198.51.100.42 或 2606:4700::1"
          >
        </label>
        <label class="drawer-field">
          <span>安全状态</span>
          <select name="status">${STATUS_OPTIONS_HTML}</select>
        </label>
        <label class="drawer-field">
          <span>备注说明</span>
          <input
            autocomplete="off"
            name="note"
            maxlength="500"
            placeholder="例如：俄勒冈免税州、已确认不风控…"
          >
        </label>
        <div class="drawer-foot">
          <label class="drawer-checkbox">
            <input name="attach_current" type="checkbox">
            <span>同时关联该服务当前命中的代理节点快照</span>
          </label>
          <div class="drawer-submit-group">
            <button type="button" data-close-drawer="ips">取消</button>
            <button type="submit" class="primary" ${saving ? 'disabled' : ''}>
              ${saving ? '正在保存…' : '保存 IP 记录'}
            </button>
          </div>
        </div>
      </form>
    </div>`
        : ''
    }

    ${renderFilterToolbar('ips', ipFilter, aiList, IP_SORT_FIELDS, '搜索 IP、备注或关联节点…')}
    ${renderFilteredListSection('ips', v.claude_ips, ipFilter, aiList, r => renderIpRow(r, v, app))}
  </section>`;
}

function renderNodeSubPanel(
  v: View,
  drawerOpen: boolean,
  drawerMode: 'add' | 'edit',
  saving: boolean
): string {
  const nodes = v.ai_nodes || [];
  const stats = countByStatus(nodes);
  const claudeVerdict = v.verdicts.find(x => x.service === 'claude');
  const geminiVerdict = v.verdicts.find(x => x.service === 'gemini');

  const fillNodeButtons = [claudeVerdict, geminiVerdict]
    .filter((x): x is NonNullable<typeof x> => Boolean(x))
    .map(vd => {
      const hasNode = Boolean(vd.node_key);
      return `<button
        type="button"
        class="fill-current-btn"
        data-fill-service="${esc(vd.service)}"
        ${hasNode ? `data-fill-node="${esc(vd.node_key)}"` : 'disabled'}
        title="${hasNode ? `填入 ${vd.name} 当前节点 ${vd.node_name}` : `${vd.name} 当前未识别到实时节点`}"
      >
        <span>填入 ${esc(vd.name)} 当前出口</span>
        ${hasNode && vd.node_name ? `<span class="fill-node-tag">${esc(vd.node_name)}</span>` : ''}
      </button>`;
    })
    .join('');

  return `<section class="panel records-card">
    <div class="records-top-bar">
      <div class="records-summary tabular">
        <strong>共 ${stats.total} 个节点</strong>
        <span class="summary-dot safe">可用 ${stats.safe}</span>
        <span class="summary-dot warn">待确认 ${stats.pending}</span>
        <span class="summary-dot risk">风险 ${stats.risk}</span>
      </div>
      <div class="records-top-actions">
        ${fillNodeButtons}
        <button type="button" data-subtab="data">${icon('cloud')}<span>导入节点</span></button>
        <button
          type="button"
          class="${drawerOpen ? '' : 'primary'}"
          data-toggle-drawer="nodes"
          aria-expanded="${drawerOpen}"
        >${icon(drawerOpen ? 'close' : 'plus')}<span>${drawerOpen ? '收起表单' : '登记节点'}</span></button>
      </div>
    </div>

    ${
      drawerOpen
        ? `<div class="records-drawer" id="node-drawer">
      <div class="drawer-head">
        <h3>${drawerMode === 'edit' ? '编辑代理节点记录' : '登记代理节点记录'}</h3>
        <button type="button" class="compact-btn" data-close-drawer="nodes">收起</button>
      </div>
      <form id="ai-node-form" class="records-drawer-form node-form-grid">
        <label class="drawer-field drawer-field-wide">
          <span>代理节点</span>
          <select name="target" data-searchable required aria-label="选择代理节点">
            <option value="">选择当前实时节点或已导入节点…</option>
          </select>
        </label>
        <label class="drawer-field">
          <span>安全状态</span>
          <select name="status">${STATUS_OPTIONS_HTML}</select>
        </label>
        <label class="drawer-field drawer-field-wide">
          <span>备注说明</span>
          <input
            autocomplete="off"
            name="note"
            maxlength="500"
            placeholder="例如：IEPL 专线稳定、固定美国出口…"
          >
        </label>
        <div class="drawer-foot">
          <small class="muted">支持按节点名称、地区或订阅分组检索；如需批量添加请点击「导入节点」。</small>
          <div class="drawer-submit-group">
            <button type="button" data-close-drawer="nodes">取消</button>
            <button type="submit" class="primary" ${saving ? 'disabled' : ''}>
              ${saving ? '正在保存…' : '保存节点记录'}
            </button>
          </div>
        </div>
      </form>
    </div>`
        : ''
    }

    ${renderFilterToolbar('nodes', nodeFilter, nodeList, NODE_SORT_FIELDS, '搜索节点名称、服务器域名、订阅来源或备注…')}
    ${renderFilteredListSection('nodes', nodes, nodeFilter, nodeList, r => renderNodeRow(r, v))}
  </section>`;
}

function renderHistorySubPanel(v: View): string {
  const count = v.history.length;
  return `<section class="panel records-card history-panel">
    <div class="records-top-bar">
      <div class="records-summary">
        <strong class="tabular">共 ${count} 条变化记录</strong>
        <span class="muted small">自动记录连续确认的出口 IP 切换、本机链路变动、AI 路径异常与人工标记（上限 200 条）</span>
      </div>
      <div class="records-top-actions">
        <button type="button" id="clear-history" class="danger" ${count ? '' : 'disabled'}>
          ${icon('trash')}<span>清空历史</span>
        </button>
      </div>
    </div>
    ${historyList.render(v.history, renderHistoryRow)}
  </section>`;
}

/** Populate `<select name="target" data-searchable>` with live service routes first, then saved nodes. */
export function populateNodeChoices(root: HTMLElement, v: View): void {
  const target = root.querySelector<HTMLFormElement>('#ai-node-form')?.elements.namedItem('target') as HTMLSelectElement | null;
  if (!target) return;
  const choices: Choice[] = [
    ...v.verdicts
      .filter(x => x.node_key)
      .map(x => ({
        value: `current:${x.service}:${x.node_key}`,
        label: `${x.name} · 当前出口 · ${x.node_name}`,
        detail: x.node_record ? `已登记：${safetyText(x.node_status)}` : '尚未登记',
        group: '当前实时节点',
      })),
    ...(v.ai_nodes || []).map(r => ({
      value: `saved:${r.service}:${r.key}`,
      label: `${serviceName(r.service)} · ${r.route.node_name}`,
      detail: [r.route.subscription || r.route.config || '手动来源', r.route.node_host].filter(Boolean).join(' · '),
      group: r.route.subscription || r.route.config || '未标注来源',
    })),
  ];
  setSelectChoices(target, choices, '搜索并选择代理节点…');
}

type Draft = Record<string, string>;
const drafts: Record<string, Draft> = {};

function captureDrafts(root: HTMLElement): void {
  for (const id of ['ai-ip-form', 'ai-node-form']) {
    const form = root.querySelector<HTMLFormElement>(`#${id}`);
    if (!form) continue;
    const data = new FormData(form);
    const next: Draft = {};
    for (const [k, val] of data.entries()) {
      next[k] = String(val);
    }
    if (id === 'ai-ip-form') {
      next.attach_current = String(data.has('attach_current'));
    }
    drafts[id] = next;
  }
}

function fillForm(form: HTMLFormElement, values: Draft): void {
  for (const [k, value] of Object.entries(values)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLSelectElement) {
      if (input.hasAttribute('data-searchable')) setSelectValue(input, value);
      else input.value = value;
    } else if (input.type === 'checkbox') {
      input.checked = value === 'true';
    } else {
      input.value = value;
    }
  }
}

function restoreDrafts(root: HTMLElement): void {
  for (const [id, draft] of Object.entries(drafts)) {
    const form = root.querySelector<HTMLFormElement>(`#${id}`);
    if (form) fillForm(form, draft);
  }
}

function clearDrafts(): void {
  for (const id of Object.keys(drafts)) delete drafts[id];
}

export function initRecordsPanel(panel: HTMLElement, app: AppShellApi): PanelHandle {
  let ipSaving = false;
  let nodeSaving = false;
  let activeSub = 'ips';
  let ipDrawerOpen = false;
  let ipDrawerMode: 'add' | 'edit' = 'add';
  let nodeDrawerOpen = false;
  let nodeDrawerMode: 'add' | 'edit' = 'add';

  initProxyData(panel, app);

  const repaintRecordsListOnly = (kind: 'ips' | 'nodes') => {
    const v = app.getState();
    if (!v) return;
    const host = panel.querySelector<HTMLElement>(`[data-records-host="${kind}"]`);
    if (!host) return;
    const html =
      kind === 'ips'
        ? renderFilteredListSection('ips', v.claude_ips, ipFilter, aiList, r => renderIpRow(r, v, app))
        : renderFilteredListSection('nodes', v.ai_nodes || [], nodeFilter, nodeList, r => renderNodeRow(r, v));
    const scratch = document.createElement('div');
    scratch.innerHTML = html;
    const replacement = scratch.firstElementChild;
    if (replacement) host.replaceWith(replacement);
  };

  const syncFilterToolbarUi = (kind: 'ips' | 'nodes') => {
    const state = kind === 'ips' ? ipFilter : nodeFilter;
    const list = kind === 'ips' ? aiList : nodeList;
    const qInput = panel.querySelector<HTMLInputElement>(`[data-records-query="${kind}"]`);
    if (qInput && qInput.value !== state.query) qInput.value = state.query;
    panel.querySelectorAll<HTMLButtonElement>(`[data-filter-kind="${kind}"][data-filter-service]`).forEach(b => {
      b.setAttribute('aria-pressed', String((b.dataset.filterService || '') === state.service));
    });
    panel.querySelectorAll<HTMLButtonElement>(`[data-filter-kind="${kind}"][data-filter-status]`).forEach(b => {
      b.setAttribute('aria-pressed', String((b.dataset.filterStatus || '') === state.status));
    });
    const sortSel = panel.querySelector<HTMLSelectElement>(`[data-records-sort="${kind}"]`);
    if (sortSel) sortSel.value = list.options.sort;
    const dirBtn = panel.querySelector<HTMLButtonElement>(`[data-records-dir="${kind}"]`);
    if (dirBtn) {
      const dirLabel = list.options.direction === 'asc' ? '↑ 正序' : '↓ 逆序';
      dirBtn.textContent = dirLabel;
      dirBtn.setAttribute('aria-label', `排序方向：${dirLabel}`);
    }
  };

  const paint = (v: View | undefined, sub: string, skipCapture = false) => {
    activeSub = sub || 'ips';
    if (!v) return;
    updateProxyDataState(v);

    if (activeSub === 'data') {
      if (!panel.querySelector('#proxy-data-settings')) {
        panel.innerHTML = proxyDataSettings(v);
        void loadLocalProxyClients();
      }
      return;
    }

    if (!skipCapture) {
      captureDrafts(panel);
    }
    if (activeSub === 'ips') {
      panel.innerHTML = renderIpSubPanel(v, app, ipDrawerOpen, ipDrawerMode, ipSaving);
    } else if (activeSub === 'nodes') {
      panel.innerHTML = renderNodeSubPanel(v, nodeDrawerOpen, nodeDrawerMode, nodeSaving);
      populateNodeChoices(panel, v);
      refreshSearchSelects(panel);
    } else {
      panel.innerHTML = renderHistorySubPanel(v);
    }
    restoreDrafts(panel);
  };

  const openAndFillIpDrawer = (
    values: { service: string; ip: string; status: string; note: string; attachCurrent?: boolean },
    mode: 'add' | 'edit',
    focusField: 'ip' | 'status' | 'note' = 'ip'
  ) => {
    ipDrawerOpen = true;
    ipDrawerMode = mode;
    drafts['ai-ip-form'] = {
      service: values.service || 'claude',
      ip: values.ip || '',
      status: values.status || 'pending',
      note: values.note || '',
      attach_current: String(Boolean(values.attachCurrent)),
    };
    paint(app.getState(), 'ips', true);
    const target = panel.querySelector<HTMLElement>(`#ai-ip-form [name="${focusField}"]`);
    target?.focus({ preventScroll: true });
    panel.querySelector('#ip-drawer')?.scrollIntoView({ block: 'nearest' });
  };

  const openAndFillNodeDrawer = (
    targetValue: string,
    status: string,
    note: string,
    mode: 'add' | 'edit'
  ) => {
    nodeDrawerOpen = true;
    nodeDrawerMode = mode;
    drafts['ai-node-form'] = {
      target: targetValue,
      status: status || 'pending',
      note: note || '',
    };
    paint(app.getState(), 'nodes', true);
    const focusEl = targetValue
      ? panel.querySelector<HTMLElement>('#ai-node-form [name="note"]')
      : panel.querySelector<HTMLElement>('#ai-node-form .search-select-trigger');
    focusEl?.focus({ preventScroll: true });
    panel.querySelector('#node-drawer')?.scrollIntoView({ block: 'nearest' });
  };

  // Search query listeners (with IME composition safety)
  const handleQueryInput = (input: HTMLInputElement) => {
    const kind = input.dataset.recordsQuery as 'ips' | 'nodes' | undefined;
    if (!kind) return;
    const state = kind === 'ips' ? ipFilter : nodeFilter;
    const list = kind === 'ips' ? aiList : nodeList;
    state.query = input.value;
    list.page = 1;
    repaintRecordsListOnly(kind);
  };

  panel.addEventListener('input', event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset?.recordsQuery && !(event as InputEvent).isComposing) {
      handleQueryInput(input);
    }
  });

  panel.addEventListener('compositionend', event => {
    const input = event.target as HTMLInputElement;
    if (input.dataset?.recordsQuery) {
      handleQueryInput(input);
    }
  });

  panel.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    const kind = select.dataset?.recordsSort as 'ips' | 'nodes' | undefined;
    if (!kind) return;
    const list = kind === 'ips' ? aiList : nodeList;
    list.change('sort', select.value);
    repaintRecordsListOnly(kind);
  });

  panel.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;
    const state = app.getState();
    if (!state) return;

    // Filter pills & reset
    if (btn.dataset.filterKind) {
      const kind = btn.dataset.filterKind as 'ips' | 'nodes';
      const fState = kind === 'ips' ? ipFilter : nodeFilter;
      const list = kind === 'ips' ? aiList : nodeList;
      if (btn.hasAttribute('data-filter-service')) {
        fState.service = (btn.dataset.filterService || '') as FilterService;
      } else if (btn.hasAttribute('data-filter-status')) {
        fState.status = (btn.dataset.filterStatus || '') as FilterStatus;
      }
      list.page = 1;
      syncFilterToolbarUi(kind);
      repaintRecordsListOnly(kind);
      return;
    }

    if (btn.dataset.recordsDir) {
      const kind = btn.dataset.recordsDir as 'ips' | 'nodes';
      const list = kind === 'ips' ? aiList : nodeList;
      list.change('direction', list.options.direction === 'asc' ? 'desc' : 'asc');
      syncFilterToolbarUi(kind);
      repaintRecordsListOnly(kind);
      return;
    }

    if (btn.dataset.recordsReset || (btn.hasAttribute('data-list-clear') && (activeSub === 'ips' || activeSub === 'nodes'))) {
      const kind = (btn.dataset.recordsReset || activeSub) as 'ips' | 'nodes';
      const fState = kind === 'ips' ? ipFilter : nodeFilter;
      const list = kind === 'ips' ? aiList : nodeList;
      fState.query = '';
      fState.service = '';
      fState.status = '';
      list.query = '';
      list.page = 1;
      syncFilterToolbarUi(kind);
      repaintRecordsListOnly(kind);
      panel.querySelector<HTMLInputElement>(`[data-records-query="${kind}"]`)?.focus({ preventScroll: true });
      return;
    }

    // Drawer toggles
    if (btn.dataset.toggleDrawer === 'ips') {
      if (ipDrawerOpen) {
        captureDrafts(panel);
        ipDrawerOpen = false;
        paint(state, 'ips');
      } else {
        ipDrawerMode = 'add';
        ipDrawerOpen = true;
        if (!drafts['ai-ip-form']) {
          drafts['ai-ip-form'] = { service: 'claude', ip: '', status: 'pending', note: '', attach_current: 'false' };
        }
        paint(state, 'ips', true);
        panel.querySelector<HTMLInputElement>('#ai-ip-form [name="ip"]')?.focus({ preventScroll: true });
      }
      return;
    }

    if (btn.dataset.toggleDrawer === 'nodes') {
      if (nodeDrawerOpen) {
        captureDrafts(panel);
        nodeDrawerOpen = false;
        paint(state, 'nodes');
      } else {
        const defaultCurrent = state.verdicts.find(x => x.node_key);
        const initialTarget =
          drafts['ai-node-form']?.target ||
          (defaultCurrent ? `current:${defaultCurrent.service}:${defaultCurrent.node_key}` : '');
        openAndFillNodeDrawer(initialTarget, drafts['ai-node-form']?.status || 'pending', drafts['ai-node-form']?.note || '', 'add');
      }
      return;
    }

    if (btn.dataset.closeDrawer === 'ips') {
      ipDrawerOpen = false;
      paint(state, 'ips');
      return;
    }

    if (btn.dataset.closeDrawer === 'nodes') {
      nodeDrawerOpen = false;
      paint(state, 'nodes');
      return;
    }

    // 1-click prefill current exit IP / Node & row edit
    if (btn.dataset.fillIp && btn.dataset.fillService) {
      const svc = btn.dataset.fillService;
      const ip = btn.dataset.fillIp;
      const existing = state.claude_ips.find(x => x.service === svc && x.ip === ip);
      openAndFillIpDrawer(
        {
          service: svc,
          ip,
          status: existing?.status || 'pending',
          note: existing?.note || '',
          attachCurrent: true,
        },
        existing ? 'edit' : 'add',
        'status'
      );
      return;
    }

    if (btn.dataset.fillNode && btn.dataset.fillService) {
      const svc = btn.dataset.fillService;
      const nodeKey = btn.dataset.fillNode;
      const vd = state.verdicts.find(x => x.service === svc);
      const existing = vd?.node_record
        ? state.ai_nodes.find(n => n.service === svc && n.key === vd.node_record)
        : undefined;
      openAndFillNodeDrawer(
        `current:${svc}:${nodeKey}`,
        existing?.status || vd?.node_status || 'pending',
        existing?.note || '',
        existing ? 'edit' : 'add'
      );
      return;
    }

    if (btn.dataset.editIp && btn.dataset.editService) {
      const r = state.claude_ips.find(x => x.ip === btn.dataset.editIp && x.service === btn.dataset.editService);
      if (r) {
        openAndFillIpDrawer(
          { service: r.service, ip: r.ip, status: r.status, note: r.note, attachCurrent: false },
          'edit',
          'note'
        );
      }
      return;
    }

    if (btn.dataset.editNode && btn.dataset.nodeService) {
      const svc = btn.dataset.nodeService;
      const key = btn.dataset.editNode;
      const r = state.ai_nodes.find(n => n.service === svc && n.key === key);
      openAndFillNodeDrawer(`saved:${svc}:${key}`, r?.status || 'pending', r?.note || '', 'edit');
      return;
    }

    // Row deletion
    if (btn.dataset.recordDeleteIp && btn.dataset.recordService) {
      await app.deleteClaudeIp(btn.dataset.recordService, btn.dataset.recordDeleteIp, { withUndo: true });
      return;
    }

    if (btn.dataset.confirmDeleteNode && btn.dataset.nodeService) {
      const svc = btn.dataset.nodeService;
      const key = btn.dataset.confirmDeleteNode;
      const rec = state.ai_nodes.find(n => n.service === svc && n.key === key);
      const nodeLabel = rec?.route.node_name || key;
      const ok = await confirmAction({
        title: '删除节点记录？',
        message: `确认从 ${serviceName(svc)} 节点库中移除「${nodeLabel}」？`,
        detail: '删除后若再次命中该节点，状态将恢复为「未登记 / 待确认」。',
        confirm: '删除节点',
        danger: true,
      });
      if (!ok) return;
      await app.deleteAiNode(svc, key, { withUndo: true });
      return;
    }

    // Clear history
    if (btn.id === 'clear-history') {
      const ok = await confirmAction({
        title: '清空变化历史？',
        message: '将清空全部出口变化、链路切换与手动操作日志；已登记的出口 IP 与代理节点库均保留。',
        detail: '清空前会自动生成本机 settings.before-clear-*.json 恢复备份。',
        confirm: '备份并清空',
        danger: true,
      });
      if (!ok) return;
      const backup = await app.clearMonitorData('history');
      app.showToast(`变化历史已清空（备份：${backup}）`);
    }
  });

  panel.addEventListener('submit', async event => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'ai-ip-form') {
      event.preventDefault();
      if (ipSaving) return;
      const f = new FormData(form);
      const service = String(f.get('service') || 'claude');
      const ip = String(f.get('ip') || '').trim();
      const status = String(f.get('status') || 'pending');
      const note = String(f.get('note') || '').trim();
      const attachCurrent = f.has('attach_current');
      if (!ip) return;

      ipSaving = true;
      const submitBtn = form.querySelector<HTMLButtonElement>('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      const previous = app.getState()?.claude_ips.find(r => r.service === service && r.ip === ip);

      try {
        await app.call('save_claude_ip', {
          service,
          ip,
          status,
          note,
          attachCurrent,
        });
        delete drafts['ai-ip-form'];
        ipDrawerOpen = false;
        paint(app.getState(), 'ips', true);
        app.showToast(`${serviceName(service)} · IP ${ip} 已保存为${safetyText(status)}`, {
          tone: status === 'safe' ? 'safe' : status === 'risk' ? 'risk' : 'neutral',
          undoLabel: previous ? '撤销修改' : '撤回删除',
          onUndo: async () => {
            if (previous) {
              await app.call('save_claude_ip', {
                service,
                ip,
                status: previous.status,
                note: previous.note || '',
                attachCurrent: false,
              });
            } else {
              await app.call('delete_claude_ip', { service, ip });
            }
          },
        });
      } finally {
        ipSaving = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    } else if (form.id === 'ai-node-form') {
      event.preventDefault();
      if (nodeSaving) return;
      const f = new FormData(form);
      const rawTarget = String(f.get('target') || '');
      if (!rawTarget) return;
      const [kind, service, ...keyParts] = rawTarget.split(':');
      const key = keyParts.join(':');
      const status = String(f.get('status') || 'pending');
      const note = String(f.get('note') || '').trim();
      const current = kind === 'current';

      nodeSaving = true;
      const submitBtn = form.querySelector<HTMLButtonElement>('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      const stateBefore = app.getState();
      const verdict = stateBefore?.verdicts.find(v => v.service === service);
      const lookupKey = current ? verdict?.node_record || key : key;
      const previous = stateBefore?.ai_nodes.find(r => r.service === service && r.key === lookupKey);

      try {
        await app.call('save_ai_node', {
          service,
          key,
          status,
          note,
          current,
        });
        delete drafts['ai-node-form'];
        nodeDrawerOpen = false;
        paint(app.getState(), 'nodes', true);
        app.showToast(`${serviceName(service)} · 节点已保存为${safetyText(status)}`, {
          tone: status === 'safe' ? 'safe' : status === 'risk' ? 'risk' : 'neutral',
          ...(previous
            ? {
                undoLabel: '撤销修改',
                onUndo: async () => {
                  await app.call('save_ai_node', {
                    service,
                    key: previous.key,
                    status: previous.status,
                    note: previous.note || '',
                    current: false,
                  });
                },
              }
            : {}),
        });
      } finally {
        nodeSaving = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    }
  });

  return {
    getSubTabs(v) {
      return [
        { id: 'ips', label: 'IP 记录', badge: v?.claude_ips.length || 0 },
        { id: 'nodes', label: '节点库', badge: v?.ai_nodes.length || 0 },
        { id: 'history', label: '变化历史', badge: v?.history.length || 0 },
        { id: 'data', label: '导入与清理' },
      ];
    },
    render: paint,
    canLeave() {
      if (activeSub === 'data' && proxyDataInProgress()) {
        app.showToast('节点导入或清理正在进行，请等待完成后再切换。');
        return false;
      }
      return true;
    },
    hasUnsavedWork() {
      return proxyDataInProgress();
    },
    onActivate(sub) {
      if (sub === 'data') {
        void loadLocalProxyClients();
      }
    },
    onDataCleared(scope) {
      if (scope !== 'history') {
        clearDrafts();
        ipDrawerOpen = false;
        nodeDrawerOpen = false;
      }
      resetProxyDataUi();
    },
    onNavigatePayload(sub, payload) {
      if (sub === 'ips' && payload && typeof payload === 'object' && 'ip' in (payload as Record<string, unknown>)) {
        const p = payload as Pick<IpRecord, 'service' | 'ip' | 'status' | 'note'>;
        openAndFillIpDrawer(
          {
            service: p.service || 'claude',
            ip: p.ip,
            status: p.status || 'pending',
            note: p.note || '',
            attachCurrent: false,
          },
          'edit',
          'status'
        );
      }
    },
  };
}
