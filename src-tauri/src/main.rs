#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod clash_verge;
mod claude;
mod connectivity;
mod diagnostics;
mod ai;
mod exit_worker;
mod google;
mod intelligence;
mod legacy_data;
mod local_proxy;
mod model;
mod net;
mod node_finder;
mod proxy_import;
mod region;
mod shadowrocket;
mod sync;
mod tray;
mod tray_menu;
mod updates;
mod verdict;
use ai::compute_verdicts;
use model::{Event, Probe, Settings, Tracker};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

#[derive(Clone, Serialize, Default)]
struct View {
    verdicts: Vec<verdict::Verdict>,
    gemini: claude::Monitor,
    ai_nodes: Vec<shadowrocket::NodeRecord>,
    current_routes: Vec<shadowrocket::RouteSnapshot>,
    ai_tests: Vec<claude::ServiceTest>,
    ai_testing: bool,
    claude: claude::Monitor,
    claude_ips: Vec<claude::IpRecord>,
    settings: Settings,
    probes: Vec<Probe>,
    service_health: Vec<connectivity::Reading>,
    history: Vec<Event>,
    network: String,
    paused: bool,
    checking: bool,
    unacknowledged: bool,
    status: String,
    /// Abnormal checks behind a "degraded" / "usable" status, for the menu and window.
    issues: Vec<String>,
    last_check: String,
    notification_error: Option<String>,
    storage_error: Option<String>,
}
struct Data {
    tray_signature: String,
    emitted_view: String,
    emitted_checked: String,
    copy_values: HashMap<String, String>,
    view: View,
    network_tracker: Tracker,
    generation: u64,
    geocache: HashMap<String, (u64, Value)>,
    nearby_cache: HashMap<String, (u64, Value)>,
    geo_attempts: HashMap<String, Instant>,
    nearby_attempt: Option<Instant>,
}
#[derive(Clone)]
struct Shared {
    data: Arc<Mutex<Data>>,
    wake: Arc<Notify>,
    path: PathBuf,
    geo_fetch: Arc<tokio::sync::Mutex<()>>,
}
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Saved {
    paused: bool,
    ai_nodes: Vec<shadowrocket::NodeRecord>,
    ai_tests: Vec<claude::ServiceTest>,
    claude_ips: Vec<claude::IpRecord>,
    settings: Settings,
    history: Vec<Event>,
    geocache: HashMap<String, (u64, Value)>,
    nearby_cache: HashMap<String, (u64, Value)>,
}
fn lock(s: &Shared) -> std::sync::MutexGuard<'_, Data> {
    s.data.lock().unwrap_or_else(|e| e.into_inner())
}
fn now() -> String {
    chrono::Local::now().to_rfc3339()
}
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn save(s: &Shared) -> Result<(), String> {
    let d = lock(s);
    let v = Saved {
        paused: d.view.paused,
        ai_nodes: d.view.ai_nodes.clone(),
        ai_tests: d.view.ai_tests.clone(),
        claude_ips: d.view.claude_ips.clone(),
        settings: d.view.settings.clone(),
        history: if d.view.settings.retain_history {
            d.view.history.clone()
        } else {
            vec![]
        },
        geocache: d.geocache.clone(),
        nearby_cache: d.nearby_cache.clone(),
    };
    let body = serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?;
    let p = s.path.join("settings.json");
    let temp = s.path.join("settings.json.tmp");
    std::fs::create_dir_all(&s.path).map_err(|e| e.to_string())?;
    std::fs::write(&temp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(temp, p).map_err(|e| e.to_string())
}
fn persist(s: &Shared) {
    let e = save(s).err();
    lock(s).view.storage_error = e;
}
fn push_event(d: &mut Data, title: &str, detail: &str) {
    d.view.history.insert(
        0,
        Event {
            time: now(),
            title: title.into(),
            detail: detail.into(),
        },
    );
    d.view.history.truncate(200);
}
/// Exit probes that decide the status: IPv4 always, IPv6 only when required, minus ignored ones.
fn core_probes(v: &View) -> Vec<&Probe> {
    v.probes
        .iter()
        .filter(|p| !p.group.ends_with('6') || v.settings.ipv6_required)
        .collect()
}
/// Names of the checks currently counted as abnormal. Ignored checks are left out.
fn issues(v: &View) -> Vec<String> {
    if v.paused {
        return vec![];
    }
    let probes = core_probes(v)
        .into_iter()
        .filter(|p| !p.checked.is_empty() && p.ip.is_none())
        .filter(|p| !v.settings.ignores(&format!("probe:{}", p.id)))
        .map(|p| format!("{}（{}）", p.label, p.error.as_deref().unwrap_or("无结果")));
    let sites = v
        .service_health
        .iter()
        .filter(|r| r.has_confirmed_problem())
        .filter(|r| !v.settings.ignores(&format!("site:{}", r.id)))
        .map(|r| format!("{} 网站（{}）", r.name, r.detail));
    probes.chain(sites).collect()
}
fn derive_status(v: &View) -> String {
    if v.paused {
        return "paused".into();
    }
    let core = core_probes(v);
    if core.iter().all(|p| p.checked.is_empty()) {
        return "starting".into();
    }
    let good = core.iter().filter(|p| p.ip.is_some()).count();
    if good == 0 && !v.probes.iter().any(|p| p.ip.is_some()) {
        return "offline".into();
    }
    if !issues(v).is_empty() {
        return degraded_status(&v.verdicts).into();
    }
    if v.unacknowledged {
        return "changed".into();
    }
    // Ignored probes may have no IP; compare only the ones that answered.
    let ipv4 = core
        .iter()
        .filter(|p| !p.group.ends_with('6') && p.ip.is_some())
        .collect::<Vec<_>>();
    let first = ipv4.first().and_then(|p| p.ip.as_deref());
    if ipv4.iter().any(|p| p.ip.as_deref() != first) {
        "split".into()
    } else {
        "stable".into()
    }
}
/// Secondary checks failing should not hide that Claude and Gemini are confirmed usable.
fn degraded_status(verdicts: &[verdict::Verdict]) -> &'static str {
    let ai_usable = !verdicts.is_empty() && verdicts.iter().all(|x| x.level == verdict::Level::Safe);
    if ai_usable { "usable" } else { "degraded" }
}
fn label(s: &str) -> &str {
    match s {
        "paused" => "已暂停",
        "offline" => "所有检测站不可达",
        "degraded" => "部分检测异常",
        "usable" => "可以使用 · 部分辅助检测异常",
        "changed" => "变化待确认",
        "split" => "多个出口 · 正常监控",
        "stable" => "出口一致 · 正常监控",
        _ => "等待首次检测",
    }
}
fn tray_image(status: &str) -> Image<'static> {
    let mut rgba = vec![0; 36 * 36 * 4];
    let color = match status {
        "offline" => [240, 82, 82, 255],
        "changed" | "degraded" => [240, 174, 50, 255],
        "stable" | "split" | "usable" => [62, 205, 148, 255],
        _ => [155, 163, 175, 255],
    };
    for y in 0..36i32 {
        for x in 0..36i32 {
            let dx = x - 18;
            let dy = y - 18;
            let ink = match status {
                "split" => {
                    ((x - 10).pow(2) + (y - 18).pow(2) < 42)
                        || ((x - 26).pow(2) + (y - 18).pow(2) < 42)
                        || (y >= 16 && y <= 20 && x > 10 && x < 26)
                }
                "changed" | "degraded" => {
                    (dx.abs() <= y / 2 && y > 3 && y < 32)
                        && (!(16..=20).contains(&x)
                            || (!(10..=21).contains(&y) && !(25..=28).contains(&y)))
                }
                "offline" => {
                    dx * dx + dy * dy < 225
                        && (dx.abs() < 3 || dy.abs() < 3 || dx * dx + dy * dy > 155)
                }
                "paused" => {
                    (10..=15).contains(&x) && (7..=29).contains(&y)
                        || (21..=26).contains(&x) && (7..=29).contains(&y)
                }
                _ => {
                    dx * dx + dy * dy < 196
                        && (dx * dx + dy * dy > 100 || dx.abs() < 3 && dy.abs() < 3)
                }
            };
            if ink {
                let n = ((y * 36 + x) * 4) as usize;
                rgba[n..n + 4].copy_from_slice(&color);
            }
        }
    }
    Image::new_owned(rgba, 36, 36)
}
pub(crate) fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
/// The Claude process heartbeat changes every few seconds; send it as a tiny event and
/// push the full view only when business data changed.
fn emit_state(app: &tauri::AppHandle, s: &Shared, v: &View) {
    let key = {
        let mut stable = v.clone();
        stable.claude.checked.clear();
        serde_json::to_string(&stable).unwrap_or_default()
    };
    let (full, heartbeat) = {
        let mut d = lock(s);
        let full = d.emitted_view != key;
        let heartbeat = d.emitted_checked != v.claude.checked;
        if full {
            d.emitted_view = key;
        }
        d.emitted_checked = v.claude.checked.clone();
        (full, heartbeat)
    };
    if full {
        let _ = app.emit("monitor-state", v);
    } else if heartbeat {
        let _ = app.emit("claude-checked", &v.claude.checked);
    }
}
fn refresh(app: &tauri::AppHandle, s: &Shared) {
    let autostart = app.autolaunch().is_enabled().ok();
    let v = {
        let mut d = lock(s);
        d.view.verdicts = compute_verdicts(&d.view);
        d.view.status = derive_status(&d.view);
        d.view.issues = issues(&d.view);
        d.view.clone()
    };
    emit_state(app, s, &v);
    let (geodata, nearbydata) = {
        let d = lock(s);
        (
            d.geocache
                .iter()
                .map(|(ip, (_, v))| (ip.clone(), v.clone()))
                .collect::<std::collections::BTreeMap<_, _>>(),
            d.nearby_cache
                .iter()
                .map(|(key, (_, v))| (key.clone(), v.clone()))
                .collect::<std::collections::BTreeMap<_, _>>(),
        )
    };
    let signature = format!(
        "{}:{:?}:{}:{}:{}:{:?}",
        v.status,
        v.issues,
        v.paused,
        v.checking,
        v.unacknowledged,
        v.probes
            .iter()
            .map(|p| (&p.group, &p.ip, &p.checked, &p.error))
            .collect::<Vec<_>>()
    ) + &format!(
        "{:?}:{:?}:{:?}:{:?}:{:?}:{:?}:{}:{}",
        geodata,
        nearbydata,
        autostart,
        v.claude.running,
        v.claude.ip,
        v.claude.ipv6,
        serde_json::to_string(&v.claude_ips).unwrap_or_default(),
        serde_json::to_string(&v.ai_tests).unwrap_or_default()
            + &v.ai_testing.to_string()
            + &serde_json::to_string(&v.current_routes).unwrap_or_default()
            + &serde_json::to_string(&v.ai_nodes).unwrap_or_default()
            + &serde_json::to_string(&v.service_health).unwrap_or_default()
            + &serde_json::to_string(&v.verdicts).unwrap_or_default()
    );
    {
        let mut d = lock(s);
        if d.tray_signature == signature {
            return;
        }
        d.tray_signature = signature;
    }
    if let Some(tray) = app.tray_by_id("sentinel") {
        let _ = tray.set_icon(Some(tray_image(&v.status)));
        let _ = tray.set_tooltip(Some(format!("出口哨兵 · {}", label(&v.status))));
        let menu = tray_menu::build(app, s, &v, autostart, &geodata, &nearbydata);
        if let Ok(menu) = menu {
            let _ = tray.set_menu(Some(menu));
        }
    }
}
fn copy_to_clipboard(value: &str) -> Result<(), String> {
    arboard::Clipboard::new()
        .map_err(|e| e.to_string())?
        .set_text(value)
        .map_err(|e| e.to_string())
}
// IP metadata is persistent and reused until explicit refresh or bounded eviction.
async fn cached_geo(s: &Shared, ip: &str, force: bool) -> Result<Value, String> {
    cached_geo_scoped(s, ip, force, None).await
}
async fn cached_geo_scoped(s: &Shared, ip: &str, force: bool, expected: Option<u64>) -> Result<Value, String> {
    let _fetch = s.geo_fetch.lock().await;
    let (proxy, generation) = {
        let mut d = lock(s);
        if expected.is_some_and(|generation| generation != d.generation) { return Err("查询已过期，数据已清空或路径已更改".into()); }
        if !force {
            if let Some((_, value)) = d.geocache.get(ip) {
                let mut value = value.clone();
                intelligence::enrich(&mut value);
                return Ok(value);
            }
        }
        if d.geo_attempts
            .get(ip)
            .map(|t| t.elapsed() < Duration::from_secs(60))
            .unwrap_or(false)
        {
            return Err("该 IP 详情查询请间隔 60 秒重试；已缓存的信息仍保留".into());
        }
        d.geo_attempts.insert(ip.into(), Instant::now());
        (d.view.settings.foreign_proxy.clone(), d.generation)
    };
    let mut value = net::geo(ip, &proxy).await?;
    intelligence::enrich(&mut value);
    value["cached_at"] = serde_json::json!(now());
    {
        let mut d = lock(s);
        if d.generation != generation { return Err("数据已清空或路径已更改，请重新查询".into()); }
        if force {
            if let Some(old) = d.geocache.get(ip) {
                if let (Some(lat), Some(lon)) =
                    (old.1["latitude"].as_f64(), old.1["longitude"].as_f64())
                {
                    d.nearby_cache.remove(&format!("{lat:.3},{lon:.3}"));
                }
            }
        }
        intelligence::insert_cache(&mut d.geocache, ip.into(), (stamp(), value.clone()));
    }
    persist(s);
    Ok(value)
}
fn load_tray_geography(app: tauri::AppHandle, s: Shared) {
    let generation = lock(&s).generation;
    let ips = lock(&s)
        .view
        .probes
        .iter()
        .filter_map(|p| p.ip.clone())
        .collect::<std::collections::HashSet<_>>();
    tauri::async_runtime::spawn(async move {
        for ip in ips {
            if lock(&s).generation != generation { break; }
            if cached_geo_scoped(&s, &ip, false, Some(generation)).await.is_ok() {
                refresh(&app, &s);
            }
        }
    });
}
fn notify(app: &tauri::AppHandle, s: &Shared, title: &str, body: &str) {
    if !lock(s).view.settings.notifications {
        return;
    }
    let result = app.notification().builder().title(title).body(body).show();
    lock(s).view.notification_error = result.err().map(|e| e.to_string());
}
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}
#[tauri::command]
fn set_autostart(
    enabled: bool,
    app: tauri::AppHandle,
    s: tauri::State<Shared>,
) -> Result<bool, String> {
    let manager = app.autolaunch();
    let result = (|| {
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())?;
        let actual = manager.is_enabled().map_err(|e| e.to_string())?;
        if actual != enabled {
            return Err("系统返回的开机自启状态与请求不一致，请重试".into());
        }
        Ok(actual)
    })();
    // Rebuild even after failure to restore the native checkmark to the real state.
    lock(&s).tray_signature.clear();
    refresh(&app, &s);
    let _ = app.emit("autostart-changed", manager.is_enabled().ok());
    result
}
#[tauri::command]
fn get_state(s: tauri::State<Shared>) -> View {
    lock(&s).view.clone()
}
#[tauri::command]
fn check_now(s: tauri::State<Shared>) {
    s.wake.notify_one();
}
#[tauri::command]
fn acknowledge(app: tauri::AppHandle, s: tauri::State<Shared>) {
    lock(&s).view.unacknowledged = false;
    refresh(&app, &s);
}
#[tauri::command]
fn set_paused(paused: bool, app: tauri::AppHandle, s: tauri::State<Shared>) {
    {
        let mut d = lock(&s);
        if d.view.paused && !paused {
            d.view.current_routes.clear();
        }
        d.view.paused = paused;
        d.generation += 1;
    }
    persist(&s);
    refresh(&app, &s);
    s.wake.notify_one();
}
#[tauri::command]
fn save_settings(
    settings: Settings,
    app: tauri::AppHandle,
    s: tauri::State<Shared>,
) -> Result<(), String> {
    settings.validate()?;
    {
        let mut d = lock(&s);
        let old = d.view.settings.clone();
        if old.claude_proxy != settings.claude_proxy
            || old.gemini_proxy != settings.gemini_proxy
            || old.gemini_ip_url != settings.gemini_ip_url
            || old.manual_nodes_only != settings.manual_nodes_only
        {
            d.view.ai_tests.clear();
            d.view.service_health.clear();
            d.view.current_routes.clear();
            d.view.claude = claude::Monitor::default();
        }
        let reset = old.ipv6 != settings.ipv6
            || old.domestic_proxy != settings.domestic_proxy
            || old.foreign_proxy != settings.foreign_proxy;
        d.view.settings = settings.clone();
        d.generation += 1;
        if reset {
            d.view.probes = net::probes(settings.ipv6);
            push_event(
                &mut d,
                "检测路径设置已更改",
                "已重建检测基线；新路径首次结果不触发变化通知",
            );
        }
        if !settings.retain_history {
            d.view.history.clear();
        }
    }
    persist(&s);
    refresh(&app, &s);
    s.wake.notify_one();
    if let Some(e) = lock(&s).view.storage_error.clone() {
        Err(format!("设置已在内存生效，但写入失败：{e}"))
    } else {
        Ok(())
    }
}
#[tauri::command]
fn clear_history(app: tauri::AppHandle, s: tauri::State<Shared>) {
    lock(&s).view.history.clear();
    persist(&s);
    refresh(&app, &s);
}
#[tauri::command]
fn preview_proxy_import(client: String, service: String, content: String, state: tauri::State<proxy_import::State>) -> Result<proxy_import::Preview, String> {
    let mut stage = state.0.lock().map_err(|_| "导入预览不可用")?;
    stage.1 = None;
    let (mut preview, routes) = proxy_import::prepare(&client, &service, &content)?;
    stage.0 += 1;
    preview.id = stage.0;
    stage.1 = Some(proxy_import::Prepared { id: preview.id, routes });
    Ok(preview)
}
#[tauri::command]
async fn discover_proxy_clients() -> Result<Vec<local_proxy::Availability>, String> {
    tokio::task::spawn_blocking(local_proxy::discover).await.map_err(|_| "本机软件检测失败，请重试".into())
}
#[tauri::command]
async fn preview_local_proxy_import(client: String, service: String, state: tauri::State<'_, proxy_import::State>) -> Result<proxy_import::Preview, String> {
    // Invalidate any old preview before starting a potentially slower local read.
    state.0.lock().map_err(|_| "导入状态不可用")?.1 = None;
    let (mut preview, routes) = tokio::task::spawn_blocking(move || local_proxy::prepare(&client, &service)).await.map_err(|_| "本机读取任务失败")?.map_err(|code| format!("{}出口检测仍可使用。", local_proxy::explain(&code)))?;
    let mut stage = state.0.lock().map_err(|_| "导入状态不可用")?;
    stage.0 += 1; preview.id = stage.0;
    stage.1 = Some(proxy_import::Prepared { id: preview.id, routes });
    Ok(preview)
}
#[tauri::command]
async fn commit_proxy_import(id: u64, manual_only: bool, app: tauri::AppHandle, s: tauri::State<'_, Shared>, state: tauri::State<'_, proxy_import::State>, sync_state: tauri::State<'_, sync::State>) -> Result<usize, String> {
    let _sync = sync_state.0.lock().await;
    let added = {
        let mut stage = state.0.lock().map_err(|_| "导入预览不可用")?;
        let prepared = stage.1.as_ref().filter(|p| p.id == id).ok_or("预览已过期，请重新选择文件")?;
        let mut d = lock(&s);
        let (added, _) = proxy_import::merge(&mut d.view.ai_nodes, prepared.routes.clone())?;
        if manual_only {
            d.view.settings.manual_nodes_only = true;
            d.view.current_routes.clear();
            d.view.claude.route = None;
            d.view.ai_tests.clear();
            d.generation += 1;
        }
        stage.1 = None;
        added
    };
    persist(&s);
    refresh(&app, &s);
    if let Some(e) = lock(&s).view.storage_error.clone() { return Err(format!("已导入内存，但保存失败：{e}。请勿退出，修复后重新保存。")); }
    Ok(added)
}
fn reset_data(d: &mut Data, scope: &str) -> Result<(), String> {
    if !matches!(scope, "ai" | "history" | "all") { return Err("清空范围无效".into()); }
    if scope != "history" {
        d.view.ai_nodes.clear(); d.view.claude_ips.clear(); d.view.ai_tests.clear();
        d.view.current_routes.clear(); d.view.claude = claude::Monitor::default();
        d.view.paused = true;
        d.view.unacknowledged = false;
        d.generation += 1;
    }
    // History can contain old IPs and nodes, so clear it together with AI data.
    d.view.history.clear();
    if scope == "all" {
        d.view.probes = net::probes(d.view.settings.ipv6);
        d.view.network.clear(); d.view.last_check.clear(); d.view.service_health.clear();
        d.network_tracker = Tracker::default();
        d.geocache.clear(); d.nearby_cache.clear(); d.geo_attempts.clear(); d.nearby_attempt = None;
        d.copy_values.clear();
    }
    d.tray_signature.clear();
    Ok(())
}
#[tauri::command]
async fn clear_monitor_data(scope: String, app: tauri::AppHandle, s: tauri::State<'_, Shared>, imports: tauri::State<'_, proxy_import::State>, sync_state: tauri::State<'_, sync::State>) -> Result<String, String> {
    if !matches!(scope.as_str(), "ai" | "history" | "all") { return Err("清空范围无效".into()); }
    let _sync = sync_state.0.lock().await;
    let _geo = s.geo_fetch.lock().await;
    let backup = format!("settings.before-clear-{}.json", chrono::Local::now().format("%Y%m%d-%H%M%S-%f"));
    // Back up the latest in-memory state too; abort before deletion if disk is unwritable.
    save(&s).map_err(|e| format!("清空前保存失败，数据未删除：{e}"))?;
    std::fs::copy(s.path.join("settings.json"), s.path.join(&backup)).map_err(|_| "清空前备份失败，数据未删除")?;
    reset_data(&mut lock(&s), &scope)?;
    if scope == "all" { diagnostics::clear(&app); }
    imports.0.lock().map_err(|_| "导入状态不可用")?.1 = None;
    persist(&s);
    refresh(&app, &s);
    let _ = app.emit("monitor-data-cleared", &scope);
    if let Some(e) = lock(&s).view.storage_error.clone() { return Err(format!("内存已清空，但保存失败：{e}。恢复备份：{backup}")); }
    Ok(backup)
}
#[tauri::command]
fn test_notification(app: tauri::AppHandle, s: tauri::State<Shared>) -> Result<(), String> {
    app.notification()
        .builder()
        .title("出口哨兵 · 通知测试")
        .body("检测到网络或出口变化时，你会收到这样的通知。")
        .show()
        .map_err(|e| e.to_string())?;
    lock(&s).view.notification_error = None;
    Ok(())
}
#[tauri::command]
fn get_cached_geography(s: tauri::State<Shared>) -> HashMap<String, Value> {
    lock(&s)
        .geocache
        .iter()
        .map(|(ip, (_, g))| {
            let mut value = g.clone();
            intelligence::enrich(&mut value);
            (ip.clone(), value)
        })
        .collect()
}
#[tauri::command]
async fn lookup_geo(
    ip: String,
    force: Option<bool>,
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<Value, String> {
    let ip = model::public_ip(&ip)?;
    let value = cached_geo(&s, &ip, force.unwrap_or(false)).await?;
    refresh(&app, &s);
    Ok(value)
}
#[tauri::command]
async fn lookup_nearby(
    ip: String,
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<Value, String> {
    let (lat, lon, proxy, key, generation) = {
        let mut d = lock(&s);
        let (_, g) = d.geocache.get(&ip).ok_or("请先查询此 IP 的定位详情")?;
        let lat = g["latitude"].as_f64().ok_or("无纬度数据")?;
        let lon = g["longitude"].as_f64().ok_or("无经度数据")?;
        let key = format!("{lat:.3},{lon:.3}");
        if let Some((_, v)) = d.nearby_cache.get(&key) {
            return Ok(v.clone());
        }
        if d.nearby_attempt
            .map(|t| t.elapsed() < Duration::from_secs(2))
            .unwrap_or(false)
        {
            return Err("公开地点查询请间隔 2 秒，避免公共服务限流".into());
        }
        d.nearby_attempt = Some(Instant::now());
        (lat, lon, d.view.settings.foreign_proxy.clone(), key, d.generation)
    };
    let v = net::nearby(lat, lon, &proxy).await?;
    {
        let mut d = lock(&s);
        if d.generation != generation { return Err("数据已清空或路径已更改，请重新查询".into()); }
        intelligence::insert_cache(&mut d.nearby_cache, key, (stamp(), v.clone()));
    }
    persist(&s);
    refresh(&app, &s);
    Ok(v)
}
/// Each node snapshot starts a Python process on macOS, so poll fast only while someone is looking.
const ROUTE_POLL_VISIBLE: Duration = Duration::from_secs(5);
const ROUTE_POLL_HIDDEN_MIN: Duration = Duration::from_secs(30);
fn main_window_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}
async fn route_worker(app: tauri::AppHandle, s: Shared) {
    let mut last_run: Option<Instant> = None;
    let mut last_settings = String::new();
    loop {
        if last_run.is_some() {
            tokio::time::sleep(ROUTE_POLL_VISIBLE).await;
        }
        let (settings, generation, paused) = {
            let d = lock(&s);
            (d.view.settings.clone(), d.generation, d.view.paused)
        };
        let settings_key = format!("{}|{}|{}", settings.claude_proxy, settings.gemini_proxy, settings.manual_nodes_only);
        let hidden_wait = Duration::from_secs(settings.interval).max(ROUTE_POLL_HIDDEN_MIN);
        let due = last_settings != settings_key
            || main_window_visible(&app)
            || last_run.map_or(true, |t| t.elapsed() >= hidden_wait);
        if !paused && due {
            last_run = Some(Instant::now());
            last_settings = settings_key;
            let routes = shadowrocket::selected_capture_many(
                &[("claude", &settings.claude_proxy), ("gemini", &settings.gemini_proxy)],
                settings.manual_nodes_only,
            )
            .await;
            let changed = {
                let mut d = lock(&s);
                if d.generation == generation
                    && !d.view.paused
                    && d.view
                        .current_routes
                        .iter()
                        .map(|r| (&r.fingerprint, &r.error, &r.observed_at))
                        .collect::<Vec<_>>()
                        != routes
                            .iter()
                            .map(|r| (&r.fingerprint, &r.error, &r.observed_at))
                            .collect::<Vec<_>>()
                {
                    d.view.current_routes = routes;
                    true
                } else {
                    false
                }
            };
            if changed {
                refresh(&app, &s);
            }
        }
    }
}
async fn worker(app: tauri::AppHandle, s: Shared) {
    let mut services = connectivity::Monitor::default();
    let mut last_probe = Instant::now() - Duration::from_secs(3600);
    let mut sampler = net::NetworkSampler::default();
    loop {
        let force = tokio::select! {_ = s.wake.notified()=>true,_=tokio::time::sleep(Duration::from_secs(3))=>false};
        if lock(&s).view.paused {
            services = connectivity::Monitor::default();
            continue;
        }
        let network_generation = lock(&s).generation;
        let quick = tokio::task::spawn_blocking(net::quick_signature)
            .await
            .unwrap_or_default();
        let network = if sampler.full_due(&quick, force) {
            let full = tokio::task::spawn_blocking(net::network_snapshot)
                .await
                .unwrap_or_default();
            sampler.record_full(&full);
            Some(full)
        } else {
            None
        };
        let network_change = match network {
            None => false,
            Some(network) => {
                let mut d = lock(&s);
                if d.generation != network_generation || d.view.paused { continue; }
                d.view.network = network.clone();
                d.network_tracker
                    .observe(Some(network))
                    .map(|_| {
                        d.view.unacknowledged = true;
                        push_event(
                            &mut d,
                            "本机网络变化",
                            "网络接口、局域网地址、默认路由或系统代理发生变化",
                        );
                        true
                    })
                    .unwrap_or(false)
            }
        };
        if network_change {
            notify(
                &app,
                &s,
                "本机网络发生变化",
                "网络接口、地址、路由或系统代理已变化，正在复核各出口 IP。",
            );
            persist(&s);
        }
        let (settings, probes, generation) = {
            let mut d = lock(&s);
            if !force
                && !network_change
                && last_probe.elapsed() < Duration::from_secs(d.view.settings.interval)
            {
                drop(d);
                refresh(&app, &s);
                continue;
            }
            d.view.checking = true;
            (d.view.settings.clone(), d.view.probes.clone(), d.generation)
        };
        refresh(&app, &s);
        let jobs = probes.into_iter().map(|p| {
            let proxy = if p.group.starts_with("domestic") {
                settings.domestic_proxy.clone()
            } else {
                settings.foreign_proxy.clone()
            };
            net::run_probe(p, proxy)
        });
        let (results, mut health) = tokio::join!(futures::future::join_all(jobs), connectivity::check_all(&settings));
        let mut details = vec![];
        {
            let mut d = lock(&s);
            d.view.checking = false;
            if generation != d.generation || d.view.paused {
                drop(d);
                refresh(&app, &s);
                continue;
            }
            d.view.probes = results
                .into_iter()
                .map(|mut p| {
                    if let Some((old, new)) = p.tracker.observe(p.ip.clone()) {
                        let title = if old.is_none() {
                            "检测恢复"
                        } else if new.is_none() {
                            "检测连续失败"
                        } else {
                            "出口 IP 变化"
                        };
                        let detail = format!(
                            "{}：{} → {}",
                            p.label,
                            old.as_deref().unwrap_or("不可达"),
                            new.as_deref().unwrap_or("不可达")
                        );
                        details.push(format!("{title} · {detail}"));
                    }
                    p.stable = p.tracker.settled();
                    p
                })
                .collect();
            for alert in services.apply(&mut health) {
                details.push(format!("{} · {}", alert.title, alert.detail));
            }
            d.view.service_health = health;
            d.view.last_check = now();
            if !details.is_empty() {
                d.view.unacknowledged = true;
                push_event(&mut d, "网络与服务状态变化", &details.join("\n"));
            }
        }
        if !details.is_empty() {
            notify(&app, &s, "出口哨兵 · 网络与服务告警", &details.join("\n"));
            persist(&s);
        }
        last_probe = Instant::now();
        refresh(&app, &s);
        load_tray_geography(app.clone(), s.clone());
    }
}
fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}
fn main() {
    // WebKitGTK's DMA-BUF renderer shows a blank window on many Wayland/NVIDIA setups
    // (e.g. Hyprland on Omarchy). Respect an explicit user value.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // Must run before any window exists: WebView storage lives under the identifier too.
    let migration_errors = legacy_data::migrate();
    let autostart = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    tauri::Builder::default()
        .manage(updates::State::default())
        .manage(sync::State::default())
        .manage(proxy_import::State::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(autostart.arg("--autostart").build())
        .setup(move |app| {
            let path = app.path().app_data_dir()?;
            let (mut saved, load_error) = match std::fs::read(path.join("settings.json")) {
                Ok(b) => match serde_json::from_slice::<Saved>(&b) {
                    Ok(v) => (v, None),
                    Err(e) => (
                        Saved::default(),
                        Some(format!("配置读取失败，已使用默认值：{e}")),
                    ),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    #[allow(unused_mut)]
                    let mut initial = Saved::default();
                    #[cfg(not(target_os = "macos"))]
                    if let Some(proxy) = clash_verge::local_proxy() {
                        initial.settings.foreign_proxy = proxy.clone();
                        initial.settings.claude_proxy = proxy.clone();
                        initial.settings.gemini_proxy = proxy;
                    }
                    (initial, None)
                },
                Err(e) => (Saved::default(), Some(e.to_string())),
            };
            if saved.settings.validate().is_err() {
                saved.settings = Settings::default();
            }
            saved.history.truncate(200);
            if !saved.settings.retain_history {
                saved.history.clear();
            }
            let s = Shared {
                path,
                geo_fetch: Arc::new(tokio::sync::Mutex::new(())),
                wake: Arc::new(Notify::new()),
                data: Arc::new(Mutex::new(Data {
                    tray_signature: String::new(),
                    emitted_view: String::new(),
                    emitted_checked: String::new(),
                    copy_values: HashMap::new(),
                    view: View {
                        verdicts: vec![],
                        gemini: claude::Monitor::default(),
                        ai_nodes: saved.ai_nodes,
                        current_routes: vec![],
                        ai_tests: saved.ai_tests,
                        ai_testing: false,
                        claude: claude::Monitor::default(),
                        claude_ips: saved.claude_ips,
                        probes: net::probes(saved.settings.ipv6),
                        service_health: vec![],
                        settings: saved.settings,
                        history: saved.history,
                        network: String::new(),
                        paused: saved.paused,
                        checking: false,
                        unacknowledged: false,
                        status: "starting".into(),
                        issues: vec![],
                        last_check: String::new(),
                        notification_error: None,
                        storage_error: load_error.or_else(|| {
                            (!migration_errors.is_empty()).then(|| migration_errors.join("；"))
                        }),
                    },
                    generation: 0,
                    network_tracker: Tracker::default(),
                    geocache: saved.geocache,
                    nearby_cache: saved.nearby_cache,
                    geo_attempts: HashMap::new(),
                    nearby_attempt: None,
                })),
            };
            app.manage(s.clone());
            app.manage(diagnostics::Shared::default());
            TrayIconBuilder::with_id("sentinel")
                .icon(tray_image("starting"))
                .icon_as_template(false)
                .tooltip("出口哨兵 · 等待检测")
                .on_menu_event(tray_menu::on_event)
                .build(app)?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            if !std::env::args().any(|arg| arg == "--autostart") {
                show(app.handle());
            }
            refresh(app.handle(), &s);
            s.wake.notify_one();
            tauri::async_runtime::spawn(route_worker(app.handle().clone(), s.clone()));
            tauri::async_runtime::spawn(exit_worker::run(app.handle().clone(), s.clone()));
            tauri::async_runtime::spawn(worker(app.handle().clone(), s));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            sync::get_sync_config,
            sync::save_sync_config,
            sync::import_verge_webdav,
            sync::sync_action,
            updates::check_update,
            updates::install_update,
            get_state,
            ai::save_claude_ip,
            ai::save_ai_node,
            ai::copy_ai_route,
            ai::test_ai_services,
            get_autostart,
            set_autostart,
            check_now,
            acknowledge,
            set_paused,
            save_settings,
            clear_history,
            preview_proxy_import,
            discover_proxy_clients,
            preview_local_proxy_import,
            commit_proxy_import,
            clear_monitor_data,
            test_notification,
            get_cached_geography,
            lookup_geo,
            lookup_nearby,
            node_finder::find_nodes_near,
            diagnostics::open_diagnostics,
            diagnostics::get_diagnostics,
            diagnostics::run_diagnostics,
            diagnostics::copy_diagnostics
        ])
        .build(tauri::generate_context!())
        .expect("无法启动出口哨兵")
        .run(|handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show(handle);
            }
        });
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use crate::ai::{mark_service_ip, parse_safety};
    fn shared(path: PathBuf, saved: Saved) -> Shared {
        Shared {
            path,
            wake: Arc::new(Notify::new()),
            geo_fetch: Arc::new(tokio::sync::Mutex::new(())),
            data: Arc::new(Mutex::new(Data {
                tray_signature: String::new(),
                    emitted_view: String::new(),
                    emitted_checked: String::new(),
                copy_values: HashMap::new(),
                view: View {
                    verdicts: vec![],
                    gemini: claude::Monitor::default(),
                    ai_nodes: saved.ai_nodes,
                    current_routes: vec![],
                    ai_tests: saved.ai_tests,
                    ai_testing: false,
                    claude: claude::Monitor::default(),
                    claude_ips: saved.claude_ips,
                    settings: saved.settings,
                    probes: vec![],
                    service_health: vec![],
                    history: saved.history,
                    network: String::new(),
                    paused: false,
                    checking: false,
                    unacknowledged: false,
                    status: String::new(),
                    issues: vec![],
                    last_check: String::new(),
                    notification_error: None,
                    storage_error: None,
                },
                network_tracker: Tracker::default(),
                generation: 0,
                geocache: saved.geocache,
                nearby_cache: saved.nearby_cache,
                geo_attempts: HashMap::new(),
                nearby_attempt: None,
            })),
        }
    }
    #[test]
    fn clear_scopes_preserve_settings_and_persist_empty_paused_state() {
        let path = std::env::temp_dir().join(format!("sentinel-clear-test-{}", std::process::id()));
        let mut saved = Saved::default();
        saved.settings.manual_nodes_only = true;
        saved.settings.claude_proxy = "http://127.0.0.1:7890".into();
        claude::upsert(&mut saved.claude_ips, "claude", "8.8.8.8", claude::Safety::Safe, "old".into(), "t0").unwrap();
        let (_, routes) = proxy_import::prepare("clash_mi", "both", "trojan://pw@node.example:443#Old").unwrap();
        proxy_import::merge(&mut saved.ai_nodes, routes).unwrap();
        saved.geocache.insert("8.8.8.8".into(), (1, serde_json::json!({"ip":"8.8.8.8"})));
        let s = shared(path.clone(), saved);
        {
            let mut d = lock(&s);
            d.view.current_routes = d.view.ai_nodes.iter().map(|n| n.route.clone()).collect();
            d.view.ai_tests.push(claude::ServiceTest::default());
            push_event(&mut d, "old IP", "old node");
            assert!(reset_data(&mut d, "invalid").is_err());
            assert_eq!(d.view.ai_nodes.len(), 2);
            reset_data(&mut d, "history").unwrap();
            assert!(d.view.history.is_empty()); assert!(!d.view.paused); assert_eq!(d.view.claude_ips.len(), 1);
            reset_data(&mut d, "ai").unwrap();
            assert!(d.view.ai_nodes.is_empty() && d.view.claude_ips.is_empty() && d.view.current_routes.is_empty() && d.view.ai_tests.is_empty());
            assert!(!d.geocache.is_empty()); assert!(d.view.paused); assert_eq!(d.generation, 1);
            reset_data(&mut d, "all").unwrap();
            assert!(d.geocache.is_empty() && d.nearby_cache.is_empty());
        }
        save(&s).unwrap();
        let loaded: Saved = serde_json::from_slice(&std::fs::read(path.join("settings.json")).unwrap()).unwrap();
        assert!(loaded.paused && loaded.ai_nodes.is_empty() && loaded.claude_ips.is_empty());
        assert!(loaded.settings.manual_nodes_only); assert_eq!(loaded.settings.claude_proxy, "http://127.0.0.1:7890");
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn tray_mark_targets_explicit_service_ip_and_preserves_notes() {
        let path = std::env::temp_dir().join(format!("sentinel-tray-test-{}", std::process::id()));
        let mut saved = Saved::default();
        claude::upsert(
            &mut saved.claude_ips,
            "claude",
            "8.8.8.8",
            claude::Safety::Pending,
            "原备注".into(),
            "t0",
        )
        .unwrap();
        claude::observe(&mut saved.claude_ips, "8.8.8.8", "claude.ai", "t1");
        claude::upsert(
            &mut saved.claude_ips,
            "gemini",
            "8.8.8.8",
            claude::Safety::Risk,
            "Gemini".into(),
            "t0",
        )
        .unwrap();
        let shared = shared(path.clone(), saved);
        mark_service_ip(&shared, "claude", "8.8.8.8", parse_safety("safe").unwrap()).unwrap();
        let loaded: Saved =
            serde_json::from_slice(&std::fs::read(path.join("settings.json")).unwrap()).unwrap();
        assert_eq!(loaded.claude_ips[0].status, claude::Safety::Safe);
        assert_eq!(loaded.claude_ips[0].note, "原备注");
        assert_eq!(loaded.claude_ips[0].first_open.as_deref(), Some("t1"));
        assert_eq!(loaded.claude_ips[1].status, claude::Safety::Risk);
        assert!(parse_safety("invalid").is_err());
        assert!(mark_service_ip(&shared, "gemini", "127.0.0.1", claude::Safety::Safe).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn unchanged_ip_reuses_persisted_metadata_without_http() {
        let path = std::env::temp_dir().join(format!("sentinel-cache-test-{}", std::process::id()));
        let mut saved = Saved::default();
        saved.settings.foreign_proxy = "invalid-proxy-for-test".into();
        saved.geocache.insert(
            "8.8.8.8".into(),
            (
                1,
                serde_json::json!({"ip":"8.8.8.8","postal":"43215","connection":{"asn":16509}}),
            ),
        );
        claude::upsert(
            &mut saved.claude_ips,
            "claude",
            "8.8.8.8",
            claude::Safety::Safe,
            "已确认".into(),
            "t0",
        )
        .unwrap();
        claude::observe(&mut saved.claude_ips, "8.8.8.8", "claude.ai", "t1");
        claude::upsert(
            &mut saved.claude_ips,
            "gemini",
            "8.8.8.8",
            claude::Safety::Risk,
            "不可用".into(),
            "t0",
        )
        .unwrap();
        let first = shared(path.clone(), saved);
        for _ in 0..3 {
            assert_eq!(
                cached_geo(&first, "8.8.8.8", false).await.unwrap()["postal"],
                "43215"
            );
        }
        assert!(lock(&first).geo_attempts.is_empty());
        save(&first).unwrap();
        let loaded: Saved =
            serde_json::from_slice(&std::fs::read(path.join("settings.json")).unwrap()).unwrap();
        let restarted = shared(path.clone(), loaded);
        {
            let d = lock(&restarted);
            assert_eq!(d.view.claude_ips.len(), 2);
            assert_eq!(d.view.claude_ips[0].status, claude::Safety::Safe);
            assert_eq!(d.view.claude_ips[0].first_open.as_deref(), Some("t1"));
            assert_eq!(d.view.claude_ips[1].status, claude::Safety::Risk);
            assert!(d.view.claude_ips[1].first_open.is_none());
        }
        let g = cached_geo(&restarted, "8.8.8.8", false).await.unwrap();
        assert_eq!(g["network_type"]["idc"], "是（ASN 参考）");
        assert!(lock(&restarted).geo_attempts.is_empty());
        std::fs::remove_dir_all(path).unwrap();
    }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    fn verdict(level: verdict::Level) -> verdict::Verdict {
        verdict::Verdict { level, ..Default::default() }
    }

    #[test]
    fn degraded_stays_green_when_ai_services_are_confirmed_usable() {
        let both_safe = [verdict(verdict::Level::Safe), verdict(verdict::Level::Safe)];
        assert_eq!(degraded_status(&both_safe), "usable");
    }

    #[test]
    fn degraded_warns_when_any_ai_service_is_not_confirmed() {
        let mixed = [verdict(verdict::Level::Safe), verdict(verdict::Level::Warn)];
        assert_eq!(degraded_status(&mixed), "degraded");
        assert_eq!(degraded_status(&[verdict(verdict::Level::Unknown)]), "degraded");
        assert_eq!(degraded_status(&[]), "degraded");
    }

    fn probe(id: &str, group: &str, ip: Option<&str>) -> Probe {
        Probe {
            id: id.into(),
            label: id.into(),
            group: group.into(),
            ip: ip.map(Into::into),
            checked: "now".into(),
            error: ip.is_none().then(|| "超时".into()),
            ..Default::default()
        }
    }

    #[test]
    fn issues_name_failing_checks_and_ignored_ones_do_not_degrade() {
        let mut v = View {
            probes: vec![
                probe("cn-ipip", "domestic", None),
                probe("global-cf", "foreign", Some("1.1.1.1")),
                probe("global-v6", "foreign6", None),
            ],
            ..Default::default()
        };
        assert_eq!(derive_status(&v), "degraded");
        let found = issues(&v);
        assert_eq!(found.len(), 1, "IPv6 is not required, so only IPIP counts: {found:?}");
        assert!(found[0].contains("cn-ipip") && found[0].contains("超时"));
        v.settings.ignored_checks = vec!["probe:cn-ipip".into()];
        assert!(v.settings.validate().is_ok());
        assert!(issues(&v).is_empty());
        assert_eq!(derive_status(&v), "stable");
        v.settings.ignored_checks = vec!["probe:nope".into()];
        assert!(v.settings.validate().is_err());
    }
}
