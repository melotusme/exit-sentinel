// Overview page: one verdict card per AI service, then the plain exit IPs.
import './overview.css';
import { ListView } from './list';
import { ago, esc, icon, safetyText, time, titles } from './ui';
import type { Json, Probe, Uplink, Verdict, View } from './types';

export const geoCache = new Map<string, Json>();
export const series = new Map<string, { time: string; values: number[] }>();

export const probeList = new ListView<Probe>(
  'probes',
  {
    label: { label: '检测站', value: r => r.label },
    ip: { label: '出口 IP', value: r => r.ip || '' },
    latency: { label: '耗时', value: r => String(r.latency) },
  },
  r => `${r.label} ${r.ip || ''} ${r.error || ''}`,
  r => r.group,
  { domestic: '国内 IPv4', foreign: '国外 IPv4', domestic6: '国内 IPv6', foreign6: '国外 IPv6' }
);

const levelText: Record<string, string> = { safe: '可以使用', warn: '需要确认', risk: '有风险', unknown: '未确认' };
const healthText: Record<string, string> = { reachable: '访问正常', restricted: '访问受限（403 / 429 等）', unreachable: '连接失败' };

export function recordSeries(v: View) {
  for (const p of v.probes) {
    if (!p.checked) continue;
    const prev = series.get(p.id) || { time: '', values: [] };
    if (prev.time === p.checked) continue;
    const values = p.ip ? [...prev.values, p.latency].slice(-24) : prev.values;
    series.set(p.id, { time: p.checked, values });
  }
}

function markButtons(kind: 'ip' | 'node', x: Verdict, current: string | null) {
  const target = kind === 'ip' ? `data-mark-ip="${esc(x.ip || '')}"` : `data-mark-node="${esc(x.node_key)}"`;
  return `<div class="mark-buttons" role="group" aria-label="${kind === 'ip' ? '标记出口 IP' : '标记节点'}">
    ${(['safe', 'risk'] as const)
      .map(status => `<button type="button" class="mark ${status} ${current === status ? 'selected' : ''}" data-service="${esc(x.service)}" data-status="${status}" ${target} aria-pressed="${current === status}">${status === 'safe' ? '可用' : '风险'}</button>`)
      .join('')}
  </div>`;
}

function ipRow(x: Verdict) {
  if (!x.ip) {
    return `<div class="verdict-row">
      <span class="verdict-label">出口 IP</span>
      <div class="verdict-value"><strong>未确认</strong><small>${esc(x.ip_hint)}</small></div>
    </div>`;
  }
  return `<div class="verdict-row">
    <span class="verdict-label">出口 IP</span>
    <div class="verdict-value">
      <div class="ip-copy-line"><strong class="mono">${esc(x.ip)}</strong><button type="button" class="text-button compact" data-copy-text="${esc(x.ip)}">复制</button></div>
      <small>${esc(x.ip_source)}${x.ip_checked ? ` · ${esc(ago(x.ip_checked))}` : ''} · <span class="safety ${esc(x.ip_status || 'none')}">${safetyText(x.ip_status)}</span></small>
    </div>
    ${markButtons('ip', x, x.ip_status)}
  </div>`;
}

function nodeRow(x: Verdict) {
  if (!x.node_name) {
    return `<div class="verdict-row">
      <span class="verdict-label">节点</span>
      <div class="verdict-value"><strong>未确认</strong><small>${esc(x.node_hint)}</small></div>
    </div>`;
  }
  const seen = x.node_seen ? ` · ${ago(x.node_seen)}` : '';
  return `<div class="verdict-row">
    <span class="verdict-label">节点</span>
    <div class="verdict-value">
      <strong>${esc(x.node_name)}</strong>
      <small>${esc(x.node_source)}${esc(seen)}${x.node_stale ? '（较早的记录）' : ''} · <span class="safety ${esc(x.node_status || 'none')}">${safetyText(x.node_status)}</span></small>
    </div>
    ${x.node_key ? markButtons('node', x, x.node_status) : `<small class="verdict-note">${esc(x.node_hint || '暂不能登记')}</small>`}
  </div>`;
}

function regionRow(x: Verdict) {
  if (!x.region_label && !x.region_hint) return '';
  const blocked = ['CHN', 'HKG', 'MAC'].includes(x.region_code);
  return `<div class="verdict-row">
    <span class="verdict-label">Google 判定</span>
    <div class="verdict-value">
      <strong class="${blocked ? 'region-blocked' : ''}">${esc(x.region_label || '未知')}</strong>
      <small>${esc(x.region_label ? `${x.region_source || 'Gemini 页面'}里 Google 给出的地区 · ${ago(x.region_checked)}` : x.region_hint)}</small>
    </div>
  </div>`;
}

