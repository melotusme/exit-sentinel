//! Updates from the public releases repository. No GitHub login is needed:
//! metadata and assets are read anonymously, download URLs are limited to that
//! repository, and every package is verified against the updater public key.
//!
//! Scheduling, verification, silent installation and relaunch coordination are
//! owned here so automatic updates work reliably even while the main window is
//! hidden in the tray, without colliding with manual actions or OS shutdown.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

const OWNER_REPO: &str = "melotusme/exit-sentinel-releases";
const LIMIT: usize = 256 * 1024 * 1024;
const SILENT_RELAUNCH_FILE: &str = "silent-relaunch.json";
const SILENT_RELAUNCH_MAX_AGE_SECS: u64 = 600;
const STARTUP_DELAY_SECS: u64 = 45;
const CHECK_INTERVAL_SECS: u64 = 6 * 3600;
const DEFERRED_POLL_SECS: u64 = 60;
const MAX_AUTO_INSTALL_FAILURES: u32 = 2;
const PROGRESS_EMIT_MIN_INTERVAL: Duration = Duration::from_millis(120);
const PROGRESS_EMIT_MIN_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub notes: Option<String>,
    pub received: u64,
    pub total: Option<u64>,
    pub last_checked_at: Option<u64>,
    pub last_updated_from: Option<String>,
    pub error: Option<String>,
    pub error_is_manual: bool,
    pub can_silent_install: bool,
    pub silent_blocked_reason: Option<String>,
    pub auto_update_check: bool,
    pub auto_update_install: bool,
}

