// IP location / network details dialog and nearby public places.
import { mapLinks } from './maps';
import { geoCache } from './overview';
import { esc, icon, time } from './ui';
import type { Json } from './types';

export interface DetailDeps {
  dialog: HTMLDialogElement;
  call: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
  probeIp: (id: string) => string | null;
  lockScroll: () => void;
  rememberOpener: (modal: HTMLDialogElement, trigger?: HTMLElement) => void;
  /** New geography arrived; the page behind the dialog should refresh when it closes. */
  onGeoLoaded: () => void;
}
let deps: DetailDeps;
export function initIpDetails(d: DetailDeps) {
  deps = d;
}

export async function showDetails(id: string, force = false, trigger?: HTMLElement) {
  const dialog = deps.dialog;
  const ip = deps.probeIp(id);
  if (!ip) return;
  dialog.dataset.ip = ip;
  if (!dialog.open) deps.rememberOpener(dialog, trigger);
  document.querySelector('#detail-content')!.innerHTML = `
    <div class="dialog-head">
      <div>
        <span class="eyebrow">IP INTELLIGENCE</span>
        <h2>${esc(ip)}</h2>
      </div>
      <button type="button" id="close-dialog">关闭</button>
    </div>
    <p class="muted">正在查询位置、运营商与邮编…</p>`;
  if (!dialog.open) { deps.lockScroll(); dialog.showModal(); }
  try {
    const g = await deps.call<Json>('lookup_geo', { ip, force });
    geoCache.set(ip, g);
    if (dialog.dataset.ip !== ip || !dialog.open) return;
    const value = (x: unknown) => esc(x === null || x === undefined || x === '' ? '未提供' : x);
    const fields = [
      ['网络类型', g.network_type?.label],
      ['IDC / 机房', g.network_type?.idc],
      ['家宽', g.network_type?.residential],
      ['移动网络', g.network_type?.mobile],
      ['企业 / 其他', g.network_type?.other],
      ['类型判断依据', g.network_type?.basis],
      ['类型数据来源', g.network_type?.source],
      ['信息查询时间', g.cached_at],
      ['国家 / 地区', g.country],
      ['国家代码', g.country_code],
      ['省 / 州', g.region],
      ['美国免税州', g.sales_tax?.label],
      ['销售税说明', g.sales_tax?.note],
      ['城市', g.city],
      ['邮政编码（粗略）', g.postal],
      ['时区', g.timezone?.id],
      ['UTC 偏移', g.timezone?.utc],
      ['地址类型', g.type],
      ['ASN', g.connection?.asn ? `AS${g.connection.asn}` : null],
      ['运营商 ISP', g.connection?.isp],
      ['所属组织', g.connection?.org],
      ['网络域名', g.connection?.domain],
      ['纬度', g.latitude],
      ['经度', g.longitude],
      ['数据源', 'ipwho.is'],
    ];
    const restoreFocus = dialog.contains(document.activeElement);
    document.querySelector('#detail-content')!.innerHTML = `
      <div class="dialog-head">
        <div>
          <div class="eyebrow">IP INTELLIGENCE</div>
          <h2>${esc(ip)}</h2>
        </div>
        <button type="button" id="close-dialog">关闭</button>
      </div>
      <p class="muted">此信息描述 IP 数据库中的出口位置，不能定位到你的真实住址。</p>
      <dl class="geo-grid">${fields.map(([k, v]) => `<div><dt>${k}</dt><dd>${value(v)}</dd></div>`).join('')}</dl>
      <div class="notice">
        <p>没有住宅 / 代理 / “纯净度”可靠数据时，不给出猜测性评级。此处邮编也不是账单地址验证结果。同一 IP 信息保存在本机，重启后复用；不会随出口轮询重复查询。</p>
        <button type="button" id="refresh-ip-info">重新获取此 IP 信息</button>
      </div>
      <h3>附近公开地点</h3>
      <p class="muted">自动以粗略坐标查询 10 公里范围内的公开图书馆地址。会向 OpenStreetMap Nominatim 发送坐标；结果可在原始地图核验。</p>
      <button type="button" id="nearby" class="primary">${icon('pin')}查询真实公开地点</button>
      <div id="places"></div>`;
    document.querySelector('#refresh-ip-info')?.addEventListener('click', () => showDetails(id, true));
    if (restoreFocus) document.querySelector<HTMLButtonElement>('#close-dialog')?.focus();
    deps.onGeoLoaded();
    document
      .querySelector('.geo-grid')!
      .insertAdjacentHTML('beforebegin', '<section id="address-summary"><p class="muted">正在查询附近公开地址和邮编…</p></section>');
    const maps = mapLinks(Number(g.latitude), Number(g.longitude), [g.city, g.region, g.country].filter(Boolean).join(', '));
    if (maps)
      document
        .querySelector('.geo-grid')!
        .insertAdjacentHTML(
          'afterend',
          `<div class="map-actions"><span class="small muted">IP 粗略位置</span><button type="button" data-url="${esc(maps.amap)}">高德地图 ↗</button><button type="button" data-url="${esc(maps.google)}">Google 地图 ↗</button></div>`
        );
    await loadPlaces(ip);
  } catch (e) {
    if (dialog.dataset.ip === ip && dialog.open) {
      const restoreFocus = dialog.contains(document.activeElement);
      document.querySelector('#detail-content')!.innerHTML = `
        <div class="dialog-head"><h2>详情暂不可用</h2><button type="button" id="close-dialog">关闭</button></div>
        <p>${esc(String(e))}</p>
        <p>出口 IP 检测仍继续。关闭后可稍后重试。</p>`;
      if (restoreFocus) document.querySelector<HTMLButtonElement>('#close-dialog')?.focus();
    }
  }
}