function healthRow(x: Verdict) {
  return `<div class="verdict-row">
    <span class="verdict-label">访问</span>
    <div class="verdict-value">
      <strong>${x.health ? healthText[x.health] : '等待检测'}</strong>
      <small>${esc(x.health_detail || '每个检测周期请求一次主页')}</small>
    </div>
  </div>`;
}

function verdictCard(v: View, x: Verdict) {
  const test = v.ai_tests.find(t => t.service === x.service);
  const process = x.service === 'claude'
    ? `Claude 桌面版：${v.claude.running === null ? '未知' : v.claude.running ? '运行中' : '未打开'}`
    : '';
  const lastTest = test ? `最近测试 ${test.http_code === null ? '连接失败' : `HTTP ${test.http_code}`} · ${time(test.time)}` : '';
  return `<section class="verdict-card level-${esc(x.level)}" aria-labelledby="verdict-${esc(x.service)}">
    <header class="verdict-head">
      <span class="service-badge ${esc(x.service)}">${esc(x.name)}</span>
      <span class="verdict-level">${levelText[x.level]}</span>
    </header>
    <h2 id="verdict-${esc(x.service)}" class="verdict-headline">${esc(x.headline)}</h2>
    <div class="verdict-rows">${regionRow(x)}${ipRow(x)}${nodeRow(x)}${healthRow(x)}</div>
    <footer class="verdict-foot">
      <small>${esc([process, lastTest].filter(Boolean).join(' · '))}</small>
      <button type="button" class="text-button" data-copy-service="${esc(x.service)}" ${x.node_name ? '' : 'disabled'}>复制节点信息</button>
    </footer>
  </section>`;
}

function primary(v: View, group: string) {
  return v.probes.find(p => p.group === group && p.ip) || v.probes.find(p => p.group === group);
}

function exitTile(v: View, group: string, title: string) {
  const p = primary(v, group);
  const g = p?.ip ? geoCache.get(p.ip) : null;
  const where = g ? [g.country, g.region, g.city].filter(Boolean).join(' · ') : p?.ip ? '位置待查询' : p?.error || '';
  const tax = g?.country_code === 'US' && g?.sales_tax?.label ? ` · ${g.sales_tax.label}` : '';
  return `<article class="exit-tile ${v.paused ? 'is-paused' : ''}">
    <span class="exit-tile-title">${esc(title)}</span>
    <strong class="mono">${esc(p?.ip || (v.paused ? '已暂停' : p?.checked ? '不可达' : '等待检测'))}</strong>
    <small>${esc(where + tax)}</small>
    <div class="exit-tile-foot">
      <small>${p?.ip ? `${p.latency} ms · ${esc(p.label)}` : ''}</small>
      ${p?.ip ? `<div class="tile-actions"><button type="button" class="text-button compact" data-copy-text="${esc(p.ip)}">复制</button><button type="button" class="text-button compact" data-detail="${esc(p.id)}">详情 ${icon('arrow')}</button></div>` : ''}
    </div>
  </article>`;
}

const isMac = /Mac/i.test(navigator.userAgent);

/** Wired / Wi-Fi (with its name) under the default route, looked through any TUN / VPN. */
export function uplinkChip(u: Uplink | undefined, network: string): string {
  if (!u || (!u.interface && !network)) return '<span class="uplink-chip muted">出口链路读取中…</span>';
  if (!u.interface) return '<span class="uplink-chip">出口链路：未连接</span>';
  const device = u.port && u.port !== u.interface ? `${u.port}（${u.interface}）` : u.interface;
  if (u.medium === 'wired') {
    return `<span class="uplink-chip wired" title="${esc(device)}"><strong>有线</strong>${esc(device)}</span>`;
  }
  if (u.medium === 'wireless') {
    const name = u.ssid
      ? `<strong>无线</strong><span class="mono">${esc(u.ssid)}</span>`
      : `<strong>无线</strong><span class="muted">${esc(u.ssid_hint || 'Wi-Fi 名称未知')}</span>`;
    const ask = !u.ssid && isMac ? '<button type="button" class="text-button compact" id="wifi-name-permission">允许读取 Wi-Fi 名称</button>' : '';
    return `<span class="uplink-chip wireless" title="${esc(device)}">${name}</span>${ask}`;
  }
  return `<span class="uplink-chip"><strong>未知类型</strong>${esc(device)}</span>`;
}