impl Default for UpdateStatus {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            current_version: env!("CARGO_PKG_VERSION").into(),
            latest_version: None,
            notes: None,
            received: 0,
            total: None,
            last_checked_at: None,
            last_updated_from: None,
            error: None,
            error_is_manual: false,
            can_silent_install: false,
            silent_blocked_reason: None,
            auto_update_check: true,
            auto_update_install: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrayUpdateSummary {
    pub phase: String,
    pub latest_version: Option<String>,
    pub auto_silent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SilentEligibility {
    pub allowed: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SilentRelaunchMarker {
    from_version: String,
    target_version: String,
    created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SilentRelaunchOutcome {
    pub keep_hidden: bool,
    pub updated_from: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct InstallCircuitBreaker {
    failed_version: Option<String>,
    failures: u32,
}

impl InstallCircuitBreaker {
    fn record_failure(&mut self, version: &str) -> u32 {
        if self.failed_version.as_deref() == Some(version) {
            self.failures = self.failures.saturating_add(1);
        } else {
            self.failed_version = Some(version.to_string());
            self.failures = 1;
        }
        self.failures
    }

    fn is_blocked(&self, version: &str) -> bool {
        self.failed_version.as_deref() == Some(version)
            && self.failures >= MAX_AUTO_INSTALL_FAILURES
    }

    fn reset(&mut self) {
        self.failed_version = None;
        self.failures = 0;
    }
}

struct PendingUpdate {
    update: tauri_plugin_updater::Update,
    verified_bytes: Option<Vec<u8>>,
}

#[derive(Default)]
struct Inner {
    status: UpdateStatus,
    pending: Option<PendingUpdate>,
    data_dir: Option<PathBuf>,
    circuit: InstallCircuitBreaker,
    last_check_instant: Option<Instant>,
    next_retry_at: Option<Instant>,
    consecutive_check_failures: u32,
}

#[derive(Default)]
pub struct State {
    op_lock: tokio::sync::Mutex<()>,
    inner: std::sync::Mutex<Inner>,
    wake: tokio::sync::Notify,
}

impl State {
    fn lock_inner(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn initialize(
        &self,
        app: &tauri::AppHandle,
        data_dir: PathBuf,
        settings: &crate::model::Settings,
        updated_from: Option<String>,
    ) {
        let eligibility = detect_silent_eligibility(app);
        let mut inner = self.lock_inner();
        inner.data_dir = Some(data_dir);
        inner.status.current_version = app.package_info().version.to_string();
        inner.status.last_updated_from = updated_from;
        inner.status.can_silent_install = eligibility.allowed;
        inner.status.silent_blocked_reason = eligibility.blocked_reason;
        inner.status.auto_update_check = settings.auto_update_check;
        inner.status.auto_update_install = settings.auto_update_install;
    }

    pub fn status_snapshot(&self) -> UpdateStatus {
        self.lock_inner().status.clone()
    }

    pub fn tray_summary(&self) -> TrayUpdateSummary {
        let inner = self.lock_inner();
        TrayUpdateSummary {
            phase: inner.status.phase.clone(),
            latest_version: inner.status.latest_version.clone(),
            auto_silent: inner.status.auto_update_check && inner.status.auto_update_install,
        }
    }

    pub fn wake(&self) {
        self.wake.notify_one();
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FetchError {
    message: String,
    rate_limited: bool,
}

impl FetchError {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            rate_limited: false,
        }
    }

    fn rate_limited(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            rate_limited: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApplyOutcome {
    Deferred,
    Installed,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn next_check_delay(consecutive_failures: u32, rate_limited: bool) -> Duration {
    if consecutive_failures == 0 {
        return Duration::from_secs(CHECK_INTERVAL_SECS);
    }
    if rate_limited {
        let secs = match consecutive_failures {
            1 => 3600,
            2 => 2 * 3600,
            _ => CHECK_INTERVAL_SECS,
        };
        return Duration::from_secs(secs);
    }
    let secs = match consecutive_failures {
        1 => 15 * 60,
        2 => 30 * 60,
        3 => 60 * 60,
        _ => CHECK_INTERVAL_SECS,
    };
    Duration::from_secs(secs)
}

fn dir_is_writable(dir: &Path) -> bool {
    static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);
    if !dir.is_dir() {
        return false;
    }
    let seq = PROBE_SEQ.fetch_add(1, Ordering::Relaxed);
    let probe = dir.join(format!(
        ".exit-sentinel-write-probe-{}-{seq}",
        std::process::id()
    ));
    match OpenOptions::new().write(true).create_new(true).open(&probe) {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[allow(dead_code)]
fn evaluate_silent_eligibility_paths(
    is_debug: bool,
    target_os: &str,
    exe_path: Option<&Path>,
    appimage_path: Option<&Path>,
) -> SilentEligibility {
    if is_debug {
        return SilentEligibility {
            allowed: false,
            blocked_reason: Some("开发调试构建已禁用自动静默安装".into()),
        };
    }
    match target_os {
        "windows" => {
            let Some(parent) = exe_path.and_then(|p| p.parent()) else {
                return SilentEligibility {
                    allowed: false,
                    blocked_reason: Some("无法确认当前安装目录，请手动安装更新。".into()),
                };
            };
            if dir_is_writable(parent) {
                SilentEligibility {
                    allowed: true,
                    blocked_reason: None,
                }
            } else {
                SilentEligibility {
                    allowed: false,
                    blocked_reason: Some(
                        "当前安装目录需要管理员权限，为避免弹出系统确认框，请手动安装更新。".into(),
                    ),
                }
            }
        }
        "macos" => {
            let bundle = exe_path.and_then(|p| {
                let macos_dir = p.parent()?;
                if macos_dir.file_name().and_then(|s| s.to_str()) != Some("MacOS") {
                    return None;
                }
                let contents_dir = macos_dir.parent()?;
                if contents_dir.file_name().and_then(|s| s.to_str()) != Some("Contents") {
                    return None;
                }
                let app_bundle = contents_dir.parent()?;
                if app_bundle.extension().and_then(|s| s.to_str()) != Some("app") {
                    return None;
                }
                Some(app_bundle)
            });
            let Some(bundle) = bundle else {
                return SilentEligibility {
                    allowed: false,
                    blocked_reason: Some("当前未以 .app 应用包运行，无法自动静默更新。".into()),
                };
            };
            let parent_writable = bundle.parent().is_some_and(dir_is_writable);
            let bundle_writable = dir_is_writable(bundle);
            if parent_writable && bundle_writable {
                SilentEligibility {
                    allowed: true,
                    blocked_reason: None,
                }
            } else {
                SilentEligibility {
                    allowed: false,
                    blocked_reason: Some(
                        "应用所在目录需要管理员权限，为避免弹出系统密码框，请手动点击安装更新。"
                            .into(),
                    ),
                }
            }
        }
        "linux" => {
            let Some(appimage) = appimage_path else {
                return SilentEligibility {
                    allowed: false,
                    blocked_reason: Some("当前未通过 AppImage 运行，无法自动静默更新。".into()),
                };
            };
            let parent_writable = appimage.parent().is_some_and(dir_is_writable);
            if parent_writable {
                SilentEligibility {
                    allowed: true,
                    blocked_reason: None,
                }
            } else {
                SilentEligibility {
                    allowed: false,
                    blocked_reason: Some(
                        "当前 AppImage 目录不可写，无法自动静默更新，请手动更新。".into(),
                    ),
                }
            }
        }
        _ => SilentEligibility {
            allowed: false,
            blocked_reason: Some("当前平台暂不支持自动静默安装。".into()),
        },
    }
}

fn detect_silent_eligibility(app: &tauri::AppHandle) -> SilentEligibility {
    let exe_path = std::env::current_exe().ok();
    #[cfg(target_os = "linux")]
    let appimage_path = app.env().appimage.as_deref().map(PathBuf::from);
    #[cfg(not(target_os = "linux"))]
    let appimage_path: Option<PathBuf> = {
        let _ = app;
        None
    };

    let target_os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "other"
    };

    evaluate_silent_eligibility_paths(
        cfg!(debug_assertions),
        target_os,
        exe_path.as_deref(),
        appimage_path.as_deref(),
    )
}

fn write_silent_relaunch_marker(
    data_dir: &Path,
    from_version: &str,
    target_version: &str,
    now_secs: u64,
) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|_| "无法访问本机配置目录。".to_string())?;
    let marker = SilentRelaunchMarker {
        from_version: from_version.to_string(),
        target_version: target_version.to_string(),
        created_at: now_secs,
    };
    let bytes = serde_json::to_vec(&marker).map_err(|_| "无法写入静默重启标记。".to_string())?;
    let path = data_dir.join(SILENT_RELAUNCH_FILE);
    let temp = data_dir.join(format!("{SILENT_RELAUNCH_FILE}.tmp"));
    std::fs::write(&temp, bytes).map_err(|_| "无法写入静默重启标记。".to_string())?;
    std::fs::rename(&temp, &path).map_err(|_| {
        let _ = std::fs::remove_file(&temp);
        "无法保存静默重启标记。".to_string()
    })
}

fn remove_silent_relaunch_marker(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(SILENT_RELAUNCH_FILE));
}

fn consume_silent_relaunch_marker_at(
    data_dir: &Path,
    current_version: &str,
    now_secs: u64,
) -> SilentRelaunchOutcome {
    let path = data_dir.join(SILENT_RELAUNCH_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(b) => {
            let _ = std::fs::remove_file(&path);
            b
        }
        Err(_) => return SilentRelaunchOutcome::default(),
    };
    let Ok(marker) = serde_json::from_slice::<SilentRelaunchMarker>(&bytes) else {
        return SilentRelaunchOutcome::default();
    };
    let fresh = now_secs.saturating_sub(marker.created_at) <= SILENT_RELAUNCH_MAX_AGE_SECS
        && marker.created_at <= now_secs.saturating_add(60);
    if !fresh {
        return SilentRelaunchOutcome::default();
    }
    let updated_from = (marker.from_version != current_version && !marker.from_version.is_empty())
        .then_some(marker.from_version);
    SilentRelaunchOutcome {
        keep_hidden: true,
        updated_from,
    }
}

pub fn consume_silent_relaunch(data_dir: &Path, current_version: &str) -> SilentRelaunchOutcome {
    consume_silent_relaunch_marker_at(data_dir, current_version, unix_now())
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

fn client() -> Result<reqwest::Client, FetchError> {
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
        .map_err(|_| FetchError::plain("无法初始化更新连接。"))
}

/// The packaged file each updater platform key must download.
fn asset_name(platform: &str) -> Result<&'static str, FetchError> {
    match platform {
        "windows-x86_64" => Ok("Exit.Sentinel.windows.x64.exe"),
        "linux-x86_64" => Ok("Exit.Sentinel.linux.x86_64.AppImage"),
        "darwin-aarch64" => Ok("Exit.Sentinel.app.tar.gz"),
        _ => Err(FetchError::plain(format!(
            "更新清单包含不支持的平台 {platform}。"
        ))),
    }
}

fn asset(release: &Value, name: &str) -> Result<String, FetchError> {
    release["assets"]
        .as_array()
        .and_then(|a| a.iter().find(|a| a["name"] == name))
        .and_then(|a| a["browser_download_url"].as_str())
        .filter(|url| valid_download_url(url))
        .map(String::from)
        .ok_or_else(|| {
            FetchError::plain(format!("Release 缺少有效的 {name}，请检查发布是否完整。"))
        })
}

async fn get(
    client: &reqwest::Client,
    url: &str,
    binary: bool,
) -> Result<reqwest::Response, FetchError> {
    if url != latest_url() && !valid_download_url(url) {
        return Err(FetchError::plain("拒绝访问发布仓库以外的地址。"));
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
        .map_err(|_| FetchError::plain("GitHub 更新连接失败或超时，请检查网络。"))?;
    match response.status().as_u16() {
        200..=299 => Ok(response),
        403 | 429 => Err(FetchError::rate_limited(
            "GitHub 暂时限制了更新查询频率，请稍后重试。",
        )),
        404 => Err(FetchError::plain("发布仓库还没有正式 Release。")),
        code if response.status().is_redirection() => Err(FetchError::plain(format!(
            "GitHub 返回了不受信任的下载跳转（HTTP {code}）。"
        ))),
        code => Err(FetchError::plain(format!(
            "GitHub 更新请求失败（HTTP {code}），请稍后重试。"
        ))),
    }
}

fn format_install_error(err: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match err {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) | E::MissingSignedVersion => {
            "更新包签名校验失败；当前版本仍保留，请稍后重试。".into()
        }
        E::SignedVersionMismatch { .. } => {
            "更新包签名版本与发布清单不一致，已拒绝安装；当前版本仍保留。".into()
        }
        E::InvalidUpdaterFormat | E::BinaryNotFoundInArchive => {
            "更新包格式无效；当前版本仍保留，请检查发布资产是否完整。".into()
        }
        E::TempDirNotOnSameMountPoint | E::TempDirNotFound => {
            "无法在应用所在磁盘创建临时目录，安装已中止；当前版本仍保留。".into()
        }
        E::PreviousAppNotRestored(_) => {
            "安装中断且未能自动恢复原应用文件，请重新安装最新版本。".into()
        }
        E::Io(io_err) if io_err.kind() == std::io::ErrorKind::PermissionDenied => {
            "没有写入应用目录的权限（或取消了系统授权），安装未完成；当前版本仍保留。".into()
        }
        E::Io(io_err) => format!(
            "安装更新时发生文件读写错误（{:?}）；当前版本仍保留，请重试。",
            io_err.kind()
        ),
        _ => "更新包验签或安装失败；当前版本仍保留，请重试。".into(),
    }
}

fn emit_status(app: &tauri::AppHandle, status: &UpdateStatus) {
    if !crate::shutdown::is_shutting_down() {
        let _ = app.emit_to("main", "update-status", status);
    }
}

fn refresh_ui_and_tray(app: &tauri::AppHandle, status: &UpdateStatus) {
    emit_status(app, status);
    if let Some(shared) = app.try_state::<crate::Shared>() {
        crate::refresh(app, &shared);
    }
}

fn build_updater_for_manifest(
    app: &tauri::AppHandle,
    manifest: Value,
) -> Result<Option<tauri_plugin_updater::Update>, FetchError> {
    let exit_app = app.clone();
    app.updater_builder()
        .on_before_exit(move || {
            crate::shutdown::begin_exit();
            exit_app.cleanup_before_exit();
        })
        .build()
        .map_err(|_| FetchError::plain("更新器配置异常。"))?
        .restore_update(manifest)
        .map_err(|_| FetchError::plain("更新清单无效或不支持当前架构。"))
}

async fn check_locked(
    app: &tauri::AppHandle,
    state: &State,
    manual: bool,
) -> Result<UpdateStatus, FetchError> {
    if crate::shutdown::is_shutting_down() {
        return Err(FetchError::plain("应用正在退出，已取消更新检查。"));
    }

    let previous_phase = {
        let mut inner = state.lock_inner();
        let prev = inner.status.phase.clone();
        inner.status.phase = "checking".into();
        inner.status.received = 0;
        inner.status.total = None;
        if manual {
            inner.status.error = None;
            inner.status.error_is_manual = false;
            inner.circuit.reset();
        }
        emit_status(app, &inner.status);
        prev
    };

    let fetch_result: Result<Option<tauri_plugin_updater::Update>, FetchError> = async {
        let http = client()?;
        let release: Value = get(&http, &latest_url(), false)
            .await?
            .json()
            .await
            .map_err(|_| FetchError::plain("GitHub Release 元数据格式异常。"))?;
        let mut manifest: Value = get(&http, &asset(&release, "latest.json")?, true)
            .await?
            .json()
            .await
            .map_err(|_| FetchError::plain("更新清单格式异常。"))?;
        // Resolve every package from this fixed release instead of trusting manifest URLs.
        if let Some(platforms) = manifest["platforms"].as_object_mut() {
            for (key, platform) in platforms.iter_mut() {
                platform["url"] = Value::String(asset(&release, asset_name(key)?)?);
            }
        }
        build_updater_for_manifest(app, manifest)
    }
    .await;

    let now_ts = unix_now();
    let now_inst = Instant::now();

    match fetch_result {
        Ok(Some(update)) => {
            let status = {
                let mut inner = state.lock_inner();
                let same_verified = inner
                    .pending
                    .as_ref()
                    .filter(|p| p.update.version == update.version && p.verified_bytes.is_some())
                    .and_then(|p| p.verified_bytes.clone());
                let keep_deferred = same_verified.is_some()
                    && inner.status.auto_update_check
                    && inner.status.auto_update_install
                    && inner.status.can_silent_install;
                inner.status.latest_version = Some(update.version.clone());
                inner.status.notes = update.body.clone();
                inner.status.last_checked_at = Some(now_ts);
                inner.status.error = None;
                inner.status.error_is_manual = false;
                inner.status.phase = if keep_deferred {
                    "ready_deferred".into()
                } else {
                    "available".into()
                };
                if !keep_deferred {
                    inner.status.received = 0;
                    inner.status.total = None;
                }
                inner.pending = Some(PendingUpdate {
                    update,
                    verified_bytes: same_verified,
                });
                inner.last_check_instant = Some(now_inst);
                inner.next_retry_at = None;
                inner.consecutive_check_failures = 0;
                inner.status.clone()
            };
            refresh_ui_and_tray(app, &status);
            Ok(status)
        }
        Ok(None) => {
            let status = {
                let mut inner = state.lock_inner();
                inner.pending = None;
                inner.status.phase = "idle".into();
                inner.status.latest_version = None;
                inner.status.notes = None;
                inner.status.received = 0;
                inner.status.total = None;
                inner.status.last_checked_at = Some(now_ts);
                inner.status.error = None;
                inner.status.error_is_manual = false;
                inner.last_check_instant = Some(now_inst);
                inner.next_retry_at = None;
                inner.consecutive_check_failures = 0;
                inner.status.clone()
            };
            refresh_ui_and_tray(app, &status);
            Ok(status)
        }
        Err(err) => {
            let status = {
                let mut inner = state.lock_inner();
                inner.consecutive_check_failures =
                    inner.consecutive_check_failures.saturating_add(1);
                let delay = next_check_delay(inner.consecutive_check_failures, err.rate_limited);
                inner.last_check_instant = Some(now_inst);
                inner.next_retry_at = Some(now_inst + delay);
                inner.status.last_checked_at = Some(now_ts);
                inner.status.error = Some(err.message.clone());
                inner.status.error_is_manual = manual;
                let has_deferred = inner
                    .pending
                    .as_ref()
                    .is_some_and(|p| p.verified_bytes.is_some());
                inner.status.phase = if !manual && has_deferred && previous_phase == "ready_deferred"
                {
                    "ready_deferred".into()
                } else {
                    "error".into()
                };
                inner.status.clone()
            };
            refresh_ui_and_tray(app, &status);
            Err(err)
        }
    }
}

async fn download_and_verify_locked(
    app: &tauri::AppHandle,
    state: &State,
    manual: bool,
) -> Result<(tauri_plugin_updater::Update, Vec<u8>), String> {
    if crate::shutdown::is_shutting_down() {
        return Err("应用正在退出，已取消更新下载。".into());
    }

    let (update, cached_bytes) = {
        let inner = state.lock_inner();
        let Some(pending) = inner.pending.as_ref() else {
            return Err("请先检查新版本。".into());
        };
        (pending.update.clone(), pending.verified_bytes.clone())
    };

    if let Some(bytes) = cached_bytes {
        return Ok((update, bytes));
    }

    let http = client().map_err(|e| e.message)?;
    let mut response = get(&http, update.download_url.as_str(), true)
        .await
        .map_err(|e| e.message)?;
    let total = response.content_length();
    if total.is_some_and(|size| size > LIMIT as u64) {
        return Err("更新包超过 256 MiB 限制。".into());
    }

    {
        let mut inner = state.lock_inner();
        inner.status.phase = "downloading".into();
        inner.status.received = 0;
        inner.status.total = total;
        inner.status.error = None;
        inner.status.error_is_manual = manual;
        emit_status(app, &inner.status);
    }

    let mut bytes = Vec::new();
    let mut last_emit = Instant::now();
    let mut last_emitted_bytes: u64 = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "更新包下载中断，请重试。".to_string())?
    {
        if crate::shutdown::is_shutting_down() {
            return Err("应用正在退出，已中止更新下载。".into());
        }
        if bytes.len() + chunk.len() > LIMIT {
            return Err("更新包超过 256 MiB 限制。".into());
        }
        bytes.extend_from_slice(&chunk);
        let received = bytes.len() as u64;
        if received.saturating_sub(last_emitted_bytes) >= PROGRESS_EMIT_MIN_BYTES
            || last_emit.elapsed() >= PROGRESS_EMIT_MIN_INTERVAL
        {
            last_emit = Instant::now();
            last_emitted_bytes = received;
            let status = {
                let mut inner = state.lock_inner();
                inner.status.received = received;
                inner.status.total = total;
                inner.status.clone()
            };
            emit_status(app, &status);
        }
    }

    {
        let mut inner = state.lock_inner();
        inner.status.phase = "verifying".into();
        inner.status.received = bytes.len() as u64;
        inner.status.total = total.or(Some(bytes.len() as u64));
        emit_status(app, &inner.status);
    }

    let verify_update = update.clone();
    let (bytes, verify_result) = tokio::task::spawn_blocking(move || {
        let res = verify_update.verify(&bytes);
        (bytes, res)
    })
    .await
    .map_err(|_| "更新包校验任务异常中断，请重试。".to_string())?;

    if let Err(err) = verify_result {
        let mut inner = state.lock_inner();
        if let Some(pending) = inner.pending.as_mut() {
            pending.verified_bytes = None;
        }
        return Err(format_install_error(&err));
    }

    {
        let mut inner = state.lock_inner();
        if let Some(pending) = inner.pending.as_mut() {
            if pending.update.version == update.version {
                pending.verified_bytes = Some(bytes.clone());
            }
        }
    }

    Ok((update, bytes))
}

fn windows_visible_for_deferral(app: &tauri::AppHandle) -> bool {
    crate::main_window_visible(app) || crate::diagnostics_window_visible(app)
}

async fn apply_verified_locked(
    app: &tauri::AppHandle,
    state: &State,
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
    silent: bool,
) -> Result<ApplyOutcome, String> {
    if crate::shutdown::is_shutting_down() {
        return Err("应用正在退出，已取消更新安装。".into());
    }

    // Hold sync lock during silent install so we never interrupt an in-flight WebDAV sync.
    let sync_state = app.try_state::<crate::sync::State>();
    let _sync_guard = if silent {
        let Some(sync_state) = sync_state.as_ref() else {
            return Ok(ApplyOutcome::Deferred);
        };
        match sync_state.0.try_lock() {
            Ok(guard) => Some(guard),
            Err(_) => {
                let changed = {
                    let mut inner = state.lock_inner();
                    let needs_update =
                        inner.status.phase != "ready_deferred" || inner.status.error.is_some();
                    if needs_update {
                        inner.status.phase = "ready_deferred".into();
                        inner.status.error = None;
                        inner.status.error_is_manual = false;
                        Some(inner.status.clone())
                    } else {
                        None
                    }
                };
                if let Some(status) = changed {
                    refresh_ui_and_tray(app, &status);
                }
                return Ok(ApplyOutcome::Deferred);
            }
        }
    } else {
        None
    };

    if silent {
        let eligible = state.lock_inner().status.can_silent_install;
        if !eligible {
            let changed = {
                let mut inner = state.lock_inner();
                if inner.status.phase != "available" {
                    inner.status.phase = "available".into();
                    Some(inner.status.clone())
                } else {
                    None
                }
            };
            if let Some(status) = changed {
                refresh_ui_and_tray(app, &status);
            }
            return Ok(ApplyOutcome::Deferred);
        }
        if windows_visible_for_deferral(app) {
            let changed = {
                let mut inner = state.lock_inner();
                let needs_update =
                    inner.status.phase != "ready_deferred" || inner.status.error.is_some();
                if needs_update {
                    inner.status.phase = "ready_deferred".into();
                    inner.status.error = None;
                    inner.status.error_is_manual = false;
                    Some(inner.status.clone())
                } else {
                    None
                }
            };
            if let Some(status) = changed {
                refresh_ui_and_tray(app, &status);
            }
            return Ok(ApplyOutcome::Deferred);
        }
    }

    let (data_dir, current_version) = {
        let mut inner = state.lock_inner();
        inner.status.phase = "installing".into();
        inner.status.error = None;
        inner.status.error_is_manual = !silent;
        emit_status(app, &inner.status);
        (inner.data_dir.clone(), inner.status.current_version.clone())
    };

    if silent {
        if let Some(dir) = data_dir.as_deref() {
            let _ = write_silent_relaunch_marker(dir, &current_version, &update.version, unix_now());
        }
    }

    crate::shutdown::begin_quiesce();
    let version = update.version.clone();
    let install_result = tokio::task::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "更新安装任务异常中断；当前版本仍保留，请重试。".to_string())
        .and_then(|res| res.map_err(|err| format_install_error(&err)));

    match install_result {
        Ok(()) => {
            {
                let mut inner = state.lock_inner();
                inner.pending = None;
            }
            crate::shutdown::begin_exit();
            app.request_restart();
            Ok(ApplyOutcome::Installed)
        }
        Err(msg) => {
            crate::shutdown::cancel_quiesce();
            if silent {
                if let Some(dir) = data_dir.as_deref() {
                    remove_silent_relaunch_marker(dir);
                }
            }
            let status = {
                let mut inner = state.lock_inner();
                if silent {
                    inner.circuit.record_failure(&version);
                }
                inner.status.phase = "error".into();
                inner.status.error = Some(msg.clone());
                inner.status.error_is_manual = !silent;
                inner.status.clone()
            };
            refresh_ui_and_tray(app, &status);
            Err(msg)
        }
    }
}

fn record_auto_failure(app: &tauri::AppHandle, state: &State, version: Option<&str>, msg: String) {
    let status = {
        let mut inner = state.lock_inner();
        if let Some(ver) = version {
            inner.circuit.record_failure(ver);
        }
        inner.status.phase = "error".into();
        inner.status.error = Some(msg);
        inner.status.error_is_manual = false;
        inner.status.clone()
    };
    refresh_ui_and_tray(app, &status);
}

fn reconcile_phase_for_settings(
    phase: &str,
    has_verified_bytes: bool,
    auto_update_check: bool,
    auto_update_install: bool,
    can_silent_install: bool,
) -> Option<&'static str> {
    let silent_enabled = auto_update_check && auto_update_install && can_silent_install;
    if !silent_enabled && phase == "ready_deferred" {
        Some("available")
    } else if silent_enabled && phase == "available" && has_verified_bytes {
        Some("ready_deferred")
    } else {
        None
    }
}

pub fn apply_update_settings(
    auto_update_check: bool,
    auto_update_install: bool,
    app: &tauri::AppHandle,
    shared: &crate::Shared,
    state: &State,
) -> Result<UpdateStatus, String> {
    {
        let mut d = crate::lock(shared);
        d.view.settings.auto_update_check = auto_update_check;
        d.view.settings.auto_update_install = auto_update_install;
        d.tray_signature.clear();
    }
    crate::persist(shared);
    let storage_error = crate::lock(shared).view.storage_error.clone();
    let status = {
        let mut inner = state.lock_inner();
        inner.status.auto_update_check = auto_update_check;
        inner.status.auto_update_install = auto_update_install;
        let has_verified = inner
            .pending
            .as_ref()
            .is_some_and(|p| p.verified_bytes.is_some());
        if let Some(next_phase) = reconcile_phase_for_settings(
            &inner.status.phase,
            has_verified,
            auto_update_check,
            auto_update_install,
            inner.status.can_silent_install,
        ) {
            inner.status.phase = next_phase.into();
        }
        if auto_update_check && auto_update_install {
            inner.circuit.reset();
        }
        inner.status.clone()
    };
    emit_status(app, &status);
    crate::refresh(app, shared);
    state.wake();
    if let Some(err) = storage_error {
        Err(format!("更新偏好已在内存生效，但保存失败：{err}"))
    } else {
        Ok(status)
    }
}

#[tauri::command]
pub fn get_update_status(state: tauri::State<'_, State>) -> UpdateStatus {
    state.status_snapshot()
}

#[tauri::command]
pub fn set_update_settings(
    auto_update_check: bool,
    auto_update_install: bool,
    app: tauri::AppHandle,
    shared: tauri::State<'_, crate::Shared>,
    state: tauri::State<'_, State>,
) -> Result<UpdateStatus, String> {
    apply_update_settings(auto_update_check, auto_update_install, &app, &shared, &state)
}

#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<UpdateStatus, String> {
    let _op = state.op_lock.lock().await;
    check_locked(&app, &state, true)
        .await
        .map_err(|err| err.message)
}

#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, State>,
) -> Result<(), String> {
    let _op = state.op_lock.lock().await;
    {
        let mut inner = state.lock_inner();
        inner.circuit.reset();
    }
    let (update, bytes) = match download_and_verify_locked(&app, &state, true).await {
        Ok(pair) => pair,
        Err(msg) => {
            let status = {
                let mut inner = state.lock_inner();
                inner.status.phase = "error".into();
                inner.status.error = Some(msg.clone());
                inner.status.error_is_manual = true;
                inner.status.clone()
            };
            refresh_ui_and_tray(&app, &status);
            return Err(msg);
        }
    };
    apply_verified_locked(&app, &state, update, bytes, false)
        .await
        .map(|_| ())
}

pub fn on_main_window_hidden(app: &tauri::AppHandle) {
    let should_wake = {
        let state = app.state::<State>();
        let inner = state.lock_inner();
        inner.status.auto_update_check
            && inner.status.auto_update_install
            && inner.status.can_silent_install
            && matches!(inner.status.phase.as_str(), "ready_deferred" | "available")
    };
    if !should_wake {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            biased;
            _ = crate::shutdown::wait_for_shutdown() => return,
            _ = tokio::time::sleep(Duration::from_millis(500)) => {}
        }
        if !crate::shutdown::is_shutting_down() {
            handle.state::<State>().wake();
        }
    });
}

