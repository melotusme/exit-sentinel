// Records page: IP records, node records and their edit forms.
import { ListView } from './list';
import { setSelectChoices, setSelectValue, type Choice } from './select';
import { esc, safetyText, serviceName, time } from './ui';
import type { IpRecord, NodeRecord, RouteSnapshot, View } from './types';

const statusFilters = (safeLabel: string) =>
  Object.fromEntries(
    ['claude', 'gemini'].flatMap(s =>
      ['pending', 'safe', 'risk'].map(t => [`${s}:${t}`, `${serviceName(s)} · ${{ pending: '待确认', safe: safeLabel, risk: '风险' }[t]}`])
    )
  );

export const aiList = new ListView<IpRecord>(
  'ai-ips',
  {
    added_at: { label: '添加时间', value: r => r.added_at },
    ip: { label: 'IP 地址', value: r => r.ip },
    service: { label: '服务', value: r => r.service },
    status: { label: '状态', value: r => r.status },
    first_open: { label: '首次观测', value: r => r.first_open || '' },
    last_open: { label: '最近观测', value: r => r.last_open || '' },
  },
  r => `${r.service} ${r.ip} ${r.note} ${(r.routes || []).map(x => `${x.config} ${x.node_name} ${x.chain.join(' ')}`).join(' ')}`,
  r => `${r.service}:${r.status}`,
  statusFilters('可用')
);

export const nodeList = new ListView<NodeRecord>(
  'ai-nodes',
  {
    updated_at: { label: '更新时间', value: r => r.updated_at },
    node: { label: '节点名称', value: r => r.route.node_name },
    service: { label: '服务', value: r => r.service },
    status: { label: '状态', value: r => r.status },
  },
  r => `${r.service} ${r.route.config} ${r.route.subscription} ${r.route.node_host} ${r.route.node_name} ${r.route.chain.join(' ')} ${r.note}`,
  r => `${r.service}:${r.status}`,
  statusFilters('可用')
);

export const routeList = new ListView<RouteSnapshot>(
  'ip-routes',
  {
    last_seen: { label: '最近观测', value: r => r.last_seen },
    first_seen: { label: '首次观测', value: r => r.first_seen },
    node_name: { label: '节点名称', value: r => r.node_name },
    config: { label: '配置名称', value: r => r.config },
  },
  r => `${r.config} ${r.chain.join(' ')} ${r.node_name} ${r.node_host}`,
  r => (r.consistent && !r.error && r.node_name ? 'configured' : 'unknown'),
  { configured: '已识别节点', unknown: '节点未确认' }
);

export function routeSummary(r: RouteSnapshot | null | undefined) {
  if (!r) return '<p class="empty-snapshot">没有节点记录。</p>';
  if (r.error && !r.node_name) return `<div class="route-snapshot route-unavailable"><strong>节点未确认</strong><p>${esc(r.error)}</p></div>`;
  return `<div class="route-snapshot">
    <div class="snapshot-header"><strong>${esc(r.node_name || '未确认')}</strong>${r.mode ? `<span class="pill">${esc(r.mode)}</span>` : ''}</div>
    <p class="small chain-text">${esc([r.config, ...r.chain].filter(Boolean).join(' → '))}</p>
    ${r.node_host ? `<small>${esc(r.node_host)}${r.subscription ? ` · ${esc(r.subscription)}` : ''}</small>` : ''}
    ${r.error ? `<p class="warning">${esc(r.error)}</p>` : ''}
  </div>`;
}

export function routeRow(r: RouteSnapshot) {
  return `<article class="route-history-row">
    ${routeSummary(r)}
    <div class="route-history-meta">
      <small>${esc(r.basis)}</small>
      <small>首次关联：${time(r.first_seen)} · 最近关联：${time(r.last_seen)}</small>
    </div>
  </article>`;
}

