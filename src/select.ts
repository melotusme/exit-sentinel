import { ListView, escapeHtml as esc } from './list';
import './select.css';

export interface Choice { value: string; label: string; detail?: string; group?: string; disabled?: boolean }
const sources = new WeakMap<HTMLSelectElement, Choice[]>();
const buttons = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let serial = 0;

export function setSelectChoices(select: HTMLSelectElement, choices: Choice[]) {
  const value = select.value;
  sources.set(select, choices);
  // Large datasets stay in memory; the form control only needs its selected value.
  select.replaceChildren(new Option('请选择节点…', ''));
  const chosen = choices.find(c => c.value === value);
  if (chosen) { select.add(new Option(chosen.label, chosen.value, true, true)); }
  syncSelect(select);
}

export function setSelectValue(select: HTMLSelectElement, value: string) {
  const choices = sources.get(select);
  if (choices && value && !Array.from(select.options).some(o => o.value === value)) {
    const item = choices.find(c => c.value === value);
    if (item) select.add(new Option(item.label, item.value));
  }
  select.value = value;
  syncSelect(select);
}

function labelOf(select: HTMLSelectElement) {
  return select.getAttribute('aria-label') || select.labels?.[0]?.querySelector('span')?.textContent?.trim() || select.name || '选择';
}
function syncSelect(select: HTMLSelectElement) {
  const button = buttons.get(select); if (!button) return;
  const choice = sources.get(select)?.find(c => c.value === select.value);
  const text = choice?.label || select.selectedOptions[0]?.textContent || '请选择…';
  if (button.textContent !== text) button.textContent = text;
  button.disabled = select.disabled;
  if (select.validity.valid) button.removeAttribute('aria-invalid');
  button.setAttribute('aria-label', `${labelOf(select)}：${text}，搜索并选择`);
}

