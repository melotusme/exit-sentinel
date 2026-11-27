// Records page: IP records, node records, change history, and proxy data import/clear.
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
import { setSelectChoices, setSelectValue, type Choice } from './select';
import type { AppShellApi } from './store';
import { esc, safetyText, serviceName, time } from './ui';
import type { Event, IpRecord, NodeRecord, PanelHandle, RouteSnapshot, View } from './types';

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
      <button type="button" data-copy-text="${esc(r.ip)}">复制 IP</button>
      <button type="button" data-copy-service="${esc(r.service)}" data-copy-ip="${esc(r.ip)}" ${routes.length ? '' : 'disabled'}>复制节点信息</button>
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
      <label class="note-field"><span>节点</span><select name="target" data-searchable required aria-label="节点"><option value="">选择当前节点或已登记节点</option></select></label>
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

const historyList = new ListView<Event>(
  'history',
  {
    time: { label: '时间', value: r => r.time },
    title: { label: '事件', value: r => r.title },
  },
  r => `${r.title} ${r.detail}`,
  () => ''
);

function historyRow(e: Event) {
  return `<article class="timeline-item">
    <span class="timeline-dot"></span>
    <div class="timeline-card">
      <div class="timeline-header">
        <h3>${esc(e.title)}</h3>
        <time>${time(e.time)}</time>
      </div>
      <p>${esc(e.detail).replace(/\n/g, '<br>')}</p>
    </div>
  </article>`;
}

export function initRecordsPanel(panel: HTMLElement, app: AppShellApi): PanelHandle {
  let ipSaving = false;
  let nodeSaving = false;
  let activeSub = 'ips';

  initProxyData(
    (msg, err) => app.showToast(msg, { persistent: Boolean(err), tone: err ? 'risk' : 'neutral' }),
    async () => {
      await app.call('get_state');
    }
  );

  panel.addEventListener('click', async event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!btn || btn.disabled) return;
    const state = app.getState();
    if (!state) return;

    if (btn.dataset.fillIp) {
      fillIp(panel, { service: btn.dataset.fillService!, ip: btn.dataset.fillIp, status: 'pending', note: '' });
    } else if (btn.dataset.editIp) {
      const r = state.claude_ips.find(x => x.ip === btn.dataset.editIp && x.service === btn.dataset.editService);
      if (r) fillIp(panel, r);
    } else if (btn.dataset.editNode) {
      fillNode(panel, state, btn.dataset.nodeService!, btn.dataset.editNode, false);
    } else if (btn.id === 'clear') {
      if (
        !(await confirmAction({
          title: '清空变化记录？',
          message: '清空全部网络与出口变化日志。IP 和节点库将保留。',
          detail: '清空前自动生成本机恢复备份。',
          confirm: '备份并清空',
          danger: true,
        }))
      )
        return;
      await app.clearMonitorData('history');
      app.showToast('变化记录已清空');
    }
  });

  panel.addEventListener('submit', async event => {
    const form = event.target as HTMLFormElement;
    if (form.id === 'ai-ip-form') {
      event.preventDefault();
      if (ipSaving) return;
      ipSaving = true;
      const f = new FormData(form);
      const submitBtn = form.querySelector<HTMLButtonElement>('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      try {
        await app.call('save_claude_ip', {
          service: String(f.get('service')),
          ip: String(f.get('ip')).trim(),
          status: String(f.get('status')),
          note: String(f.get('note')).trim(),
          attachCurrent: f.has('attach_current'),
        });
        app.showToast('IP 状态已保存');
      } finally {
        ipSaving = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    } else if (form.id === 'ai-node-form') {
      event.preventDefault();
      if (nodeSaving) return;
      nodeSaving = true;
      const f = new FormData(form);
      const submitBtn = form.querySelector<HTMLButtonElement>('[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;
      const [kind, service, ...keyParts] = String(f.get('target')).split(':');
      try {
        await app.call('save_ai_node', {
          service,
          key: keyParts.join(':'),
          status: String(f.get('status')),
          note: String(f.get('note')).trim(),
          current: kind === 'current',
        });
        app.showToast('节点状态已保存');
      } finally {
        nodeSaving = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    }
  });

  const paint = (v: View | undefined, sub: string) => {
    activeSub = sub || 'ips';
    if (!v) return;
    updateProxyDataState(v.paused);
    if (activeSub === 'data' && panel.querySelector('#proxy-data-settings')) {
      return;
    }
    captureDrafts(panel);
    if (activeSub === 'ips') {
      panel.innerHTML = renderIpRecords(v, ipSaving);
    } else if (activeSub === 'nodes') {
      panel.innerHTML = renderNodeRecords(v, nodeSaving);
      populateNodeChoices(panel, v);
    } else if (activeSub === 'history') {
      panel.innerHTML = `<section class="panel timeline">
        <div class="panel-toolbar-head">
          <div><h2>变化历史</h2><small class="muted">连续两次确认的出口变化、服务告警和手动操作，保留最近 200 条</small></div>
          <button type="button" id="clear">清空记录</button>
        </div>
        ${historyList.render(v.history, historyRow)}
      </section>`;
    } else {
      panel.innerHTML = proxyDataSettings(v.paused);
      void loadLocalProxyClients();
    }
    restoreDrafts(panel);
  };

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
        app.showToast('节点操作正在进行，请等待完成后再切换。');
        return false;
      }
      return true;
    },
    hasUnsavedWork() {
      return proxyDataInProgress();
    },
    onDataCleared(scope) {
      if (scope !== 'history') {
        clearDrafts();
        for (const f of panel.querySelectorAll<HTMLFormElement>('#ai-ip-form, #ai-node-form')) f.reset();
      }
      resetProxyDataUi();
    },
    onNavigatePayload(sub, payload) {
      if (sub === 'ips' && payload && typeof payload === 'object' && 'ip' in (payload as any)) {
        fillIp(panel, payload as Pick<IpRecord, 'service' | 'ip' | 'status' | 'note'>);
      }
    },
  };
}