function chart(p: Probe) {
  const vals = series.get(p.id)?.values || [];
  if (vals.length < 2) return '<span class="muted small">采样积累中…</span>';
  const max = Math.max(...vals, 1);
  const coords = vals.map((val, i) => [Number(((i / (vals.length - 1)) * 240 + 5).toFixed(1)), Number((34 - (val / max) * 26).toFixed(1))]);
  const points = coords.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg viewBox="0 0 250 40" class="spark" role="img" aria-label="最近 ${vals.length} 次检测延迟">
    <polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

export function probeRow(p: Probe) {
  return `<div class="probe-row">
    <div class="probe-target"><strong>${esc(p.label)}</strong><small>${esc(new URL(p.url).hostname)}</small></div>
    <div class="probe-ip-col">
      <div class="probe-ip-line"><span class="dot ${p.ip ? 'green' : 'amber'}"></span><span class="mono">${esc(p.ip || (p.checked ? '不可达' : '等待检测'))}</span></div>
      <small>${esc(p.error || (!p.stable ? '变化待二次确认' : ''))}</small>
    </div>
    <div class="probe-chart-col">${chart(p)}</div>
    <div class="latency">${p.checked ? `<span class="latency-pill">${p.latency} <small>ms</small></span>` : '—'}</div>
  </div>`;
}

function googleHealth(v: View) {
  const r = v.service_health?.find(h => h.id === 'google');
  if (v.paused || !r) return '';
  const region = v.gemini?.country ? ` · 出口地区 ${esc(v.verdicts.find(x => x.service === 'gemini')?.region_label || v.gemini.country)}` : '';
  return `<span class="pill ${r.status === 'reachable' ? 'ok' : ''}">Google · ${healthText[r.status]}${r.stable ? '' : ' · 复核中'}${region}</span>`;
}

export function renderOverview(v: View): string {
  const warnings = [
    v.storage_error ? `配置保存失败：${v.storage_error}` : '',
    v.notification_error ? `系统通知发送失败：${v.notification_error}。请到系统设置检查通知权限。` : '',
  ].filter(Boolean);
  const pendingList = v.pending_changes?.length
    ? v.pending_changes.map(esc).join('<br>')
    : v.history[0]
      ? esc(v.history[0].detail).replace(/\n/g, '<br>')
      : '';
  return `
    <section class="status-bar ${esc(v.status)}">
      <span class="status-symbol">${icon('pulse')}</span>
      <div class="status-text">
        <div class="status-headline"><strong>${titles[v.status] || v.status}</strong>${googleHealth(v)}</div>
        ${v.pending_changes?.length ? `<small class="status-issues">待确认：${v.pending_changes.map(esc).join('；')}</small>` : ''}
        ${v.issues?.length ? `<small class="status-issues">异常项：${v.issues.map(esc).join('；')}。可在设置中忽略。</small>` : ''}
        <small>上次检测：${time(v.last_check)} · 每 ${v.settings.interval} 秒</small>
      </div>
      <div class="status-actions">
        ${v.unacknowledged ? '<button type="button" id="ack" class="primary">确认已知变化</button>' : ''}
        <button type="button" data-tab="diagnostics" data-subtab="history">查看变化记录</button>
        ${v.paused ? '' : '<button type="button" id="pause">暂停监控</button>'}
      </div>
    </section>
    ${v.unacknowledged && pendingList ? `<div class="alert-card" role="alert"><strong>待确认变化（${v.pending_changes?.length || 1} 项）</strong><p>${pendingList}</p></div>` : ''}
    ${warnings.map(w => `<p class="warning">${esc(w)}</p>`).join('')}
    ${v.settings.manual_nodes_only ? '<div class="notice"><p><strong>自动节点识别已关闭。</strong>判定只能依靠出口 IP。</p><button type="button" id="enable-auto-nodes">恢复自动识别</button></div>' : ''}

    <div class="section-head">
      <h2>AI 服务判定</h2>
      <button type="button" id="test-ai" ${v.ai_testing || v.paused ? 'disabled' : ''}>${v.ai_testing ? '正在测试…' : '测试 Claude 和 Gemini'}</button>
    </div>
    <div class="verdict-grid">${v.verdicts.map(x => verdictCard(v, x)).join('')}</div>
    <p class="small muted">结论来自你登记的 IP / 节点状态；Gemini 另看 Google 判定的地区，判成中国时直接显示有风险。Claude 的 IP 是本应用经同一路径访问 claude.ai 看到的出口，不代表账号状态。</p>

    <div class="section-head"><h2>网络出口</h2>${uplinkChip(v.uplink, v.network)}</div>
    <div class="exit-tiles">
      ${exitTile(v, 'domestic', '国内 IPv4')}
      ${exitTile(v, 'foreign', '国外 IPv4')}
      ${exitTile(v, 'domestic6', '国内 IPv6')}
      ${exitTile(v, 'foreign6', '国外 IPv6')}
    </div>
    <details class="panel probe-panel">
      <summary>检测站明细（${v.probes.length} 个）</summary>
      <div class="probe-head"><span>检测目标</span><span>出口 / 状态</span><span>延迟趋势</span><span class="align-right">耗时</span></div>
      ${probeList.render(v.probes, probeRow)}
    </details>
    <details class="network panel">
      <summary>本机网络与系统代理</summary>
      <div class="network-body"><pre>${esc(v.network || '正在读取…')}</pre></div>
    </details>`;
}
