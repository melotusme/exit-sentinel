# 出口哨兵 · Exit Sentinel

macOS 菜单栏应用，基于 Tauri 2。分别观测国内、国外及 AI 服务出口，记录网络变化并发送本机通知。

## 功能

- 国内 / 国外检测站独立监控；IPv6 可选。
- IP 位置、ASN、运营商及保守网络类型参考，地理信息本地缓存。
- 美国出口显示是否为无州级销售税州；阿拉斯加额外提示地方销售税。参见 [销售税规则](docs/SALES-TAX.md)。
- Claude / Gemini 分别记录路径、IP、Shadowrocket 配置推断及人工可用状态。
- 网站 curl 诊断：状态码、阶段耗时、原始请求与响应，支持复制。
- 列表支持筛选、排序、分页和独立偏好记忆。
- 菜单栏 / 设置页开机自启开关；关闭窗口后后台运行。
- GitHub 自动检查更新，下载验证签名后安装并重启；可关闭自动检查。

## 开发

需要 Node.js 22+、Rust stable 和 Xcode Command Line Tools。

```sh
npm ci
npm run build
npm test
npm run tauri -- dev
```

本机构建脚本绕过失效的全局 Cargo 镜像配置，不修改全局设置。正式更新包需要本机外置签名私钥或 CI Secret：参见 [发布说明](docs/RELEASING.md)。

## 隐私

无遥测，不读取 Claude 登录凭据，不修改代理规则。出口检测服务能看到请求来源 IP；无缓存时向 ipwho.is 查询出口地理信息；查看附近公开地点时向 Nominatim 发送粗略坐标。更新检查访问 GitHub，不发送本地监控记录。

设置、IP 和节点记录保存在 `~/Library/Application Support/local.mhzrm.exit-sentinel/settings.json`，权限 0600。该目录不打包、不提交。Shadowrocket 读取只保留节点身份和路由元数据，不导出密码、密钥或订阅链接。

当前应用使用 ad-hoc 签名，尚未做 Apple Developer ID 签名与公证；其他 Mac 的首次安装可能需要在系统设置允许打开。更新包签名独立于 Apple 签名。

[安全检查范围与结果](docs/SECURITY-REVIEW.md)
