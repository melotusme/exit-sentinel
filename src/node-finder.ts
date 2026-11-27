// Network Tools -> "按地区找节点" (`diagnostics:find`):
// Rank known proxy nodes by geographic closeness to a city, US state, country, or reference IP.

import { ListView } from './list';
import type { AppShellApi } from './store';
import type { GeoInfo, View } from './types';
import { esc, formatGeoSummary, icon, safetyText, serviceName } from './ui';

export interface Place {
  label: string;
  country_code: string;
  country: string;
  region: string;
  city: string;
  lat: number | null;
  lon: number | null;
  source: string;
}

export interface NodeMatch {
  name: string;
  host: string;
  subscription: string;
  services: { service: string; status: string }[];
  place: Place;
  score: number;
  distance_km: number | null;
  reason: string;
}

export interface FindResult {
  target: Place;
  matches: NodeMatch[];
  unplaced: number;
  total: number;
}

interface PresetChip {
  label: string;
  query: string;
  taxFree?: boolean;
}

export const FINDER_PRESETS: PresetChip[] = [
  { label: 'Oregon 免税州', query: 'Portland, Oregon', taxFree: true },
  { label: 'Delaware 免税州', query: 'Delaware', taxFree: true },
  { label: 'Montana 免税州', query: '蒙大拿', taxFree: true },
  { label: 'Los Angeles', query: 'Los Angeles' },
  { label: 'Seattle', query: 'Seattle' },
  { label: 'Tokyo', query: 'Tokyo' },
  { label: 'Singapore', query: 'Singapore' },
];

const US_TAX_FREE_REGIONS = new Set(['oregon', 'delaware', 'montana', 'new hampshire', 'alaska']);

const tier = (score: number) =>
  score >= 95 ? 'city' : score >= 85 ? 'region' : score >= 60 ? 'country' : 'near';

export const nearList = new ListView<NodeMatch>(
  'near-nodes',
  {
    score: { label: '匹配度', value: r => String(r.score).padStart(3, '0') },
    distance: {
      label: '直线距离',
      value: r => (r.distance_km === null ? '999999' : String(Math.round(r.distance_km)).padStart(6, '0')),
    },
    name: { label: '节点名称', value: r => r.name },
  },
  r => `${r.name} ${r.host} ${r.subscription} ${r.place.label} ${r.reason}`,
  r => tier(r.score),
  { city: '同城 / 邻近', region: '同州 / 省', country: '同国家', near: '周边地区' },
  {
    defaultSize: 20,
    searchPlaceholder: '在匹配节点中搜索名称、订阅或备注…',
    emptyTitle: '未找到该地区附近的节点',
    emptyHint: '可尝试切换到邻近城市/国家，或前往记录库导入最新代理节点订阅。',
    pillFilters: {
      city: '同城 / 邻近',
      region: '同州 / 省',
      country: '同国家',
      near: '周边地区',
    },
  }
);

let query = '';
let result: FindResult | null = null;
let busy = false;
let error = '';

export function resetNodeFinder() {
  query = '';
  result = null;
  busy = false;
  error = '';
  nearList.query = '';
  nearList.filter = '';
  nearList.page = 1;
}

function isUsTaxFreePlace(p: Place): boolean {
  return p.country_code === 'US' && US_TAX_FREE_REGIONS.has((p.region || '').trim().toLowerCase());
}

function formatDistanceBadge(m: NodeMatch): string {
  const d = m.distance_km;
  if (d !== null && Number.isFinite(d)) {
    const km = Math.round(d);
    if (m.score >= 100) return `同城 · 约 ${km} km`;
    if (m.score >= 95) return `邻近 · 约 ${km} km`;
    if (m.score >= 85) return `同州/省 · 约 ${km} km`;
    if (m.score >= 60) return `同国家 · 约 ${km} km`;
    return `周边 · 约 ${km} km`;
  }
  return m.reason || '同区域';
}

function findMeasuredExitForNode(
  m: NodeMatch,
  v: View | undefined,
  getGeo: (ip: string | null | undefined) => GeoInfo | undefined
): { ip: string | null; geo: GeoInfo | undefined } {
  const fromSource = /^实测出口\s+([0-9a-fA-F:.]+)$/.exec(m.place.source || '');
  if (fromSource?.[1]) {
    return { ip: fromSource[1], geo: getGeo(fromSource[1]) };
  }
  if (v) {
    const rec = v.claude_ips.find(ipRec =>
      ipRec.routes?.some(
        r =>
          r.node_name.trim().toLowerCase() === m.name.trim().toLowerCase() &&
          (!m.host || !r.node_host || r.node_host.trim().toLowerCase() === m.host.trim().toLowerCase())
      )
    );
    if (rec?.ip) {
      return { ip: rec.ip, geo: getGeo(rec.ip) };
    }
  }
  return { ip: null, geo: undefined };
}

