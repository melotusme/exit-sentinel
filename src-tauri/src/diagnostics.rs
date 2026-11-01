use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};

pub const SITES: &[(&str, &str, &str, &str)] = &[
    ("baidu", "百度", "https://www.baidu.com/", "domestic"),
    ("bing", "必应中国", "https://cn.bing.com/", "domestic"),
    ("google", "Google", "https://www.google.com/", "foreign"),
    (
        "cloudflare",
        "Cloudflare",
        "https://www.cloudflare.com/cdn-cgi/trace",
        "foreign",
    ),
    ("apple", "Apple", "https://www.apple.com/", "foreign"),
    ("github", "GitHub", "https://github.com/", "foreign"),
    ("claude", "Claude", "https://claude.ai/", "claude"),
    ("gemini", "Gemini", "https://gemini.google.com/", "gemini"),
];
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Report {
    pub id: String,
    pub name: String,
    pub url: String,
    pub time: String,
    pub command: String,
    pub path: String,
    pub exit_code: i32,
    pub metrics: Value,
    pub trace: String,
    pub headers: String,
    pub body: String,
    pub body_bytes: usize,
    pub truncated: bool,
}
#[derive(Clone, Default, Serialize)]
pub struct State {
    pub running: bool,
    pub selected: String,
    pub reports: BTreeMap<String, Report>,
    pub error: Option<String>,
}
#[derive(Clone, Default)]
pub struct Shared(pub Arc<Mutex<State>>);

