// Shared IP Intelligence View & Quick Light-Dismiss Modal (#details + inline diagnostics:ip-lookup).
// Hierarchy: Input + Active Exit Chips -> Hero Summary -> 3 Structured Metadata Cards -> Nearby Landmarks & Maps.

import { mapLinks } from './maps';
import type { AppShellApi } from './store';
import type { GeoInfo, IpModalHandle, Json, View } from './types';
import { esc, icon, safetyText, time } from './ui';

interface ActiveExitChip {
  id: string;
  label: string;
  ip: string | null;
}

interface NearbyPlace {
  name?: string;
  address?: string;
  postal?: string;
  distance_km?: number;
  latitude?: number;
  longitude?: number;
  url?: string;
}

interface NearbyPayload {
  places: NearbyPlace[];
  attribution?: string;
  queried_at?: string;
}

export interface IpIntelController {
  renderView: (view?: View) => string;
  inspectIp: (ip: string, force?: boolean) => Promise<void>;
  loadNearby: () => Promise<void>;
  getCurrentIp: () => string;
  reset: () => void;
  bindEvents: (host: HTMLElement) => void;
}

const IP_INPUT_PATTERN = '^[0-9a-fA-F:.]{3,45}$';

function isPlausibleIpInput(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length < 3 || s.length > 45) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return false;
  return s.includes('.') || s.includes(':');
}

function collectActiveExits(v: View | undefined): ActiveExitChip[] {
  const domestic =
    v?.probes.find(p => p.group === 'domestic' && p.ip)?.ip ||
    v?.probes.find(p => p.group === 'domestic6' && p.ip)?.ip ||
    null;
  const foreign =
    v?.probes.find(p => p.group === 'foreign' && p.ip)?.ip ||
    v?.probes.find(p => p.group === 'foreign6' && p.ip)?.ip ||
    null;
  const claude = v?.verdicts.find(x => x.service === 'claude')?.ip || v?.claude.ip || null;
  const gemini = v?.verdicts.find(x => x.service === 'gemini')?.ip || v?.gemini.ip || null;

  return [
    { id: 'domestic', label: '国内出口', ip: domestic },
    { id: 'foreign', label: '国外出口', ip: foreign },
    { id: 'claude', label: 'Claude 出口', ip: claude },
    { id: 'gemini', label: 'Gemini 出口', ip: gemini },
  ];
}

function resolveSalesTaxPill(g: GeoInfo): { label: string; tone: 'ok' | 'warn' | 'neutral'; detail: string } | null {
  if (g.country_code !== 'US') return null;
  const st = g.sales_tax as Record<string, any> | undefined;
  const status = String(st?.status || '');
  const rawLabel = String(st?.label || '');
  const rawNote = String(st?.note || '按 IP 州份判断，仅指州级销售税，不代表账单地址验证结果。');
  const regionStr = `${g.region || ''} ${g.region_code || ''}`;
  const isAlaska = /\bAK\b|alaska|阿拉斯加/i.test(regionStr) || rawNote.includes('阿拉斯加');

  const isTaxFree =
    status === 'no_state_sales_tax' || (/免/.test(rawLabel) && !rawLabel.includes('非免'));

  if (isAlaska && isTaxFree) {
    return {
      label: '阿拉斯加地方税提示',
      tone: 'warn',
      detail: rawNote,
    };
  }
  if (isTaxFree) {
    return {
      label: '免州级销售税',
      tone: 'ok',
      detail: rawNote,
    };
  }
  if (status === 'state_sales_tax' || rawLabel.includes('非免税') || rawLabel.includes('有州级')) {
    return {
      label: '需缴州税',
      tone: 'neutral',
      detail: rawNote,
    };
  }
  return {
    label: '州税状态待确认',
    tone: 'neutral',
    detail: rawNote,
  };
}

interface NetworkTraitPill {
  label: string;
  tone: 'ok' | 'warn' | 'neutral';
}

