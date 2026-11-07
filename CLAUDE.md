# 项目规则

## Git

- 直接在 `main` 上开发和提交，不建功能分支。
- 仓库只保留 `main` 一个分支（本地和远端）。如果出现其他分支，合并进 `main` 后删除。
- 提交信息格式：`<type>: <description>`（feat / fix / refactor / docs / test / chore / perf / ci），不加署名行。

## GitHub Actions 额度约束（必须遵守）

账户是 GitHub Free，私有仓库每月只有 $12 的 Actions 额度，用完后 Actions 会被暂停（预算为 $0，不会扣费）。macOS runner 单价约为 Linux 的 10 倍，是主要开销。

- **macOS 版本只在本机构建**：构建、测试、签名、打包、上传都在本机 Mac 上做。不要在私有仓库的工作流里使用 `macos-*` runner，检查、测试、发布工作流都一样。
- **不要定时任务**：不要添加 `schedule` / cron 触发的工作流，发布只能手动触发。
- 新增或修改工作流前，先确认不会加回 macOS runner 或定时触发；拿不准就先问用户。
- 公开仓库的 Actions 免费，不受以上额度限制。
- 本项目现状：源码仓库 `melotusme/exit-sentinel` 和发布仓库 `melotusme/exit-sentinel-releases` 都已公开（2026-11-07），两边的 Actions（含 `release.yml` 的 macOS 构建）都免费，可以直接触发发布。发布仓库在 0.6.0 之前的 Release 含旧应用标识（带真名），已全部删除；不要恢复或重新上传旧版本。只有 Homebrew tap 仍是私有。
- 源码仓库是公开的：不要把真名、个人邮箱、本机绝对路径、机器名、真实 IP 或节点订阅写进代码、文档、测试或提交说明。用户的公开 ID 是 `mhzrm`。

## 发布与部署

流程见 [docs/RELEASING.md](docs/RELEASING.md)，简要如下：

1. 同步修改 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock、src-tauri/tauri.conf.json 的版本号，并在 release-notes.md 顶部写新版本说明。
2. `npm run build` 和 `npm test` 通过后提交到 `main` 并推送。
3. 触发发布仓库的工作流：`gh workflow run "Publish signed release" -R melotusme/exit-sentinel-releases -f source_ref=main`。它在 macOS、Windows、Linux 上构建、测试、签名，全部成功才发布。
4. 发布后更新私有 Homebrew tap（`melotusme/homebrew-exit-sentinel` 的 `scripts/update-cask.py`）。
5. 本机部署（macOS）：安装新版到 `~/Applications/Exit Sentinel.app`，替换前备份旧版应用和 `~/Library/Application Support/dev.exit-sentinel.desktop/settings.json`（0.5.1 及以前是 `local.<名字>.exit-sentinel`，新版首次启动自动复制）。
6. Linux（Omarchy）部署：在目标机器运行 Release 中的 `install-linux.sh`（见 README），它会备份旧版应用和设置。
