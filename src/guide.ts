// Usage notes shown at the bottom of the settings page.
export function renderGuide(): string {
  return `<details class="panel prose guide-panel">
    <summary>使用说明与隐私</summary>
    <h3>判定怎么来的</h3>
    <p>每个服务的结论只来自你登记的状态：当前出口 IP 和当前节点任一标为“风险”就显示有风险；IP 标为“可用”显示可以使用；没有 IP 时以节点状态为准。主页能打开（HTTP 200）不代表账号可用，403 / 429 也不代表账号被封。</p>
    <h3>出口 IP 与节点</h3>
    <p>Claude 的出口 IP 是本应用经同一路径访问 claude.ai 看到的地址，Claude 桌面版、网页版和 Claude Code 通常走同一分流，但不保证。Gemini 另外读取 Google 自己的判定：gemini.google.com 页面里带有 Google 给这次请求判定的地区，判成中国（或香港 / 澳门）时直接显示有风险。Gemini 的出口 IP 来自 Google STUN 服务器回显（UDP，同样经过 google.com 分流）；回显成国内出口说明 UDP 没走代理，此时不采用。Antigravity 等工具若走 googleapis.com，需确认它和 gemini.google.com 命中同一条分流规则。</p>
    <p>节点来自代理软件的最近连接记录或当前配置。同一个节点在 Shadowrocket、Clash Verge、Karing 等之间按“名称 + 服务器地址”识别，导入后标记的状态会用于当前判定。</p>
    <h3>菜单栏图标</h3>
    <p>绿色圆环：出口一致；绿色双点：多个出口；黄色三角：检测异常或有变化待确认；红色叉：全部检测站不可达；灰色双竖线：已暂停。关闭窗口后仍在后台监控，退出请在菜单栏选择“退出出口哨兵”。</p>
    <h3>数据去哪里</h3>
    <p>检测站和 claude.ai 能看到请求来源 IP。查询 IP 位置时发送到 ipwho.is，附近地点查询发送粗略坐标到 OpenStreetMap Nominatim。记录只保存在本机；没有遥测，不读取 Claude 登录信息，不修改代理规则。</p>
    <div class="form-actions">
      <button type="button" data-url="https://support.claude.com/en/articles/8461763-where-can-i-access-claude">Claude 支持地区 ↗</button>
      <button type="button" data-url="https://support.claude.com/en/articles/8241253-safeguards-warnings-and-appeals">Claude 申诉说明 ↗</button>
    </div>
  </details>`;
}