function placeButtons(p: Json) {
  const links = mapLinks(Number(p.latitude), Number(p.longitude), p.name);
  return `<div class="map-actions">${links ? `<button type="button" data-url="${esc(links.amap)}">高德地图 ↗</button><button type="button" data-url="${esc(links.google)}">Google 地图 ↗</button>` : ''}<button type="button" data-url="${esc(p.url)}">OSM 来源 ↗</button></div>`;
}

export async function loadPlaces(ip: string) {
  const dialog = deps.dialog;
  const b = document.querySelector<HTMLButtonElement>('#nearby');
  if (!b) return;
  b.disabled = true;
  b.textContent = '正在查询附近真实地址…';
  const e = document.querySelector('#places');
  if (e) e.innerHTML = '<p class="muted small">正在查询附近公开地点及当地邮编…</p>';
  try {
    const r = await deps.call<Json>('lookup_nearby', { ip });
    if (dialog.dataset.ip !== ip || !dialog.open) return;
    const summary = document.querySelector('#address-summary');
    const first = r.places[0];
    if (summary)
      summary.innerHTML = first
        ? `<article class="place featured"><span class="eyebrow">附近真实公开地址 · 位置参考</span><h4>${esc(first.name)}</h4><p class="address">${esc(first.address)}</p><p><strong>当地邮政编码：${esc(first.postal || '未收录')}</strong></p><p class="small muted">距 IP 粗略坐标约 ${Number(first.distance_km).toFixed(1)} km；不是本人住址。</p>${placeButtons(first)}</article>`
        : '<p class="muted">附近未找到含完整门牌的公开地址，下方仍可查看 IP 定位及数据库邮编。</p>';
    document.querySelector('#places')!.innerHTML = r.places.length
      ? `<p class="small muted">${esc(r.attribution)} · ${time(r.queried_at)}</p>${r.places
          .slice(1)
          .map(
            (p: Json) =>
              `<article class="place"><span class="eyebrow">其他附近公开地点</span><h4>${esc(p.name)}</h4><p class="address">${esc(p.address)}</p><p><strong>当地邮政编码：${esc(p.postal || '未收录')}</strong></p><p class="small muted">距 IP 粗略坐标约 ${Number(p.distance_km).toFixed(1)} km；不是本人住址。</p>${placeButtons(p)}</article>`
          )
          .join('')}<p class="small muted">Google 地图或高德地图会接收所点击地点的坐标。海外地点在高德中的覆盖可能有限。</p>`
      : '<p>该区域未找到附完整街道门牌的公开地点。没有为缺失地址补写内容。</p>';
  } catch (e) {
    if (dialog.dataset.ip === ip) {
      const summary = document.querySelector('#address-summary');
      if (summary) summary.innerHTML = '<p class="muted">附近地址暂不可用，下方仍可查看 IP 详情及数据库邮编。</p>';
      const p = document.querySelector('#places');
      if (p) p.innerHTML = `<p class="warning">附近地址暂不可用：${esc(String(e))}。IP 与邮编详情仍可查看。</p>`;
    }
  } finally {
    if (b.isConnected) {
      b.disabled = false;
      b.innerHTML = `${icon('pin')}重新查询附近公开地址`;
    }
  }
}