async fn run_background_cycle(app: &tauri::AppHandle, startup_ready: bool) {
    let state = app.state::<State>();
    let _op = state.op_lock.lock().await;
    if crate::shutdown::is_shutting_down() {
        return;
    }

    let (auto_check, auto_install, can_silent, has_deferred, pending_version, check_due) = {
        let inner = state.lock_inner();
        let now = Instant::now();
        let due = if !inner.status.auto_update_check {
            false
        } else if let Some(retry_at) = inner.next_retry_at {
            now >= retry_at
        } else if let Some(last) = inner.last_check_instant {
            now.saturating_duration_since(last) >= Duration::from_secs(CHECK_INTERVAL_SECS)
        } else {
            startup_ready
        };
        let pending_ver = inner.pending.as_ref().map(|p| p.update.version.clone());
        let deferred = inner
            .pending
            .as_ref()
            .is_some_and(|p| p.verified_bytes.is_some());
        (
            inner.status.auto_update_check,
            inner.status.auto_update_install,
            inner.status.can_silent_install,
            deferred,
            pending_ver,
            due,
        )
    };

    if !auto_check {
        return;
    }

    // 1. If an update is already downloaded & verified, apply it silently once hidden & idle.
    if has_deferred && auto_install && can_silent {
        let blocked = pending_version
            .as_deref()
            .is_some_and(|v| state.lock_inner().circuit.is_blocked(v));
        if !blocked && !windows_visible_for_deferral(app) {
            let pair = {
                let inner = state.lock_inner();
                inner.pending.as_ref().and_then(|p| {
                    p.verified_bytes
                        .clone()
                        .map(|bytes| (p.update.clone(), bytes))
                })
            };
            if let Some((update, bytes)) = pair {
                let _ = apply_verified_locked(app, &state, update, bytes, true).await;
                return;
            }
        }
    }

    // 2. If a periodic/retry check is due, run it.
    if check_due {
        let _ = check_locked(app, &state, false).await;
    }

    if crate::shutdown::is_shutting_down() {
        return;
    }

    // 3. If silent auto-install is enabled and an update is available, download, verify, and apply/defer.
    let target_version = {
        let inner = state.lock_inner();
        if !inner.status.auto_update_check
            || !inner.status.auto_update_install
            || !inner.status.can_silent_install
        {
            None
        } else {
            inner.pending.as_ref().and_then(|p| {
                if inner.circuit.is_blocked(&p.update.version)
                    || (p.verified_bytes.is_some() && windows_visible_for_deferral(app))
                {
                    None
                } else {
                    Some(p.update.version.clone())
                }
            })
        }
    };

    let Some(version) = target_version else {
        return;
    };

    let (update, bytes) = match download_and_verify_locked(app, &state, false).await {
        Ok(pair) => pair,
        Err(msg) => {
            record_auto_failure(app, &state, Some(&version), msg);
            return;
        }
    };
    let _ = apply_verified_locked(app, &state, update, bytes, true).await;
}