function openSelect(select: HTMLSelectElement, trigger: HTMLButtonElement) {
  if (select.disabled) return;
  const choices: Choice[] = sources.get(select) || Array.from(select.options).map(o => ({ value: o.value, label: o.label, disabled: o.disabled }));
  const title = labelOf(select);
  const id = `${select.form?.id || select.closest('[data-list]')?.getAttribute('data-list') || 'app'}:${select.name || select.id || title}`;
  const list = new ListView<Choice>(`select:${id}`, {
    label: { label: '名称', value: r => r.label },
    group: { label: '机场 / 订阅', value: r => r.group || '' },
  }, r => `${r.label} ${r.detail || ''} ${r.group || ''}`, r => r.group || '来源未标注');
  const groups = Array.from(new Set(choices.map(c => c.group).filter(Boolean))) as string[];
  const dialog = document.createElement('dialog');
  dialog.className = 'choice-dialog';
  const heading = `choice-title-${++serial}`;
  dialog.setAttribute('aria-labelledby', heading);
  dialog.innerHTML = `<header><h2 id="${heading}">${esc(title)}</h2><button type="button" data-choice-close>关闭</button></header>
    <label class="choice-search"><span>搜索选项</span><input type="search" autocomplete="off" placeholder="搜索名称、机场、订阅、服务或服务器…"></label>
    ${groups.length ? `<label class="choice-group"><span>机场 / 订阅</span><select name="${esc(id)}-provider"><option value="">全部机场 / 订阅</option>${groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select></label>` : ''}
    <div class="choice-order"><button type="button" data-choice-sort>排序：名称</button><button type="button" data-choice-direction></button><span>每页</span>${[10,20,50,100].map(n => `<button type="button" data-choice-size="${n}">${n}</button>`).join('')}</div>
    <p class="choice-count" role="status" aria-live="polite"></p><div class="choice-results"></div><nav class="choice-pages" aria-label="选项分页"></nav>`;
  const results = dialog.querySelector<HTMLElement>('.choice-results')!;
  const search = dialog.querySelector<HTMLInputElement>('input[type=search]')!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  const paint = () => {
    const { rows, visible, pages, start, end } = list.pageData(choices);
    results.innerHTML = visible.length ? visible.map(c => `<button type="button" class="choice-row" data-choice-value="${esc(c.value)}" ${c.disabled ? 'disabled' : ''} aria-pressed="${select.value === c.value}"><strong>${esc(c.label)}</strong>${c.detail || c.group ? `<small>${esc(c.detail || c.group)}</small>` : ''}${select.value === c.value ? '<span class="choice-check" aria-hidden="true">✓</span>' : ''}</button>`).join('') : `<p class="empty">${choices.length ? '没有符合筛选条件的选项，请更换关键字或机场。' : '暂无可选择的节点，请先导入节点。'}</p>`;
    dialog.querySelector('.choice-count')!.textContent = `第 ${rows.length ? start + 1 : 0}–${end} 条，共 ${rows.length} 条${list.query || list.filter ? `（全部 ${choices.length} 条）` : ''}`;
    dialog.querySelector('.choice-pages')!.innerHTML = `<button type="button" data-choice-page="1" ${list.page === 1 ? 'disabled' : ''}>首页</button><button type="button" data-choice-page="${list.page - 1}" ${list.page === 1 ? 'disabled' : ''}>上一页</button><span>${list.page} / ${pages}</span><button type="button" data-choice-page="${list.page + 1}" ${list.page === pages ? 'disabled' : ''}>下一页</button><button type="button" data-choice-page="${pages}" ${list.page === pages ? 'disabled' : ''}>末页</button>`;
    dialog.querySelector('[data-choice-sort]')!.textContent = `排序：${list.fields[list.options.sort].label}`;
    dialog.querySelector('[data-choice-direction]')!.textContent = list.options.direction === 'asc' ? '正序 ↑' : '逆序 ↓';
    dialog.querySelectorAll<HTMLElement>('[data-choice-size]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.choiceSize) === list.options.size)));
  };
  dialog.addEventListener('input', event => {
    if (event.target !== search) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (!active) return; list.change('query', search.value); paint(); }, 120);
  });
  dialog.addEventListener('change', event => {
    if ((event.target as HTMLElement).matches('.choice-group select')) { list.change('filter', (event.target as HTMLSelectElement).value); paint(); }
  });
  dialog.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-choice-close')) { dialog.close(); return; }
    if (button.hasAttribute('data-choice-value')) {
      if (!select.isConnected) { dialog.close(); return; }
      setSelectValue(select, button.dataset.choiceValue!);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.close(); return;
    }
    if (button.dataset.choicePage) list.page = Number(button.dataset.choicePage);
    if (button.dataset.choiceSize) list.change('size', button.dataset.choiceSize);
    if (button.hasAttribute('data-choice-sort')) list.change('sort', list.options.sort === 'label' ? 'group' : 'label');
    if (button.hasAttribute('data-choice-direction')) list.change('direction', list.options.direction === 'asc' ? 'desc' : 'asc');
    paint();
  });
  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && event.target === search) { event.preventDefault(); results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (event.target as HTMLElement).matches('.choice-row')) {
      event.preventDefault(); const next = event.key === 'ArrowDown' ? (event.target as HTMLElement).nextElementSibling : (event.target as HTMLElement).previousElementSibling;
      (next as HTMLButtonElement | null)?.focus();
    }
  });
  dialog.addEventListener('close', () => { active = false; clearTimeout(timer); dialog.remove(); trigger.setAttribute('aria-expanded', 'false'); (trigger.isConnected ? trigger : document.getElementById(trigger.id))?.focus(); document.dispatchEvent(new CustomEvent('search-select-closed')); }, { once: true });
  document.body.append(dialog); paint(); active = true; trigger.setAttribute('aria-expanded', 'true'); dialog.showModal(); search.focus();
}

export function refreshSearchSelects(root: ParentNode = document) {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select')) {
    if (!buttons.has(select)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'search-select-trigger';
      button.id = `choice-trigger:${select.form?.id || select.closest('[data-list]')?.getAttribute('data-list') || 'app'}:${select.name || select.id || labelOf(select)}`;
      button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
      select.classList.add('search-select-native'); select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
      buttons.set(select, button); select.after(button);
      button.addEventListener('click', () => openSelect(select, button));
      select.addEventListener('change', () => syncSelect(select));
      select.addEventListener('focus', () => button.focus());
      select.addEventListener('invalid', event => { event.preventDefault(); button.focus(); button.setAttribute('aria-invalid', 'true'); });
    }
    syncSelect(select);
  }
}
export function initSearchSelects() {
  refreshSearchSelects();
  document.addEventListener('reset', event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) queueMicrotask(() => refreshSearchSelects(form));
  });
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLSelectElement) syncSelect(record.target);
      else for (const node of record.addedNodes) if (node instanceof HTMLElement) {
        if (node instanceof HTMLSelectElement) refreshSearchSelects(node.parentElement!);
        else if (node.querySelector('select')) refreshSearchSelects(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
}
