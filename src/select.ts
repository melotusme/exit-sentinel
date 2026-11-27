// Scoped Searchable Select Picker: ONLY enhances `<select data-searchable>` (large dynamic node lists).
// Standard 2-8 option `<select>` elements remain fast, native, left-aligned CSS-styled dropdowns.

import { enableLightDismiss, openModal } from './confirm';
import { ListView, escapeHtml as esc } from './list';

export interface Choice {
  value: string;
  label: string;
  detail?: string;
  group?: string;
  disabled?: boolean;
}

const sources = new WeakMap<HTMLSelectElement, Choice[]>();
const buttons = new WeakMap<HTMLSelectElement, HTMLButtonElement>();
let serial = 0;
let observerInitialized = false;

export function setSelectChoices(select: HTMLSelectElement, choices: Choice[], placeholder = '请选择节点…') {
  const value = select.value;
  // Automatically mark dynamic option-list selects as searchable
  if (!select.hasAttribute('data-searchable')) {
    select.setAttribute('data-searchable', '');
  }
  sources.set(select, choices);
  select.replaceChildren(new Option(placeholder, ''));
  const chosen = choices.find(c => c.value === value);
  if (chosen) {
    select.add(new Option(chosen.label, chosen.value, true, true));
  }
  refreshSearchSelects(select.parentElement || document);
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
  return (
    select.getAttribute('aria-label') ||
    select.labels?.[0]?.querySelector('span')?.textContent?.trim() ||
    select.name ||
    '选择选项'
  );
}

function syncSelect(select: HTMLSelectElement) {
  const button = buttons.get(select);
  if (!button) return;
  const choice = sources.get(select)?.find(c => c.value === select.value);
  const text = choice?.label || select.selectedOptions[0]?.textContent || '请选择…';
  if (button.textContent !== text) button.textContent = text;
  button.classList.toggle('is-placeholder', !select.value);
  button.disabled = select.disabled;
  if (select.validity.valid) button.removeAttribute('aria-invalid');
  button.setAttribute('aria-label', `${labelOf(select)}：${text}`);
}

