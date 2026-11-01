# GitHub 自更新发布

更新清单位于 `tauri.conf.json` 的 `plugins.updater.endpoints`。客户端仅访问公开 HTTPS 清单及更新包，不携带 GitHub Token。清单包括 version、notes、pub_date 以及 platforms.darwin-aarch64 的 url / signature。

macOS 更新包是 `.app.tar.gz` 和对应 `.sig`，DMG 供首次安装。更新插件强制验证更新包签名。应用内只有公钥；私钥位于本机仓库外的 `~/.local/share/exit-sentinel/signing/updater.key`，请自行备份此私钥。丢失后无法向现有客户端发布可信更新。

## 本机发布

1. 同步修改 package.json、package-lock.json、src-tauri/Cargo.toml、src-tauri/tauri.conf.json 的版本。
2. `npm run build`、`npm test`，然后构建：

```sh
TAURI_SIGNING_PRIVATE_KEY="$HOME/.local/share/exit-sentinel/signing/updater.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' npm run desktop:build -- --bundles app
node scripts/package.mjs
```

3. 写好更新说明文件，发布：

```sh
node scripts/publish.mjs /absolute/path/to/release-notes.md
```

脚本先创建草稿，上传签名包、清单和可用的 DMG 后才公开版本，避免客户端读到不完整发布。仅上传指定构建产物，不上传源码、本机数据或私钥。`--prepare-only` 只生成本地清单。

源码仓库与发布仓库可分开；发布仓库名可通过 `RELEASE_REPOSITORY` 覆盖，但必须与客户端内置 endpoint 一致。客户端无凭据，不能直接下载私有 GitHub Release。

## 验证

从公开下载地址取得清单与包，核对版本、架构、签名、包内容与 Apple 签名；随后用安装版“检查软件更新”验证。完整更新验证必须从旧版本下载安装新版并确认重启后的版本，单纯 HTTP 200 不等于更新成功。

本机仍使用 ad-hoc Apple 签名；更新包签名不会替代 Developer ID 签名和公证。

## GitHub Actions

公开发布仓库的 Actions → Publish signed release → Run workflow 可从私有源码分支或标签构建并发布。也会每小时检查源码 main 的版本；版本已发布时跳过构建。公开仓库的定时任务可能被 GitHub 因长期无活动而停用，届时可手动恢复。

CI 使用只读源码 Deploy Key 和更新签名私钥 Secret，不嵌入客户端。仅手动触发 / 定时触发，不运行外部 PR 代码。源码 main 的新版本需同步更新 release-notes.md。
