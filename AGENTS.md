# AGENTS.md

本仓库的完整规则在 [CLAUDE.md](CLAUDE.md)，开始工作前先完整阅读。下面是其中必须遵守的额度约束。

## GitHub Actions 额度约束（必须遵守）

账户是 GitHub Free，私有仓库每月只有 $12 的 Actions 额度，用完后 Actions 会被暂停（预算为 $0，不会扣费）。macOS runner 单价约为 Linux 的 10 倍，是主要开销。

- **macOS 版本只在本机构建**：构建、测试、签名、打包、上传都在本机 Mac 上做。不要在私有仓库的工作流里使用 `macos-*` runner，检查、测试、发布工作流都一样。
- **不要定时任务**：不要添加 `schedule` / cron 触发的工作流，发布只能手动触发。
- 新增或修改工作流前，先确认不会加回 macOS runner 或定时触发；拿不准就先问用户。
- 公开仓库的 Actions 免费，不受以上额度限制。
- 本项目现状：源码仓库 `melotusme/exit-sentinel` 和发布仓库 `melotusme/exit-sentinel-releases` 都已公开（2026-11-07），两边的 Actions（含 `release.yml` 的 macOS 构建）都免费，可以直接触发发布。发布仓库在 0.6.0 之前的 Release 含旧应用标识（带真名），已全部删除；不要恢复或重新上传旧版本。只有 Homebrew tap 仍是私有。
- 源码仓库是公开的：不要把真名、个人邮箱、本机绝对路径、机器名、真实 IP 或节点订阅写进代码、文档、测试或提交说明。用户的公开 ID 是 `mhzrm`。