export function ipRecordRow(r: IpRecord) {
  const routes = r.routes || [];
  const latest = [...routes].sort((a, b) => b.last_seen.localeCompare(a.last_seen))[0];
  return `<article class="ai-record">
    <div class="record-main">
      <span class="service-badge ${esc(r.service)}">${serviceName(r.service)}</span>
      <p class="mono record-ip">${esc(r.ip)}</p>
      <span class="safety ${esc(r.status)}">${safetyText(r.status)}</span>
    </div>
    <div class="record-detail">
      <div class="record-meta-grid">
        <small>首次观测：${r.first_open ? time(r.first_open) : '—'}</small>
        <small>最近观测：${r.last_open ? time(r.last_open) : '—'}</small>
        <small>来源：${esc(r.source || '手动添加')}</small>
      </div>
      ${latest ? `<small>最近节点：${esc(latest.node_name || '未确认')}</small>` : ''}
      ${r.note ? `<p class="record-note">${esc(r.note)}</p>` : ''}
    </div>
    <div class="record-actions">
      <button type="button" data-edit-service="${esc(r.service)}" data-edit-ip="${esc(r.ip)}">修改</button>
      <button type="button" data-route-service="${esc(r.service)}" data-route-ip="${esc(r.ip)}" ${routes.length ? '' : 'disabled'}>节点记录（${routes.length}）</button>
      <button type="button" data-copy-service="${esc(r.service)}" data-copy-ip="${esc(r.ip)}" ${routes.length ? '' : 'disabled'}>复制</button>
    </div>
  </article>`;
}

export function nodeRecordRow(r: NodeRecord) {
  return `<article class="ai-record">
    <div class="record-main">
      <span class="service-badge ${esc(r.service)}">${serviceName(r.service)}</span>
      <strong>${esc(r.route.node_name)}</strong>
      <span class="safety ${esc(r.status)}">${safetyText(r.status)}</span>
    </div>
    <div class="record-detail">
      <small>${esc([r.route.node_host, r.route.subscription || r.route.config].filter(Boolean).join(' · '))}</small>
      ${r.note ? `<p class="record-note">${esc(r.note)}</p>` : ''}
      <small>更新：${time(r.updated_at)}</small>
    </div>
    <div class="record-actions">
      <button type="button" data-edit-node="${esc(r.key)}" data-node-service="${esc(r.service)}">修改</button>
    </div>
  </article>`;
}

const statusOptions = `<option value="pending">待确认</option><option value="safe">可用</option><option value="risk">风险</option>`;

export function renderIpRecords(v: View, saving: boolean) {
  const current = v.verdicts.filter(x => x.ip);
  return `<section class="panel ai-records">
    <form id="ai-ip-form" class="ai-form embedded-form">
      <label><span>服务</span><select name="service"><option value="claude">Claude</option><option value="gemini">Gemini</option></select></label>
      <label><span>公网 IP</span><input autocomplete="off" spellcheck="false" name="ip" required placeholder="203.0.113.1 或 2001:db8::1"></label>
      <label><span>状态</span><select name="status">${statusOptions}</select></label>
      <label class="note-field"><span>备注</span><input autocomplete="off" name="note" maxlength="500" placeholder="节点地区、确认依据…"></label>
      <div class="ai-form-submit"><button type="submit" class="primary" ${saving ? 'disabled' : ''}>${saving ? '正在保存…' : '保存 IP'}</button></div>
      <label class="manual-route-toggle"><input name="attach_current" type="checkbox"><span>同时关联当前节点（确认这个 IP 来自当前节点时勾选）</span></label>
    </form>
    ${current.length ? `<div class="form-actions records-fill">${current.map(x => `<button type="button" data-fill-ip="${esc(x.ip!)}" data-fill-service="${esc(x.service)}">填入 ${esc(x.name)} 当前出口</button>`).join('')}</div>` : ''}
    ${aiList.render(v.claude_ips, ipRecordRow)}
  </section>`;
}

