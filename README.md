# 出口哨兵 · Exit Sentinel

macOS 菜单栏 / Windows 托盘应用，基于 Tauri 2。分别观测国内、国外及 AI 服务出口，记录网络变化并发送本机通知。

## 功能

- 国内 / 国外检测站独立监控；IPv6 可选。
- IP 位置、ASN、运营商及保守网络类型参考，地理信息本地缓存。
- 美国出口显示是否为无州级销售税州；阿拉斯加额外提示地方销售税。参见 [销售税规则](docs/SALES-TAX.md)。
- Claude / Gemini 分别记录路径、IP、代理节点快照（macOS Shadowrocket / Windows Clash Verge Rev）及人工可用状态。
- 网站 curl 诊断：状态码、阶段耗时、原始请求与响应，支持复制。
- 列表支持筛选、排序、分页和独立偏好记忆。
- 菜单栏 / 设置页开机自启开关；关闭窗口后后台运行。
- GitHub 私有仓库自动检查更新，下载验证签名后安装并重启；可关闭自动检查。

## 安装

### Windows x64

从[私有 Release](https://github.com/melotusme/exit-sentinel-releases/releases/latest)下载 `Exit.Sentinel.windows.x64.exe`，安装后使用托盘图标。Windows 使用 Clash Verge Rev / Mihomo，不安装或调用 Shadowrocket、Python。首次启动如检测到 Clash Verge，将国外 / Claude / Gemini 检测代理预填为实际 mixed-port；国内代理保持独立，可在设置更改。支持 HTTP 控制器和 Windows 本机命名管道；默认读取 `%APPDATA%/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml`。

### Homebrew（Apple Silicon macOS）

```sh
brew install gh
gh auth login
gh auth setup-git
brew tap melotusme/exit-sentinel https://github.com/melotusme/homebrew-exit-sentinel.git
brew install --cask melotusme/exit-sentinel/exit-sentinel
```

GitHub 账号须可读三个私有仓库：源码、发布仓库和 tap。tap 通过本机 `gh` 下载，SHA-256 校验后安装，不把访问令牌写入 cask。升级使用 `brew update` 和 `brew upgrade --cask melotusme/exit-sentinel/exit-sentinel`，或应用内检查更新。

## WebDAV / 坚果云

设置 → WebDAV 配置同步：默认坚果云目录 `https://dav.jianguoyun.com/dav/`，填写账号和第三方应用密码，或点击“从本机 Clash Verge 导入”。自动创建 `ExitSentinel/` 子目录，专用文件 `exit-sentinel-v1.json` 不与 Clash Verge 备份混用。

连接保存到本机 `webdav.json`；应用密码存 macOS 钥匙串 / Windows 凭据管理器，读取时不返回界面。每台电脑分别配置凭据。

- 首台：保存连接 → 测试连接 → 上传本机配置。
- 其他设备：保存连接 → 下载并应用。下载前备份本机完整配置。
- 冲突时先下载核对；上传前发现云端变化会拒绝操作，上传前的旧云端版本保存为 backup 文件；坚果云不保证条件写入原子性，避免两台设备同时上传。同步为手动操作，不在后台覆盖。
- 同步检测偏好、AI 服务 IP / 节点与人工状态；本机代理、历史、缓存、开机自启独立保留。macOS 的 Shadowrocket 节点也可作为历史记录同步到 Windows，当前节点仍读取本机客户端。
- 云端 JSON 包含 IP、节点名称、备注；无端到端加密，请使用私有 WebDAV 目录。

## 开发

需要 Node.js 22+、Rust stable。macOS 需要 Xcode Command Line Tools；Windows 需要 Visual Studio C++ Build Tools 和 WebView2。

```sh
npm ci
npm run build
npm test
npm run tauri -- dev
```

本机构建脚本绕过失效的全局 Cargo 镜像配置，不修改全局设置。源码和发布仓库均为私有；客户端需要先安装 GitHub CLI 并执行 `gh auth login`，账号须有仓库读取权限。正式更新包需要本机外置签名私钥或 CI Secret：参见 [发布说明](docs/RELEASING.md)。

## 隐私

无遥测，不读取 Claude 登录凭据，不修改代理规则。出口检测服务能看到请求来源 IP；无缓存时向 ipwho.is 查询出口地理信息；查看附近公开地点时向 Nominatim 发送粗略坐标。更新检查通过本机 gh 登录访问私有 GitHub API，不发送本地监控记录；凭据仅在 Rust 后端使用，不进入前端、配置或应用包。

Windows 配置位于 `%APPDATA%/local.mhzrm.exit-sentinel/`。macOS 设置、IP 和节点记录保存在 `~/Library/Application Support/local.mhzrm.exit-sentinel/settings.json`，Unix 权限 0600。该目录不打包、不提交。Shadowrocket 读取只保留节点身份和路由元数据，不导出密码、密钥或订阅链接。

当前应用使用 ad-hoc 签名，尚未做 Apple Developer ID 签名与公证；其他 Mac 的首次安装可能需要在系统设置允许打开。更新包签名独立于 Apple 签名。

[安全检查范围与结果](docs/SECURITY-REVIEW.md)
