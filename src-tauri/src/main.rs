#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod clash_verge;
mod claude;
mod diagnostics;
mod intelligence;
mod model;
mod net;
mod private_updates;
mod shadowrocket;
mod sync;
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
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

#[derive(Clone, Serialize)]
struct View {
    ai_nodes: Vec<shadowrocket::NodeRecord>,
    current_routes: Vec<shadowrocket::RouteSnapshot>,
    ai_tests: Vec<claude::ServiceTest>,
    ai_testing: bool,
    claude: claude::Monitor,
    claude_ips: Vec<claude::IpRecord>,
    settings: Settings,
    probes: Vec<Probe>,
    history: Vec<Event>,
    network: String,
    paused: bool,
    checking: bool,
    unacknowledged: bool,
    status: String,
    last_check: String,
    notification_error: Option<String>,
    storage_error: Option<String>,
}
struct Data {
    tray_signature: String,
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
fn derive_status(v: &View) -> String {
    if v.paused {
        return "paused".into();
    }
    let core = v
        .probes
        .iter()
        .filter(|p| p.group != "ipv6")
        .collect::<Vec<_>>();
    if core.iter().all(|p| p.checked.is_empty()) {
        return "starting".into();
    }
    let good = core.iter().filter(|p| p.ip.is_some()).count();
    if good == 0 {
        return "offline".into();
    }
    if good < core.len() {
        return "degraded".into();
    }
    if v.unacknowledged {
        return "changed".into();
    }
    let first = core[0].ip.as_deref();
    if core.iter().any(|p| p.ip.as_deref() != first) {
        "split".into()
    } else {
        "stable".into()
    }
}
fn label(s: &str) -> &str {
    match s {
        "paused" => "已暂停",
        "offline" => "所有检测站不可达",
        "degraded" => "部分检测异常",
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
        "stable" | "split" => [62, 205, 148, 255],
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
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
fn service_target(v: &View, service: &str) -> Option<(String, &'static str)> {
    if service == "claude" && !v.paused && v.claude.running == Some(true) {
        if let Some(ip) = &v.claude.ip {
            return Some((ip.clone(), "当前 Claude 同域名观测"));
        }
    }
    if let Some(t) = v
        .ai_tests
        .iter()
        .find(|t| t.service == service && t.ip.is_some())
    {
        return Some((
            t.ip.clone().unwrap(),
            if service == "gemini" {
                "最近测试参考出口；需核对 Google 分流"
            } else {
                "最近测试出口；未确认当前 Desktop 路径"
            },
        ));
    }
    v.claude_ips
        .iter()
        .filter(|r| r.service == service)
        .max_by_key(|r| &r.added_at)
        .map(|r| (r.ip.clone(), "最近登记 IP；未确认当前出口"))
}
fn remember_observed_route(v: &mut View, service: &str, ip: &str) {
    let route = if service == "claude" && v.claude.ip.as_deref() == Some(ip) {
        v.claude.route.clone()
    } else {
        v.ai_tests
            .iter()
            .find(|t| t.service == service && t.ip.as_deref() == Some(ip))
            .and_then(|t| t.route.clone())
    };
    if let (Some(route), Some(record)) = (
        route,
        v.claude_ips
            .iter_mut()
            .find(|r| r.service == service && r.ip == ip),
    ) {
        shadowrocket::remember(&mut record.routes, route);
    }
}
fn route_copy_text(v: &View, service: &str, ip: Option<&str>) -> Result<String, String> {
    let route = if let Some(ip) = ip {
        v.claude_ips
            .iter()
            .find(|r| r.service == service && r.ip == ip)
            .and_then(|r| r.routes.iter().max_by_key(|s| &s.last_seen))
    } else {
        v.current_routes.iter().find(|r| r.service == service)
    };
    let r = route.ok_or("暂无节点快照；请先检测或等待新记录")?;
    Ok(format!("服务：{service}\n出口 IP：{}\n配置：{}\n模式：{}\n策略链：{}\n节点：{}\n节点服务器：{}\n节点 ID：{}\n来源：{}\n记录时间：{}\n证据：{}\n提示：{}", ip.unwrap_or("未确认；仅当前配置快照"), r.config, r.mode, r.chain.join(" → "), r.node_name, r.node_host, r.node_id, r.subscription, r.last_seen, r.basis, r.error))
}
#[tauri::command]
fn copy_ai_route(
    service: String,
    ip: Option<String>,
    s: tauri::State<Shared>,
) -> Result<(), String> {
    copy_to_clipboard(&route_copy_text(&lock(&s).view, &service, ip.as_deref())?)
}
fn safety_label(status: &claude::Safety) -> &'static str {
    match status {
        claude::Safety::Safe => "可用",
        claude::Safety::Risk => "风险 / 不可用",
        claude::Safety::Pending => "待确认",
    }
}
fn parse_safety(value: &str) -> Result<claude::Safety, String> {
    match value {
        "safe" => Ok(claude::Safety::Safe),
        "risk" => Ok(claude::Safety::Risk),
        "pending" => Ok(claude::Safety::Pending),
        _ => Err("未知状态".into()),
    }
}
fn mark_service_ip(
    s: &Shared,
    service: &str,
    ip: &str,
    status: claude::Safety,
) -> Result<(), String> {
    {
        let mut d = lock(s);
        let note = d
            .view
            .claude_ips
            .iter()
            .find(|r| r.service == service && r.ip == ip)
            .map(|r| r.note.clone())
            .unwrap_or_default();
        claude::upsert(
            &mut d.view.claude_ips,
            service,
            ip,
            status.clone(),
            note,
            &now(),
        )?;
        remember_observed_route(&mut d.view, service, ip);
        push_event(
            &mut d,
            "手动设置 AI 服务 IP",
            &format!("{service} · {ip} → {}", safety_label(&status)),
        );
    }
    persist(s);
    if let Some(e) = lock(s).view.storage_error.clone() {
        Err(format!("状态已在内存生效，但保存失败：{e}"))
    } else {
        Ok(())
    }
}
fn refresh(app: &tauri::AppHandle, s: &Shared) {
    let autostart = app.autolaunch().is_enabled().ok();
    let v = {
        let mut d = lock(s);
        d.view.status = derive_status(&d.view);
        d.view.clone()
    };
    let _ = app.emit("monitor-state", &v);
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
        "{}:{}:{}:{}:{:?}",
        v.status,
        v.paused,
        v.checking,
        v.unacknowledged,
        v.probes
            .iter()
            .map(|p| (&p.group, &p.ip))
            .collect::<Vec<_>>()
    ) + &format!(
        "{:?}:{:?}:{:?}:{:?}:{:?}:{}:{}",
        geodata,
        nearbydata,
        autostart,
        v.claude.running,
        v.claude.ip,
        serde_json::to_string(&v.claude_ips).unwrap_or_default(),
        serde_json::to_string(&v.ai_tests).unwrap_or_default()
            + &v.ai_testing.to_string()
            + &serde_json::to_string(&v.current_routes).unwrap_or_default()
            + &serde_json::to_string(&v.ai_nodes).unwrap_or_default()
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
        let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
            let status = MenuItem::with_id(app, "status", label(&v.status), false, None::<&str>)?;
            let mut copies = HashMap::new();
            let make_submenu = |group: &str,
                                title: &str,
                                copies: &mut HashMap<String, String>|
             -> tauri::Result<Submenu<tauri::Wry>> {
                let p = v.probes.iter().find(|p| p.group == group && p.ip.is_some());
                let ip = p.and_then(|p| p.ip.as_deref()).unwrap_or("未知");
                let sub = Submenu::with_id(app, group, format!("{title} {ip}"), true)?;
                let g = geodata.get(ip);
                let name = g
                    .and_then(|g| g["connection"]["isp"].as_str())
                    .unwrap_or(title);
                let location = g
                    .map(|g| {
                        ["country", "region", "city"]
                            .iter()
                            .filter_map(|k| g[*k].as_str())
                            .collect::<Vec<_>>()
                            .join(" / ")
                    })
                    .unwrap_or_default();
                let postal = g.and_then(|g| g["postal"].as_str()).unwrap_or("");
                let org = g
                    .and_then(|g| g["connection"]["org"].as_str())
                    .unwrap_or("");
                let asn = g
                    .and_then(|g| g["connection"]["asn"].as_u64())
                    .map(|n| format!("AS{n}"))
                    .unwrap_or_default();
                let timezone = g.and_then(|g| g["timezone"]["id"].as_str()).unwrap_or("");
                let network_type = g.map(intelligence::classification).unwrap_or_default();
                let tax = g.map(intelligence::sales_tax).unwrap_or_default();
                let mut rows = vec![
                    (
                        "sales-tax",
                        "美国免税州",
                        tax["label"].as_str().unwrap_or("待查询").into(),
                    ),
                    (
                        "sales-tax-note",
                        "税务说明",
                        tax["note"].as_str().unwrap_or("").into(),
                    ),
                    (
                        "network-type",
                        "网络类型",
                        network_type["label"].as_str().unwrap_or("待查询").into(),
                    ),
                    (
                        "network-basis",
                        "类型依据",
                        network_type["basis"].as_str().unwrap_or("待查询").into(),
                    ),
                    ("name", "IP 名称", name.to_string()),
                    (
                        "ip",
                        "IP 地址",
                        if p.is_some() {
                            ip.into()
                        } else {
                            String::new()
                        },
                    ),
                    ("location", "位置", location),
                    ("postal", "当地邮编（IP 定位）", postal.into()),
                    ("org", "所属组织", org.into()),
                    ("asn", "ASN", asn),
                    ("timezone", "时区", timezone.into()),
                ];
                if let Some(g) = g {
                    if let (Some(lat), Some(lon)) =
                        (g["latitude"].as_f64(), g["longitude"].as_f64())
                    {
                        if let Some(nearby) = nearbydata.get(&format!("{lat:.3},{lon:.3}")) {
                            if let Some(place) = nearby["places"].as_array().and_then(|a| a.first())
                            {
                                rows.push((
                                    "address",
                                    "附近公开地址",
                                    place["address"].as_str().unwrap_or("").into(),
                                ));
                                rows.push((
                                    "place-postal",
                                    "地点邮编",
                                    place["postal"].as_str().unwrap_or("").into(),
                                ));
                            }
                        }
                    }
                }
                let hint = MenuItem::with_id(
                    app,
                    format!("{group}-hint"),
                    "点击信息行即可复制",
                    false,
                    None::<&str>,
                )?;
                sub.append(&hint)?;
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                for (field, label, value) in rows {
                    let id = format!("copy:{group}:{field}");
                    let text = if value.is_empty() {
                        format!(
                            "{label}：{}",
                            if g.is_some() {
                                "未提供"
                            } else {
                                "查询中…"
                            }
                        )
                    } else {
                        format!("{label}：{value}")
                    };
                    let item = MenuItem::with_id(app, &id, text, !value.is_empty(), None::<&str>)?;
                    if !value.is_empty() {
                        copies.insert(id, value);
                    }
                    sub.append(&item)?;
                    sub.append(&PredefinedMenuItem::separator(app)?)?;
                }
                let detail = MenuItem::with_id(
                    app,
                    if group == "domestic" { "cn" } else { "gl" },
                    "打开完整详情…",
                    p.is_some(),
                    None::<&str>,
                )?;
                sub.append(&detail)?;
                Ok(sub)
            };
            let cn = make_submenu("domestic", "国内出口", &mut copies)?;
            let gl = make_submenu("foreign", "国外出口", &mut copies)?;
            lock(s).copy_values = copies;
            let curl_menu = Submenu::with_id(app, "curl-tests", "网站连通性 · curl", true)?;
            curl_menu.append(&MenuItem::with_id(
                app,
                "curl:all",
                "一键测试全部站点",
                true,
                None::<&str>,
            )?)?;
            for &(id, name, _, group) in diagnostics::SITES {
                curl_menu.append(&PredefinedMenuItem::separator(app)?)?;
                curl_menu.append(&MenuItem::with_id(
                    app,
                    format!("curl:{id}"),
                    format!(
                        "{name} · {}",
                        match group {
                            "domestic" => "国内路径",
                            "claude" => "Claude 独立路径",
                            "gemini" => "Gemini 独立路径",
                            _ => "国外路径",
                        }
                    ),
                    true,
                    None::<&str>,
                )?)?;
            }
            curl_menu.append(&PredefinedMenuItem::separator(app)?)?;
            curl_menu.append(&MenuItem::with_id(
                app,
                "curl:show",
                "打开测试结果面板",
                true,
                None::<&str>,
            )?)?;
            let open = MenuItem::with_id(app, "open", "打开监控面板", true, None::<&str>)?;
            let check = MenuItem::with_id(
                app,
                "check",
                "立即检测",
                !v.paused && !v.checking,
                None::<&str>,
            )?;
            let ack =
                MenuItem::with_id(app, "ack", "确认已知变化", v.unacknowledged, None::<&str>)?;
            let pause = MenuItem::with_id(
                app,
                "pause",
                if v.paused {
                    "恢复监控"
                } else {
                    "暂停监控"
                },
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "退出出口哨兵", true, None::<&str>)?;
            let autostart_item = CheckMenuItem::with_id(
                app,
                "autostart",
                if autostart.is_some() {
                    "开机自启"
                } else {
                    "开机自启（状态读取失败）"
                },
                autostart.is_some(),
                autostart.unwrap_or(false),
                None::<&str>,
            )?;
            let menu = Menu::new(app)?;
            menu.append(&status)?;
            menu.append(&MenuItem::with_id(
                app,
                "ai-monitor",
                format!(
                    "Claude：{} · AI 服务与 IP 状态…",
                    if v.paused {
                        "监控暂停"
                    } else {
                        match v.claude.running {
                            Some(true) => "运行中",
                            Some(false) => "未打开",
                            None => "待检测",
                        }
                    }
                ),
                true,
                None::<&str>,
            )?)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            for (service, name) in [("claude", "Claude"), ("gemini", "Gemini")] {
                let target = service_target(&v, service);
                let record = target.as_ref().and_then(|(ip, _)| {
                    v.claude_ips
                        .iter()
                        .find(|r| r.service == service && &r.ip == ip)
                });
                let title = target
                    .as_ref()
                    .map(|(ip, _)| {
                        format!(
                            "{name} · {} · {ip}",
                            record.map(|r| safety_label(&r.status)).unwrap_or("待确认")
                        )
                    })
                    .unwrap_or_else(|| format!("{name} · 出口未确认"));
                let sub = Submenu::with_id(app, format!("ai-service:{service}"), title, true)?;
                if let Some(route) = v.current_routes.iter().find(|r| r.service == service) {
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-config:{service}"),
                        format!(
                            "当前配置：{}",
                            if route.config.is_empty() {
                                "未读取"
                            } else {
                                &route.config
                            }
                        ),
                        false,
                        None::<&str>,
                    )?)?;
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-node:{service}"),
                        format!(
                            "当前选择（配置推断）：{}",
                            if route.node_name.is_empty() {
                                "未确认"
                            } else {
                                &route.node_name
                            }
                        ),
                        false,
                        None::<&str>,
                    )?)?;
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-chain:{service}"),
                        route.chain.join(" → "),
                        false,
                        None::<&str>,
                    )?)?;
                }
                if let Some(route) = v.current_routes.iter().find(|r| {
                    r.service == service
                        && r.consistent
                        && r.error.is_empty()
                        && !r.node_name.is_empty()
                }) {
                    let node = v
                        .ai_nodes
                        .iter()
                        .find(|r| r.service == service && r.key == route.fingerprint);
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-node-status:{service}"),
                        format!(
                            "节点状态：{}（不要求 IP）",
                            node.map(|r| safety_label(&r.status)).unwrap_or("未登记")
                        ),
                        false,
                        None::<&str>,
                    )?)?;
                    for (status, label) in [
                        ("safe", "当前节点标为可用"),
                        ("risk", "当前节点标为风险 / 不可用"),
                        ("pending", "登记当前节点为待确认"),
                    ] {
                        sub.append(&MenuItem::with_id(
                            app,
                            format!("ai-node-mark:{service}:{status}:{}", route.fingerprint),
                            label,
                            true,
                            None::<&str>,
                        )?)?;
                    }
                }
                if let Some(route) =
                    record.and_then(|r| r.routes.iter().max_by_key(|s| &s.last_seen))
                {
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-record-node:{service}"),
                        format!(
                            "此 IP 记录节点：{}（配置快照）",
                            if route.node_name.is_empty() {
                                "未确认"
                            } else {
                                &route.node_name
                            }
                        ),
                        false,
                        None::<&str>,
                    )?)?;
                }
                sub.append(&MenuItem::with_id(
                    app,
                    format!("ai-copy:{service}"),
                    "复制配置、策略链和节点信息",
                    true,
                    None::<&str>,
                )?)?;
                sub.append(&PredefinedMenuItem::separator(app)?)?;
                if let Some((ip, basis)) = &target {
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-basis:{service}"),
                        *basis,
                        false,
                        None::<&str>,
                    )?)?;
                    for (status, label) in [
                        ("safe", "标为可用"),
                        ("risk", "标为风险 / 不可用"),
                        ("pending", "标为待确认"),
                    ] {
                        sub.append(&MenuItem::with_id(
                            app,
                            format!("ai-mark:{service}:{status}:{ip}"),
                            label,
                            true,
                            None::<&str>,
                        )?)?;
                    }
                    sub.append(&PredefinedMenuItem::separator(app)?)?;
                }
                for (status, label) in [
                    ("safe", "登记可用 IP…"),
                    ("risk", "登记风险 IP…"),
                    ("pending", "登记待确认 IP…"),
                ] {
                    sub.append(&MenuItem::with_id(
                        app,
                        format!("ai-register:{service}:{status}"),
                        label,
                        true,
                        None::<&str>,
                    )?)?;
                }
                menu.append(&sub)?;
            }
            menu.append(&MenuItem::with_id(
                app,
                "ai-test",
                if v.ai_testing {
                    "Claude + Gemini 测试中…"
                } else {
                    "测试 Claude 和 Gemini"
                },
                !v.ai_testing,
                None::<&str>,
            )?)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&cn)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&gl)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&curl_menu)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
            menu.append(&autostart_item)?;
            menu.append(&MenuItem::with_id(
                app,
                "update",
                "检查软件更新…",
                true,
                None::<&str>,
            )?)?;
            for item in [&open, &check, &ack, &pause, &quit] {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                menu.append(item)?;
            }
            Ok(menu)
        })();
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
    let _fetch = s.geo_fetch.lock().await;
    let proxy = {
        let mut d = lock(s);
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
        d.view.settings.foreign_proxy.clone()
    };
    let mut value = net::geo(ip, &proxy).await?;
    intelligence::enrich(&mut value);
    value["cached_at"] = serde_json::json!(now());
    {
        let mut d = lock(s);
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
    let ips = lock(&s)
        .view
        .probes
        .iter()
        .filter_map(|p| p.ip.clone())
        .collect::<std::collections::HashSet<_>>();
    tauri::async_runtime::spawn(async move {
        for ip in ips {
            if cached_geo(&s, &ip, false).await.is_ok() {
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
        d.view.paused = paused;
        d.generation += 1;
    }
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
        {
            d.view.ai_tests.clear();
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
    let (lat, lon, proxy, key) = {
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
        (lat, lon, d.view.settings.foreign_proxy.clone(), key)
    };
    let v = net::nearby(lat, lon, &proxy).await?;
    intelligence::insert_cache(&mut lock(&s).nearby_cache, key, (stamp(), v.clone()));
    persist(&s);
    refresh(&app, &s);
    Ok(v)
}
#[tauri::command]
async fn test_ai_services(
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<(), String> {
    run_ai_tests(app, s.inner().clone()).await
}
async fn run_ai_tests(app: tauri::AppHandle, s: Shared) -> Result<(), String> {
    let (settings, generation) = {
        let mut d = lock(&s);
        if d.view.ai_testing {
            return Err("AI 服务测试正在运行".into());
        }
        d.view.ai_testing = true;
        (d.view.settings.clone(), d.generation)
    };
    refresh(&app, &s);
    let (claude, gemini) = tokio::join!(
        claude::test_service("claude", &settings),
        claude::test_service("gemini", &settings)
    );
    let stale = {
        let mut d = lock(&s);
        d.view.ai_testing = false;
        let stale = d.generation != generation;
        if !stale {
            d.view.ai_tests = vec![claude, gemini];
            let ips = d
                .view
                .ai_tests
                .iter()
                .filter_map(|t| t.ip.clone().map(|ip| (t.service.clone(), ip)))
                .collect::<Vec<_>>();
            for (service, ip) in ips {
                remember_observed_route(&mut d.view, &service, &ip);
            }
        }
        stale
    };
    persist(&s);
    refresh(&app, &s);
    if stale {
        Err("测试期间设置发生变化，请重新测试".into())
    } else {
        Ok(())
    }
}
async fn mark_node(
    s: &Shared,
    service: &str,
    key: &str,
    status: claude::Safety,
    note: Option<String>,
    current: bool,
) -> Result<(), String> {
    if !["claude", "gemini"].contains(&service) {
        return Err("未知 AI 服务".into());
    }
    let route = if current {
        let proxy = {
            let d = lock(s);
            if service == "claude" {
                d.view.settings.claude_proxy.clone()
            } else {
                d.view.settings.gemini_proxy.clone()
            }
        };
        let route = shadowrocket::capture(service, &proxy).await;
        if route.fingerprint != key {
            return Err("Shadowrocket 选择已变化，请刷新后登记当前节点".into());
        }
        route
    } else {
        lock(s)
            .view
            .ai_nodes
            .iter()
            .find(|r| r.service == service && r.key == key)
            .map(|r| r.route.clone())
            .ok_or("未找到登记节点")?
    };
    {
        let mut d = lock(s);
        let note = note.unwrap_or_else(|| {
            d.view
                .ai_nodes
                .iter()
                .find(|r| r.service == service && r.key == key)
                .map(|r| r.note.clone())
                .unwrap_or_default()
        });
        let detail = format!(
            "{service} · {} · {} → {}（节点登记，IP 未关联）",
            route.config,
            route.node_name,
            safety_label(&status)
        );
        shadowrocket::upsert_node(&mut d.view.ai_nodes, service, route, status, note, &now())?;
        push_event(&mut d, "手动设置 AI 服务节点", &detail);
    }
    persist(s);
    if let Some(e) = lock(s).view.storage_error.clone() {
        return Err(format!("状态已在内存生效，但保存失败：{e}"));
    }
    Ok(())
}
#[tauri::command]
async fn save_ai_node(
    service: String,
    key: String,
    status: claude::Safety,
    note: String,
    current: bool,
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<(), String> {
    let result = mark_node(&s, &service, &key, status, Some(note), current).await;
    refresh(&app, &s);
    result
}
#[tauri::command]
async fn save_claude_ip(
    service: String,
    ip: String,
    status: claude::Safety,
    note: String,
    attach_current: Option<bool>,
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<(), String> {
    let normalized = model::public_ip(ip.trim())?;
    if !["claude", "gemini"].contains(&service.as_str()) {
        return Err("未知 AI 服务".into());
    }
    let manual_route = if attach_current.unwrap_or(false) {
        let proxy = {
            let d = lock(&s);
            if service == "claude" {
                d.view.settings.claude_proxy.clone()
            } else {
                d.view.settings.gemini_proxy.clone()
            }
        };
        let mut route = shadowrocket::capture(&service, &proxy).await;
        if !route.error.is_empty() {
            return Err(format!("无法关联当前节点：{}", route.error));
        }
        route.association = "手动关联：出口 IP 由用户提供并确认".into();
        Some(route)
    } else {
        None
    };
    {
        let mut d = lock(&s);
        claude::upsert(
            &mut d.view.claude_ips,
            &service,
            &normalized,
            status,
            note,
            &now(),
        )?;
        remember_observed_route(&mut d.view, &service, &normalized);
        if let Some(route) = manual_route {
            if let Some(record) = d
                .view
                .claude_ips
                .iter_mut()
                .find(|r| r.service == service && r.ip == normalized)
            {
                shadowrocket::remember(&mut record.routes, route);
            }
        }
    }
    persist(&s);
    refresh(&app, &s);
    if let Some(e) = lock(&s).view.storage_error.clone() {
        Err(format!("内存已更新，保存失败：{e}"))
    } else {
        Ok(())
    }
}
async fn claude_worker(app: tauri::AppHandle, s: Shared) {
    let mut active = String::new();
    let mut last = Instant::now() - Duration::from_secs(3600);
    let mut previous_running = false;
    let mut previous_path = String::new();
    let mut failed = false;
    loop {
        let (paused, settings, generation, network) = {
            let d = lock(&s);
            (
                d.view.paused,
                d.view.settings.clone(),
                d.generation,
                d.view.network.clone(),
            )
        };
        if paused {
            active.clear();
            previous_running = false;
            failed = false;
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }
        let running = tokio::task::spawn_blocking(claude::running)
            .await
            .unwrap_or_else(|e| Err(e.to_string()));
        let path = format!("{}:{}:{}", "claude.ai", settings.claude_proxy, network);
        let should_probe = running == Ok(true)
            && (!previous_running
                || path != previous_path
                || last.elapsed() >= Duration::from_secs(settings.interval));
        {
            let mut d = lock(&s);
            d.view.claude.running = running.as_ref().ok().copied();
            d.view.claude.checked = now();
            if let Err(e) = &running {
                d.view.claude.error = Some(e.clone());
                d.view.claude.ip = None;
            }
            if running == Ok(false) {
                d.view.claude.ip = None;
                d.view.claude.error = None;
                active.clear();
                failed = false;
            }
        }
        previous_running = running == Ok(true);
        if should_probe {
            previous_path = path;
            last = Instant::now();
            let probe = Probe {
                id: "claude".into(),
                label: "claude.ai 同域名 trace".into(),
                group: "foreign".into(),
                url: "https://claude.ai/cdn-cgi/trace".into(),
                ..Default::default()
            };
            let proxy = settings.claude_proxy;
            let route_before = shadowrocket::capture("claude", &proxy).await;
            let result = net::run_probe(probe, proxy.clone()).await;
            let route_after = shadowrocket::capture("claude", &proxy).await;
            let route = shadowrocket::correlate(&route_before, route_after);
            // Recheck process after the network roundtrip; never record a closed app.
            let still_running = tokio::task::spawn_blocking(claude::running)
                .await
                .ok()
                .and_then(Result::ok);
            let mut warning = None;
            let mut changed = false;
            {
                let mut d = lock(&s);
                if d.generation == generation && !d.view.paused && still_running == Some(true) {
                    d.view.claude.route = Some(route.clone());
                    d.view.claude.source = result.label.clone();
                    d.view.claude.ip = result.ip.clone();
                    d.view.claude.error = result.error.clone();
                    if let Some(ip) = result.ip {
                        failed = false;
                        let key =
                            format!("{}:{ip}:{}:{}", result.id, route.fingerprint, route.error);
                        if active != key {
                            warning =
                                claude::observe(&mut d.view.claude_ips, &ip, &result.label, &now());
                            remember_observed_route(&mut d.view, "claude", &ip);
                            warning = warning
                                .map(|body| format!("{body}\n节点快照：{}", route.summary()));
                            active = key;
                            changed = true;
                        }
                    } else {
                        active.clear();
                        if !failed {
                            warning = Some(format!(
                                "Claude 正在运行，但 {} 出口检测失败，无法核对 IP：{}",
                                result.label,
                                result.error.unwrap_or_default()
                            ));
                        }
                        failed = true;
                    }
                    if let Some(body) = &warning {
                        d.view.unacknowledged = true;
                        push_event(&mut d, "Claude 出口告警", body);
                    }
                } else {
                    active.clear();
                    previous_running = false;
                    failed = false;
                }
            }
            if let Some(body) = warning {
                notify(&app, &s, "出口哨兵 · Claude 出口告警", &body);
                changed = true;
            }
            if changed {
                persist(&s);
            }
        }
        refresh(&app, &s);
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
async fn route_worker(app: tauri::AppHandle, s: Shared) {
    loop {
        let (settings, generation, paused) = {
            let d = lock(&s);
            (d.view.settings.clone(), d.generation, d.view.paused)
        };
        if !paused {
            let (claude, gemini) = tokio::join!(
                shadowrocket::capture("claude", &settings.claude_proxy),
                shadowrocket::capture("gemini", &settings.gemini_proxy)
            );
            let routes = vec![claude, gemini];
            let changed = {
                let mut d = lock(&s);
                if d.generation == generation
                    && !d.view.paused
                    && d.view
                        .current_routes
                        .iter()
                        .map(|r| (&r.fingerprint, &r.error))
                        .collect::<Vec<_>>()
                        != routes
                            .iter()
                            .map(|r| (&r.fingerprint, &r.error))
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
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}
async fn worker(app: tauri::AppHandle, s: Shared) {
    let mut last_probe = Instant::now() - Duration::from_secs(3600);
    loop {
        let force = tokio::select! {_ = s.wake.notified()=>true,_=tokio::time::sleep(Duration::from_secs(3))=>false};
        if lock(&s).view.paused {
            continue;
        }
        let network = tokio::task::spawn_blocking(net::network_snapshot)
            .await
            .unwrap_or_default();
        let network_change = {
            let mut d = lock(&s);
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
            let proxy = if p.group == "domestic" {
                settings.domestic_proxy.clone()
            } else {
                settings.foreign_proxy.clone()
            };
            net::run_probe(p, proxy)
        });
        let results = futures::future::join_all(jobs).await;
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
            d.view.last_check = now();
            if !details.is_empty() {
                d.view.unacknowledged = true;
                push_event(&mut d, "出口状态变化", &details.join("\n"));
            }
        }
        if !details.is_empty() {
            notify(&app, &s, "出口哨兵 · 出口状态变化", &details.join("\n"));
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
    let autostart = tauri_plugin_autostart::Builder::new();
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    tauri::Builder::default()
        .manage(private_updates::State::default())
        .manage(sync::State::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(autostart.arg("--autostart").build())
        .setup(|app| {
            let path = app.path().app_data_dir()?;
            let (mut saved, load_error) = match std::fs::read(path.join("settings.json")) {
                Ok(b) => match serde_json::from_slice::<Saved>(&b) {
                    Ok(v) => (v, None),
                    Err(e) => (
                        Saved::default(),
                        Some(format!("配置读取失败，已使用默认值：{e}")),
                    ),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Saved::default(), None),
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
                    copy_values: HashMap::new(),
                    view: View {
                        ai_nodes: saved.ai_nodes,
                        current_routes: vec![],
                        ai_tests: saved.ai_tests,
                        ai_testing: false,
                        claude: claude::Monitor::default(),
                        claude_ips: saved.claude_ips,
                        probes: net::probes(saved.settings.ipv6),
                        settings: saved.settings,
                        history: saved.history,
                        network: String::new(),
                        paused: false,
                        checking: false,
                        unacknowledged: false,
                        status: "starting".into(),
                        last_check: String::new(),
                        notification_error: None,
                        storage_error: load_error,
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
            tauri::WebviewWindowBuilder::new(
                app,
                "diagnostics",
                tauri::WebviewUrl::App("index.html?mode=diagnostics".into()),
            )
            .title("网站连通性 · curl")
            .inner_size(900.0, 720.0)
            .min_inner_size(680.0, 480.0)
            .visible(false)
            .skip_taskbar(true)
            .decorations(false)
            .build()?;
            TrayIconBuilder::with_id("sentinel")
                .icon(tray_image("starting"))
                .icon_as_template(false)
                .tooltip("出口哨兵 · 等待检测")
                .on_menu_event(|app, event| {
                    let s = app.state::<Shared>();
                    if let Some(id) = event.id.as_ref().strip_prefix("ai-node-mark:") {
                        let parts: Vec<_> = id.splitn(3, ':').map(String::from).collect();
                        if parts.len() == 3 {
                            let app = app.clone(); let shared = s.inner().clone();
                            tauri::async_runtime::spawn(async move {
                                let result = match parse_safety(&parts[1]) { Ok(status) => mark_node(&shared, &parts[0], &parts[2], status, None, true).await, Err(e) => Err(e) };
                                let message = result.map(|_| "节点状态已保存（无需 IP）".to_string()).unwrap_or_else(|e| e);
                                let _ = app.emit("ai-status-saved", &message);
                                notify(&app, &shared, "出口哨兵 · 节点登记", &message);
                                refresh(&app, &shared);
                            });
                        }
                        return;
                    }
                    if let Some(service) = event.id.as_ref().strip_prefix("ai-copy:") {
                        let text = { let d = lock(&s); let ip = service_target(&d.view, service).map(|t| t.0); route_copy_text(&d.view, service, ip.as_deref()).or_else(|_| route_copy_text(&d.view, service, None)) };
                        let message = text.and_then(|text| copy_to_clipboard(&text)).map(|_| "配置与节点信息已复制".to_string()).unwrap_or_else(|e| e);
                        let _ = app.emit("ai-status-saved", message); return;
                    }
                    if event.id.as_ref() == "ai-test" {
                        let app = app.clone(); let shared = s.inner().clone();
                        tauri::async_runtime::spawn(async move {
                            let result = run_ai_tests(app.clone(), shared.clone()).await;
                            let body = match result {
                                Err(e) => e,
                                Ok(()) => lock(&shared).view.ai_tests.iter().map(|t| format!("{}：{} · IP {}", t.service, t.http_code.map(|c| format!("HTTP {c}")).unwrap_or_else(|| "连接失败".into()), t.ip.as_deref().unwrap_or("未确认"))).collect::<Vec<_>>().join("\n"),
                            };
                            notify(&app, &shared, "出口哨兵 · AI 服务测试完成", &body);
                        });
                        return;
                    }
                    if event.id.as_ref().starts_with("ai-mark:") {
                        let parts = event.id.as_ref().splitn(4, ':').collect::<Vec<_>>();
                        if parts.len() == 4 {
                            let result = parse_safety(parts[2]).and_then(|status| mark_service_ip(&s, parts[1], parts[3], status));
                            let message = result.map(|_| format!("{} · {} 状态已保存", parts[1], parts[3])).unwrap_or_else(|e| e);
                            let _ = app.emit("ai-status-saved", message);
                            refresh(app, &s);
                        }
                        return;
                    }
                    if event.id.as_ref().starts_with("ai-register:") {
                        let parts = event.id.as_ref().split(':').collect::<Vec<_>>();
                        if parts.len() == 3 {
                            show(app);
                            let _ = app.emit_to("main", "open-ai-ip", serde_json::json!({"service":parts[1],"status":parts[2],"ip":"","note":""}));
                        }
                        return;
                    }
                    if event.id.as_ref() == "ai-monitor" {
                        show(app);
                        let _ = app.emit("open-ai-monitor", ());
                        return;
                    }
                    if event.id.as_ref().starts_with("copy:") {
                        let value = lock(&s).copy_values.get(event.id.as_ref()).cloned();
                        if let Some(value) = value {
                            if let Err(error) = copy_to_clipboard(&value) {
                                let _ = app.emit("clipboard-error", error);
                            }
                        }
                        return;
                    }
                    if let Some(id) = event.id.as_ref().strip_prefix("curl:") {
                        diagnostics::show_popup(app);
                        if id != "show" {
                            let _ = diagnostics::launch(app, id);
                        }
                        return;
                    }
                    match event.id.as_ref() {
                        "autostart" => {
                            let result = get_autostart(app.clone()).and_then(|enabled| {
                                set_autostart(!enabled, app.clone(), app.state::<Shared>())
                            });
                            if let Err(error) = result {
                                show(app);
                                let _ = app.emit("autostart-error", error);
                            }
                        }
                        "cn" | "gl" => {
                            let group = if event.id.as_ref() == "cn" {
                                "domestic"
                            } else {
                                "foreign"
                            };
                            let probe = lock(&s)
                                .view
                                .probes
                                .iter()
                                .find(|p| p.group == group && p.ip.is_some())
                                .map(|p| p.id.clone());
                            if let Some(id) = probe {
                                show(app);
                                let _ = app.emit_to("main", "open-ip-detail", id);
                            }
                        }
                        "update" => { show(app); let _ = app.emit_to("main", "check-update", ()); },
                        "open" => show(app),
                        "check" => s.wake.notify_one(),
                        "ack" => {
                            lock(&s).view.unacknowledged = false;
                            refresh(app, &s);
                        }
                        "pause" => {
                            {
                                let mut d = lock(&s);
                                d.view.paused = !d.view.paused;
                                d.generation += 1;
                            }
                            refresh(app, &s);
                            s.wake.notify_one();
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            if !std::env::args().any(|arg| arg == "--autostart") {
                show(app.handle());
            }
            refresh(app.handle(), &s);
            s.wake.notify_one();
            tauri::async_runtime::spawn(route_worker(app.handle().clone(), s.clone()));
            tauri::async_runtime::spawn(claude_worker(app.handle().clone(), s.clone()));
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
            private_updates::check_private_update,
            private_updates::install_private_update,
            get_state,
            save_claude_ip,
            save_ai_node,
            copy_ai_route,
            test_ai_services,
            get_autostart,
            set_autostart,
            check_now,
            acknowledge,
            set_paused,
            save_settings,
            clear_history,
            test_notification,
            get_cached_geography,
            lookup_geo,
            lookup_nearby,
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
    fn shared(path: PathBuf, saved: Saved) -> Shared {
        Shared {
            path,
            wake: Arc::new(Notify::new()),
            geo_fetch: Arc::new(tokio::sync::Mutex::new(())),
            data: Arc::new(Mutex::new(Data {
                tray_signature: String::new(),
                copy_values: HashMap::new(),
                view: View {
                    ai_nodes: saved.ai_nodes,
                    current_routes: vec![],
                    ai_tests: saved.ai_tests,
                    ai_testing: false,
                    claude: claude::Monitor::default(),
                    claude_ips: saved.claude_ips,
                    settings: saved.settings,
                    probes: vec![],
                    history: saved.history,
                    network: String::new(),
                    paused: false,
                    checking: false,
                    unacknowledged: false,
                    status: String::new(),
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