function resolveNetworkTraits(g: GeoInfo): NetworkTraitPill[] {
  const nt = (g.network_type || {}) as Record<string, any>;
  const sec = (g.security || {}) as Record<string, any>;
  const label = String(nt.label || '');
  const idc = String(nt.idc || '');
  const res = String(nt.residential || '');
  const mob = String(nt.mobile || '');

  const pills: NetworkTraitPill[] = [];

  const cleanLabel = label.replace(/（[^）]*未确认[^）]*）/g, '');

  if (idc.startsWith('是') || sec.hosting === true || /idc|云服务|cdn|hosting|机房/i.test(cleanLabel)) {
    pills.push({ label: '机房/托管 (Hosting)', tone: 'warn' });
  }
  if (res.startsWith('是') || /运营商|家宽|商宽|residential/i.test(cleanLabel)) {
    pills.push({ label: '家宽/商宽参考', tone: 'ok' });
  }
  if (mob.startsWith('是') || /移动蜂窝|蜂窝网络|\bmobile\b|\bcellular\b/i.test(cleanLabel)) {
    pills.push({ label: '移动蜂窝', tone: 'neutral' });
  }
  if (sec.proxy === true || sec.vpn === true || sec.tor === true || /代理|vpn|proxy|tor/i.test(cleanLabel)) {
    pills.push({ label: '代理/VPN 特征', tone: 'warn' });
  }

  if (!pills.length) {
    pills.push({ label: '常规网络（保守参考）', tone: 'neutral' });
  }
  return pills;
}

function formatCoordPair(lat: unknown, lon: unknown): string {
  const a = Number(lat);
  const b = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '未提供';
  return `${a.toFixed(4)}, ${b.toFixed(4)}`;
}

function syncFieldAriaError(input: HTMLInputElement, invalid: boolean) {
  const errorId = input.dataset.error;
  input.classList.toggle('user-invalid-fallback', invalid);
  input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
  if (!errorId) return;
  const ids = (input.getAttribute('aria-describedby') || '')
    .split(/\s+/)
    .filter(id => id && id !== errorId);
  if (invalid) ids.push(errorId);
  if (ids.length) input.setAttribute('aria-describedby', ids.join(' '));
  else input.removeAttribute('aria-describedby');
}

