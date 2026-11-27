// Compact, self-managing ListView with single-row left-aligned toolbar and auto-hidden single-page footer.

export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface SavedOptions {
  size: number;
  sort: string;
  direction: 'asc' | 'desc';
}

export interface ListViewConfig {
  defaultSize?: 10 | 20 | 50 | 100;
  searchPlaceholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  /** Optional quick-filter pill map rendered inline instead of or alongside the filter dropdown. */
  pillFilters?: Record<string, string>;
  hideToolbar?: boolean;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

interface ActiveBinding {
  list: ListView<any>;
  records: any[];
  row: (r: any) => string;
}

const activeLists = new Map<string, ActiveBinding>();
let listenersBound = false;

export class ListView<T> {
  query = '';
  filter = '';
  page = 1;
  options: SavedOptions;

  constructor(
    readonly id: string,
    readonly fields: Record<string, { label: string; value: (r: T) => string }>,
    readonly text: (r: T) => string,
    readonly category: (r: T) => string,
    readonly filters: Record<string, string> = {},
    readonly config: ListViewConfig = {}
  ) {
    const defaults: SavedOptions = {
      size: config.defaultSize || 20,
      sort: Object.keys(fields)[0],
      direction: 'desc',
    };
    try {
      const saved = JSON.parse(localStorage.getItem(`sentinel.list.${id}`) || 'null');
      this.options =
        saved &&
        [10, 20, 50, 100].includes(saved.size) &&
        fields[saved.sort] &&
        ['asc', 'desc'].includes(saved.direction)
          ? saved
          : defaults;
    } catch {
      this.options = defaults;
    }
  }

  save() {
    try {
      localStorage.setItem(`sentinel.list.${this.id}`, JSON.stringify(this.options));
    } catch {}
  }

  pageData(records: T[]) {
    const terms = this.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const rows = records.filter(r => {
      if (this.filter && this.category(r) !== this.filter) return false;
      if (!terms.length) return true;
      const hay = this.text(r).toLocaleLowerCase();
      return terms.every(term => hay.includes(term));
    });
    const sortField = this.fields[this.options.sort] || Object.values(this.fields)[0];
    if (sortField) {
      rows.sort(
        (a, b) =>
          collator.compare(sortField.value(a), sortField.value(b)) *
          (this.options.direction === 'asc' ? 1 : -1)
      );
    }
    const pages = Math.max(1, Math.ceil(rows.length / this.options.size));
    this.page = Math.max(1, Math.min(this.page, pages));
    const start = (this.page - 1) * this.options.size;
    const end = Math.min(rows.length, start + this.options.size);
    return { rows, visible: rows.slice(start, end), pages, start, end };
  }

  renderBodyAndFooter(records: T[], row: (r: T) => string) {
    const e = escapeHtml;
    const { rows, visible, pages, start, end } = this.pageData(records);
    const isFiltered = Boolean(this.query.trim() || this.filter);
    const showPagination = rows.length > this.options.size || pages > 1;
    const showCompactMeta = !showPagination && isFiltered && rows.length > 0;
    const arrow = this.options.direction === 'asc' ? '↑' : '↓';
    const sortLabel = this.fields[this.options.sort]?.label || '';

    const rowsHtml = `<div class="list-rows">
      ${
        rows.length
          ? visible.map(row).join('')
          : `<div class="empty">
              <div class="empty-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              </div>
              <strong>${e(isFiltered && records.length ? '没有匹配的记录' : this.config.emptyTitle || '暂无记录')}</strong>
              <p>${e(
                isFiltered && records.length
                  ? `未找到符合当前筛选条件的内容（共 ${records.length} 条记录）。`
                  : this.config.emptyHint || '等待检测结果生成，或手动添加新记录。'
              )}</p>
              ${isFiltered && records.length ? '<button type="button" data-list-clear>清空筛选条件</button>' : ''}
            </div>`
      }
    </div>`;

    const footerHtml = showPagination
      ? `<div class="list-footer">
          <div class="list-meta tabular">
            <span>显示 <strong>${start + 1}–${end}</strong> / 共 <strong>${rows.length}</strong> 条${isFiltered ? `（总计 ${records.length} 条）` : ''}</span>
            ${sortLabel ? `<span>· ${e(sortLabel)} ${arrow}</span>` : ''}
          </div>
          <div class="list-pagination">
            <label class="page-size-label">
              <span>每页</span>
              <select name="${e(this.id)}-size" data-list-action="size" aria-label="每页条数">
                ${[10, 20, 50, 100].map(n => `<option value="${n}" ${n === this.options.size ? 'selected' : ''}>${n} 条</option>`).join('')}
              </select>
            </label>
            <div class="page-buttons">
              <button type="button" data-list-page="${this.page - 1}" ${this.page === 1 ? 'disabled' : ''}>上一页</button>
              <span class="page-indicator">${this.page} / ${pages}</span>
              <button type="button" data-list-page="${this.page + 1}" ${this.page === pages ? 'disabled' : ''}>下一页</button>
            </div>
          </div>
        </div>`
      : showCompactMeta
        ? `<div class="list-footer">
            <div class="list-meta tabular"><span>筛选出 <strong>${rows.length}</strong> / ${records.length} 条</span></div>
            <button type="button" class="text-button compact" data-list-clear>重置筛选</button>
          </div>`
        : `<div class="list-footer" hidden></div>`;

    return { rowsHtml, footerHtml };
  }

