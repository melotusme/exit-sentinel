// Concise 3-card FAQ & privacy reference shown under Settings -> 更新与关于.

import { icon } from './ui';

export function renderGuide(): string {
  return `<section class="guide-section" id="guide-accordion" aria-labelledby="guide-heading">
    <div class="guide-section-head">
      <div>
        <h2 id="guide-heading">使用说明与常见问题</h2>
        <p class="small muted">了解安全判定优先级、系统托盘状态含义与本机隐私边界</p>
      </div>
      <button type="button" class="ghost-btn" id="toggle-all-guides" aria-expanded="false">展开全部</button>
    </div>

    <div class="guide-cards">
      <details class="panel guide-card">
        <summary>
          <span class="guide-summary-title">Claude 与 Gemini 安全判定规则</span>
          <span class="guide-summary-sub">IP 与节点人工标记优先级 · Google 地区校验 · STUN 回显</span>
        </summary>
        <div class="guide-card-body">
          <ul class="guide-list">
            <li>
              <strong>判定优先级</strong>：结论严格依据你登记的信任状态——当前出口 IP 或代理节点任一标为<strong>风险</strong>即提示“有风险”；出口 IP 标为<strong>可用</strong>即显示“可以使用”；暂无 IP 时参考节点标记。
            </li>
            <li>
              <strong>Claude 出口与连通性</strong>：通过与浏览器相同的分流路径访问 <code class="mono">claude.ai</code> 观测出口 IP。网页返回 <code class="mono tabular">HTTP 200</code> 仅代表网络可达，不等同于账号安全；遇到 <code class="mono tabular">403 / 429</code> 也不代表账号被封禁。
            </li>
            <li>
              <strong>Gemini 地区与 UDP 回显</strong>：自动解析 <code class="mono">gemini.google.com</code> 页面内 Google 判定的服务地区（判为中国大陆、香港或澳门时直接标为风险），并通过 Google STUN（UDP）回显公网出口。若代理未转发 UDP 导致回显为国内 IP，会自动忽略该回显；也可在“代理与分流 → 高级”中配置 HTTPS 参考回显地址。
            </li>
            <li>
              <strong>跨客户端节点识别</strong>：按“节点名称 + 服务器地址”生成统一指纹，在 Clash Verge、Shadowrocket、Karing 等客户端之间共享信任状态。
            </li>
          </ul>
          <div class="form-actions guide-links">
            <button type="button" data-url="https://support.claude.com/en/articles/8461763-where-can-i-access-claude">
              <span>Claude 官方支持地区</span>${icon('external')}
            </button>
            <button type="button" data-url="https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals">
              <span>Claude 账号申诉说明</span>${icon('external')}
            </button>
          </div>
        </div>
      </details>

      <details class="panel guide-card">
        <summary>
          <span class="guide-summary-title">系统托盘图标与分流状态说明</span>
          <span class="guide-summary-sub">5 种托盘图标颜色形态 · 后台驻留与彻底退出方式</span>
        </summary>
        <div class="guide-card-body">
          <ul class="tray-legend-list">
            <li>
              <span class="pill ok"><span class="dot green"></span>绿色双点</span>
              <span><strong>国内外分流正常</strong>：国内与国外出口正常分流，AI 服务出口无风险且无未确认变化。</span>
            </li>
            <li>
              <span class="pill ok"><span class="dot green"></span>绿色圆环</span>
              <span><strong>各站出口一致</strong>：所有核心检测站连通正常并返回同一公网出口（如全局代理或纯直连环境）。</span>
            </li>
            <li>
              <span class="pill warn"><span class="dot amber"></span>黄色三角</span>
              <span><strong>待确认或部分异常</strong>：发现出口 IP / 节点变化尚未确认，或部分非忽略检测项连接失败。</span>
            </li>
            <li>
              <span class="pill risk"><span class="dot red"></span>红色叉号</span>
              <span><strong>存在风险或全部离线</strong>：Claude / Gemini 当前命中已标为“风险”的出口，或全部检测站均不可达。</span>
            </li>
            <li>
              <span class="pill"><span class="dot muted-dot"></span>灰色双竖线</span>
              <span><strong>监控已暂停</strong>：暂停期间不轮询出口也不记录变化。关闭主窗口仍在托盘后台运行，彻底退出请在托盘菜单点击“退出出口哨兵”。</span>
            </li>
          </ul>
        </div>
      </details>

      <details class="panel guide-card">
        <summary>
          <span class="guide-summary-title">本地配置文件与隐私安全说明</span>
          <span class="guide-summary-sub">纯本机存储 · 系统凭据库加密 · 零遥测与只读代理原则</span>
        </summary>
        <div class="guide-card-body">
          <ul class="guide-list">
            <li>
              <strong>本地存储与凭据隔离</strong>：偏好设置、IP 与节点信任库、地理缓存及最近 <span class="tabular">200</span> 条历史记录均保存在本机应用数据目录（<code class="mono">settings.json</code> 与 <code class="mono">webdav.json</code>）。WebDAV 应用密码仅存入操作系统凭据库（Windows 凭据管理器 / macOS 钥匙串 / Linux Keyring），绝不写入同步文件。
            </li>
            <li>
              <strong>零遥测与只读原则</strong>：不包含任何统计遥测，不读取浏览器或客户端登录态，也绝不修改 Clash Verge、Shadowrocket 等代理软件的配置文件与分流规则。
            </li>
            <li>
              <strong>外部网络请求范围</strong>：除按周期请求 <span class="tabular">6</span> 个出口检测站及 <code class="mono">claude.ai</code> / <code class="mono">gemini.google.com</code> 外，仅在查询 IP 归属时访问 <code class="mono">ipwho.is</code>，在展开附近参考地点时向 OpenStreetMap Nominatim 发送保留三位小数的粗略坐标。
            </li>
          </ul>
        </div>
      </details>
    </div>
  </section>`;
}