export function createIpIntelController(
  app: AppShellApi,
  opts: {
    mode: 'inline' | 'modal';
    getContainer: () => HTMLElement | null;
    isActive?: () => boolean;
    onAfterNavigate?: () => void;
  }
): IpIntelController {
  const prefix = opts.mode === 'modal' ? 'modal-ip' : 'inline-ip';
  let inputDraft = '';
  let currentIp = '';
  let geo: GeoInfo | null = null;
  let geoBusy = false;
  let geoError = '';
  let nearby: NearbyPayload | null = null;
  let nearbyBusy = false;
  let nearbyError = '';
  let reqSeq = 0;

  const isMounted = () => (opts.isActive ? opts.isActive() : Boolean(opts.getContainer()));

  const repaintResultRegion = () => {
    const host = opts.getContainer();
    if (!host) return;
    const v = app.getState();
    const chipsEl = host.querySelector<HTMLElement>('[data-ip-chips-slot]');
    if (chipsEl) chipsEl.innerHTML = renderQuickExitChips(v);
    const requeryBtn = host.querySelector<HTMLButtonElement>('[data-ip-requery]');
    if (requeryBtn) {
      requeryBtn.disabled = !currentIp || geoBusy;
      requeryBtn.innerHTML = `${icon('refresh')}<span>${geoBusy ? '查询中…' : '重新查询'}</span>`;
    }
    const resultEl = host.querySelector<HTMLElement>('[data-ip-result-slot]');
    if (resultEl) {
      resultEl.setAttribute('aria-busy', String(geoBusy));
      resultEl.innerHTML = renderResultBody(v);
    }
  };

  function renderQuickExitChips(v: View | undefined): string {
    const chips = collectActiveExits(v);
    return chips
      .map(c => {
        const selected = Boolean(c.ip && c.ip === currentIp);
        return `<button
          type="button"
          class="chip-btn exit-quick-chip ${selected ? 'selected' : ''}"
          data-quick-ip="${esc(c.ip || '')}"
          aria-pressed="${selected}"
          ${!c.ip || geoBusy ? 'disabled' : ''}
          title="${c.ip ? `查询 ${c.label}：${c.ip}` : `${c.label}暂无实测地址`}"
        >
          <span>${esc(c.label)}</span>
          <span class="chip-ip mono tabular">${esc(c.ip || '暂无')}</span>
        </button>`;
      })
      .join('');
  }

  function renderTrustRow(service: 'claude' | 'gemini', ip: string, v: View | undefined): string {
    const rec = v?.claude_ips.find(r => r.service === service && r.ip === ip);
    const st = rec?.status || null;
    const badgeCls = st ? esc(st) : 'none';
    const name = service === 'claude' ? 'Claude' : 'Gemini';
    return `<div class="ip-trust-row">
      <div class="ip-trust-status">
        <span class="service-badge ${service === 'gemini' ? 'gemini' : ''}">${name}</span>
        <span class="safety ${badgeCls}">${esc(safetyText(st))}</span>
      </div>
      <div class="ip-trust-btns">
        <button
          type="button"
          class="compact-action ${st === 'safe' ? 'is-active-safe' : ''}"
          data-mark-ip="${esc(ip)}"
          data-service="${service}"
          data-status="safe"
        >标为可用</button>
        <button
          type="button"
          class="compact-action ${st === 'risk' ? 'is-active-risk' : ''}"
          data-mark-ip="${esc(ip)}"
          data-service="${service}"
          data-status="risk"
        >标为风险</button>
      </div>
    </div>`;
  }

  function renderNearbySection(ip: string, g: GeoInfo): string {
    const locTitle = [g.city, g.region, g.country].filter(Boolean).join(', ');
    const coordLinks = mapLinks(Number(g.latitude), Number(g.longitude), locTitle);

    let bodyHtml = '';
    if (nearbyBusy) {
      bodyHtml = `<p class="muted small ip-nearby-state">正在向 OpenStreetMap 查询 10 km 内公开图书馆参考地址与邮编…</p>`;
    } else if (nearbyError) {
      bodyHtml = `<div class="ip-inline-alert warn">
        <span>附近公开地标暂不可用：${esc(nearbyError)}（上方归属地与 ASN 信息不受影响）。</span>
      </div>`;
    } else if (nearby) {
      if (nearby.places?.length) {
        bodyHtml = `
          <div class="ip-places-grid">
            ${nearby.places
              .map(p => {
                const pLinks = mapLinks(Number(p.latitude), Number(p.longitude), String(p.name || ''));
                const dist = Number.isFinite(Number(p.distance_km))
                  ? `约 ${Number(p.distance_km).toFixed(1)} km`
                  : '附近';
                const osmHref =
                  typeof p.url === 'string' && p.url.startsWith('https://www.openstreetmap.org/')
                    ? p.url
                    : pLinks?.osm || '';
                return `<article class="place-card">
                  <div class="place-card-head">
                    <strong>${esc(p.name || '公开地点')}</strong>
                    <span class="pill tabular nowrap">${esc(dist)}</span>
                  </div>
                  <p class="place-address">${esc(p.address || '未提供街道详情')}</p>
                  <div class="place-card-foot">
                    <span class="place-postal">当地邮编：<strong class="mono tabular">${esc(p.postal || '未收录')}</strong></span>
                    <div class="map-actions">
                      ${pLinks ? `<button type="button" class="text-button compact" data-url="${esc(pLinks.amap)}">高德地图 ↗</button>` : ''}
                      ${pLinks ? `<button type="button" class="text-button compact" data-url="${esc(pLinks.google)}">Google 地图 ↗</button>` : ''}
                      ${osmHref ? `<button type="button" class="text-button compact" data-url="${esc(osmHref)}">OpenStreetMap ↗</button>` : ''}
                    </div>
                  </div>
                </article>`;
              })
              .join('')}
          </div>
          <p class="small muted ip-osm-attr">
            ${esc(nearby.attribution || '© OpenStreetMap contributors')} · 查询于 <span class="tabular">${esc(nearby.queried_at ? time(nearby.queried_at) : '刚刚')}</span> · 公开机构地址非个人住址
          </p>`;
      } else {
        bodyHtml = `<p class="muted small ip-nearby-state">该 IP 粗略坐标 10 km 范围内未检索到带完整门牌的公开图书馆记录；可通过右侧地图链接直接核验坐标位置。</p>`;
      }
    } else {
      bodyHtml = `<p class="muted small ip-nearby-state">需要核对当地真实街道与邮政编码时，可点击「查询附近地标」检索 OpenStreetMap 公开地标。</p>`;
    }

    return `<section class="ip-nearby-card" aria-label="附近公共地标参考与地图链接">
      <div class="ip-nearby-head">
        <div>
          <h3>附近公共地标参考与地图链接</h3>
          <p class="small muted">基于 IP 数据库粗略坐标核验周边公开机构邮编；点击地图按钮将在系统浏览器打开外部地图。</p>
        </div>
        <div class="ip-nearby-controls">
          ${
            coordLinks
              ? `<button type="button" data-url="${esc(coordLinks.amap)}">高德地图 ↗</button>
                 <button type="button" data-url="${esc(coordLinks.google)}">Google 地图 ↗</button>
                 <button type="button" data-url="${esc(coordLinks.osm)}">OpenStreetMap ↗</button>`
              : ''
          }
          <button type="button" data-ip-nearby ${nearbyBusy ? 'disabled' : ''}>
            ${icon('pin')}<span>${nearbyBusy ? '查询中…' : nearby ? '重新查询地标' : '查询附近地标'}</span>
          </button>
        </div>
      </div>
      ${bodyHtml}
    </section>`;
  }

  function renderResultBody(v: View | undefined): string {
    if (geoBusy && !geo) {
      return `<div class="ip-loading-card">
        <span class="is-spinning">${icon('refresh')}</span>
        <div>
          <strong>正在查询 <span class="mono tabular">${esc(currentIp)}</span> 的归属地与自治域信息…</strong>
          <p class="small muted">优先复用本机缓存；未命中时通过 ipwho.is 获取 ASN、时区与州税参考。</p>
        </div>
      </div>`;
    }

    if (geoError) {
      return `<div class="warning ip-error-box" role="alert">
        <div>
          <strong>无法完成 IP 查询（<span class="mono tabular">${esc(currentIp)}</span>）</strong>
          <p class="small">${esc(geoError)}</p>
        </div>
        <button type="button" data-ip-requery>重试查询</button>
      </div>`;
    }

    if (!geo || !currentIp) {
      return `<div class="empty ip-empty-state">
        <div class="empty-icon">${icon('globe')}</div>
        <strong>输入公网 IP 或点击上方当前出口快捷按钮</strong>
        <p>核心自治域 ASN、运营商、国家/州省归属与美国免税州提示将置顶展示，仅做只读查询，不会自动改动监控配置。</p>
      </div>`;
    }

    const g = geo;
    const ipVersion = g.type || (currentIp.includes(':') ? 'IPv6' : 'IPv4');
    const headlineLoc =
      [g.country, g.region, g.city]
        .filter((x, idx, arr) => Boolean(x) && arr.indexOf(x) === idx)
        .join(' · ') || '未知地区';
    const taxPill = resolveSalesTaxPill(g);
    const netTraits = resolveNetworkTraits(g);

    const asnLabel = g.connection?.asn ? `AS${g.connection.asn}` : 'ASN 未知';
    const ispOrg = [g.connection?.isp, g.connection?.org]
      .filter((x, idx, arr) => Boolean(x) && arr.indexOf(x) === idx)
      .join(' / ');
    const asnSummary = [asnLabel, ispOrg || '运营商未提供'].join(' · ');

    const val = (x: unknown, fallback = '未提供') =>
      esc(x === null || x === undefined || x === '' ? fallback : x);

    const taxCardTitle =
      g.country_code === 'US'
        ? val(g.sales_tax?.label, taxPill?.label || '州税待确认')
        : '非美国出口（不适用美国州税）';
    const taxCardNote =
      g.country_code === 'US'
        ? val(
            g.sales_tax?.note,
            '按 IP 所在州份判断，仅指州级销售税；不代表账单地址或实际交易免税。'
          )
        : '仅在出口位于美国（US）时计算免州级销售税参考（OR / DE / MT / NH / AK）。';

    return `
      <div class="ip-intel-results">
        <!-- 1. Hero Summary Card (Always at top) -->
        <section class="ip-hero-card" aria-label="IP 核心归属摘要">
          <div class="ip-hero-top">
            <div class="ip-hero-addr-group">
              <strong class="ip-hero-addr mono tabular nowrap">${esc(currentIp)}</strong>
              <span class="pill tabular">${esc(ipVersion)}</span>
              <button type="button" class="text-button compact" data-copy-text="${esc(currentIp)}">
                ${icon('copy')}<span>复制</span>
              </button>
            </div>
            <span class="small muted tabular">${g.cached_at ? `缓存于 ${esc(time(g.cached_at))}` : '实时查询结果'}</span>
          </div>

          <div class="ip-hero-headline">
            <h2>${esc(headlineLoc)}</h2>
            ${g.country_code ? `<span class="pill mono">${esc(g.country_code)}</span>` : ''}
            ${taxPill ? `<span class="pill ${taxPill.tone}">${esc(taxPill.label)}</span>` : ''}
            ${netTraits.map(t => `<span class="pill ${t.tone}">${esc(t.label)}</span>`).join('')}
          </div>

          <div class="ip-hero-asn">
            <span class="mono tabular ip-asn-tag">${esc(asnLabel)}</span>
            <span class="ip-isp-text">${esc(ispOrg || '未提供运营商或组织名称')}</span>
            ${g.connection?.domain ? `<span class="muted mono small">(${esc(g.connection.domain)})</span>` : ''}
          </div>
        </section>

        <!-- 2. Three Structured Metadata Cards -->
        <div class="ip-meta-deck">
          <section class="ip-meta-card" aria-label="地理位置与时区">
            <h3>地理位置与时区</h3>
            <dl class="ip-kv-list">
              <div><dt>国家 / 代码</dt><dd>${val(g.country)}${g.country_code ? ` <span class="muted mono">(${esc(g.country_code)})</span>` : ''}</dd></div>
              <div><dt>州 / 省</dt><dd>${val(g.region)}${g.region_code ? ` <span class="muted mono">(${esc(g.region_code)})</span>` : ''}</dd></div>
              <div><dt>城市</dt><dd>${val(g.city)}</dd></div>
              <div><dt>参考邮编</dt><dd class="mono tabular">${val(g.postal, '未收录')}</dd></div>
              <div><dt>时区 / UTC</dt><dd class="tabular">${val(g.timezone?.id)}${g.timezone?.utc ? ` (${esc(g.timezone.utc)})` : ''}</dd></div>
              <div><dt>粗略经纬度</dt><dd class="mono tabular">${esc(formatCoordPair(g.latitude, g.longitude))}</dd></div>
            </dl>
          </section>

          <section class="ip-meta-card" aria-label="自治域与路由信息">
            <h3>自治域与路由信息</h3>
            <dl class="ip-kv-list">
              <div><dt>自治域号 (ASN)</dt><dd class="mono tabular">${esc(asnLabel)}</dd></div>
              <div><dt>所属组织</dt><dd>${val(g.connection?.org)}</dd></div>
              <div><dt>运营商 (ISP)</dt><dd>${val(g.connection?.isp)}</dd></div>
              <div><dt>网络域名 / 网段</dt><dd class="mono">${val(g.connection?.domain || g.cidr || g.rir)}</dd></div>
              <div><dt>网络类型参考</dt><dd>${val(g.network_type?.label, asnSummary)}</dd></div>
              <div><dt>判定依据</dt><dd class="muted">${val(g.network_type?.basis, 'ipwho.is ASN 与本地保守参考表')}</dd></div>
            </dl>
          </section>

          <section class="ip-meta-card" aria-label="税务与使用参考">
            <h3>税务与使用参考</h3>
            <div class="ip-tax-summary">
              <strong>${taxCardTitle}</strong>
              <p class="small muted">${taxCardNote}</p>
            </div>
            <div class="ip-trust-box">
              <div class="ip-trust-head">
                <span>登记至信任记录库</span>
                <button type="button" class="text-button compact" data-goto-ip-records="${esc(currentIp)}">记录库详情 →</button>
              </div>
              ${renderTrustRow('claude', currentIp, v)}
              ${renderTrustRow('gemini', currentIp, v)}
            </div>
          </section>
        </div>

        <!-- 3. Nearby Public Landmarks & Map Links (Below Core Cards) -->
        ${renderNearbySection(currentIp, g)}
      </div>`;
  }

  async function inspectIp(rawIp: string, force = false): Promise<void> {
    const cleaned = rawIp.trim();
    if (!cleaned) return;
    inputDraft = cleaned;
    currentIp = cleaned;
    geoBusy = true;
    geoError = '';
    if (force || geo?.ip !== cleaned) {
      nearby = null;
      nearbyError = '';
      nearbyBusy = false;
    }
    const seq = ++reqSeq;

    const host = opts.getContainer();
    const input = host?.querySelector<HTMLInputElement>(`#${prefix}-input`);
    if (input) {
      input.value = cleaned;
      syncFieldAriaError(input, false);
    }
    repaintResultRegion();

    try {
      const cached = !force ? app.getGeo(cleaned) : undefined;
      const fetched = cached || (await app.lookupGeo(cleaned, force));
      if (seq !== reqSeq || !isMounted()) return;
      const canonical = fetched.ip || cleaned;
      currentIp = canonical;
      inputDraft = canonical;
      geo = fetched;
      geoBusy = false;
      if (input && input.isConnected) input.value = canonical;
      repaintResultRegion();
      await loadNearby(seq);
    } catch (e) {
      if (seq !== reqSeq || !isMounted()) return;
      geo = null;
      geoBusy = false;
      geoError = String(e);
      repaintResultRegion();
    }
  }

  async function loadNearby(parentSeq = reqSeq): Promise<void> {
    if (!currentIp || !geo) return;
    const targetIp = currentIp;
    nearbyBusy = true;
    nearbyError = '';
    repaintResultRegion();
    try {
      const res = await app.lookupNearby(targetIp);
      if (parentSeq !== reqSeq || currentIp !== targetIp || !isMounted()) return;
      nearby = {
        places: Array.isArray(res?.places) ? res.places : [],
        attribution: res?.attribution,
        queried_at: res?.queried_at,
      };
    } catch (e) {
      if (parentSeq !== reqSeq || currentIp !== targetIp || !isMounted()) return;
      nearbyError = String(e);
    } finally {
      if (parentSeq === reqSeq && currentIp === targetIp && isMounted()) {
        nearbyBusy = false;
        repaintResultRegion();
      }
    }
  }

  function renderView(v = app.getState()): string {
    const hintId = `${prefix}-hint`;
    const errId = `${prefix}-error`;
    return `<div class="ip-intel-shell ${opts.mode === 'inline' ? 'panel ip-intel-inline' : ''}">
      <div class="ip-intel-toolbar">
        <form class="ip-intel-form" data-ip-intel-form novalidate>
          <div class="ip-field-head">
            <label for="${prefix}-input">公网 IPv4 / IPv6 地址</label>
            <span id="${hintId}" class="small muted">支持任意公网地址只读查询；本机已缓存结果将直接秒开</span>
          </div>
          <div class="ip-lookup-controls">
            <input
              id="${prefix}-input"
              name="ip"
              type="text"
              required
              maxlength="45"
              pattern="${IP_INPUT_PATTERN}"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              aria-invalid="false"
              aria-describedby="${hintId}"
              data-error="${errId}"
              value="${esc(inputDraft)}"
              placeholder="输入公网 IP，如 198.51.100.42 或 2606:4700:4700::1111"
            >
            <button type="submit" class="primary" ${geoBusy ? 'disabled' : ''}>
              ${icon('search')}<span>${geoBusy ? '查询中…' : '查询归属'}</span>
            </button>
            <button type="button" data-ip-requery ${!currentIp || geoBusy ? 'disabled' : ''} title="忽略本机缓存，重新向数据源请求最新信息">
              ${icon('refresh')}<span>重新查询</span>
            </button>
          </div>
          <div id="${errId}" class="field-error-msg">
            <span role="img" aria-label="错误">${icon('alert')}</span>
            <span>请输入有效的公网 IPv4 或 IPv6 地址（例如 198.51.100.42 或 2606:4700::1111）。</span>
          </div>
        </form>

        <div class="ip-quick-bar">
          <span class="ip-quick-label">当前活跃出口：</span>
          <div class="ip-quick-exits" role="group" aria-label="当前活跃出口快捷查询" data-ip-chips-slot>
            ${renderQuickExitChips(v)}
          </div>
        </div>
      </div>

      <div class="ip-result-host" data-ip-result-slot aria-live="polite" aria-busy="${geoBusy}">
        ${renderResultBody(v)}
      </div>
    </div>`;
  }

  function bindEvents(host: HTMLElement) {
    host.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.id !== `${prefix}-input`) return;
      inputDraft = input.value;
      if (input.getAttribute('aria-invalid') === 'true' && isPlausibleIpInput(input.value)) {
        syncFieldAriaError(input, false);
      }
    });

    host.addEventListener(
      'blur',
      event => {
        const input = event.target as HTMLInputElement;
        if (input.id !== `${prefix}-input`) return;
        const val = input.value.trim();
        if (val && !isPlausibleIpInput(val)) {
          syncFieldAriaError(input, true);
        }
      },
      true
    );

    host.addEventListener('submit', event => {
      const form = (event.target as HTMLElement).closest<HTMLFormElement>('[data-ip-intel-form]');
      if (!form) return;
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>(`#${prefix}-input`);
      if (!input) return;
      const val = input.value.trim();
      if (!isPlausibleIpInput(val)) {
        syncFieldAriaError(input, true);
        input.focus();
        return;
      }
      syncFieldAriaError(input, false);
      void inspectIp(val, false);
    });

    host.addEventListener('click', event => {
      const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!btn || btn.disabled) return;

      if (btn.dataset.quickIp) {
        void inspectIp(btn.dataset.quickIp, false);
        return;
      }
      if (btn.hasAttribute('data-ip-requery') && currentIp) {
        void inspectIp(currentIp, true);
        return;
      }
      if (btn.hasAttribute('data-ip-nearby') && currentIp) {
        void loadNearby();
        return;
      }
      if (btn.dataset.gotoIpRecords) {
        const targetIp = btn.dataset.gotoIpRecords;
        opts.onAfterNavigate?.();
        void app.navigate('records', 'ips', {
          service: 'claude',
          ip: targetIp,
          status: 'pending',
          note: '',
        });
      }
    });
  }

  return {
    renderView,
    inspectIp,
    loadNearby: () => loadNearby(),
    getCurrentIp: () => currentIp,
    reset() {
      reqSeq++;
      inputDraft = '';
      currentIp = '';
      geo = null;
      geoBusy = false;
      geoError = '';
      nearby = null;
      nearbyBusy = false;
      nearbyError = '';
    },
    bindEvents,
  };
}