  render(records: T[], row: (r: T) => string) {
    activeLists.set(this.id, { list: this, records, row });
    const e = escapeHtml;
    const { rowsHtml, footerHtml } = this.renderBodyAndFooter(records, row);
    const hasFilterSelect = Object.keys(this.filters).length > 0 && !this.config.pillFilters;
    const hasPills = Boolean(this.config.pillFilters && Object.keys(this.config.pillFilters).length);
    const sortEntries = Object.entries(this.fields);
    const dirArrow = this.options.direction === 'asc' ? '正序 ↑' : '逆序 ↓';

    const toolbarHtml = this.config.hideToolbar
      ? ''
      : `<div class="list-tools">
          <div class="list-search">
            <div class="input-with-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
              <input name="${e(this.id)}-query" type="search" autocomplete="off" data-list-action="query" aria-label="搜索记录" value="${e(this.query)}" placeholder="${e(this.config.searchPlaceholder || '搜索 IP、节点、备注…')}">
            </div>
          </div>
          ${
            hasPills
              ? `<div class="list-pills" role="group" aria-label="分类筛选">
                  <button type="button" class="list-pill-btn" data-list-pill="" aria-pressed="${this.filter === ''}">全部</button>
                  ${Object.entries(this.config.pillFilters!)
                    .map(
                      ([k, label]) =>
                        `<button type="button" class="list-pill-btn" data-list-pill="${e(k)}" aria-pressed="${this.filter === k}">${e(label)}</button>`
                    )
                    .join('')}
                </div>`
              : ''
          }
          <div class="list-controls-group">
            ${
              hasFilterSelect
                ? `<div class="list-control">
                    <select name="${e(this.id)}-filter" data-list-action="filter" aria-label="按状态或类型筛选">
                      <option value="">全部类型</option>
                      ${Object.entries(this.filters)
                        .map(([k, v]) => `<option value="${e(k)}" ${this.filter === k ? 'selected' : ''}>${e(v)}</option>`)
                        .join('')}
                    </select>
                  </div>`
                : ''
            }
            ${
              sortEntries.length > 1
                ? `<div class="list-control">
                    <select name="${e(this.id)}-sort" data-list-action="sort" aria-label="排序字段">
                      ${sortEntries
                        .map(([k, v]) => `<option value="${e(k)}" ${this.options.sort === k ? 'selected' : ''}>按${e(v.label)}</option>`)
                        .join('')}
                    </select>
                  </div>`
                : ''
            }
            <button type="button" class="list-dir-btn" data-list-toggle-dir title="切换排序方向" aria-label="排序方向：${dirArrow}">${dirArrow}</button>
          </div>
        </div>`;

    return `<section class="list-view" data-list="${e(this.id)}">
      ${toolbarHtml}
      ${rowsHtml}
      ${footerHtml}
    </section>`;
  }