fn shell_arg(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn text(bytes: &[u8], max: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(max)]).into_owned()
}
struct Scratch(std::path::PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn execute(id: &str, name: &str, url: &str, proxy: &str) -> Result<Report, String> {
    let folder = std::env::temp_dir().join(format!(
        "sentinel-curl-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let scratch = Scratch(folder);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&scratch.0, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let body_path = scratch.0.join("body");
    let header_path = scratch.0.join("headers");
    let mut args = vec![
        "-q".into(),
        "--silent".into(),
        "--show-error".into(),
        "--verbose".into(),
        "--location".into(),
        "--max-redirs".into(),
        "3".into(),
        "--connect-timeout".into(),
        "5".into(),
        "--max-time".into(),
        "15".into(),
        "--max-filesize".into(),
        "262144".into(),
        "--compressed".into(),
        "--proto".into(),
        "=https".into(),
        "--proto-redir".into(),
        "=https".into(),
        "--user-agent".into(),
        "ExitSentinel/0.1 curl-network-test".into(),
    ];
    if proxy == "direct" {
        args.extend(["--noproxy".into(), "*".into()]);
    } else if !proxy.is_empty() {
        args.extend([
            "--proxy".into(),
            proxy.into(),
            "--noproxy".into(),
            String::new(),
        ]);
    }
    // The displayed command is independently runnable; actual invocation uses argv, never a shell.
    let command = format!(
        "{} {} --dump-header - --write-out '\\n%{{json}}\\n' {}",
        if cfg!(target_os = "windows") {
            "curl.exe"
        } else {
            "/usr/bin/curl"
        },
        args.iter()
            .map(|s| shell_arg(s))
            .collect::<Vec<_>>()
            .join(" "),
        shell_arg(url)
    );
    args.extend([
        "--dump-header".into(),
        header_path.to_string_lossy().into_owned(),
        "--output".into(),
        body_path.to_string_lossy().into_owned(),
        "--write-out".into(),
        "%{json}".into(),
        "--url".into(),
        url.into(),
    ]);
    let out = crate::command(if cfg!(target_os = "windows") {
        "curl.exe"
    } else {
        "/usr/bin/curl"
    })
    .args(&args)
    .output()
    .map_err(|e| format!("无法运行系统 curl：{e}"))?;
    let body = std::fs::read(&body_path).unwrap_or_default();
    let headers = std::fs::read(&header_path).unwrap_or_default();
    Ok(Report {
        id: id.into(),
        name: name.into(),
        url: url.into(),
        time: crate::now(),
        command,
        path: if proxy == "direct" {
            "direct：忽略进程代理，仍遵循本机路由 / TUN".into()
        } else if proxy.is_empty() {
            "本机路由 / TUN 与进程代理变量；不读取系统 PAC".into()
        } else {
            format!("显式代理：{proxy}")
        },
        exit_code: out.status.code().unwrap_or(-1),
        metrics: serde_json::from_slice(&out.stdout).unwrap_or(Value::Null),
        trace: text(&out.stderr, 131072),
        headers: text(&headers, 65536),
        body: text(&body, 262144),
        body_bytes: body.len(),
        truncated: body.len() >= 262144 || out.status.code() == Some(63),
    })
}
fn publish(app: &tauri::AppHandle, shared: &Shared) {
    let state = shared.0.lock().unwrap().clone();
    let _ = app.emit("diagnostics-state", state);
}
pub fn show_popup(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("diagnostics") {
        if let Some(tray) = app.tray_by_id("sentinel") {
            if let Ok(Some(rect)) = tray.rect() {
                if let Ok(Some(monitor)) = w.current_monitor() {
                    let scale = monitor.scale_factor();
                    let pos = rect.position.to_physical::<f64>(scale);
                    let size = rect.size.to_physical::<f64>(scale);
                    let left = monitor.position().x as f64;
                    let right = left + monitor.size().width as f64;
                    let x = (pos.x + size.width - 900.0 * scale)
                        .max(left + 8.0 * scale)
                        .min((right - 900.0 * scale - 8.0 * scale).max(left));
                    let _ = w.set_position(tauri::PhysicalPosition::new(
                        x,
                        pos.y + size.height + 6.0 * scale,
                    ));
                }
            }
        }
        let _ = w.show();
        let _ = w.set_focus();
    }
}
pub fn launch(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if id != "all" && id != "ai" && !SITES.iter().any(|s| s.0 == id) {
        return Err("未知检测站点".into());
    }
    let shared = app.state::<Shared>().inner().clone();
    {
        let mut state = shared.0.lock().unwrap();
        if state.running {
            return Err("已有测试正在进行，请等待完成".into());
        }
        state.running = true;
        state.error = None;
        state.selected = if id == "ai" {
            "claude".into()
        } else if id == "all" {
            "baidu".into()
        } else {
            id.into()
        };
    }
    publish(app, &shared);
    let settings = crate::lock(&app.state::<crate::Shared>())
        .view
        .settings
        .clone();
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        for &(site, name, url, group) in SITES.iter().filter(|s| {
            id == "all" || (id == "ai" && ["claude", "gemini"].contains(&s.0)) || s.0 == id
        }) {
            let proxy = match group {
                "domestic" => &settings.domestic_proxy,
                "claude" => &settings.claude_proxy,
                "gemini" => &settings.gemini_proxy,
                _ => &settings.foreign_proxy,
            }
            .clone();
            let result =
                tauri::async_runtime::spawn_blocking(move || execute(site, name, url, &proxy))
                    .await;
            {
                let mut state = shared.0.lock().unwrap();
                match result {
                    Ok(Ok(report)) => {
                        state.reports.insert(site.into(), report);
                    }
                    Ok(Err(error)) => state.error = Some(error),
                    Err(e) => state.error = Some(e.to_string()),
                }
            }
            publish(&app, &shared);
        }
        shared.0.lock().unwrap().running = false;
        publish(&app, &shared);
    });
    Ok(())
}
#[tauri::command]
pub fn open_diagnostics(app: tauri::AppHandle) {
    show_popup(&app);
}
#[tauri::command]
pub fn get_diagnostics(s: tauri::State<Shared>) -> State {
    s.0.lock().unwrap().clone()
}
#[tauri::command]
pub fn run_diagnostics(site: String, app: tauri::AppHandle) -> Result<(), String> {
    launch(&app, &site)
}
#[tauri::command]
pub fn copy_diagnostics(
    site: String,
    section: String,
    s: tauri::State<Shared>,
) -> Result<(), String> {
    let state = s.0.lock().unwrap();
    let report = state.reports.get(&site).ok_or("尚无测试结果")?;
    let value = match section.as_str() {
        "command" => report.command.clone(),
        "trace" => report.trace.clone(),
        "headers" => report.headers.clone(),
        "body" => report.body.clone(),
        "all" => serde_json::to_string_pretty(report).map_err(|e| e.to_string())?,
        _ => return Err("未知复制内容".into()),
    };
    crate::copy_to_clipboard(&value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preset_urls_are_fixed_https() {
        assert_eq!(SITES.len(), 8);
        for s in SITES {
            let url = url::Url::parse(s.2).unwrap();
            assert_eq!(url.scheme(), "https");
            assert!(url.username().is_empty());
        }
        assert_eq!(shell_arg("a'b"), "'a'\\''b'");
    }
    #[test]
    #[ignore = "opt-in actual curl connectivity"]
    fn live_curl() {
        for site in [&SITES[0], &SITES[2]] {
            let r = execute(site.0, site.1, site.2, "").unwrap();
            assert!(r.metrics.is_object(), "{}", r.trace);
            assert!(r.metrics["time_total"].as_f64().is_some());
            println!(
                "{} exit={} HTTP={} total={} remote={}",
                r.name,
                r.exit_code,
                r.metrics["http_code"],
                r.metrics["time_total"],
                r.metrics["remote_ip"]
            );
        }
    }
}