function countKnownNodes(v: View | undefined): number {
  if (!v) return 0;
  const seen = new Set<string>();
  for (const n of v.ai_nodes) {
    if (n.route.node_name) seen.add(`${n.route.node_name.toLowerCase()}|${n.route.node_host.toLowerCase()}`);
  }
  for (const r of v.current_routes) {
    if (r.node_name) seen.add(`${r.node_name.toLowerCase()}|${r.node_host.toLowerCase()}`);
  }
  return seen.size;
}

function renderNearRow(app: AppShellApi, v: View | undefined, m: NodeMatch): string {
  const distBadge = formatDistanceBadge(m);
  const tierCls = tier(m.score);
  const { ip: exitIp, geo } = findMeasuredExitForNode(m, v, app.getGeo);
  const geoLine = exitIp && geo ? formatGeoSummary(geo) : m.place.label;
  const geoSt = geo?.sales_tax as Record<string, any> | undefined;
  const geoTaxLabel = String(geoSt?.label || '');
  const taxFree = geo
    ? geo.country_code === 'US' &&
      (geoSt?.status === 'no_state_sales_tax' || (/免/.test(geoTaxLabel) && !geoTaxLabel.includes('非免')))
    : isUsTaxFreePlace(m.place);

  const statuses = m.services.length
    ? m.services
        .map(
          s =>
            `<span class="safety ${esc(s.status)}">${esc(serviceName(s.service))} · ${esc(safetyText(s.status))}</span>`
        )
        .join('')
    : '<span class="safety none">未登记状态</span>';

  const subMeta = [
    m.subscription ? `订阅：${m.subscription}` : '',
    m.host ? `入口：${m.host}` : '',
    exitIp ? '依据：实测出口' : `依据：${m.place.source || '节点名称'}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<article class="near-row">
    <div class="near-row-main">
      <div class="near-title-line">
        <span class="near-distance-pill tier-${tierCls} tabular nowrap">${esc(distBadge)}</span>
        <strong class="near-node-name">${esc(m.name)}</strong>
        ${taxFree ? '<span class="pill ok nowrap">免州税区</span>' : ''}
      </div>
      <div class="near-meta-line">
        ${
          exitIp
            ? `<span class="near-exit-chip"><span class="muted">实测出口</span> <code class="mono tabular nowrap">${esc(exitIp)}</code></span>`
            : ''
        }
        <span class="near-geo-text">${esc(geoLine || m.place.country)}</span>
        ${subMeta ? `<span class="near-sub-text muted">· ${esc(subMeta)}</span>` : ''}
      </div>
    </div>

    <div class="near-row-side">
      <div class="near-status-group">${statuses}</div>
      <div class="near-actions">
        <button type="button" data-copy-text="${esc(m.name)}">${icon('copy')}<span>复制节点名</span></button>
        ${
          exitIp
            ? `<button type="button" data-ip-modal="${esc(exitIp)}">${icon('globe')}<span>IP 详情</span></button>`
            : `<button type="button" disabled title="该节点尚未记录实测出口 IP，切换使用后将自动关联">${icon('globe')}<span>无实测 IP</span></button>`
        }
      </div>
    </div>
  </article>`;
}

function renderSummaryHeader(r: FindResult): string {
  const t = r.target;
  const coords =
    t.lat !== null && t.lon !== null
      ? `${t.lat.toFixed(2)}°, ${t.lon.toFixed(2)}°`
      : null;
  const taxFree = isUsTaxFreePlace(t);

  return `<div class="near-summary-bar">
    <div class="near-summary-target">
      <div class="near-target-headline">
        <span class="near-target-icon">${icon('pin')}</span>
        <strong>${esc(t.label || t.country || query)}</strong>
        ${t.country_code ? `<span class="pill mono">${esc(t.country_code)}</span>` : ''}
        ${taxFree ? '<span class="pill ok">美国免州税州</span>' : ''}
        ${coords ? `<span class="pill mono tabular">${esc(coords)}</span>` : ''}
      </div>
      <p class="small muted">解析来源：${esc(t.source)} · 优先采用实测出口 IP 定位，未测过的节点按名称识别地区</p>
    </div>

    <div class="near-summary-counts tabular">
      <span class="pill ok">匹配 ${r.matches.length} 个</span>
      <span class="pill">已收录 ${r.total} 个</span>
      ${r.unplaced > 0 ? `<span class="pill" title="名称不含地区关键词且暂无实测出口 IP 的节点">未识别地区 ${r.unplaced} 个</span>` : ''}
      <button type="button" class="text-button compact" data-tab="records" data-subtab="data">导入/更新节点 →</button>
    </div>
  </div>`;
}

export function renderNodeFinder(app: AppShellApi): string {
  const v = app.getState();
  const knownCount = countKnownNodes(v);

  return `<div class="finder-workspace">
    <section class="panel finder-toolbar">
      <form id="near-form" class="finder-form" novalidate>
        <div class="ip-field-head">
          <label for="near-query-input">按目标地区或参考 IP 查找节点</label>
          <span id="near-query-hint" class="small muted">支持城市、美国州名、国家或公网 IP；已收录 <strong class="tabular">${knownCount}</strong> 个去重节点</span>
        </div>
        <div class="ip-lookup-controls">
          <input
            id="near-query-input"
            name="near-query"
            type="text"
            required
            maxlength="200"
            autocomplete="off"
            spellcheck="false"
            aria-invalid="false"
            aria-describedby="near-query-hint"
            value="${esc(query)}"
            placeholder="输入城市、美国州名、国家或参考 IP，如 Oregon / Seattle / Tokyo"
          >
          <button type="submit" class="primary" ${busy ? 'disabled' : ''}>
            ${icon('search')}<span>${busy ? '正在查找…' : '查找相近节点'}</span>
          </button>
        </div>
      </form>

      <div class="finder-presets-row">
        <span class="ip-quick-label">常用地区预设：</span>
        <div class="finder-presets" role="group" aria-label="常用地区快捷预设">
          ${FINDER_PRESETS.map(p => {
            const active = query.trim().toLowerCase() === p.query.toLowerCase();
            return `<button
              type="button"
              class="chip-btn ${active ? 'selected' : ''}"
              data-near-preset="${esc(p.query)}"
              aria-pressed="${active}"
              ${busy ? 'disabled' : ''}
            >
              <span>${esc(p.label)}</span>
            </button>`;
          }).join('')}
        </div>
      </div>
    </section>

    ${
      knownCount === 0
        ? `<section class="notice finder-import-callout">
            <div>
              <strong>尚未导入代理节点库</strong>
              <p class="small muted">导入 Clash Verge、Shadowrocket、Karing 等客户端节点后，即可按地区与免税州一键筛选最近节点。</p>
            </div>
            <button type="button" class="primary" data-tab="records" data-subtab="data">前往导入代理节点 →</button>
          </section>`
        : ''
    }

    ${
      error
        ? `<div class="warning" role="alert">
            <span>${esc(error)}</span>
          </div>`
        : ''
    }

    ${
      result
        ? `<section class="panel finder-results-panel">
            ${renderSummaryHeader(result)}
            ${
              result.total === 0
                ? `<div class="empty">
                    <div class="empty-icon">${icon('nodes')}</div>
                    <strong>当前节点库为空</strong>
                    <p>请先从本机代理客户端或订阅文件导入节点列表，再来按目标地区筛选。</p>
                    <button type="button" class="primary" data-tab="records" data-subtab="data">去导入节点</button>
                  </div>`
                : nearList.render(result.matches, m => renderNearRow(app, v, m))
            }
          </section>`
        : knownCount > 0
          ? `<section class="panel empty finder-idle-panel">
              <div class="empty-icon">${icon('pin')}</div>
              <strong>选择上方快捷地区，或输入任意城市 / 参考 IP</strong>
              <p>系统会结合实测出口 IP 归属地与节点命名，按同城、同州省、同国家及大圆距离自动排序。</p>
            </section>`
          : ''
    }
  </div>`;
}

export async function findNear(app: AppShellApi, text: string, repaint: () => void): Promise<void> {
  const cleaned = text.trim();
  if (busy || !cleaned) return;
  query = cleaned;
  busy = true;
  error = '';
  repaint();
  try {
    result = (await app.findNodesNear(cleaned)) as FindResult;
    nearList.page = 1;
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    repaint();
  }
}
