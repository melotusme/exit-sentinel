//! WebDAV v1: manual, conditional writes and local backup before replacing portable settings.
//! Credentials remain in the operating system credential store, never in sync JSON.
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};
use tauri::Manager;
const FILE: &str = "exit-sentinel-v1.json";
const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub struct State(tokio::sync::Mutex<()>);
#[derive(Default, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub etag: Option<String>,
    pub remote_hash: Option<String>,
    pub last_sync: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Portable {
    schema: u8,
    interval: u64,
    notifications: bool,
    retain_history: bool,
    ipv6: bool,
    ai_nodes: Vec<crate::shadowrocket::NodeRecord>,
    claude_ips: Vec<crate::claude::IpRecord>,
}
impl Portable {
    #[cfg(test)]
    fn from_saved(s: &crate::Saved) -> Self {
        Self {
            schema: 1,
            interval: s.settings.interval,
            notifications: s.settings.notifications,
            retain_history: s.settings.retain_history,
            ipv6: s.settings.ipv6,
            ai_nodes: s.ai_nodes.clone(),
            claude_ips: s.claude_ips.clone(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1
            || !(10..=3600).contains(&self.interval)
            || self.ai_nodes.len() > 10000
            || self.claude_ips.len() > 10000
        {
            return Err("同步配置版本或范围无效".into());
        }
        for r in &self.claude_ips {
            if !matches!(r.service.as_str(), "claude" | "gemini")
                || crate::model::public_ip(&r.ip).is_err()
                || r.note.chars().count() > 500
            {
                return Err("同步 IP 记录无效".into());
            }
        }
        for r in &self.ai_nodes {
            if !matches!(r.service.as_str(), "claude" | "gemini")
                || r.service != r.route.service
                || r.key != r.route.fingerprint
                || r.key.is_empty()
                || r.note.chars().count() > 500
            {
                return Err("同步节点记录无效".into());
            }
        }
        Ok(())
    }
}
fn load(path: &Path) -> Result<Config, String> {
    match std::fs::read(path.join("webdav.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| "本机 WebDAV 配置损坏".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Config {
            url: "https://dav.jianguoyun.com/dav/".into(),
            ..Default::default()
        }),
        Err(_) => Err("无法读取 WebDAV 配置".into()),
    }
}
fn entry(c: &Config) -> Result<keyring::Entry, String> {
    let id = format!("{:x}", Sha256::digest(format!("{}|{}", c.url, c.username)));
    keyring::Entry::new("Exit Sentinel WebDAV", &id).map_err(|_| "系统凭据库不可用".into())
}
fn store(path: &Path, c: &Config) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|_| "无法创建本机配置目录")?;
    std::fs::write(
        path.join("webdav.json"),
        serde_json::to_vec_pretty(c).map_err(|_| "无法序列化 WebDAV 配置")?,
    )
    .map_err(|_| "无法保存 WebDAV 配置".into())
}
fn endpoint(c: &Config) -> Result<url::Url, String> {
    remote_url(c, FILE)
}
fn remote_url(c: &Config, filename: &str) -> Result<url::Url, String> {
    let mut u = url::Url::parse(&c.url).map_err(|_| "WebDAV 地址格式无效")?;
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
        || c.username.trim().is_empty()
    {
        return Err("请填写无内嵌认证的 HTTPS WebDAV 目录和用户名".into());
    }
    if !u.path().ends_with('/') {
        u.set_path(&format!("{}/", u.path()));
    }
    u.join(&format!("ExitSentinel/{filename}"))
        .map_err(|_| "WebDAV 文件地址无效".into())
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Exit-Sentinel-WebDAV/1")
        .build()
        .map_err(|_| "无法创建 WebDAV 连接".into())
}
fn password(c: &Config) -> Result<String, String> {
    entry(c)?
        .get_password()
        .map_err(|_| "未找到 WebDAV 应用密码，请重新填写或从 Clash Verge 导入".into())
}
#[tauri::command]
pub fn get_sync_config(app: tauri::AppHandle) -> Result<Config, String> {
    let mut c = load(&app.path().app_data_dir().map_err(|_| "配置目录不可用")?)?;
    c.has_password = password(&c).is_ok();
    Ok(c)
}
pub fn configure(
    path: &Path,
    url: String,
    username: String,
    secret: String,
) -> Result<Config, String> {
    let old = load(path)?;
    let same = old.url == url && old.username == username;
    let mut c = Config {
        url,
        username,
        etag: if same { old.etag } else { None },
        remote_hash: if same { old.remote_hash } else { None },
        last_sync: if same { old.last_sync } else { String::new() },
        ..Default::default()
    };
    endpoint(&c)?;
    if !secret.is_empty() {
        entry(&c)?
            .set_password(&secret)
            .map_err(|_| "无法保存到系统凭据库")?;
    }
    c.has_password = password(&c).is_ok();
    if !c.has_password {
        return Err("请填写 WebDAV 应用密码".into());
    }
    store(path, &c)?;
    Ok(c)
}
#[tauri::command]
pub async fn save_sync_config(
    url: String,
    username: String,
    secret: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<Config, String> {
    let _guard = state.0.lock().await;
    configure(
        &app.path().app_data_dir().map_err(|_| "配置目录不可用")?,
        url.trim().into(),
        username.trim().into(),
        secret,
    )
}
fn decrypt(key: &[u8], value: &str) -> Result<String, String> {
    let data = STANDARD
        .decode(value)
        .map_err(|_| "Clash Verge WebDAV 密文格式无效")?;
    if data.len() < 28 {
        return Err("Clash Verge WebDAV 密文过短".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "Clash Verge 本机加密密钥无效")?;
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| "无法解密 Clash Verge WebDAV，请在本机手动填写")?;
    serde_json::from_slice::<String>(&plain).map_err(|_| "Clash Verge WebDAV 字段格式无效".into())
}
pub fn import(path: &Path) -> Result<Config, String> {
    let v = crate::clash_verge::yaml("verge.yaml")?;
    let key = std::fs::read(crate::clash_verge::directory()?.join(".encryption_key"))
        .map_err(|_| "无法读取 Clash Verge 本机加密密钥")?;
    let read = |k: &str| decrypt(&key, v[k].as_str().ok_or("Clash Verge 尚未配置 WebDAV")?);
    configure(
        path,
        read("webdav_url")?,
        read("webdav_username")?,
        read("webdav_password")?,
    )
}
#[tauri::command]
pub async fn import_verge_webdav(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<Config, String> {
    let _guard = state.0.lock().await;
    import(&app.path().app_data_dir().map_err(|_| "配置目录不可用")?)
}
async fn read_remote(
    c: &Config,
    secret: &str,
    filename: &str,
) -> Result<(Option<Vec<u8>>, Option<String>), String> {
    let mut r = client()?
        .get(remote_url(c, filename)?)
        .basic_auth(&c.username, Some(secret))
        .send()
        .await
        .map_err(|_| "WebDAV 连接失败或超时")?;
    if r.status() == 404 {
        return Ok((None, None));
    }
    if r.status() != 200 {
        return Err(format!("WebDAV 下载失败（HTTP {}）", r.status().as_u16()));
    }
    let etag = r
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let mut bytes = Vec::new();
    while let Some(b) = r.chunk().await.map_err(|_| "WebDAV 下载中断")? {
        if bytes.len() + b.len() > LIMIT {
            return Err("云端配置超过 8 MiB".into());
        }
        bytes.extend_from_slice(&b);
    }
    Ok((Some(bytes), etag))
}
async fn write_remote(
    c: &Config,
    secret: &str,
    bytes: &[u8],
    filename: &str,
) -> Result<Option<String>, String> {
    let folder = remote_url(c, "")?;
    let mkcol = client()?
        .request(reqwest::Method::from_bytes(b"MKCOL").unwrap(), folder)
        .basic_auth(&c.username, Some(secret))
        .send()
        .await
        .map_err(|_| "无法创建 WebDAV 同步目录")?;
    if !matches!(mkcol.status().as_u16(), 201 | 405) {
        return Err(format!(
            "WebDAV 创建目录失败（HTTP {}）",
            mkcol.status().as_u16()
        ));
    }
    let (current, current_etag) = read_remote(c, secret, filename).await?;
    if let Some(current) = current {
        let hash = format!("{:x}", Sha256::digest(&current));
        let matches = c
            .remote_hash
            .as_ref()
            .map(|h| h == &hash)
            .unwrap_or_else(|| c.etag.is_some() && c.etag == current_etag);
        if !matches {
            return Err("云端已有配置或已被其他设备更新，请先下载核对后再上传".into());
        }
        // Jianguoyun does not enforce If-None-Match. Preserve the version observed
        // before a write and disclose that simultaneous writes are not atomic.
        let backup_name = format!(
            "backup-{}-{}.json",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.9f"),
            &hash[..12]
        );
        let backup = client()?
            .put(remote_url(c, &backup_name)?)
            .basic_auth(&c.username, Some(secret))
            .header("Content-Type", "application/json")
            .body(current)
            .send()
            .await
            .map_err(|_| "云端备份失败，已中止上传")?;
        if !matches!(backup.status().as_u16(), 200 | 201 | 204) {
            return Err("云端备份失败，已中止上传".into());
        }
    } else if c.remote_hash.is_some() || c.etag.is_some() {
        return Err("云端配置已被删除，请重新保存连接并核对同步目录".into());
    }
    let mut request = client()?
        .put(remote_url(c, filename)?)
        .basic_auth(&c.username, Some(secret))
        .header("Content-Type", "application/json");
    request = if let Some(etag) = &c.etag {
        if etag.starts_with("W/") {
            request
        } else {
            request.header("If-Match", etag)
        }
    } else {
        request.header("If-None-Match", "*")
    };
    let response = request
        .body(bytes.to_vec())
        .send()
        .await
        .map_err(|_| "WebDAV 上传失败或超时")?;
    if response.status() == 412 {
        return Err("云端已有配置或已被其他设备更新，请先下载核对后再上传".into());
    }
    if !matches!(response.status().as_u16(), 200 | 201 | 204) {
        return Err(format!(
            "WebDAV 上传失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let (remote, etag) = read_remote(c, secret, filename).await?;
    if remote.as_deref() != Some(bytes) {
        return Err("上传后云端已变化，请下载核对".into());
    }
    Ok(etag)
}
pub async fn test_connection(path: &Path) -> Result<String, String> {
    let c = load(path)?;
    let r = client()?
        .request(reqwest::Method::from_bytes(b"PROPFIND").unwrap(), &c.url)
        .basic_auth(&c.username, Some(password(&c)?))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|_| "WebDAV 连接失败或超时")?;
    if r.status().as_u16() != 207 {
        return Err(format!(
            "WebDAV 目录检查失败（HTTP {}）",
            r.status().as_u16()
        ));
    }
    Ok("WebDAV 目录连接成功（HTTP 207）".into())
}
#[tauri::command]
pub async fn sync_action(
    action: String,
    app: tauri::AppHandle,
    s: tauri::State<'_, crate::Shared>,
    state: tauri::State<'_, State>,
) -> Result<String, String> {
    let _guard = state.0.lock().await;
    if action == "test" {
        return test_connection(&s.path).await;
    }
    if !matches!(action.as_str(), "push" | "pull") {
        return Err("未知同步操作".into());
    }
    let mut c = load(&s.path)?;
    let secret = password(&c)?;
    if action == "push" {
        let portable = {
            let d = crate::lock(&s);
            Portable {
                schema: 1,
                interval: d.view.settings.interval,
                notifications: d.view.settings.notifications,
                retain_history: d.view.settings.retain_history,
                ipv6: d.view.settings.ipv6,
                ai_nodes: d.view.ai_nodes.clone(),
                claude_ips: d.view.claude_ips.clone(),
            }
        };
        portable.validate()?;
        let bytes = serde_json::to_vec_pretty(&portable).map_err(|_| "同步配置序列化失败")?;
        if bytes.len() > LIMIT {
            return Err("本机同步配置超过 8 MiB".into());
        }
        c.etag = write_remote(&c, &secret, &bytes, FILE).await?;
        c.remote_hash = Some(format!("{:x}", Sha256::digest(&bytes)));
    } else {
        let (bytes, etag) = read_remote(&c, &secret, FILE).await?;
        let bytes = bytes.ok_or("云端尚无 Exit Sentinel 配置，请先从已有配置的设备上传")?;
        let portable: Portable =
            serde_json::from_slice(&bytes).map_err(|_| "云端不是有效的 Exit Sentinel v1 配置")?;
        portable.validate()?;
        crate::save(&s)?;
        let backup = s.path.join(format!(
            "settings.before-webdav-{}.json",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%.9f")
        ));
        std::fs::copy(s.path.join("settings.json"), backup)
            .map_err(|_| "下载中止：无法备份本机配置")?;
        let mut d = crate::lock(&s);
        let old = d.view.clone();
        d.view.settings.interval = portable.interval;
        d.view.settings.notifications = portable.notifications;
        d.view.settings.retain_history = portable.retain_history;
        d.view.settings.ipv6 = portable.ipv6;
        d.view.claude_ips = portable.claude_ips;
        d.view.ai_nodes = portable.ai_nodes;
        if !portable.retain_history {
            d.view.history.clear();
        }
        d.generation += 1;
        drop(d);
        if let Err(e) = crate::save(&s) {
            crate::lock(&s).view = old;
            return Err(format!("下载未应用：{e}"));
        }
        c.etag = etag;
        c.remote_hash = Some(format!("{:x}", Sha256::digest(&bytes)));
        s.wake.notify_one();
        crate::refresh(&app, &s);
    }
    c.last_sync = crate::now();
    store(&s.path, &c)?;
    Ok(if action == "push" {
        "配置已上传。"
    } else {
        "云端配置已应用；本机原配置已备份。代理端口和开机自启保留。"
    }
    .into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "opt-in local credential import and live WebDAV roundtrip"]
    async fn live_import_and_roundtrip() {
        let path = std::path::PathBuf::from(
            std::env::var_os("EXIT_SENTINEL_SETUP_DIR")
                .expect("provide app data directory explicitly"),
        );
        let c = import(&path).unwrap();
        assert!(
            c.url.starts_with("https://dav.jianguoyun.com/"),
            "expected configured Jianguoyun account"
        );
        assert!(test_connection(&path).await.unwrap().contains("207"));
        let secret = password(&c).unwrap();
        let name = format!(
            "exit-sentinel-validation-{}.json",
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        );
        let mut scratch = c.clone();
        scratch.etag = None;
        scratch.remote_hash = None;
        let body = serde_json::to_vec(&Portable::from_saved(&crate::Saved::default())).unwrap();
        let first = write_remote(&scratch, &secret, &body, &name).await;
        let outcome: Result<(), String> = async {
            scratch.etag = first?;
            scratch.remote_hash = Some(format!("{:x}", Sha256::digest(&body)));
            if scratch.etag.is_none() {
                return Err("provider did not return an ETag".into());
            }
            let (readback, _) = read_remote(&scratch, &secret, &name).await?;
            assert_eq!(readback.unwrap(), body);
            let mut no_revision = scratch.clone();
            no_revision.etag = None;
            no_revision.remote_hash = None;
            assert!(write_remote(&no_revision, &secret, &body, &name)
                .await
                .unwrap_err()
                .contains("云端"));
            let mut revised = body.clone();
            revised.push(b'\n');
            let next = write_remote(&scratch, &secret, &revised, &name).await?;
            if next == scratch.etag {
                return Err("ETag did not change".into());
            }
            assert!(write_remote(&scratch, &secret, &body, &name).await.is_err());
            Ok(())
        }
        .await;
        let deleted = client()
            .unwrap()
            .delete(remote_url(&scratch, &name).unwrap())
            .basic_auth(&scratch.username, Some(secret))
            .send()
            .await
            .unwrap();
        assert!(matches!(deleted.status().as_u16(), 200 | 204 | 404));
        outcome.unwrap();
        println!("Jianguoyun: import to OS credential store, PROPFIND 207, JSON roundtrip, preflight create/update and stale revision conflict, scratch cleanup passed");
    }
    #[tokio::test]
    #[ignore = "opt-in upload of this computer's existing settings to configured WebDAV"]
    async fn seed_configured_webdav() {
        let path = std::path::PathBuf::from(
            std::env::var_os("EXIT_SENTINEL_SETUP_DIR")
                .expect("provide app data directory explicitly"),
        );
        let saved: crate::Saved =
            serde_json::from_slice(&std::fs::read(path.join("settings.json")).unwrap()).unwrap();
        let portable = Portable::from_saved(&saved);
        portable.validate().unwrap();
        let bytes = serde_json::to_vec_pretty(&portable).unwrap();
        let mut c = load(&path).unwrap();
        let secret = password(&c).unwrap();
        c.etag = write_remote(&c, &secret, &bytes, FILE).await.unwrap();
        c.remote_hash = Some(format!("{:x}", Sha256::digest(&bytes)));
        c.last_sync = crate::now();
        store(&path, &c).unwrap();
        let (readback, _) = read_remote(&c, &secret, FILE).await.unwrap();
        assert_eq!(readback.unwrap(), bytes);
        println!("Configured WebDAV seeded and readback verified: {} service IP records, {} node records", portable.claude_ips.len(), portable.ai_nodes.len());
    }
    #[test]
    fn portable_excludes_credentials_and_machine_proxy() {
        let mut s = crate::Saved::default();
        s.settings.foreign_proxy = "http://127.0.0.1:1234".into();
        let v = serde_json::to_string(&Portable::from_saved(&s)).unwrap();
        assert!(!v.contains("1234"));
        assert!(!v.contains("password"));
        let mut p: Portable = serde_json::from_str(&v).unwrap();
        p.validate().unwrap();
        p.schema = 2;
        assert!(p.validate().is_err());
    }
    #[test]
    fn requires_clean_https_and_builds_dedicated_filename() {
        for url in [
            "http://example.com/dav",
            "https://u:p@example.com/dav",
            "https://example.com/dav?secret=x",
        ] {
            assert!(endpoint(&Config {
                url: url.into(),
                username: "u".into(),
                ..Default::default()
            })
            .is_err());
        }
        assert_eq!(
            endpoint(&Config {
                url: "https://dav.jianguoyun.com/dav/".into(),
                username: "u".into(),
                ..Default::default()
            })
            .unwrap()
            .path(),
            "/dav/ExitSentinel/exit-sentinel-v1.json"
        );
    }
    #[test]
    fn imports_authenticated_verge_ciphertext_only() {
        let key = [7u8; 32];
        let nonce = [8u8; 12];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let mut bytes = nonce.to_vec();
        bytes.extend(
            cipher
                .encrypt(
                    aes_gcm::Nonce::from_slice(&nonce),
                    br#""app-password""#.as_ref(),
                )
                .unwrap(),
        );
        assert_eq!(
            decrypt(&key, &STANDARD.encode(&bytes)).unwrap(),
            "app-password"
        );
        bytes[13] ^= 1;
        assert!(decrypt(&key, &STANDARD.encode(&bytes)).is_err());
        assert!(decrypt(&key, "plaintext").is_err());
    }
}
