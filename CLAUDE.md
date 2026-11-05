# 项目规则

## Git

- 直接在 `main` 上开发和提交，不建功能分支。
- 仓库只保留 `main` 一个分支（本地和远端）。如果出现其他分支，合并进 `main` 后删除。
- 提交信息格式：`<type>: <description>`（feat / fix / refactor / docs / test / chore / perf / ci），不加署名行。

## 发布与部署

流程见 [docs/RELEASING.md](docs/RELEASING.md)，简要如下：

1. 同步修改 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/Cargo.lock、src-tauri/tauri.conf.json 的版本号，并在 release-notes.md 顶部写新版本说明。
2. `npm run build` 和 `npm test` 通过后提交到 `main` 并推送。
3. 触发发布仓库的工作流：`gh workflow run "Publish signed release" -R melotusme/exit-sentinel-releases -f source_ref=main`。它在 macOS 和 Windows 上构建、测试、签名，全部成功才发布。
4. 发布后更新私有 Homebrew tap（`melotusme/homebrew-exit-sentinel` 的 `scripts/update-cask.py`）。
5. 本机部署（macOS）：安装新版到 `~/Applications/Exit Sentinel.app`，替换前备份旧版应用和 `~/Library/Application Support/local.mhzrm.exit-sentinel/settings.json`。
6. Linux（Omarchy）部署：在目标机器运行 Release 中的 `install-linux.sh`（见 README），它会备份旧版应用和设置。