fn clamp_deferred_wait(check_wait: Duration) -> Duration {
    check_wait
        .min(Duration::from_secs(DEFERRED_POLL_SECS))
        .max(Duration::from_secs(5))
}

fn next_worker_wait(state: &State, startup_deadline: Instant) -> Option<Duration> {
    let inner = state.lock_inner();
    if !inner.status.auto_update_check {
        return None;
    }
    let now = Instant::now();
    let check_wait = if let Some(retry_at) = inner.next_retry_at {
        retry_at.saturating_duration_since(now)
    } else if let Some(last) = inner.last_check_instant {
        (last + Duration::from_secs(CHECK_INTERVAL_SECS)).saturating_duration_since(now)
    } else {
        startup_deadline.saturating_duration_since(now)
    };

    let has_deferred = inner.status.auto_update_install
        && inner.status.can_silent_install
        && inner
            .pending
            .as_ref()
            .is_some_and(|p| p.verified_bytes.is_some() && !inner.circuit.is_blocked(&p.update.version));

    if has_deferred {
        Some(clamp_deferred_wait(check_wait))
    } else {
        Some(check_wait.max(Duration::from_secs(1)))
    }
}

pub fn spawn_worker(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let startup_deadline = Instant::now() + Duration::from_secs(STARTUP_DELAY_SECS);
        loop {
            if !crate::shutdown::wait_until_active_or_exit().await {
                break;
            }
            let wait = {
                let state = app.state::<State>();
                next_worker_wait(&state, startup_deadline)
            };
            let state = app.state::<State>();
            match wait {
                Some(duration) if !duration.is_zero() => {
                    tokio::select! {
                        biased;
                        _ = crate::shutdown::wait_for_shutdown() => continue,
                        _ = state.wake.notified() => {}
                        _ = tokio::time::sleep(duration) => {}
                    }
                }
                None => {
                    tokio::select! {
                        biased;
                        _ = crate::shutdown::wait_for_shutdown() => continue,
                        _ = state.wake.notified() => {}
                    }
                }
                Some(_) => {}
            }
            if crate::shutdown::is_shutting_down() {
                continue;
            }
            let startup_ready = Instant::now() >= startup_deadline;
            run_background_cycle(&app, startup_ready).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "exit-sentinel-updates-test-{tag}-{}-{}",
            std::process::id(),
            unix_now()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn assets_only_come_from_the_fixed_repository() {
        let make = |url: String| {
            serde_json::json!({"assets":[{"name":"latest.json","browser_download_url":url}]})
        };
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
    fn silent_relaunch_marker_roundtrip_one_shot_and_expiry() {
        let dir = temp_test_dir("marker");
        write_silent_relaunch_marker(&dir, "0.7.5", "0.7.6", 1_000).unwrap();
        assert!(dir.join(SILENT_RELAUNCH_FILE).exists());

        // Consuming returns keep_hidden=true and updated_from when version advanced, and deletes file.
        let outcome = consume_silent_relaunch_marker_at(&dir, "0.7.6", 1_120);
        assert_eq!(
            outcome,
            SilentRelaunchOutcome {
                keep_hidden: true,
                updated_from: Some("0.7.5".into()),
            }
        );
        assert!(!dir.join(SILENT_RELAUNCH_FILE).exists());
        // Second consume is a no-op.
        assert_eq!(
            consume_silent_relaunch_marker_at(&dir, "0.7.6", 1_121),
            SilentRelaunchOutcome::default()
        );

        // Same version relaunch keeps hidden without claiming version changed.
        write_silent_relaunch_marker(&dir, "0.7.5", "0.7.6", 2_000).unwrap();
        assert_eq!(
            consume_silent_relaunch_marker_at(&dir, "0.7.5", 2_010),
            SilentRelaunchOutcome {
                keep_hidden: true,
                updated_from: None,
            }
        );

        // Expired marker (> 600s) is ignored and deleted.
        write_silent_relaunch_marker(&dir, "0.7.5", "0.7.6", 3_000).unwrap();
        assert_eq!(
            consume_silent_relaunch_marker_at(&dir, "0.7.6", 3_601),
            SilentRelaunchOutcome::default()
        );
        assert!(!dir.join(SILENT_RELAUNCH_FILE).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backoff_and_circuit_breaker_prevent_hammering_and_loops() {
        assert_eq!(next_check_delay(0, false), Duration::from_secs(6 * 3600));
        assert_eq!(next_check_delay(1, false), Duration::from_secs(15 * 60));
        assert_eq!(next_check_delay(2, false), Duration::from_secs(30 * 60));
        assert_eq!(next_check_delay(3, false), Duration::from_secs(60 * 60));
        assert_eq!(next_check_delay(4, false), Duration::from_secs(6 * 3600));
        assert_eq!(next_check_delay(1, true), Duration::from_secs(3600));
        assert_eq!(next_check_delay(2, true), Duration::from_secs(2 * 3600));
        assert_eq!(next_check_delay(3, true), Duration::from_secs(6 * 3600));

        let mut cb = InstallCircuitBreaker::default();
        assert!(!cb.is_blocked("0.7.6"));
        assert_eq!(cb.record_failure("0.7.6"), 1);
        assert!(!cb.is_blocked("0.7.6"));
        assert_eq!(cb.record_failure("0.7.6"), 2);
        assert!(cb.is_blocked("0.7.6"));
        // New version is not blocked by old version failures.
        assert!(!cb.is_blocked("0.7.7"));
        assert_eq!(cb.record_failure("0.7.7"), 1);
        assert!(!cb.is_blocked("0.7.7"));
        cb.reset();
        assert!(!cb.is_blocked("0.7.6"));
    }

    #[test]
    fn silent_eligibility_handles_debug_and_platform_paths() {
        let dir = temp_test_dir("elig");

        // Debug builds always disable silent auto-install.
        let dbg = evaluate_silent_eligibility_paths(true, "windows", Some(&dir.join("app.exe")), None);
        assert!(!dbg.allowed);
        assert_eq!(
            dbg.blocked_reason.as_deref(),
            Some("开发调试构建已禁用自动静默安装")
        );

        // Windows writable install dir is eligible.
        let win_ok =
            evaluate_silent_eligibility_paths(false, "windows", Some(&dir.join("app.exe")), None);
        assert!(win_ok.allowed && win_ok.blocked_reason.is_none());

        // Missing directory is not writable -> ineligible.
        let missing = dir.join("does-not-exist").join("app.exe");
        let win_no = evaluate_silent_eligibility_paths(false, "windows", Some(&missing), None);
        assert!(!win_no.allowed && win_no.blocked_reason.is_some());

        // macOS requires a writable .app bundle + writable parent.
        let non_bundle = evaluate_silent_eligibility_paths(
            false,
            "macos",
            Some(&dir.join("exit-sentinel")),
            None,
        );
        assert!(!non_bundle.allowed);
        let mac_bin = dir
            .join("Exit Sentinel.app")
            .join("Contents")
            .join("MacOS")
            .join("exit-sentinel");
        std::fs::create_dir_all(mac_bin.parent().unwrap()).unwrap();
        let mac_ok = evaluate_silent_eligibility_paths(false, "macos", Some(&mac_bin), None);
        assert!(mac_ok.allowed && mac_ok.blocked_reason.is_none());

        // Linux requires AppImage path in writable directory.
        let linux_no_ai = evaluate_silent_eligibility_paths(false, "linux", None, None);
        assert!(!linux_no_ai.allowed);
        let appimage = dir.join("Exit.Sentinel.AppImage");
        let linux_ok =
            evaluate_silent_eligibility_paths(false, "linux", None, Some(&appimage));
        assert!(linux_ok.allowed && linux_ok.blocked_reason.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_status_serializes_expected_camel_case_contract() {
        let status = UpdateStatus {
            phase: "ready_deferred".into(),
            current_version: "0.7.5".into(),
            latest_version: Some("0.7.6".into()),
            notes: Some("notes".into()),
            received: 1024,
            total: Some(2048),
            last_checked_at: Some(1_700_000_000),
            last_updated_from: Some("0.7.4".into()),
            error: None,
            error_is_manual: false,
            can_silent_install: true,
            silent_blocked_reason: None,
            auto_update_check: true,
            auto_update_install: true,
        };
        let v = serde_json::to_value(&status).unwrap();
        for key in [
            "phase",
            "currentVersion",
            "latestVersion",
            "notes",
            "received",
            "total",
            "lastCheckedAt",
            "lastUpdatedFrom",
            "error",
            "errorIsManual",
            "canSilentInstall",
            "silentBlockedReason",
            "autoUpdateCheck",
            "autoUpdateInstall",
        ] {
            assert!(v.get(key).is_some(), "missing camelCase key {key}");
        }
    }

    #[test]
    fn toggling_auto_install_reconciles_ready_deferred_and_available_phases() {
        // Turning auto_update_install off while ready_deferred downgrades to available.
        assert_eq!(
            reconcile_phase_for_settings("ready_deferred", true, true, false, true),
            Some("available")
        );
        // Turning auto_update_check off while ready_deferred also downgrades to available.
        assert_eq!(
            reconcile_phase_for_settings("ready_deferred", true, false, true, true),
            Some("available")
        );
        // Turning silent install back on while available with verified bytes restores ready_deferred.
        assert_eq!(
            reconcile_phase_for_settings("available", true, true, true, true),
            Some("ready_deferred")
        );
        // Without verified bytes or when silent install is blocked, available stays available.
        assert_eq!(
            reconcile_phase_for_settings("available", false, true, true, true),
            None
        );
        assert_eq!(
            reconcile_phase_for_settings("available", true, true, true, false),
            None
        );
        // Deferred wait is always clamped between 5s and DEFERRED_POLL_SECS (prevents busy-spin).
        assert_eq!(clamp_deferred_wait(Duration::ZERO), Duration::from_secs(5));
        assert_eq!(
            clamp_deferred_wait(Duration::from_secs(12)),
            Duration::from_secs(12)
        );
        assert_eq!(
            clamp_deferred_wait(Duration::from_secs(3600)),
            Duration::from_secs(DEFERRED_POLL_SECS)
        );
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