export function renderNodeRecords(v: View, saving: boolean) {
  return `<section class="panel ai-records">
    <form id="ai-node-form" class="ai-form embedded-form">
      <label class="note-field"><span>节点</span><select name="target" required aria-label="节点"><option value="">选择当前节点或已登记节点</option></select></label>
      <label><span>状态</span><select name="status">${statusOptions}</select></label>
      <label class="note-field"><span>备注</span><input autocomplete="off" name="note" maxlength="500" placeholder="已验证可用、节点地区…"></label>
      <div class="ai-form-submit"><button type="submit" class="primary" ${saving ? 'disabled' : ''}>${saving ? '正在保存…' : '保存节点'}</button></div>
    </form>
    ${v.ai_nodes.length ? '' : '<p class="node-empty-hint">还没有节点记录。可以在“导入与清理”中从代理软件导入，或在概览页直接标记当前节点。</p>'}
    ${nodeList.render(v.ai_nodes || [], nodeRecordRow)}
  </section>`;
}

/** Fill the node form's choices: current nodes first, then saved records. */
export function populateNodeChoices(root: HTMLElement, v: View) {
  const target = root.querySelector<HTMLFormElement>('#ai-node-form')?.elements.namedItem('target') as HTMLSelectElement | null;
  if (!target) return;
  const choices: Choice[] = [
    ...v.verdicts.filter(x => x.node_key).map(x => ({
      value: `current:${x.service}:${x.node_key}`,
      label: `${x.name} · 当前 · ${x.node_name}`,
      detail: x.node_record ? `已登记：${safetyText(x.node_status)}` : '未登记',
      group: '当前节点',
    })),
    ...(v.ai_nodes || []).map(r => ({
      value: `saved:${r.service}:${r.key}`,
      label: `${serviceName(r.service)} · ${r.route.node_name}`,
      detail: `${r.route.subscription || '来源未标注'} · ${r.route.node_host}`,
      group: r.route.subscription || '来源未标注',
    })),
  ];
  setSelectChoices(target, choices);
}

type Draft = Record<string, string>;
const drafts: Record<string, Draft> = {};

export function captureDrafts(root: HTMLElement) {
  for (const id of ['ai-ip-form', 'ai-node-form']) {
    const form = root.querySelector<HTMLFormElement>(`#${id}`);
    if (!form) continue;
    const data = new FormData(form);
    drafts[id] = { ...Object.fromEntries(data.entries()) as Draft, attach_current: String(data.has('attach_current')) };
  }
}

export function restoreDrafts(root: HTMLElement) {
  for (const [id, draft] of Object.entries(drafts)) {
    const form = root.querySelector<HTMLFormElement>(`#${id}`);
    if (form) fillForm(form, draft);
  }
}

export function clearDrafts() {
  for (const id of Object.keys(drafts)) delete drafts[id];
}

function fillForm(form: HTMLFormElement, values: Draft) {
  for (const [k, value] of Object.entries(values)) {
    const input = form.elements.namedItem(k) as HTMLInputElement | HTMLSelectElement | null;
    if (!input) continue;
    if (input instanceof HTMLSelectElement) setSelectValue(input, value);
    else if (input.type === 'checkbox') input.checked = value === 'true';
    else input.value = value;
  }
}

const scrollBehavior = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth');

export function fillIp(root: HTMLElement, r: Pick<IpRecord, 'service' | 'ip' | 'status' | 'note'>) {
  const form = root.querySelector<HTMLFormElement>('#ai-ip-form');
  if (!form) return;
  fillForm(form, { service: r.service, ip: r.ip, status: r.status, note: r.note });
  form.querySelector<HTMLInputElement>('[name=ip]')?.focus();
  form.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
}

export function fillNode(root: HTMLElement, v: View, service: string, key: string, current: boolean) {
  const form = root.querySelector<HTMLFormElement>('#ai-node-form');
  if (!form) return;
  const record = v.ai_nodes.find(n => n.service === service && n.key === key);
  fillForm(form, { target: `${current ? 'current' : 'saved'}:${service}:${key}`, status: record?.status || 'pending', note: record?.note || '' });
  form.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  (form.elements.namedItem('status') as HTMLSelectElement).focus();
}