function openSelect(select: HTMLSelectElement, trigger: HTMLButtonElement) {
  if (select.disabled) return;
  const choices: Choice[] = (
    sources.get(select) ||
    Array.from(select.options).map(o => ({ value: o.value, label: o.label, disabled: o.disabled }))
  ).filter(c => c.value !== '');

  const title = labelOf(select);
  const id = `${select.form?.id || 'app'}:${select.name || select.id || title}`;
  const list = new ListView<Choice>(
    `select:${id}`,
    {
      label: { label: '名称', value: r => r.label },
      group: { label: '订阅 / 分组', value: r => r.group || '' },
    },
    r => `${r.label} ${r.detail || ''} ${r.group || ''}`,
    r => r.group || '未分组',
    {},
    { defaultSize: 20 }
  );
  list.options.direction = 'asc';

  const groups = Array.from(new Set(choices.map(c => c.group).filter(Boolean))) as string[];
  const dialog = document.createElement('dialog');
  dialog.className = 'choice-dialog';
  const heading = `choice-title-${++serial}`;
  dialog.setAttribute('aria-labelledby', heading);
  dialog.innerHTML = `
    <header>
      <h2 id="${heading}">${esc(title)}</h2>
      <button type="button" data-choice-close>关闭</button>
    </header>
    <div class="choice-toolbar">
      <label class="choice-search">
        <span>搜索节点或服务器</span>
        <input type="search" autocomplete="off" placeholder="输入节点名称、地区、订阅或域名…">
      </label>
      ${
        groups.length > 1
          ? `<label class="choice-group">
              <span>订阅来源</span>
              <select name="${esc(id)}-provider">
                <option value="">全部来源 (${choices.length})</option>
                ${groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
              </select>
            </label>`
          : ''
      }
    </div>
    <div class="choice-meta-bar">
      <span class="choice-count tabular" role="status" aria-live="polite"></span>
      <div class="choice-order">
        <button type="button" data-choice-sort>按名称</button>
        <button type="button" data-choice-direction>正序 ↑</button>
      </div>
    </div>
    <div class="choice-results"></div>
    <nav class="choice-pages" aria-label="节点分页" hidden></nav>`;

  const results = dialog.querySelector<HTMLElement>('.choice-results')!;
  const search = dialog.querySelector<HTMLInputElement>('input[type="search"]')!;
  const pagesEl = dialog.querySelector<HTMLElement>('.choice-pages')!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = false;

  const paint = () => {
    const { rows, visible, pages, start, end } = list.pageData(choices);
    results.innerHTML = visible.length
      ? visible
          .map(
            c => `<button type="button" class="choice-row" data-choice-value="${esc(c.value)}" ${c.disabled ? 'disabled' : ''} aria-pressed="${select.value === c.value}">
              <strong>${esc(c.label)}</strong>
              ${c.detail || c.group ? `<small>${esc(c.detail || c.group)}</small>` : ''}
              ${select.value === c.value ? '<span class="choice-check" aria-hidden="true">✓</span>' : ''}
            </button>`
          )
          .join('')
      : `<div class="empty"><strong>${choices.length ? '没有匹配的节点' : '暂无可选节点'}</strong><p>${choices.length ? '请尝试缩短关键字或切换订阅来源。' : '请先在“导入与清理”中读取代理节点，或等待实时连接识别。'}</p></div>`;

    dialog.querySelector('.choice-count')!.textContent = rows.length
      ? pages > 1
        ? `显示 ${start + 1}–${end} / 共 ${rows.length} 个`
        : `共 ${rows.length} 个可选节点`
      : '0 个匹配结果';

    pagesEl.hidden = pages <= 1;
    pagesEl.innerHTML =
      pages > 1
        ? `<button type="button" data-choice-page="${list.page - 1}" ${list.page === 1 ? 'disabled' : ''}>上一页</button>
           <span class="tabular">${list.page} / ${pages}</span>
           <button type="button" data-choice-page="${list.page + 1}" ${list.page === pages ? 'disabled' : ''}>下一页</button>`
        : '';

    dialog.querySelector('[data-choice-sort]')!.textContent = `按${list.fields[list.options.sort].label}`;
    dialog.querySelector('[data-choice-direction]')!.textContent =
      list.options.direction === 'asc' ? '正序 ↑' : '逆序 ↓';
  };

  dialog.addEventListener('input', event => {
    if (event.target !== search) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!active) return;
      list.change('query', search.value);
      paint();
    }, 90);
  });

  dialog.addEventListener('change', event => {
    if ((event.target as HTMLElement).matches('.choice-group select')) {
      list.change('filter', (event.target as HTMLSelectElement).value);
      paint();
    }
  });

  dialog.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-choice-close')) {
      dialog.close();
      return;
    }
    if (button.hasAttribute('data-choice-value')) {
      if (select.isConnected) {
        setSelectValue(select, button.dataset.choiceValue!);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      dialog.close();
      return;
    }
    if (button.dataset.choicePage) list.page = Number(button.dataset.choicePage);
    if (button.hasAttribute('data-choice-sort')) {
      list.change('sort', list.options.sort === 'label' ? 'group' : 'label');
    }
    if (button.hasAttribute('data-choice-direction')) {
      list.change('direction', list.options.direction === 'asc' ? 'desc' : 'asc');
    }
    paint();
  });

  dialog.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && event.target === search) {
      event.preventDefault();
      results.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (event.target as HTMLElement).matches('.choice-row')) {
      event.preventDefault();
      const next =
        event.key === 'ArrowDown'
          ? (event.target as HTMLElement).nextElementSibling
          : (event.target as HTMLElement).previousElementSibling;
      (next as HTMLButtonElement | null)?.focus();
    }
  });

  enableLightDismiss(dialog, () => {
    active = false;
    clearTimeout(timer);
    dialog.remove();
    trigger.setAttribute('aria-expanded', 'false');
    document.dispatchEvent(new CustomEvent('search-select-closed'));
  });

  document.body.append(dialog);
  paint();
  active = true;
  trigger.setAttribute('aria-expanded', 'true');
  openModal(dialog, trigger);
  search.focus();
}

export function refreshSearchSelects(root: ParentNode = document) {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select[data-searchable]')) {
    if (!buttons.has(select)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-select-trigger';
      button.id = `choice-trigger:${select.form?.id || 'app'}:${select.name || select.id || labelOf(select)}`;
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      select.classList.add('search-select-native');
      select.tabIndex = -1;
      select.setAttribute('aria-hidden', 'true');
      buttons.set(select, button);
      select.after(button);
      button.addEventListener('click', () => openSelect(select, button));
      select.addEventListener('change', () => syncSelect(select));
      select.addEventListener('focus', () => button.focus());
      select.addEventListener('invalid', event => {
        event.preventDefault();
        button.focus();
        button.setAttribute('aria-invalid', 'true');
      });
    }
    syncSelect(select);
  }
}

export function initSearchSelects() {
  refreshSearchSelects();
  if (observerInitialized) return;
  observerInitialized = true;

  document.addEventListener('reset', event => {
    const form = event.target;
    if (form instanceof HTMLFormElement) queueMicrotask(() => refreshSearchSelects(form));
  });

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLSelectElement) {
        if (record.target.hasAttribute('data-searchable')) syncSelect(record.target);
      } else {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node instanceof HTMLSelectElement && node.hasAttribute('data-searchable') && node.parentElement) {
              refreshSearchSelects(node.parentElement);
            } else if (node.querySelector('select[data-searchable]')) {
              refreshSearchSelects(node);
            }
          }
        }
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'data-searchable'],
  });
}
