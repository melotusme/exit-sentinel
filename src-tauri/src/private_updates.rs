use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const REPO: &str = "repos/melotusme/exit-sentinel-releases";
const API: &str = "https://api.github.com/";
#[derive(Default)]
pub struct State(tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>);
#[derive(Serialize)]
pub struct Available {
    version: String,
    current_version: String,
    body: Option<String>,
}

async fn token() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        let gh_path = std::env::var_os("ProgramFiles")
            .map(std::path::PathBuf::from)
            .map(|p| p.join("GitHub CLI/gh.exe"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| std::path::PathBuf::from("gh.exe"));
        #[cfg(target_os = "windows")]
        let gh = gh_path.to_str().ok_or("GitHub CLI 路径编码无效")?;
        #[cfg(not(target_os = "windows"))]
        let gh = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"]
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
            .ok_or("私有更新需要 GitHub CLI：请安装 gh 并执行 gh auth login。")?;
        let out = crate::command(gh)
            .args(["auth", "token", "--hostname", "github.com"])
            .output()
            .map_err(|_| "无法读取本机 GitHub 登录，请执行 gh auth login。")?;
        if !out.status.success() {
            return Err("GitHub 尚未登录，请执行 gh auth login，并确认账号可读取更新仓库。".into());
        }
        let token = String::from_utf8(out.stdout)
            .map_err(|_| "GitHub 凭据格式异常。")?
            .trim()
            .to_owned();
        if token.is_empty() {
            return Err("GitHub 登录凭据为空，请重新登录。".into());
        }
        Ok(token)
    })
    .await
    .map_err(|_| "读取 GitHub 登录状态失败。".to_string())?
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Exit-Sentinel-private-updater")
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化私有更新连接。".into())
}
fn asset(release: &Value, name: &str) -> Result<String, String> {
    let prefix = format!("{API}{REPO}/releases/assets/");
    release["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .and_then(|a| a["url"].as_str())
        .filter(|url| {
            url.strip_prefix(&prefix)
                .map(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
                .unwrap_or(false)
        })
        .map(String::from)
        .ok_or_else(|| format!("私有 Release 缺少有效的 {name}，请检查发布是否完整。"))
}
async fn get(
    client: &reqwest::Client,
    token: &str,
    url: &str,
    binary: bool,
) -> Result<reqwest::Response, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .header(
            "Accept",
            if binary {
                "application/octet-stream"
            } else {
                "application/vnd.github+json"
            },
        )
        .send()
        .await
        .map_err(|_| "GitHub 更新连接失败或超时，请检查网络。")?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        401 => Err("GitHub 登录已失效，请执行 gh auth login。".into()),
        403 | 404 => {
            Err("无法读取私有更新：请确认 GitHub 账号拥有仓库权限，且已有正式 Release。".into())
        }
        code => Err(format!("GitHub 更新请求失败（HTTP {code}），请稍后重试。")),
    }
}
#[tauri::command]
pub async fn check_private_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<Option<Available>, String> {
    let mut pending = state.0.lock().await;
    let token = token().await?;
    let client = client()?;
    let release: Value = get(
        &client,
        &token,
        &format!("{API}{REPO}/releases/latest"),
        false,
    )
    .await?
    .json()
    .await
    .map_err(|_| "GitHub Release 元数据格式异常。")?;
    let mut manifest: Value = get(&client, &token, &asset(&release, "latest.json")?, true)
        .await?
        .json()
        .await
        .map_err(|_| "私有更新清单格式异常。")?;
    // Never trust a manifest-provided URL with a credential. Resolve the asset
    // from this fixed repository and keep all credentials in the native process.
    if let Some(platforms) = manifest["platforms"].as_object_mut() {
        for (key, platform) in platforms.iter_mut() {
            let name = if key.starts_with("windows-") {
                "Exit.Sentinel.windows.x64.exe"
            } else {
                "Exit.Sentinel.app.tar.gz"
            };
            platform["url"] = Value::String(asset(&release, name)?);
        }
    }
    let update = app
        .updater_builder()
        .build()
        .map_err(|_| "更新器配置异常。")?
        .restore_update(manifest)
        .map_err(|_| "私有更新清单无效或不支持当前架构。")?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        body: u.body.clone(),
    });
    *pending = update;
    Ok(available)
}
#[tauri::command]
pub async fn install_private_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let mut pending = state.0.lock().await;
    let update = pending.as_ref().ok_or("请先检查新版本。")?;
    let token = token().await?;
    let client = client()?;
    let mut response = get(&client, &token, update.download_url.as_str(), true).await?;
    let total = response.content_length();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "更新包下载中断，请重试。")?
    {
        if bytes.len() + chunk.len() > 256 * 1024 * 1024 {
            return Err("更新包超过 256 MiB 限制。".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = app.emit_to(
            "main",
            "private-update-progress",
            serde_json::json!({"received":bytes.len(),"total":total}),
        );
    }
    let _ = app.emit_to("main", "private-update-installing", ());
    update
        .install(bytes)
        .map_err(|_| "更新包验签或安装失败；当前版本仍保留，请重试。")?;
    *pending = None;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_only_go_to_fixed_repository_asset_ids() {
        let make = |url| serde_json::json!({"assets":[{"name":"latest.json","url":url}]});
        assert!(asset(
            &make(format!("{API}{REPO}/releases/assets/123")),
            "latest.json"
        )
        .is_ok());
        for url in ["https://evil.example/123", "https://api.github.com/repos/other/private/releases/assets/123", "https://api.github.com/repos/melotusme/exit-sentinel-releases/releases/assets/123?token=bad"] {
            assert!(asset(&make(url.to_string()), "latest.json").is_err());
        }
        assert!(asset(&serde_json::json!({}), "latest.json").is_err());
    }
}
