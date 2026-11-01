import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';
import { initUpdates, updateSettings } from './updater';
import { getVersion } from '@tauri-apps/api/app';
import { ListView } from './list';
import { mapLinks } from './maps';
import { startDiagnostics } from './diagnostics';

if(new URLSearchParams(location.search).get('mode')==='diagnostics'){void startDiagnostics();}else{

interface Settings { interval:number; claude_proxy:string;gemini_proxy:string;gemini_ip_url:string; notifications:boolean; retain_history:boolean; ipv6:boolean; domestic_proxy:string; foreign_proxy:string }
interface Probe { id:string;label:string;group:string;url:string;ip:string|null;last_good_ip:string|null;detail:string;latency:number;checked:string;error:string|null;stable:boolean }
interface Event {time:string;title:string;detail:string}
interface RouteSnapshot {association:string;service:string;domain:string;config:string;mode:string;matched_rule:string;chain:string[];compiled_chain:string[];node_name:string;node_id:string;node_host:string;subscription:string;basis:string;error:string;consistent:boolean;fingerprint:string;first_seen:string;last_seen:string}
interface IpRecord {routes:RouteSnapshot[];service:string;ip:string;status:string;note:string;added_at:string;first_open:string|null;last_open:string|null;source:string}
interface AiTest {route:RouteSnapshot|null;path:string;service:string;time:string;ip:string|null;ip_basis:string;http_code:number|null;latency:number;error:string|null}
interface NodeRecord {key:string;service:string;route:RouteSnapshot;status:string;note:string;added_at:string;updated_at:string}
interface View {ai_nodes:NodeRecord[];current_routes:RouteSnapshot[];claude:{route:RouteSnapshot|null;running:boolean|null;checked:string;ip:string|null;source:string;error:string|null};claude_ips:IpRecord[];ai_tests:AiTest[];ai_testing:boolean;settings:Settings;probes:Probe[];history:Event[];network:string;paused:boolean;checking:boolean;unacknowledged:boolean;status:string;last_check:string;notification_error:string|null;storage_error:string|null}
type Json = Record<string,any>;
let state:View|undefined, tab='monitor', auto:boolean|null=null, autoBusy=false;
const aiList = new ListView<IpRecord>('ai-ips',{added_at:{label:'添加时间',value:r=>r.added_at},ip:{label:'IP 地址',value:r=>r.ip},service:{label:'服务',value:r=>r.service},status:{label:'状态',value:r=>r.status},first_open:{label:'首次观测',value:r=>r.first_open||''},last_open:{label:'最近观测',value:r=>r.last_open||''}},r=>`${r.service} ${r.ip} ${r.note} ${(r.routes||[]).map(r=>`${r.config} ${r.node_name} ${r.chain.join(" ")}`).join(" ")}`,r=>`${r.service}:${r.status}`,Object.fromEntries(['claude','gemini'].flatMap(s=>['pending','safe','risk'].map(t=>[`${s}:${t}`,`${s==='claude'?'Claude':'Gemini'} · ${{pending:'待确认',safe:'可用（手动确认）',risk:'风险'}[t]}`]))));
const probeList = new ListView<Probe>('probes',{label:{label:'检测站',value:r=>r.label},ip:{label:'出口 IP',value:r=>r.ip||''},latency:{label:'耗时',value:r=>String(r.latency)}},r=>`${r.label} ${r.ip||''} ${r.error||''}`,r=>r.group,{domestic:'国内',foreign:'国外',ipv6:'IPv6'});
const historyList = new ListView<Event>('history',{time:{label:'时间',value:r=>r.time},title:{label:'事件',value:r=>r.title}},r=>`${r.title} ${r.detail}`,()=> '');
const routeList = new ListView<RouteSnapshot>('ip-routes',{last_seen:{label:'最近观测',value:r=>r.last_seen},first_seen:{label:'首次观测',value:r=>r.first_seen},node_name:{label:'节点名称',value:r=>r.node_name},config:{label:'配置名称',value:r=>r.config}},r=>`${r.config} ${r.chain.join(' ')} ${r.node_name} ${r.node_host}`,r=>r.consistent&&!r.error&&r.node_name?'configured':'unknown',{configured:'配置推断',unknown:'节点未确认 / 采样变化'});
const nodeList = new ListView<NodeRecord>('ai-nodes',{updated_at:{label:'更新时间',value:r=>r.updated_at},node:{label:'节点名称',value:r=>r.route.node_name},service:{label:'服务',value:r=>r.service},status:{label:'状态',value:r=>r.status}},r=>`${r.service} ${r.route.config} ${r.route.node_name} ${r.route.chain.join(' ')} ${r.note}`,r=>`${r.service}:${r.status}`,Object.fromEntries(['claude','gemini'].flatMap(s=>['pending','safe','risk'].map(t=>[`${s}:${t}`,`${s==='claude'?'Claude':'Gemini'} · ${{pending:'待确认',safe:'可用',risk:'风险'}[t]}`]))));
function nodeRow(r:NodeRecord){return `<article class="ai-record"><div><strong>${r.service==='claude'?'Claude':'Gemini'} · ${esc(r.route.node_name)}</strong><p class="safety ${esc(r.status)}">${safetyText(r.status)}</p><small>节点登记 · 未关联出口 IP</small></div><div>${routeSummary(r.route)}<p>${esc(r.note||'暂无备注')}</p><small>更新：${time(r.updated_at)}</small></div><div class="record-actions"><button data-edit-node="${esc(r.key)}" data-node-service="${esc(r.service)}">修改节点状态</button></div></article>`}
function safetyText(s:string){return ({pending:'待确认',safe:'可用 · 手动确认',risk:'风险 / 不可用'} as Record<string,string>)[s]||'未登记'}
function nodeCurrent(r:RouteSnapshot|undefined){if(!r||!r.consistent||r.error||!r.node_name)return '<p class="small muted">当前节点未确认，暂不能登记。</p>';const record=state?.ai_nodes?.find(n=>n.service===r.service&&n.key===r.fingerprint);return `<p>节点状态：<strong>${record?safetyText(record.status):'未登记'}</strong> · 无需 IP</p><button data-register-node="${esc(r.service)}" data-node-key="${esc(r.fingerprint)}">登记 / 修改当前节点</button>`}
function fillNode(service:string,key:string,current:boolean){const form=content.querySelector<HTMLFormElement>('#ai-node-form');if(!form)return;const record=state?.ai_nodes?.find(n=>n.service===service&&n.key===key);for(const [k,v] of Object.entries({target:`${current?'current':'saved'}:${service}:${key}`,status:record?.status||'pending',note:record?.note||''})){(form.elements.namedItem(k) as HTMLInputElement).value=v;}form.scrollIntoView({block:'center',behavior:'smooth'});(form.elements.namedItem('status') as HTMLSelectElement).focus()}
let routeRows:RouteSnapshot[]=[];
const geoCache = new Map<string,Json>();
const series = new Map<string,{time:string;values:number[]}>();
const icons:Record<string,string> = {
  shield:'<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  pulse:'<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  settings:'<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>',
  book:'<path d="M12 5v16M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2V4Z"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a8 8 0 0 1 14 5M18 17A8 8 0 0 1 4 12"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',
  pin:'<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2"/>',
};
const icon=(name:string)=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icons[name]||icons.pulse}</svg>`;
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const time=(s:string)=>s?new Date(s).toLocaleString('zh-CN',{hour12:false}):'尚未检测';
const titles:Record<string,string>={starting:'等待首次检测',paused:'监控已暂停',offline:'所有检测站不可达',degraded:'部分检测异常',changed:'发现变化，请确认',split:'正在监控多个出口',stable:'各站出口一致'};
document.querySelector('#app')!.innerHTML=`
  <aside><div class="brand"><span class="brand-icon">${icon('shield')}</span><div>出口哨兵<small>EXIT SENTINEL</small></div></div>
  <div class="section-label">工作空间</div><nav aria-label="主导航"><button data-tab="monitor" class="active">${icon('globe')}出口监控</button><button data-tab="ai">${icon('shield')}AI 服务与 IP</button><button data-tab="history">${icon('pulse')}变化记录 <span id="event-count">0</span></button><button data-tab="settings">${icon('settings')}监控设置</button><button data-tab="guide">${icon('book')}使用指南</button></nav>
  <div class="sidebar-foot"><span class="dot green"></span> 本机运行 · 无账号<small>关闭窗口后，菜单栏继续守护。</small><span class="version">macOS / <span id="app-version">读取版本…</span></span></div></aside>
  <main><header><div><div class="eyebrow">NETWORK OBSERVATORY</div><h1 id="page-title">看清每一条出口。</h1><p id="page-subtitle">国内与国外，分别观测。网络变化，及时知晓。</p></div><button id="curl-panel">网站连通性 · curl</button><button id="check" class="primary">${icon('refresh')}立即检测</button></header><div id="software-update" role="status" aria-live="polite"></div><div id="content"></div></main>
  <dialog id="route-details" class="route-dialog"><div id="route-content"></div></dialog><dialog id="details"><div id="detail-content"></div></dialog><div id="toast" role="status" aria-live="polite"></div>`;
const content=document.querySelector<HTMLElement>('#content')!;
const dialog=document.querySelector<HTMLDialogElement>('#details')!;
function toast(message:string){const e=document.querySelector<HTMLElement>('#toast')!;e.textContent=message;e.classList.add('visible');setTimeout(()=>e.classList.remove('visible'),5000)}
async function call<T=void>(name:string,args?:Record<string,unknown>):Promise<T>{try{return await invoke<T>(name,args)}catch(e){toast(String(e));throw e}}
function primary(group:string){return state?.probes.find(p=>p.group===group&&p.ip)||state?.probes.find(p=>p.group===group)}
function chart(p:Probe){const vals=series.get(p.id)?.values||[];if(vals.length<2)return '<span class="muted small">积累检测样本后显示延迟走势</span>';
  const max=Math.max(...vals,1),points=vals.map((v,i)=>`${i/(vals.length-1)*250},${34-v/max*28}`).join(' ');
  return `<svg viewBox="0 0 250 40" class="spark" role="img" aria-label="最近 ${vals.length} 次检测延迟"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`}
function exitCard(group:string,title:string,en:string){const p=primary(group);const g=p?.ip?geoCache.get(p.ip):null;
  return `<section class="exit-card ${group}"><div class="card-top"><span class="route-icon">${icon('globe')}</span><span class="pill">${esc(en)}</span></div><div class="eyebrow">${esc(title)}</div>
    <div class="ip">${esc(p?.ip||'等待有效出口')}</div><div class="ip-info">${g?esc([g.country,g.region,g.city].filter(Boolean).join(' / ')):esc(p?.detail||'点击详情，查询城市、邮编和运营商')}</div>
    <p class="tax-hint">${g?.sales_tax?esc(g.sales_tax.label):'免税州：等待位置查询'}</p>${g?.country_code==='US'?`<small>${esc(g.sales_tax?.note)}</small>`:''}<div class="route-line"><span class="node"></span><span>这台 Mac</span><span class="route-dash"></span><span>${esc(group==='domestic'?'国内检测站':'国外检测站')}</span><span class="node end"></span></div>
    <div class="card-bottom"><span>${p?.ip?`${p.latency} ms <span class="muted">检测耗时</span>`:'<span class="muted">尚无有效测量</span>'}</span><button class="text-button" data-detail="${esc(p?.id||'')}" ${!p?.ip?'disabled':''}>IP 详情 ${icon('arrow')}</button></div></section>`;
}
function routeSummary(r:RouteSnapshot|null|undefined){return r?`<div class="route-snapshot"><strong>节点：${esc(r.node_name||'未确认')}</strong><p>配置：${esc(r.config||'未读取')} · ${esc(r.mode)}</p><p class="small">${esc(r.chain.join(' → ')||'暂无策略链')}</p><small>${esc(r.node_host?`节点服务器：${r.node_host} · ${r.subscription}`:r.subscription)}</small><small>${esc(r.association)} · ${esc(r.basis)}</small>${r.error?`<p class="warning">${esc(r.error)}</p>`:''}</div>`:'<small>暂无节点快照；请重新检测。</small>'}
function ipRow(r:IpRecord){const routes=r.routes||[],latest=[...routes].sort((a,b)=>b.last_seen.localeCompare(a.last_seen))[0];return `<article class="ai-record"><div><strong>${r.service==='claude'?'Claude':'Gemini'}</strong><p class="mono">${esc(r.ip)}</p><span class="safety ${esc(r.status)}">${({pending:'待确认',safe:'可用 · 手动确认',risk:'风险 / 不可用'} as Record<string,string>)[r.status]}</span></div><div><small>首次观测：${r.first_open?time(r.first_open):'无打开记录'}</small><small>最近观测：${r.last_open?time(r.last_open):'无打开记录'}</small><small>依据：${esc(r.source||'手动添加')}</small>${routeSummary(latest)}<p>${esc(r.note||'暂无备注')}</p></div><div class="record-actions"><button data-edit-service="${esc(r.service)}" data-edit-ip="${esc(r.ip)}">修改状态</button><button data-route-service="${esc(r.service)}" data-route-ip="${esc(r.ip)}" ${routes.length?'':'disabled'}>节点记录（${routes.length}）</button><button data-copy-service="${esc(r.service)}" data-copy-ip="${esc(r.ip)}" ${routes.length?'':'disabled'}>复制节点信息</button></div></article>`;}
function routeRow(r:RouteSnapshot){return `<article class="route-history-row">${routeSummary(r)}<small>规则候选：${esc(r.matched_rule)} · ${esc(r.domain)}</small><small>节点 ID：${esc(r.node_id||'未唯一匹配')}</small><small>缓存策略链：${esc(r.compiled_chain.join(' → ')||'未读取')}</small><small>首次关联：${time(r.first_seen)} · 最近关联：${time(r.last_seen)}</small></article>`}
function showRoutes(r:IpRecord){routeRows=r.routes||[];const modal=document.querySelector<HTMLDialogElement>('#route-details')!;document.querySelector('#route-content')!.innerHTML=`<div class="dialog-head"><h2>${esc(r.service)} · ${esc(r.ip)}</h2><button id="close-routes">关闭</button></div><p class="muted">保存检测前后的配置快照，用于下次找回节点。配置推断不代表逐连接日志确认；同一 IP 可以对应多个节点。</p>${routeList.render(routeRows,routeRow)}`;modal.showModal()}
function historyRow(e:Event){return `<article><span class="timeline-dot"></span><time>${time(e.time)}</time><h3>${esc(e.title)}</h3><p>${esc(e.detail).replace(/\n/g,'<br>')}</p></article>`;}
function probeRow(p:Probe){return `<div class="probe-row"><div><strong>${esc(p.label)}</strong><small>${esc(new URL(p.url).hostname)}</small></div><div><span class="dot ${p.ip?'green':'amber'}"></span><span class="mono">${esc(p.ip||(p.checked?'不可达':'等待检测'))}</span><small>${esc(p.error||(!p.stable?'变化待二次确认':p.checked?'检测有效':''))}</small></div><div>${chart(p)}</div><div class="latency">${p.checked?`${p.latency}<small>ms</small>`:'—'}</div></div>`;}
function render(){if(!state)return; const v=state;
  document.querySelector('#event-count')!.textContent=String(v.history.length);
  const check=document.querySelector<HTMLButtonElement>('#check')!;check.disabled=v.checking||v.paused;check.innerHTML=`${icon('refresh')}${v.checking?'检测中…':'立即检测'}`;
  document.querySelector('#page-title')!.textContent=({monitor:'看清每一条出口。',ai:'每个服务，独立确认。',history:'变化，都有迹可循。',settings:'按你的网络来。',guide:'从观测，到理解。'} as Record<string,string>)[tab];
  document.querySelector('#page-subtitle')!.textContent=({monitor:'国内与国外，分别观测。网络变化，及时知晓。',ai:'Claude 与 Gemini 按服务和 IP 独立记录；可用状态由你手动确认。',history:'仅记录已确认的变化，保留最近 200 条。',settings:'检测沿真实路由运行。设置仅影响本应用。',guide:'出口监控、位置参考与账号规则的边界。'} as Record<string,string>)[tab];
  if(tab==='monitor')content.innerHTML=`
    <section class="status-bar ${esc(v.status)}"><span class="status-symbol">${icon('pulse')}</span><div><strong>${titles[v.status]||v.status}</strong><small>上次检测 ${time(v.last_check)} · 每 ${v.settings.interval} 秒复核 · 本机网络约每 3 秒检查</small></div><div class="status-actions">${v.unacknowledged?'<button id="ack">确认变化</button>':''}<button id="pause">${v.paused?'恢复监控':'暂停'}</button></div></section>
    ${v.storage_error?`<p class="warning">配置保存异常：${esc(v.storage_error)}</p>`:''}${v.notification_error?`<p class="warning">通知发送异常：${esc(v.notification_error)}。请到系统设置检查通知权限。</p>`:''}
    <div class="exit-grid">${exitCard('domestic','国内出口','DOMESTIC')}${exitCard('foreign','国外出口','GLOBAL')}</div>
    <div class="section-head"><h2>检测站观测</h2><span>各域名单独建立基线</span></div><section class="panel probe-panel"><div class="probe-head"><span>检测目标</span><span>实际出口 / 状态</span><span>最近延迟走势</span><span>耗时</span></div>
    ${probeList.render(v.probes,probeRow)}</section>
    <div class="notice">${icon('shield')}<p>检测站看到的出口，取决于该域名的分流规则。这里的 IP <strong>不等于 Claude 一定看到的 IP</strong>；绿色只表示检测成功，不代表账号安全评级。</p></div>
    <details class="network"><summary>查看本机网络与系统代理快照</summary><pre>${esc(v.network||'正在读取…')}</pre><p>自动使用系统路由 / TUN 与进程代理环境变量；不会自动执行 macOS PAC。IPv6 默认关闭，可在设置中单独开启。</p></details>`;
  if(tab==='history')content.innerHTML=`<div class="section-head"><h2>变化时间线</h2><button id="clear">清空记录</button></div><section class="panel timeline">${historyList.render(v.history,historyRow)}</section>`;
  if(tab==='ai')renderAi();
  if(tab==='settings')renderSettings();
  if(tab==='guide')content.innerHTML=`<section class="panel prose"><div class="eyebrow">QUICK START</div><h2>一分钟开始监控</h2><ol><li>保留你现有的分流配置，等待四个检测站返回实际出口。</li><li>在监控设置中允许系统通知，点击“发送测试通知”验证。</li><li>点击卡片的 IP 详情查看国家、城市、邮编和 ASN。</li><li>从菜单栏点击国内或国外 IP 即可打开详情和附近地址。只检索 IP 粗略定位周边 10 公里内的图书馆。</li><li>点击窗口关闭按钮后仍会监控。要退出，请在菜单栏菜单中选择“退出出口哨兵”。</li></ol>
  <h2>菜单栏图标怎么看</h2><p>绿色圆环：出口一致；绿色双点：观测到多个出口；黄色三角：检测异常或有变化待确认；红色叉：全部主检测站不可达；灰色双竖线：暂停。颜色与图形同时变化。</p>
  <h2>关于地址与邮编</h2><p>IP 定位不是 GPS，常常是城市中心或运营商登记位置。邮编来自 IP 数据库，可能缺失或过期。公开地点地址来自 OpenStreetMap，和你本人的住址、账单信息无关；显示结果时提供可核验的原始地图链接。</p>
  <h2>关于 Claude 账号</h2><p>官方没有“防封保证”。实际身处支持地区、真实账号与支付信息、遵守条款和使用政策才是官方依据。固定出口只是减少网络意外的工程措施。可通过下方官方文档核对支持地区与账号政策。</p><p><button data-url="https://support.claude.com/en/articles/8461763-where-can-i-access-claude">官方支持地区</button> <button data-url="https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals">官方申诉说明</button></p>
  <h2>数据去哪里</h2><p>出口检测站接收正常 HTTPS 请求并看到请求源 IP。出口 IP 没有缓存时会发给 ipwho.is；成功结果保存在本机并在重启后复用。打开 IP 详情时会把粗略坐标发给 Nominatim。最近 200 条变化记录和偏好保存在本机，可关闭历史落盘。无遥测，不读取 Claude 登录态，不修改代理规则。</p><p>© OpenStreetMap contributors · ODbL。免费公共查询服务可能限流或暂时不可用。</p></section>`;
}
let aiDraft:Record<string,string>={}, nodeDraft:Record<string,string>={};
function renderAi(){
  const old=content.querySelector<HTMLFormElement>('#ai-ip-form');if(old){aiDraft=Object.fromEntries(new FormData(old).entries()) as Record<string,string>;aiDraft.attach_current=String(new FormData(old).has('attach_current'));}
  const oldNode=content.querySelector<HTMLFormElement>('#ai-node-form');if(oldNode)nodeDraft=Object.fromEntries(new FormData(oldNode).entries()) as Record<string,string>;
  const v=state!, c=v.claude;
  content.innerHTML=`<section class="panel ai-summary"><div><h2>Claude Desktop · ${v.paused?'监控已暂停':c.running===null?'待检测 / 进程读取异常':c.running?'运行中':'未打开'}</h2><p class="muted">${v.paused?'暂停期间不记录打开事件':`进程最近检查：<span id="claude-checked">${time(c.checked)}</span>`} · 关闭窗口仍监控</p><p>Claude 观测出口：<strong class="mono">${esc(c.ip||'尚无有效结果')}</strong></p><small>${esc(c.source||'claude.ai 同域名 trace')} · 本应用请求，进程分流需另行核对</small></div><div><button id="test-ai" class="primary" ${v.ai_testing?'disabled':''}>${v.ai_testing?'正在分别测试…':'测试 Claude 和 Gemini'}</button><p class="small muted">不登录账号，不自动更改可用状态</p></div></section>
  ${v.unacknowledged&&v.history[0]?.title==='Claude 出口告警'?`<div class="warning" role="alert"><strong>Claude 出口需要确认</strong><p>${esc(v.history[0].detail)}</p><button id="ack">确认已读</button><small>确认已读不会修改 IP 的可用状态。</small></div>`:''}
  ${c.error?`<p class="warning">Claude 出口未确认：${esc(c.error)}</p>`:''}${v.storage_error?`<p class="warning">保存异常：${esc(v.storage_error)}</p>`:''}${v.notification_error?`<p class="warning">系统通知异常：${esc(v.notification_error)}</p>`:''}
  <div class="exit-grid ai-tests">${['claude','gemini'].map(service=>{const t=v.ai_tests.find(t=>t.service===service),current=v.current_routes?.find(r=>r.service===service);return `<section class="panel ai-test"><h2>${service==='claude'?'Claude':'Gemini'} · 独立路径</h2>${t?`<p>${t.http_code===null?'连接失败':`主页 HTTP ${t.http_code}`} · ${t.latency} ms</p><p class="mono">${esc(t.ip||'出口 IP 未确认')}</p><small>${esc(t.ip_basis)}</small><small>路径：${esc(t.path||'本机路由 / TUN')}</small><p class="small">${esc(t.error||'主页请求成功；账号与对话可用性仍由你确认')}</p><small>${time(t.time)}</small>`:'<p class="muted">尚未测试</p>'}<div class="section-head"><h3>当前 Shadowrocket 选择</h3><button data-copy-service="${esc(service)}" ${current?'':'disabled'}>复制</button></div>${routeSummary(current)}${nodeCurrent(current)}${t?.route?`<details class="network"><summary>查看本次测试的节点快照</summary>${routeSummary(t.route)}</details>`:''}</section>`}).join('')}</div>
  <div class="notice"><p>Claude 使用 claude.ai 的 trace 获取源 IP。Gemini 没有默认 IP 回显接口，可在设置中配置已确认与 Google 策略一致的检测 URL；否则保持未确认。两者独立遵循 TUN 分流，可分别指定代理。HTTP 对端地址是服务器或 Fake-IP，不能作为出口 IP。</p></div>
  <div class="section-head"><h2>登记节点状态（无需 IP）</h2></div>
  <form id="ai-node-form" class="panel ai-form"><label class="note-field">服务与节点<select name="target" required><option value="">请选择当前节点或已登记节点</option>${(v.current_routes||[]).filter(r=>r.consistent&&!r.error&&r.node_name).map(r=>`<option value="current:${esc(r.service)}:${esc(r.fingerprint)}">${r.service==='claude'?'Claude':'Gemini'} · 当前 · ${esc(r.node_name)} · ${esc(r.config)}</option>`).join('')}${(v.ai_nodes||[]).map(r=>`<option value="saved:${esc(r.service)}:${esc(r.key)}">${r.service==='claude'?'Claude':'Gemini'} · 已登记 · ${esc(r.route.node_name)} · ${esc(r.route.config)}</option>`).join('')}</select></label><label>手动节点状态<select name="status"><option value="pending">待确认</option><option value="safe">可用（手动确认）</option><option value="risk">风险 / 不可用</option></select></label><label class="note-field">节点备注<input name="note" maxlength="500" placeholder="可用性确认依据"></label><button type="submit" class="primary">保存节点状态</button><p class="small muted">Claude / Gemini 独立登记，不要求 IP。只确认此配置节点快照；切换节点后不会套用旧状态。</p></form>
  <div class="section-head"><h2>已登记节点</h2></div><section class="panel ai-records">${nodeList.render(v.ai_nodes||[],nodeRow)}</section>
  <div class="section-head"><h2>添加 / 更新 IP 状态</h2><button id="use-claude-ip" ${!c.ip?'disabled':''}>填入 Claude 当前出口</button></div>
  <form id="ai-ip-form" class="panel ai-form"><label>服务<select name="service"><option value="claude">Claude</option><option value="gemini">Gemini</option></select></label><label>公网 IP<input name="ip" required placeholder="IPv4 或 IPv6"></label><label>手动状态<select name="status"><option value="pending">待确认</option><option value="safe">可用（手动确认安全）</option><option value="risk">风险 / 不可用</option></select></label><label class="note-field">备注<input name="note" maxlength="500" placeholder="节点、地区或确认依据"></label><button type="submit" class="primary">保存 IP 状态</button><label class="manual-route-toggle"><input name="attach_current" type="checkbox">我已核对该 IP 与当前所选节点，关联当前 Shadowrocket 配置快照</label><p class="small muted">同一服务 + IP 更新已有记录；跨服务独立保存。“可用”表示你的确认。手动添加不生成首次打开记录。</p></form>
  <div class="section-head"><h2>服务 IP 记录</h2><span>首次打开为 Sentinel 监控期间的首次观测</span></div><section class="panel ai-records">${aiList.render(v.claude_ips,ipRow)}</section>`;
  const nodeForm=content.querySelector<HTMLFormElement>('#ai-node-form');for(const [k,v] of Object.entries(nodeDraft)){const input=nodeForm?.elements.namedItem(k) as HTMLInputElement|null;if(input)input.value=v;}
  const form=content.querySelector<HTMLFormElement>('#ai-ip-form');for(const [k,v] of Object.entries(aiDraft)){const input=form?.elements.namedItem(k) as HTMLInputElement|null;if(input){if(input.type==='checkbox')input.checked=v==='true';else input.value=v;}}
}
function renderSettings(){const s=state!.settings;
  content.innerHTML=`<form id="settings-form" class="panel settings"><h2>检测与提醒</h2><label class="field">出口检测间隔（秒）<input name="interval" type="number" min="10" max="3600" value="${s.interval}" required><small>默认 30 秒。出口变化、失败、恢复连续两次确认；本机网络变化约 6 秒确认。</small></label>
  <label class="toggle"><span>变化时发送系统通知<small>无提示音，菜单栏同时切换图标。</small></span><input name="notifications" type="checkbox" ${s.notifications?'checked':''}></label>
  <label class="toggle"><span>开机自启<small id="autostart-status">${auto===null?'正在读取系统状态…':'登录这台 Mac 后在菜单栏后台运行。切换立即生效，无需保存。'}</small></span><input name="autostart" type="checkbox" role="switch" ${auto?'checked':''} ${auto===null||autoBusy?'disabled':''}></label>
  <label class="toggle"><span>保存变化记录<small>只保留最近 200 条；关闭后清除已保存的记录。</small></span><input name="retain_history" type="checkbox" ${s.retain_history?'checked':''}></label>
  <label class="toggle"><span>额外检测国外 IPv6 出口<small>默认关闭。无 IPv6 连通时显示不可达，不影响四项主检测的整体状态。</small></span><input name="ipv6" type="checkbox" ${s.ipv6?'checked':''}></label>
  ${updateSettings()}<h2>分流路径</h2><p class="muted">留空：遵循本机路由 / TUN 和进程代理变量。不会自动读取 macOS 系统代理或执行 PAC。direct：仅忽略进程代理变量，仍遵循 TUN。</p>
  <label class="field">国内检测代理<input name="domestic_proxy" value="${esc(s.domestic_proxy)}" placeholder="留空，或 direct，或 http://127.0.0.1:端口"><small>只影响国内两个检测站。</small></label>
  <label class="field">国外检测与详情查询代理<input name="foreign_proxy" value="${esc(s.foreign_proxy)}" placeholder="留空，或 socks5h://127.0.0.1:端口"><small>推荐使用代理客户端的本地无认证端口；不保存代理密码。</small></label>
  <h2>AI 服务独立路径</h2><p class="muted">默认留空，各自域名沿现有 TUN 分流；不会继承“国外检测代理”。不修改 Shadowrocket 规则。</p>
  <label class="field">Claude 检测代理<input name="claude_proxy" value="${esc(s.claude_proxy)}" placeholder="留空，或独立本地代理 URL"></label>
  <label class="field">Gemini 检测代理<input name="gemini_proxy" value="${esc(s.gemini_proxy)}" placeholder="留空，或独立本地代理 URL"></label>
  <label class="field">Gemini 参考出口检测 URL（可选）<input name="gemini_ip_url" value="${esc(s.gemini_ip_url)}" placeholder="https://…"><small>必须回显公网 IP，且你已确认它与 Gemini 命中相同策略 / 节点。没有配置时显示 IP 未确认；不会使用通用国外 IP 替代。</small></label>
  <div class="form-actions"><button class="primary" type="submit">保存设置</button><button type="button" id="test-notification">发送测试通知</button></div><p id="permission" class="small muted"></p></form>`;
  isPermissionGranted().then(ok=>{const e=document.querySelector('#permission');if(e)e.textContent=ok?'通知授权：已允许（仍受勿扰模式和系统通知设置影响）':'通知授权：尚未允许；保存并启用通知或发送测试通知时会请求授权。'}).catch(()=>{});
}
async function permission(){let ok=await isPermissionGranted();if(!ok)ok=(await requestPermission())==='granted';if(!ok)toast('通知尚未获允许，请在系统设置 → 通知 → Exit Sentinel 中启用。');return ok}
async function showDetails(id:string,force=false){const p=state?.probes.find(p=>p.id===id);if(!p?.ip)return;
  const ip=p.ip;dialog.dataset.ip=ip;if(!dialog.open)dialog.showModal();document.querySelector('#detail-content')!.innerHTML=`<div class="dialog-head"><h2>IP 详情</h2><button id="close-dialog">关闭</button></div><p class="ip">${esc(ip)}</p><p>正在查询位置、运营商与邮编…</p>`;
  try{const g=await call<Json>('lookup_geo',{ip,force});geoCache.set(ip,g);if(dialog.dataset.ip!==ip||!dialog.open)return;
    const value=(x:unknown)=>esc(x===null||x===undefined||x===''?'未提供':x);
    const fields=[['网络类型',g.network_type?.label],['IDC / 机房',g.network_type?.idc],['家宽',g.network_type?.residential],['移动网络',g.network_type?.mobile],['企业 / 其他',g.network_type?.other],['类型判断依据',g.network_type?.basis],['类型数据来源',g.network_type?.source],['信息查询时间',g.cached_at],['国家 / 地区',g.country],['国家代码',g.country_code],['省 / 州',g.region],['美国免税州',g.sales_tax?.label],['销售税说明',g.sales_tax?.note],['城市',g.city],['邮政编码（粗略）',g.postal],['时区',g.timezone?.id],['UTC 偏移',g.timezone?.utc],['地址类型',g.type],['ASN',g.connection?.asn?`AS${g.connection.asn}`:null],['运营商 ISP',g.connection?.isp],['所属组织',g.connection?.org],['网络域名',g.connection?.domain],['纬度',g.latitude],['经度',g.longitude],['数据源','ipwho.is']];
    document.querySelector('#detail-content')!.innerHTML=`<div class="dialog-head"><div><div class="eyebrow">IP INTELLIGENCE</div><h2>${esc(ip)}</h2></div><button id="close-dialog">关闭</button></div><p class="muted">此信息描述 IP 数据库中的出口位置，不能定位到你的真实住址。</p><dl class="geo-grid">${fields.map(([k,v])=>`<div><dt>${k}</dt><dd>${value(v)}</dd></div>`).join('')}</dl><div class="notice"><p>没有住宅 / 代理 / “纯净度”可靠数据时，不给出猜测性评级。此处邮编也不是账单地址验证结果。同一 IP 信息保存在本机，重启后复用；不会随出口轮询重复查询。</p><button id="refresh-ip-info">重新获取此 IP 信息</button></div><h3>附近公开地点</h3><p class="muted">自动以粗略坐标查询 10 公里范围内的公开图书馆地址。会向 OpenStreetMap Nominatim 发送坐标；结果可在原始地图核验。</p><button id="nearby" class="primary">${icon('pin')}查询真实公开地点</button><div id="places"></div>`;
    document.querySelector('#refresh-ip-info')?.addEventListener('click',()=>showDetails(id,true));
    if(tab==='monitor')render();
    document.querySelector('.geo-grid')!.insertAdjacentHTML('beforebegin','<section id="address-summary"><p class="muted">正在查询附近公开地址和邮编…</p></section>');
    const maps=mapLinks(Number(g.latitude),Number(g.longitude),[g.city,g.region,g.country].filter(Boolean).join(', '));
    if(maps)document.querySelector('.geo-grid')!.insertAdjacentHTML('afterend',`<div class="map-actions"><span class="small muted">IP 粗略位置</span><button data-url="${esc(maps.amap)}">高德地图 ↗</button><button data-url="${esc(maps.google)}">Google 地图 ↗</button></div>`);
    await loadPlaces(ip);
  }catch(e){if(dialog.dataset.ip===ip)document.querySelector('#detail-content')!.innerHTML=`<div class="dialog-head"><h2>详情暂不可用</h2><button id="close-dialog">关闭</button></div><p>${esc(String(e))}</p><p>出口 IP 检测仍继续。关闭后可稍后重试。</p>`}
}
function placeButtons(p:Json){const links=mapLinks(Number(p.latitude),Number(p.longitude),p.name);return `<div class="map-actions">${links?`<button data-url="${esc(links.amap)}">高德地图 ↗</button><button data-url="${esc(links.google)}">Google 地图 ↗</button>`:''}<button data-url="${esc(p.url)}">OSM 来源 ↗</button></div>`}
async function loadPlaces(ip:string){const b=document.querySelector<HTMLButtonElement>('#nearby');if(!b)return;b.disabled=true;b.textContent='正在查询附近真实地址…';
  const e=document.querySelector('#places');if(e)e.innerHTML='<p class="muted small">正在查询附近公开地点及当地邮编…</p>';
  try{const r=await call<Json>('lookup_nearby',{ip});if(dialog.dataset.ip!==ip||!dialog.open)return;
    const summary=document.querySelector('#address-summary');const first=r.places[0];if(summary)summary.innerHTML=first?`<article class="place featured"><span class="eyebrow">附近真实公开地址 · 位置参考</span><h4>${esc(first.name)}</h4><p class="address">${esc(first.address)}</p><p><strong>当地邮政编码：${esc(first.postal||'未收录')}</strong></p><p class="small muted">距 IP 粗略坐标约 ${Number(first.distance_km).toFixed(1)} km；不是本人住址。</p>${placeButtons(first)}</article>`:'<p class="muted">附近未找到含完整门牌的公开地址，下方仍可查看 IP 定位及数据库邮编。</p>';
    document.querySelector('#places')!.innerHTML=r.places.length?`<p class="small muted">${esc(r.attribution)} · ${time(r.queried_at)}</p>${r.places.slice(1).map((p:Json,i:number)=>`<article class="place"><span class="eyebrow">其他附近公开地点</span><h4>${esc(p.name)}</h4><p class="address">${esc(p.address)}</p><p><strong>当地邮政编码：${esc(p.postal||'未收录')}</strong></p><p class="small muted">距 IP 粗略坐标约 ${Number(p.distance_km).toFixed(1)} km；不是本人住址。</p>${placeButtons(p)}</article>`).join('')}<p class="small muted">Google 地图或高德地图会接收所点击地点的坐标。海外地点在高德中的覆盖可能有限。</p>`:'<p>该区域未找到附完整街道门牌的公开地点。没有为缺失地址补写内容。</p>';
  }catch(e){if(dialog.dataset.ip===ip){const summary=document.querySelector('#address-summary');if(summary)summary.innerHTML='<p class="muted">附近地址暂不可用，下方仍可查看 IP 详情及数据库邮编。</p>';const p=document.querySelector('#places');if(p)p.innerHTML=`<p class="warning">附近地址暂不可用：${esc(String(e))}。IP 与邮编详情仍可查看。</p>`}}
  finally{if(b.isConnected){b.disabled=false;b.innerHTML=`${icon('pin')}重新查询附近公开地址`}}
}
document.addEventListener('click',async event=>{const b=(event.target as HTMLElement).closest<HTMLButtonElement>('button');if(!b||b.disabled)return;
  try{
    const list=b.closest<HTMLElement>('[data-list]');
    if(b.dataset.listPage&&list){const l=list.dataset.list==='ai-nodes'?nodeList:list.dataset.list==='ai-ips'?aiList:list.dataset.list==='probes'?probeList:list.dataset.list==='ip-routes'?routeList:historyList;l.page=Number(b.dataset.listPage);if(list.dataset.list==='ip-routes'){list.outerHTML=routeList.render(routeRows,routeRow)}else render();return}
    if(b.dataset.registerNode){fillNode(b.dataset.registerNode,b.dataset.nodeKey!,true);return}
    if(b.dataset.editNode){fillNode(b.dataset.nodeService!,b.dataset.editNode,false);return}
    if(b.dataset.copyService){await call('copy_ai_route',{service:b.dataset.copyService,ip:b.dataset.copyIp||null});toast('配置、策略链和节点信息已复制');return}
    if(b.dataset.routeIp){const r=state?.claude_ips.find(r=>r.ip===b.dataset.routeIp&&r.service===b.dataset.routeService);if(r)showRoutes(r);return}
    if(b.dataset.editIp){const r=state?.claude_ips.find(r=>r.ip===b.dataset.editIp&&r.service===b.dataset.editService);if(r)fillIp(r);return}
    if(b.dataset.tab){tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('active',(n as HTMLElement).dataset.tab===tab));render();if(tab==='settings')await syncAutostart();return}
    if(b.dataset.url){await openUrl(b.dataset.url);return}
    if(b.dataset.detail){await showDetails(b.dataset.detail);return}
    switch(b.id){
      case 'test-ai':await call('test_ai_services');toast('Claude 与 Gemini 测试完成，结果已分别更新');renderAi();break;
      case 'use-claude-ip':if(state?.claude.ip)fillIp({service:'claude',ip:state.claude.ip,status:'pending',note:''});break;
      case 'curl-panel':await call('open_diagnostics');break;
      case 'check':await call('check_now');break;
      case 'pause':await call('set_paused',{paused:!state?.paused});break;
      case 'ack':await call('acknowledge');break;
      case 'clear':await call('clear_history');toast('记录已清空');break;
      case 'close-routes':document.querySelector<HTMLDialogElement>('#route-details')!.close();break;
      case 'close-dialog':dialog.close();dialog.dataset.ip='';break;
      case 'test-notification':if(await permission()){await call('test_notification');toast('已向 macOS 提交通知，请确认通知是否出现。')}break;
      case 'nearby':await loadPlaces(dialog.dataset.ip!);break;
    }
  }catch(e){toast(String(e))}
});
function fillIp(r:Pick<IpRecord,'service'|'ip'|'status'|'note'>){const form=content.querySelector<HTMLFormElement>('#ai-ip-form');if(!form)return;for(const [k,v] of Object.entries(r)){const e=form.elements.namedItem(k) as HTMLInputElement|null;if(e)e.value=v;}form.querySelector<HTMLInputElement>('[name=ip]')?.focus();form.scrollIntoView({block:'center',behavior:'smooth'});}
function listInput(event:globalThis.Event){const input=event.target as HTMLInputElement;const root=input.closest<HTMLElement>('[data-list]');if(!root||!input.dataset.listAction)return;
  const l=root.dataset.list==='ai-nodes'?nodeList:root.dataset.list==='ai-ips'?aiList:root.dataset.list==='probes'?probeList:root.dataset.list==='ip-routes'?routeList:historyList;
  l.change(input.dataset.listAction,input.value);
  const fresh=document.createElement('div');
  fresh.innerHTML=root.dataset.list==='ai-nodes'?nodeList.render(state!.ai_nodes||[],nodeRow):root.dataset.list==='ai-ips'?aiList.render(state!.claude_ips,ipRow):root.dataset.list==='probes'?probeList.render(state!.probes,probeRow):root.dataset.list==='ip-routes'?routeList.render(routeRows,routeRow):historyList.render(state!.history,historyRow);
  root.querySelector('.list-rows')!.replaceChildren(...Array.from(fresh.querySelector('.list-rows')!.childNodes));
  root.querySelector('.list-footer')!.replaceWith(fresh.querySelector('.list-footer')!);
}
document.addEventListener('input',e=>{if((e.target as HTMLElement).dataset.listAction==='query'&&!(e as InputEvent).isComposing)listInput(e)});
document.addEventListener('compositionend',e=>{if((e.target as HTMLElement).dataset.listAction==='query')listInput(e)});
document.addEventListener('change',e=>{if((e.target as HTMLElement).dataset.listAction&& (e.target as HTMLElement).dataset.listAction!=='query')listInput(e)});
document.addEventListener('submit',async e=>{if((e.target as HTMLElement).id!=='ai-node-form')return;e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form),button=form.querySelector<HTMLButtonElement>('[type=submit]')!;button.disabled=true;const [kind,service,key]=String(f.get('target')).split(':');try{await call('save_ai_node',{service,key,status:String(f.get('status')),note:String(f.get('note')).trim(),current:kind==='current'});toast('节点状态已保存，无需出口 IP');renderAi()}catch{}finally{button.disabled=false}});
document.addEventListener('submit',async e=>{if((e.target as HTMLElement).id!=='ai-ip-form')return;e.preventDefault();const form=e.target as HTMLFormElement,f=new FormData(form),button=form.querySelector<HTMLButtonElement>('[type=submit]')!;button.disabled=true;
  try{await call('save_claude_ip',{service:String(f.get('service')),ip:String(f.get('ip')).trim(),status:String(f.get('status')),note:String(f.get('note')).trim(),attachCurrent:f.has('attach_current')});toast('IP 状态已保存');renderAi()}catch{}finally{button.disabled=false}
});
function paintAutostart(message?:string){const input=content.querySelector<HTMLInputElement>('[name=autostart]');if(input){input.checked=auto===true;input.disabled=auto===null||autoBusy;input.setAttribute('aria-busy',String(autoBusy));}const status=content.querySelector('#autostart-status');if(status)status.textContent=message||(autoBusy?'正在更新系统设置…':auto===null?'无法读取系统状态，请重新进入设置页重试。':'登录这台 Mac 后在菜单栏后台运行。切换立即生效，无需保存。');}
async function syncAutostart(){if(autoBusy)return;try{auto=await invoke<boolean>('get_autostart');paintAutostart()}catch(e){auto=null;paintAutostart();toast(`开机自启状态读取失败：${e}`)}}
document.addEventListener('change',async event=>{const input=event.target as HTMLInputElement;if(input.name!=='autostart'||autoBusy)return;const wanted=input.checked;autoBusy=true;paintAutostart();try{auto=await invoke<boolean>('set_autostart',{enabled:wanted});toast(auto?'已开启开机自启':'已关闭开机自启')}catch(e){try{auto=await invoke<boolean>('get_autostart')}catch{auto=null}toast(`开机自启设置失败：${e}`)}finally{autoBusy=false;paintAutostart()}});
window.addEventListener('focus',()=>{if(tab==='settings')void syncAutostart()});
document.addEventListener('submit',async event=>{if((event.target as HTMLElement).id!=='settings-form')return;event.preventDefault();const form=event.target as HTMLFormElement;const f=new FormData(form);const submit=form.querySelector<HTMLButtonElement>('[type=submit]')!;submit.disabled=true;
  try{const s:Settings={claude_proxy:String(f.get('claude_proxy')||'').trim(),gemini_proxy:String(f.get('gemini_proxy')||'').trim(),gemini_ip_url:String(f.get('gemini_ip_url')||'').trim(),interval:Number(f.get('interval')),notifications:f.has('notifications'),retain_history:f.has('retain_history'),ipv6:f.has('ipv6'),domestic_proxy:String(f.get('domestic_proxy')||'').trim(),foreign_proxy:String(f.get('foreign_proxy')||'').trim()};
    if(s.notifications)await permission();await call('save_settings',{settings:s});toast('设置已保存');
  }catch(e){toast(String(e))}finally{submit.disabled=false}
});
let geoLoading=false, geoLast=0;
async function syncGeography(){if(geoLoading||Date.now()-geoLast<15000)return;geoLoading=true;geoLast=Date.now();try{const all=await invoke<Record<string,Json>>('get_cached_geography');let changed=false;for(const [ip,g] of Object.entries(all)){if(JSON.stringify(geoCache.get(ip))!==JSON.stringify(g)){geoCache.set(ip,g);changed=true}}if(changed&&tab==='monitor')render();}catch{}finally{geoLoading=false}}
let aiRenderPending=false;
function aiSignature(v:View|undefined){if(!v)return '';return JSON.stringify({claude:{...v.claude,checked:''},routes:v.current_routes,nodes:v.ai_nodes,ips:v.claude_ips,tests:v.ai_tests,testing:v.ai_testing,paused:v.paused,unacknowledged:v.unacknowledged,event:v.history[0],storage_error:v.storage_error,notification_error:v.notification_error})}
function update(v:View){
  const changed=tab==='ai'?aiSignature(state)!==aiSignature(v):JSON.stringify(state)!==JSON.stringify(v);state=v;void syncGeography();
  for(const p of v.probes){if(!p.checked)continue;const prev=series.get(p.id)||{time:'',values:[]};if(prev.time!==p.checked){if(p.ip)prev.values.push(p.latency);prev.values=prev.values.slice(-24);prev.time=p.checked;series.set(p.id,prev)}}
  const editing=tab==='ai'&&content.contains(document.activeElement)&&document.activeElement?.matches('input,select,textarea');
  if(changed&&editing)aiRenderPending=true;
  if((changed||aiRenderPending)&&tab!=='settings'&&!editing){render();aiRenderPending=false;}
  const checked=document.querySelector('#claude-checked');if(checked)checked.textContent=time(v.claude.checked);
}
async function start(){try{await initUpdates();getVersion().then(v=>{const e=document.querySelector('#app-version');if(e)e.textContent=`v${v}`;});await listen<View>('monitor-state',e=>update(e.payload));update(await invoke<View>('get_state'));await listen<Pick<IpRecord,'service'|'ip'|'status'|'note'>>('open-ai-ip',e=>{tab='ai';document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('active',(n as HTMLElement).dataset.tab===tab));render();fillIp(e.payload)});await listen<string>('ai-status-saved',e=>toast(e.payload));await listen('open-ai-monitor',()=>{tab='ai';document.querySelectorAll('[data-tab]').forEach(n=>n.classList.toggle('active',(n as HTMLElement).dataset.tab===tab));render()});await listen<string>('open-ip-detail',e=>{void showDetails(e.payload)});await listen<boolean|null>('autostart-changed',e=>{auto=e.payload;paintAutostart()});await listen<string>('autostart-error',e=>toast(`开机自启设置失败：${e.payload}`));}catch(e){content.innerHTML=`<section class="panel empty"><h2>需要在桌面应用中运行</h2><p>请使用 Tauri 启动出口哨兵，浏览器预览不能读取本机检测服务。</p><p>${esc(String(e))}</p></section>`}}
void start();

}
