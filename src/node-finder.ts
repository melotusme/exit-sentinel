// Records → "按地区找节点": type an address / city / IP, get known nodes ranked by closeness.
import { invoke } from '@tauri-apps/api/core';
import { ListView } from './list';
import { esc, safetyText, serviceName } from './ui';

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
interface FindResult {
  target: Place;
  matches: NodeMatch[];
  unplaced: number;
  total: number;
}

const tier = (score: number) => (score >= 95 ? 'city' : score >= 85 ? 'region' : score >= 60 ? 'country' : 'near');

export const nearList = new ListView<NodeMatch>(
  'near-nodes',
  {
    score: { label: '接近程度', value: r => String(r.score).padStart(3, '0') },
    distance: { label: '距离', value: r => (r.distance_km === null ? '999999' : String(Math.round(r.distance_km)).padStart(6, '0')) },
    name: { label: '节点名称', value: r => r.name },
  },
  r => `${r.name} ${r.host} ${r.subscription} ${r.place.label} ${r.reason}`,
  r => tier(r.score),
  { city: '同城 / 100 km 内', region: '同州 / 省', country: '同国家', near: '邻近国家 / 地区' }
);

let query = '';
let result: FindResult | null = null;
let busy = false;
let error = '';

export const nearRows = (): NodeMatch[] => result?.matches || [];
export const finderBusy = () => busy;
export const renderNearList = (): string => nearList.render(nearRows(), nearRow);

function nearRow(m: NodeMatch) {
  const statuses = m.services.length
    ? m.services.map(s => `<span class="safety ${esc(s.status)}">${serviceName(s.service)} · ${safetyText(s.status)}</span>`).join(' ')
    : '<span class="safety none">未登记</span>';
  return `<article class="ai-record near-row">
    <div class="record-main">
      <strong>${esc(m.name)}</strong>
      <span class="near-reason tier-${tier(m.score)}">${esc(m.reason)}</span>
    </div>
    <div class="record-detail">
      <small>${esc(m.place.label)} · 依据：${esc(m.place.source)}</small>
      <small>${esc([m.subscription, m.host].filter(Boolean).join(' · '))}</small>
      <div class="near-status">${statuses}</div>
    </div>
    <div class="record-actions">
      <button type="button" data-copy-text="${esc(m.name)}">复制节点名</button>
    </div>
  </article>`;
}

function targetCard(t: Place, r: FindResult) {
  return `<div class="near-target">
    <span class="eyebrow">目标位置</span>
    <strong>${esc(t.label || t.country)}</strong>
    <small>${esc(t.source)} · 找到 ${r.matches.length} 个相近节点，共 ${r.total} 个节点${r.unplaced ? `，其中 ${r.unplaced} 个从名称看不出地区` : ''}</small>
  </div>`;
}

export function renderNodeFinder(): string {
  return `<section class="panel ai-records">
    <form id="near-form" class="near-form">
      <label class="note-field">
        <span>地址、城市或 IP</span>
        <input name="near-query" autocomplete="off" spellcheck="false" maxlength="200" required value="${esc(query)}" placeholder="例如：洛杉矶、Seattle, WA、东京都新宿区、203.0.113.8">
      </label>
      <button type="submit" class="primary" ${busy ? 'disabled' : ''}>${busy ? '正在查找…' : '查找相近节点'}</button>
    </form>
    <p class="small muted near-hint">按节点名称里的国家 / 城市判断；某个节点测到过出口 IP 时，以实测位置为准。服务器地址常是共用入口，不代表出口位置。城市名、州名直接用内置地名表；完整地址会发给 OpenStreetMap 查询，IP 会发给 ipwho.is。</p>
    ${error ? `<p class="warning" role="alert">${esc(error)}</p>` : ''}
    ${result ? targetCard(result.target, result) + nearList.render(result.matches, nearRow) : ''}
  </section>`;
}

/** Run the search; `repaint` re-renders the page so the busy state and results show. */
export async function findNear(text: string, repaint: () => void) {
  if (busy) return;
  query = text.trim();
  busy = true;
  error = '';
  repaint();
  try {
    result = await invoke<FindResult>('find_nodes_near', { query });
    nearList.page = 1;
  } catch (e) {
    error = String(e);
  } finally {
    busy = false;
    repaint();
  }
}
