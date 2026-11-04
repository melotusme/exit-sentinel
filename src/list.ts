export const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

interface Options {
  size: number;
  sort: string;
  direction: 'asc' | 'desc';
}
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export class ListView<T> {
  query = '';
  filter = '';
  page = 1;
  options: Options;

  constructor(
    readonly id: string,
    readonly fields: Record<string, { label: string; value: (r: T) => string }>,
    readonly text: (r: T) => string,
    readonly category: (r: T) => string,
    readonly filters: Record<string, string> = {}
  ) {
    const defaults: Options = { size: 20, sort: Object.keys(fields)[0], direction: 'desc' };
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
    const rows = records.filter(
      r => {
        if (this.filter && this.category(r) !== this.filter) return false;
        const text = this.text(r).toLocaleLowerCase();
        return terms.every(term => text.includes(term));
      }
    );
    rows.sort(
      (a, b) =>
        collator.compare(this.fields[this.options.sort].value(a), this.fields[this.options.sort].value(b)) *
        (this.options.direction === 'asc' ? 1 : -1)
    );
    const pages = Math.max(1, Math.ceil(rows.length / this.options.size));
    this.page = Math.max(1, Math.min(this.page, pages));
    const start = (this.page - 1) * this.options.size;
    const end = Math.min(rows.length, start + this.options.size);
    return { rows, visible: rows.slice(start, end), pages, start, end };
  }

  render(records: T[], row: (r: T) => string) {
    const e = escapeHtml;
    const { rows, visible, pages, start, end } = this.pageData(records);
    const sortLabel = this.fields[this.options.sort]?.label || '';
    const arrow = this.options.direction === 'asc' ? '↑' : '↓';

    return `<section class="list-view" data-list="${e(this.id)}">
      <div class="list-tools">
        <label class="list-search">
          <span>关键字筛选</span>
          <div class="input-with-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input name="${this.id}-query" type="search" autocomplete="off" data-list-action="query" aria-label="关键字筛选" value="${e(this.query)}" placeholder="搜索 IP、节点、备注或内容…">
          </div>
        </label>
        ${
          Object.keys(this.filters).length
            ? `<label class="list-control">
                <span>状态 / 类型</span>
                <select name="${this.id}-filter" data-list-action="filter">
                  <option value="">全部</option>
                  ${Object.entries(this.filters)
                    .map(([k, v]) => `<option value="${e(k)}" ${this.filter === k ? 'selected' : ''}>${e(v)}</option>`)
                    .join('')}
                </select>
              </label>`
            : ''
        }
        <label class="list-control">
          <span>排序字段</span>
          <select name="${this.id}-sort" data-list-action="sort">
            ${Object.entries(this.fields)
              .map(([k, v]) => `<option value="${e(k)}" ${this.options.sort === k ? 'selected' : ''}>${e(v.label)}</option>`)
              .join('')}
          </select>
        </label>
        <label class="list-control">
          <span>排序方向</span>
          <select name="${this.id}-direction" data-list-action="direction">
            <option value="asc" ${this.options.direction === 'asc' ? 'selected' : ''}>正序 ↑</option>
            <option value="desc" ${this.options.direction === 'desc' ? 'selected' : ''}>逆序 ↓</option>
          </select>
        </label>
      </div>
      <div class="list-rows">
        ${
          rows.length
            ? visible.map(row).join('')
            : `<div class="empty">
                <div class="empty-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
                </div>
                <strong>${records.length ? '没有符合筛选条件的记录' : '暂无记录'}</strong>
                <p>${records.length ? '请尝试清空关键字或切换状态筛选条件。' : '请添加记录或等待监控结果生成。'}</p>
              </div>`
        }
      </div>
      <div class="list-footer">
        <div class="list-meta">
          <span>第 <strong>${rows.length ? start + 1 : 0}–${end}</strong> 条，共 <strong>${rows.length}</strong> 条</span>
          <span class="sort-indicator" title="当前排序">${e(sortLabel)} ${arrow}</span>
        </div>
        <div class="list-pagination">
          <label class="page-size-label">
            <span>每页</span>
            <select name="${this.id}-size" data-list-action="size">
              ${[10, 20, 50, 100].map(n => `<option value="${n}" ${n === this.options.size ? 'selected' : ''}>${n} 条</option>`).join('')}
            </select>
          </label>
          <div class="page-buttons">
            <button type="button" data-list-page="1" ${this.page === 1 ? 'disabled' : ''}>首页</button>
            <button type="button" data-list-page="${this.page - 1}" ${this.page === 1 ? 'disabled' : ''}>上一页</button>
            <span class="page-indicator">${this.page} / ${pages}</span>
            <button type="button" data-list-page="${this.page + 1}" ${this.page === pages ? 'disabled' : ''}>下一页</button>
            <button type="button" data-list-page="${pages}" ${this.page === pages ? 'disabled' : ''}>末页</button>
          </div>
        </div>
      </div>
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