export function initIpDetailsModal(
  dialog: HTMLDialogElement,
  app: AppShellApi,
  onAfterClose?: () => void
): IpModalHandle {
  dialog.setAttribute('closedby', 'any');
  dialog.removeAttribute('aria-label');
  dialog.setAttribute('aria-labelledby', 'ip-dialog-title');

  const contentEl = () => dialog.querySelector<HTMLElement>('#detail-content');
  let lastTrigger: HTMLElement | null = null;

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    let pressedOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    dialog.addEventListener('pointerdown', e => {
      pressedOutside = e.target === dialog && isOutside(e);
    });
    dialog.addEventListener('pointerup', e => {
      if (pressedOutside && e.target === dialog && isOutside(e)) {
        dialog.close();
      }
      pressedOutside = false;
    });
  }

  const controller = createIpIntelController(app, {
    mode: 'modal',
    getContainer: contentEl,
    isActive: () => dialog.open,
    onAfterNavigate: () => {
      if (dialog.open) dialog.close();
    },
  });

  dialog.addEventListener('close', () => {
    dialog.returnValue = '';
    delete dialog.dataset.ip;
    onAfterClose?.();
    if (lastTrigger?.isConnected) {
      lastTrigger.focus({ preventScroll: true });
    }
    lastTrigger = null;
  });

  const host = contentEl();
  if (host) {
    controller.bindEvents(host);
  }

  // Keep modal trust badges and quick exit chips live when user clicks 标为可用 / 标为风险 inside modal.
  app.subscribe(snap => {
    if (!dialog.open) return;
    const root = contentEl();
    if (!root) return;
    const chipsSlot = root.querySelector<HTMLElement>('[data-ip-chips-slot]');
    if (chipsSlot) {
      const exits = collectActiveExits(snap.view);
      const cur = controller.getCurrentIp();
      chipsSlot.innerHTML = exits
        .map(c => {
          const selected = Boolean(c.ip && c.ip === cur);
          return `<button type="button" class="chip-btn exit-quick-chip ${selected ? 'selected' : ''}" data-quick-ip="${esc(c.ip || '')}" aria-pressed="${selected}" ${!c.ip ? 'disabled' : ''}>
            <span>${esc(c.label)}</span>
            <span class="chip-ip mono tabular">${esc(c.ip || '暂无')}</span>
          </button>`;
        })
        .join('');
    }
    const curIp = controller.getCurrentIp();
    if (curIp && snap.view) {
      for (const svc of ['claude', 'gemini'] as const) {
        const btn = root.querySelector<HTMLElement>(`[data-mark-ip][data-service="${svc}"]`);
        const row = btn?.closest('.ip-trust-row');
        if (!row) continue;
        const rec = snap.view.claude_ips.find(r => r.service === svc && r.ip === curIp);
        const st = rec?.status || null;
        const safetyBadge = row.querySelector<HTMLElement>('.safety');
        if (safetyBadge) {
          safetyBadge.className = `safety ${st ? esc(st) : 'none'}`;
          safetyBadge.textContent = safetyText(st);
        }
        row.querySelectorAll<HTMLButtonElement>('[data-mark-ip]').forEach(b => {
          b.classList.toggle('is-active-safe', b.dataset.status === 'safe' && st === 'safe');
          b.classList.toggle('is-active-risk', b.dataset.status === 'risk' && st === 'risk');
        });
      }
    }
  });

  function mountModalShell(trigger?: HTMLElement) {
    const root = contentEl();
    if (!root) return;
    if (trigger) lastTrigger = trigger;
    else if (document.activeElement instanceof HTMLElement && !dialog.contains(document.activeElement)) {
      lastTrigger = document.activeElement;
    }

    root.innerHTML = `
      <div class="dialog-head">
        <div>
          <h1 id="ip-dialog-title" class="dialog-title">IP 归属与网络详情</h1>
        </div>
        <form method="dialog" class="dialog-close-form">
          <button type="submit" id="close-dialog">关闭</button>
        </form>
      </div>
      ${controller.renderView(app.getState())}`;

    if (!dialog.open) {
      dialog.showModal();
    }
  }

  return {
    openLookup(trigger) {
      controller.reset();
      mountModalShell(trigger);
      dialog.querySelector<HTMLInputElement>('#modal-ip-input')?.focus();
    },
    async openIp(ip, force = false, trigger) {
      mountModalShell(trigger);
      dialog.dataset.ip = ip;
      await controller.inspectIp(ip, force);
    },
    async openProbe(probeId, force = false, trigger) {
      const ip = app.getState()?.probes.find(p => p.id === probeId)?.ip;
      if (!ip) {
        controller.reset();
        mountModalShell(trigger);
        dialog.querySelector<HTMLInputElement>('#modal-ip-input')?.focus();
        return;
      }
      mountModalShell(trigger);
      dialog.dataset.ip = ip;
      await controller.inspectIp(ip, force);
    },
  };
}
