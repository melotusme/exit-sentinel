# 发布与自动更新

源码仓库 `melotusme/exit-sentinel`、发布仓库 `melotusme/exit-sentinel-releases` 和 Homebrew tap `melotusme/homebrew-exit-sentinel` 都是公开的（2026-11-07 起；0.6.0 之前的 Release 已删除）。公开仓库的 Actions 免费，macOS、Windows、Linux 都在发布仓库的 CI 上构建。发布仓库的工作流用只读 Deploy Key（Secret `SOURCE_DEPLOY_KEY`）拉取源码，私钥另存在本机 `~/hzr/secrets/`。

## 客户端更新

0.6.1 起不需要 GitHub 登录。Rust 后端匿名读取 `https://api.github.com/repos/melotusme/exit-sentinel-releases/releases/latest`，只接受该仓库 `releases/download/<tag>/<file>` 形式的下载地址，跳转只允许到 GitHub 发布 CDN。每个清单平台键对应固定的包名：`darwin-aarch64` → `Exit.Sentinel.app.tar.gz`，`windows-x86_64` → `Exit.Sentinel.windows.x64.exe`，`linux-x86_64` → `Exit.Sentinel.linux.x86_64.AppImage`。0.6.0 及以前的客户端仍用本机 gh 登录读取，公开仓库同样能读，会照常升级到 0.6.1。

Tauri 官方 updater 负责版本比较与签名校验 / 安装。只有公钥进入应用；私钥保存在仓库外 `~/.local/share/exit-sentinel/signing/updater.key` 和发布仓库的 Actions Secret 中。请备份私钥。

## 发布

同步修改 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock、src-tauri/tauri.conf.json 的版本，并更新 release-notes.md。

```sh
npm run build
npm test
TAURI_SIGNING_PRIVATE_KEY="$HOME/.local/share/exit-sentinel/signing/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' npm run desktop:build -- --bundles app
node scripts/package.mjs
node scripts/publish.mjs release-notes.md
```

脚本先在发布仓库创建草稿，上传签名包、清单及 DMG，然后发布正式版本。失败的草稿可重试；已正式发布的版本不覆盖。`--prepare-only` 仅准备本地清单。

GitHub Actions → Publish signed release → Run workflow 可指定源码分支 / 标签。没有定时任务，只能手动触发。源码 Deploy Key 为只读，签名密钥为 Secret；不运行外部 PR 代码。

## 限制

0.2.x 仅发布 Apple Silicon macOS；macOS 仍使用 ad-hoc Apple 签名，尚未 Developer ID 公证。更新包签名不能替代 Apple 签名 / 公证。


## 0.3.0 跨平台发布

发布仓库 `.github/workflows/release.yml` 对同一源码 commit 并行运行 macOS ARM64 和 Windows x64 构建、测试和签名，全部成功后一次发布，防止某个平台缺失却成为 latest。源码中的 `.github/release-workflow.yml` 为审阅副本，不在源码仓库自动发布。

Windows 使用 Tauri 自动合并的 `tauri.windows.conf.json`，生成当前用户 NSIS 安装包；不需要管理员权限。更新安装包采用 Tauri updater 签名，未配置 Windows Authenticode 证书，首次下载可能显示 SmartScreen 提示。Windows ARM64 目前使用 x64 模拟，尚无原生 ARM64 包。

`prepare-release.mjs` 为每个平台规范化资产名称，`publish-cross.mjs` 在草稿中组装包含两个平台的 `latest.json` 和 `SHA256SUMS`。本机旧 `publish.mjs` 仅供历史 macOS 发布，不用于 0.3.0 及以后。

Homebrew tap 为公开的 `melotusme/homebrew-exit-sentinel`，cask 固定版本和 SHA-256，直接从公开 Release 下载。发布后运行 tap 的 `scripts/update-cask.py` 更新并提交。当前 cask 只提供 Apple Silicon macOS。

## 0.5.0 Linux

发布矩阵增加 `ubuntu-22.04` 上的 x86_64 Linux 构建，产出 Tauri 签名的 AppImage（`Exit.Sentinel.linux.x86_64.AppImage`，清单键 `linux-x86_64`），三个平台全部成功才发布。在 Ubuntu 22.04 上构建，以兼容较旧 glibc；Arch / Omarchy 等较新的发行版可直接运行。

`install-linux.sh` 随 Release 一起上传并列入 `SHA256SUMS`。它用 curl 从公开 Release 下载 AppImage，校验 SHA-256，备份旧版和 `settings.json` 到 `~/.local/share/exit-sentinel/backups/`，安装到 `~/.local/bin/exit-sentinel.AppImage`，并写入 `~/.local/share/applications/exit-sentinel.desktop`。之后的升级可在应用内完成（Tauri updater 只支持 AppImage 形式在 Linux 上自更新）。

AppImage 需要 libfuse2（Arch：`fuse2`）。未做 Linux 包管理器（AUR / pacman）登记；Linux ARM64 尚无包。
