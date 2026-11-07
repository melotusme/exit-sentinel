//! Updates from the public releases repository. No GitHub login is needed:
//! metadata and assets are read anonymously, download URLs are limited to that
//! repository, and every package is verified against the updater public key.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::Emitter;
use tauri_plugin_updater::UpdaterExt;

const OWNER_REPO: &str = "melotusme/exit-sentinel-releases";
const LIMIT: usize = 256 * 1024 * 1024;

#[derive(Default)]
pub struct State(tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
pub struct Available {
    version: String,
    current_version: String,
    body: Option<String>,
}

fn latest_url() -> String {
    format!("https://api.github.com/repos/{OWNER_REPO}/releases/latest")
}

fn download_prefix() -> String {
    format!("https://github.com/{OWNER_REPO}/releases/download/")
}

fn valid_download_url(url: &str) -> bool {
    url.strip_prefix(&download_prefix()).is_some_and(|rest| {
        let mut parts = rest.split('/');
        matches!((parts.next(), parts.next(), parts.next()), (Some(tag), Some(file), None)
            if !tag.is_empty() && !file.is_empty() && !rest.contains(['?', '#', '\\']))
    })
}

fn valid_cdn_url(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "github-releases.githubusercontent.com"
            )
        )
}

fn client() -> Result<reqwest::Client, String> {
    // Follow GitHub's download redirect only to its own release CDN.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 3 || !valid_cdn_url(attempt.url()) {
            attempt.stop()
        } else {
            attempt.follow()
        }
    });
    reqwest::Client::builder()
        .redirect(policy)
        .user_agent("Exit-Sentinel-updater")
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化更新连接。".into())
}

/// The packaged file each updater platform key must download.
fn asset_name(platform: &str) -> Result<&'static str, String> {
    match platform {
        "windows-x86_64" => Ok("Exit.Sentinel.windows.x64.exe"),
        "linux-x86_64" => Ok("Exit.Sentinel.linux.x86_64.AppImage"),
        "darwin-aarch64" => Ok("Exit.Sentinel.app.tar.gz"),
        _ => Err(format!("更新清单包含不支持的平台 {platform}。")),
    }
}

fn asset(release: &Value, name: &str) -> Result<String, String> {
    release["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .and_then(|a| a["browser_download_url"].as_str())
        .filter(|url| valid_download_url(url))
        .map(String::from)
        .ok_or_else(|| format!("Release 缺少有效的 {name}，请检查发布是否完整。"))
}

async fn get(
    client: &reqwest::Client,
    url: &str,
    binary: bool,
) -> Result<reqwest::Response, String> {
    if url != latest_url() && !valid_download_url(url) {
        return Err("拒绝访问发布仓库以外的地址。".into());
    }
    let response = client
        .get(url)
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
        403 | 429 => Err("GitHub 暂时限制了更新查询频率，请稍后重试。".into()),
        404 => Err("发布仓库还没有正式 Release。".into()),
        code if response.status().is_redirection() => {
            Err(format!("GitHub 返回了不受信任的下载跳转（HTTP {code}）。"))
        }
        code => Err(format!("GitHub 更新请求失败（HTTP {code}），请稍后重试。")),
    }
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<Option<Available>, String> {
    let mut pending = state.0.lock().await;
    let client = client()?;
    let release: Value = get(&client, &latest_url(), false)
        .await?
        .json()
        .await
        .map_err(|_| "GitHub Release 元数据格式异常。")?;
    let mut manifest: Value = get(&client, &asset(&release, "latest.json")?, true)
        .await?
        .json()
        .await
        .map_err(|_| "更新清单格式异常。")?;
    // Resolve every package from this fixed release instead of trusting manifest URLs.
    if let Some(platforms) = manifest["platforms"].as_object_mut() {
        for (key, platform) in platforms.iter_mut() {
            platform["url"] = Value::String(asset(&release, asset_name(key)?)?);
        }
    }
    let update = app
        .updater_builder()
        .build()
        .map_err(|_| "更新器配置异常。")?
        .restore_update(manifest)
        .map_err(|_| "更新清单无效或不支持当前架构。")?;
    let available = update.as_ref().map(|u| Available {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        body: u.body.clone(),
    });
    *pending = update;
    Ok(available)
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let mut pending = state.0.lock().await;
    let update = pending.as_ref().ok_or("请先检查新版本。")?;
    let client = client()?;
    let mut response = get(&client, update.download_url.as_str(), true).await?;
    let total = response.content_length();
    if total.is_some_and(|size| size > LIMIT as u64) {
        return Err("更新包超过 256 MiB 限制。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "更新包下载中断，请重试。")?
    {
        if bytes.len() + chunk.len() > LIMIT {
            return Err("更新包超过 256 MiB 限制。".into());
        }
        bytes.extend_from_slice(&chunk);
        let _ = app.emit_to(
            "main",
            "update-progress",
            serde_json::json!({"received":bytes.len(),"total":total}),
        );
    }
    let _ = app.emit_to("main", "update-installing", ());
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
    fn assets_only_come_from_the_fixed_repository() {
        let make = |url: String| serde_json::json!({"assets":[{"name":"latest.json","browser_download_url":url}]});
        assert!(asset(
            &make(format!("{}v0.6.1/latest.json", download_prefix())),
            "latest.json"
        )
        .is_ok());
        for url in [
            "https://evil.example/latest.json",
            "https://github.com/other/repo/releases/download/v1/latest.json",
            "https://github.com/melotusme/exit-sentinel-releases/releases/download/v1/latest.json?x=1",
            "https://github.com/melotusme/exit-sentinel-releases/releases/download/v1/a/b",
        ] {
            assert!(asset(&make(url.to_string()), "latest.json").is_err(), "{url}");
        }
        assert!(asset(&serde_json::json!({}), "latest.json").is_err());
    }

    #[test]
    fn each_platform_downloads_its_own_package() {
        assert_eq!(
            asset_name("windows-x86_64").unwrap(),
            "Exit.Sentinel.windows.x64.exe"
        );
        assert_eq!(
            asset_name("linux-x86_64").unwrap(),
            "Exit.Sentinel.linux.x86_64.AppImage"
        );
        assert_eq!(
            asset_name("darwin-aarch64").unwrap(),
            "Exit.Sentinel.app.tar.gz"
        );
        assert!(asset_name("darwin-x86_64").is_err());
    }

    #[test]
    fn redirects_only_reach_github_release_cdn() {
        assert!(valid_cdn_url(
            &reqwest::Url::parse("https://release-assets.githubusercontent.com/a?sig=1").unwrap()
        ));
        for url in [
            "http://release-assets.githubusercontent.com/a",
            "https://release-assets.githubusercontent.com.evil.test/a",
            "https://user@objects.githubusercontent.com/a",
            "https://github.com/other/a",
        ] {
            assert!(!valid_cdn_url(&reqwest::Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    #[ignore = "network: reads the live public release"]
    fn live_public_release_is_readable_without_login() {
        tauri::async_runtime::block_on(async {
            let client = client().unwrap();
            let release: Value = get(&client, &latest_url(), false)
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let manifest: Value = get(&client, &asset(&release, "latest.json").unwrap(), true)
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            for key in manifest["platforms"].as_object().unwrap().keys() {
                asset(&release, asset_name(key).unwrap()).unwrap();
            }
        });
    }
}
