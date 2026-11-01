# 私有 GitHub 自更新

源码仓库 `melotusme/exit-sentinel` 和发布仓库 `melotusme/exit-sentinel-releases` 均为私有。

## 客户端认证

安装 GitHub CLI，并使用有仓库读取权限的账号执行 `gh auth login`。应用通过本机 gh 读取登录凭据，在 Rust 后端访问固定 GitHub REST API；凭据不返回前端、不写入配置、不打包、不提交。其他 Mac 也需各自登录有权限的账号。

后端读取 `/repos/melotusme/exit-sentinel-releases/releases/latest`，找到 latest.json 和应用包的资产 ID，再使用 `Accept: application/octet-stream` 获取内容。清单字段为 version / notes / pub_date / platforms / signature；下载 URL 由后端替换为固定仓库资产 API 地址。跨域跳转时 HTTP 客户端会剥离 Authorization。错误不打印凭据或带签名的下载 URL。

Tauri 官方 updater 负责版本比较与签名校验 / 安装。只有公钥进入应用；私钥保存在仓库外 `~/.local/share/exit-sentinel/signing/updater.key` 和私有发布仓库 Actions Secret 中。请备份私钥。

## 发布

同步修改 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock、src-tauri/tauri.conf.json 的版本，并更新 release-notes.md。

```sh
npm run build
npm test
TAURI_SIGNING_PRIVATE_KEY="$HOME/.local/share/exit-sentinel/signing/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' npm run desktop:build -- --bundles app
node scripts/package.mjs
node scripts/publish.mjs release-notes.md
```

脚本先创建私有仓库中的草稿，上传签名包、清单及 DMG，然后发布正式版本。失败的草稿可重试；已正式发布的版本不覆盖。`--prepare-only` 仅准备本地清单。

GitHub Actions → Publish signed release → Run workflow 可指定私有源码分支 / 标签。定时任务每小时在 Linux 上检查版本，仅有新版本才使用 macOS 构建。源码 Deploy Key 为只读，签名密钥为 Secret；不运行外部 PR 代码。

## 首次迁移与限制

旧版公开下载更新器不能读取私有仓库，需要先本机安装支持私有更新的版本，此后在应用内升级。无有效 gh 登录或仓库权限时显示明确错误。

当前仅发布 Apple Silicon macOS，仍使用 ad-hoc Apple 签名，尚未 Developer ID 公证。更新包签名不能替代 Apple 签名 / 公证。
