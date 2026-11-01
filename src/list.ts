export const escapeHtml=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
interface Options {size:number;sort:string;direction:'asc'|'desc'}
export class ListView<T> {
  query=''; filter=''; page=1; options:Options;
  constructor(readonly id:string, readonly fields:Record<string,{label:string;value:(r:T)=>string}>, readonly text:(r:T)=>string, readonly category:(r:T)=>string, readonly filters:Record<string,string>={}) {
    const defaults:Options={size:20,sort:Object.keys(fields)[0],direction:'desc'};
    try { const saved=JSON.parse(localStorage.getItem(`sentinel.list.${id}`)||'null');
      this.options=saved&&[10,20,50,100].includes(saved.size)&&fields[saved.sort]&&['asc','desc'].includes(saved.direction)?saved:defaults;
    } catch { this.options=defaults; }
  }
  save(){try{localStorage.setItem(`sentinel.list.${this.id}`,JSON.stringify(this.options))}catch{}}
  render(records:T[],row:(r:T)=>string){const e=escapeHtml;
    const rows=records.filter(r=>this.text(r).toLowerCase().includes(this.query.toLowerCase())&&(!this.filter||this.category(r)===this.filter));
    rows.sort((a,b)=>this.fields[this.options.sort].value(a).localeCompare(this.fields[this.options.sort].value(b),'zh-CN',{numeric:true})*(this.options.direction==='asc'?1:-1));
    const pages=Math.max(1,Math.ceil(rows.length/this.options.size));this.page=Math.max(1,Math.min(this.page,pages));
    const start=(this.page-1)*this.options.size,end=Math.min(rows.length,start+this.options.size);
    return `<section class="list-view" data-list="${e(this.id)}"><div class="list-tools"><label>关键字<input data-list-action="query" aria-label="关键字筛选" value="${e(this.query)}" placeholder="搜索 IP、备注或内容"></label>${Object.keys(this.filters).length?`<label>状态 / 类型<select data-list-action="filter"><option value="">全部</option>${Object.entries(this.filters).map(([k,v])=>`<option value="${e(k)}" ${this.filter===k?'selected':''}>${e(v)}</option>`).join('')}</select></label>`:''}<label>排序字段<select data-list-action="sort">${Object.entries(this.fields).map(([k,v])=>`<option value="${e(k)}" ${this.options.sort===k?'selected':''}>${e(v.label)}</option>`).join('')}</select></label><label>排序方向<select data-list-action="direction"><option value="asc" ${this.options.direction==='asc'?'selected':''}>正序 ↑</option><option value="desc" ${this.options.direction==='desc'?'selected':''}>逆序 ↓</option></select></label></div><div class="list-rows">${rows.length?rows.slice(start,end).map(row).join(''):`<div class="empty">${records.length?'没有符合筛选条件的记录':'暂无记录，请添加或等待监控结果。'}</div>`}</div><div class="list-footer"><span>第 ${rows.length?start+1:0}–${end} 条，共 ${rows.length} 条</span><label>每页<select data-list-action="size">${[10,20,50,100].map(n=>`<option ${n===this.options.size?'selected':''}>${n}</option>`).join('')}</select></label><button data-list-page="1" ${this.page===1?'disabled':''}>首页</button><button data-list-page="${this.page-1}" ${this.page===1?'disabled':''}>上一页</button><span>${this.page} / ${pages}</span><button data-list-page="${this.page+1}" ${this.page===pages?'disabled':''}>下一页</button><button data-list-page="${pages}" ${this.page===pages?'disabled':''}>末页</button></div></section>`;
  }
  change(action:string,value:string){this.page=1;if(action==='query')this.query=value;else if(action==='filter')this.filter=value;else if(action==='size')this.options.size=Number(value);else if(action==='sort')this.options.sort=value;else if(action==='direction')this.options.direction=value as 'asc'|'desc';this.save();}
}