  change(action: string, value: string) {
    this.page = 1;
    if (action === 'query') this.query = value;
    else if (action === 'filter') this.filter = value;
    else if (action === 'size') this.options.size = Number(value);
    else if (action === 'sort') this.options.sort = value;
    else if (action === 'direction') this.options.direction = value as 'asc' | 'desc';
    this.save();
  }
}

function repaintListDom(root: HTMLElement, binding: ActiveBinding, syncToolbar = false) {
  const { list, records, row } = binding;
  if (syncToolbar) {
    const queryInput = root.querySelector<HTMLInputElement>('[data-list-action="query"]');
    if (queryInput && queryInput.value !== list.query) queryInput.value = list.query;
    const filterSelect = root.querySelector<HTMLSelectElement>('[data-list-action="filter"]');
    if (filterSelect) filterSelect.value = list.filter;
    root.querySelectorAll<HTMLButtonElement>('[data-list-pill]').forEach(btn => {
      btn.setAttribute('aria-pressed', String((btn.dataset.listPill || '') === list.filter));
    });
    const dirBtn = root.querySelector<HTMLButtonElement>('[data-list-toggle-dir]');
    if (dirBtn) {
      const label = list.options.direction === 'asc' ? '正序 ↑' : '逆序 ↓';
      dirBtn.textContent = label;
      dirBtn.setAttribute('aria-label', `排序方向：${label}`);
    }
  }
  const { rowsHtml, footerHtml } = list.renderBodyAndFooter(records, row);
  const scratch = document.createElement('div');
  scratch.innerHTML = rowsHtml + footerHtml;
  const nextRows = scratch.querySelector('.list-rows');
  const nextFooter = scratch.querySelector('.list-footer');
  if (nextRows) root.querySelector('.list-rows')?.replaceWith(nextRows);
  if (nextFooter) root.querySelector('.list-footer')?.replaceWith(nextFooter);
}

/** Delegate search, filter, sort, direction, clear, and page controls for every mounted ListView. */
export function initListViews() {
  if (listenersBound) return;
  listenersBound = true;

  const onQueryInput = (event: globalThis.Event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset?.listAction !== 'query') return;
    const root = input.closest<HTMLElement>('[data-list]');
    const binding = root?.dataset.list ? activeLists.get(root.dataset.list) : undefined;
    if (!root || !binding) return;
    binding.list.change('query', input.value);
    repaintListDom(root, binding, false);
  };

  document.addEventListener('input', event => {
    if ((event.target as HTMLElement)?.dataset?.listAction === 'query' && !(event as InputEvent).isComposing) {
      onQueryInput(event);
    }
  });

  document.addEventListener('compositionend', event => {
    if ((event.target as HTMLElement)?.dataset?.listAction === 'query') {
      onQueryInput(event);
    }
  });

  document.addEventListener('change', event => {
    const el = event.target as HTMLSelectElement | HTMLInputElement;
    const action = el.dataset?.listAction;
    if (!action || action === 'query') return;
    const root = el.closest<HTMLElement>('[data-list]');
    const binding = root?.dataset.list ? activeLists.get(root.dataset.list) : undefined;
    if (!root || !binding) return;
    binding.list.change(action, el.value);
    repaintListDom(root, binding, false);
  });

  document.addEventListener('click', event => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-list-page], [data-list-pill], [data-list-toggle-dir], [data-list-clear]'
    );
    if (!btn || btn.disabled) return;
    const root = btn.closest<HTMLElement>('[data-list]');
    const binding = root?.dataset.list ? activeLists.get(root.dataset.list) : undefined;
    if (!root || !binding) return;

    if (btn.dataset.listPage) {
      binding.list.page = Number(btn.dataset.listPage);
      repaintListDom(root, binding, false);
      root.querySelector<HTMLButtonElement>('[data-list-page]:not(:disabled)')?.focus({ preventScroll: true });
    } else if (btn.hasAttribute('data-list-pill')) {
      binding.list.change('filter', btn.dataset.listPill || '');
      repaintListDom(root, binding, true);
    } else if (btn.hasAttribute('data-list-toggle-dir')) {
      binding.list.change('direction', binding.list.options.direction === 'asc' ? 'desc' : 'asc');
      repaintListDom(root, binding, true);
    } else if (btn.hasAttribute('data-list-clear')) {
      binding.list.query = '';
      binding.list.filter = '';
      binding.list.page = 1;
      repaintListDom(root, binding, true);
      root.querySelector<HTMLInputElement>('[data-list-action="query"]')?.focus({ preventScroll: true });
    }
  });
}
