//! Tray menu built from the current view. Rebuilt only when the tray signature changes.
use crate::ai::{mark_node, mark_service_ip, parse_safety, route_copy_text, run_ai_tests, safety_label, service_target};
use crate::{
    copy_to_clipboard, diagnostics, get_autostart, intelligence, label, lock, notify, persist, refresh, set_autostart, show, tray,
    verdict, Shared, View,
};
use tauri::{Emitter, Manager};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

pub fn build(
    app: &tauri::AppHandle,
    s: &Shared,
    v: &View,
    autostart: Option<bool>,
    geodata: &BTreeMap<String, Value>,
    nearbydata: &BTreeMap<String, Value>,
) -> tauri::Result<Menu<tauri::Wry>> {
    let status = MenuItem::with_id(app, "status", label(&v.status), false, None::<&str>)?;
    let mut copies = HashMap::new();
    let make_family_menu = |group: &str,
                        family: &str,
                        copies: &mut HashMap<String, String>|
     -> tauri::Result<Submenu<tauri::Wry>> {
        let p = tray::exit_probe(&v.probes, group);
        let ip = p.and_then(|p| p.ip.as_deref());
        let sub = Submenu::with_id(app, group,
            tray::exit_title(family, p, v.paused, v.checking), true)?;
        sub.append(&MenuItem::with_id(app, format!("{group}-checked"),
            format!("{}：{}", if v.paused { "监控已暂停，上次检测" } else { "最近检测" },
                p.map(|p| p.checked.as_str()).filter(|s| !s.is_empty()).unwrap_or("尚未检测")),
            false, None::<&str>)?)?;
        if let Some(p) = p {
            sub.append(&MenuItem::with_id(app, format!("{group}-source"),
                format!("检测站：{}", p.label), false, None::<&str>)?)?;
        }
        let Some(ip) = ip else {
            let message = p.and_then(|p| p.error.as_deref()).unwrap_or(
                if v.paused { "恢复监控后检测此地址族" }
                else if v.checking { "正在检测此地址族，请稍候" }
                else { "尚无此地址族的检测结果" });
            sub.append(&MenuItem::with_id(app, format!("{group}-error"),
                message, false, None::<&str>)?)?;
            return Ok(sub);
        };
        let g = geodata.get(ip);
        let name = g
            .and_then(|g| g["connection"]["isp"].as_str())
            .unwrap_or("");
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
            ("ip", "IP 地址", ip.to_string()),
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
                        "待查询（可打开详情重试）"
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
        }
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        let detail = MenuItem::with_id(
            app,
            format!("exit-detail:{group}"),
            "打开完整详情…",
            true,
            None::<&str>,
        )?;
        sub.append(&detail)?;
        Ok(sub)
    };
    let cn = Submenu::with_id(
        app,
        "domestic-exit",
        tray::exit_group_title("国内出口", "domestic", "domestic6", &v.probes, geodata, v.paused, v.checking),
        true,
    )?;
    if let Some(ip) = tray::exit_probe(&v.probes, "domestic").and_then(|p| p.ip.as_deref()) {
        let id = "copy:quick:domestic".to_string();
        cn.append(&MenuItem::with_id(app, &id, format!("复制 IPv4：{ip}"), true, None::<&str>)?)?;
        cn.append(&PredefinedMenuItem::separator(app)?)?;
        copies.insert(id, ip.to_string());
    }
    cn.append(&make_family_menu("domestic", "IPv4", &mut copies)?)?;
    cn.append(&make_family_menu("domestic6", "IPv6", &mut copies)?)?;
    let gl = Submenu::with_id(
        app,
        "foreign-exit",
        tray::exit_group_title("国外出口", "foreign", "foreign6", &v.probes, geodata, v.paused, v.checking),
        true,
    )?;
    if let Some(ip) = tray::exit_probe(&v.probes, "foreign").and_then(|p| p.ip.as_deref()) {
        let id = "copy:quick:foreign".to_string();
        gl.append(&MenuItem::with_id(app, &id, format!("复制 IPv4：{ip}"), true, None::<&str>)?)?;
        gl.append(&PredefinedMenuItem::separator(app)?)?;
        copies.insert(id, ip.to_string());
    }
    gl.append(&make_family_menu("foreign", "IPv4", &mut copies)?)?;
    gl.append(&make_family_menu("foreign6", "IPv6", &mut copies)?)?;
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
    let data_settings = MenuItem::with_id(app, "data-settings", "导入代理节点 / 清空数据…", true, None::<&str>)?;
    let check = MenuItem::with_id(
        app,
        "check",
        if v.checking { "正在检测…" } else { "立即检测" },
        !v.paused && !v.checking,
        None::<&str>,
    )?;
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
    menu.append(&MenuItem::with_id(app, "uplink", uplink_title(v), false, None::<&str>)?)?;
    if wifi_name_blocked(v) {
        menu.append(&MenuItem::with_id(app, "wifi-permission", "　→ 允许读取 Wi-Fi 名称（申请定位权限）…", true, None::<&str>)?)?;
    }
    if v.unacknowledged {
        let changes: Vec<String> = if !v.pending_changes.is_empty() {
            v.pending_changes.clone()
        } else {
            v.history
                .first()
                .map(|e| format!("{}：{}", e.title, e.detail.lines().next().unwrap_or_default()))
                .into_iter()
                .collect()
        };
        for (i, change) in changes.iter().enumerate() {
            menu.append(&MenuItem::with_id(
                app,
                format!("change:{i}"),
                format!("　· {change}"),
                false,
                None::<&str>,
            )?)?;
        }
        menu.append(&MenuItem::with_id(
            app,
            "ack",
            if cfg!(target_os = "macos") { "✓ 确认已知变化（菜单内右键也可确认）" } else { "✓ 确认已知变化" },
            true,
            None::<&str>,
        )?)?;
    }
    for (i, issue) in v.issues.iter().enumerate() {
        menu.append(&MenuItem::with_id(app, format!("issue:{i}"), format!("　· {issue}"), false, None::<&str>)?)?;
    }
    if !v.issues.is_empty() {
        menu.append(&MenuItem::with_id(app, "issue-hint", "　可在监控面板 → 设置 → 忽略的检测项中忽略", false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for verdict in &v.verdicts {
        menu.append(&ai_service_menu(app, verdict, &mut copies)?)?;
    }
    lock(s).copy_values = copies;
    menu.append(&MenuItem::with_id(
        app,
        "ai-test",
        if v.ai_testing { "Claude + Gemini 测试中…" } else { "测试 Claude 和 Gemini" },
        !v.ai_testing,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let health_summary = if v.paused {
        "网站访问状态 · 已暂停".to_string()
    } else if v.service_health.is_empty() {
        "网站访问状态 · 等待检测".to_string()
    } else {
        let bad: Vec<String> = v
            .service_health
            .iter()
            .filter(|r| r.status != crate::connectivity::Status::Reachable && !v.settings.ignores(&format!("site:{}", r.id)))
            .map(|r| format!("{} {}", r.name, r.status.label()))
            .collect();
        if bad.is_empty() {
            "网站访问状态 · 全部正常".to_string()
        } else {
            format!("网站访问状态 · {}", bad.join(" / "))
        }
    };
    let services = Submenu::with_id(app, "service-health", health_summary, true)?;
    for (id, name) in [("google", "Google"), ("claude", "Claude"), ("gemini", "Gemini"), ("antigravity", "Antigravity")] {
        let title = if v.paused {
            format!("{name} · 监控已暂停")
        } else {
            v.service_health
                .iter()
                .find(|r| r.id == id)
                .map(|r| {
                    let detail = site_detail(&r.detail, id, &v.gemini);
                    if detail.is_empty() {
                        r.summary()
                    } else {
                        format!("{}（{}）", r.summary(), detail)
                    }
                })
                .unwrap_or_else(|| format!("{name} · 等待检测"))
        } + if v.settings.ignores(&format!("site:{id}")) {
            "（已忽略）"
        } else {
            ""
        };
        services.append(&MenuItem::with_id(app, format!("site-health:{id}"), title, false, None::<&str>)?)?;
    }
    menu.append(&cn)?;
    menu.append(&gl)?;
    menu.append(&services)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&open)?;
    menu.append(&check)?;
    if v.paused {
        menu.append(&MenuItem::with_id(app, "pause", "恢复监控", true, None::<&str>)?)?;
    }
    menu.append(&curl_menu)?;
    let maintenance = Submenu::with_id(app, "maintenance", "设置与维护", true)?;
    maintenance.append(&pause)?;
    maintenance.append(&PredefinedMenuItem::separator(app)?)?;
    maintenance.append(&autostart_item)?;
    maintenance.append(&data_settings)?;
    if crate::link::HAS_LOCATION_SETTINGS {
        maintenance.append(&MenuItem::with_id(
            app,
            "location-settings",
            "打开定位服务设置（Wi-Fi 名称）…",
            true,
            None::<&str>,
        )?)?;
    }
    maintenance.append(&MenuItem::with_id(
        app,
        "update",
        "检查软件更新…",
        true,
        None::<&str>,
    )?)?;
    menu.append(&maintenance)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// Google and Gemini share one exit judgement: the country Google assigns on the Gemini path.
/// Claude's detail already carries the Cloudflare trace location.
pub fn site_detail(detail: &str, id: &str, gemini: &crate::claude::Monitor) -> String {
    if !matches!(id, "google" | "gemini" | "antigravity") {
        return detail.to_string();
    }
    let region = if !gemini.country.is_empty() {
        let name = crate::google::country_name(&gemini.country);
        match gemini.country_source.as_str() {
            "" | "Gemini 页面" => format!("出口地区 {name}"),
            source => format!("出口地区 {name}，来自{source}"),
        }
    } else if gemini.country_error.is_some() {
        "出口地区未读取到".to_string()
    } else {
        return detail.to_string();
    };
    if detail.is_empty() { region } else { format!("{detail} · {region}") }
}

/// On Wi-Fi, but the system withheld the network name because of location permission.
pub fn wifi_name_blocked(v: &View) -> bool {
    crate::link::HAS_LOCATION_SETTINGS
        && v.uplink.medium == crate::link::Medium::Wireless
        && v.uplink.ssid.is_empty()
}

/// Tray click on "允许读取 Wi-Fi 名称". Menu events arrive on the main thread, which is where
/// macOS shows the location prompt.
fn fix_wifi_name(app: &tauri::AppHandle, s: &Shared) {
    match crate::link::request_or_open_settings() {
        Ok(result) => notify(app, s, "出口哨兵 · Wi-Fi 名称", result.message()),
        Err(error) => notify(app, s, "出口哨兵 · Wi-Fi 名称", &error),
    }
    s.wake.notify_one();
}

/// "出口链路 · 有线 · USB LAN" / "出口链路 · 无线 · HomeWiFi".
pub fn uplink_title(v: &View) -> String {
    if v.uplink.interface.is_empty() && v.network.is_empty() {
        return "出口链路 · 读取中…".into();
    }
    format!("出口链路 · {}", v.uplink.label())
}

/// Right click on the open tray menu (macOS). Same as "确认已知变化"; no-op when nothing is pending.
#[cfg(target_os = "macos")]
pub fn acknowledge_from_tray(app: &tauri::AppHandle, s: &Shared) {
    {
        let mut d = lock(s);
        if !d.view.unacknowledged {
            return;
        }
        crate::clear_pending_changes(&mut d.view);
    }
    refresh(app, s);
}

fn level_mark(level: verdict::Level) -> &'static str {
    match level {
        verdict::Level::Safe => "🟢",
        verdict::Level::Warn => "🟡",
        verdict::Level::Risk => "🔴",
        verdict::Level::Unknown => "⚪",
    }
}

fn status_text(status: &Option<crate::claude::Safety>) -> &'static str {
    status.as_ref().map(safety_label).unwrap_or("未登记")
}

fn info(app: &tauri::AppHandle, id: String, text: String) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, text, false, None::<&str>)
}

fn action(app: &tauri::AppHandle, id: String, text: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, id, text, true, None::<&str>)
}

/// One submenu per service: concise verdict + node/IP in the title, one-click marking inside.
fn ai_service_menu(
    app: &tauri::AppHandle,
    x: &verdict::Verdict,
    copies: &mut HashMap<String, String>,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let service = x.service.as_str();
    let sub = Submenu::with_id(
        app,
        format!("ai-service:{service}"),
        tray::ai_service_title(level_mark(x.level), x),
        true,
    )?;
    sub.append(&info(app, format!("ai-headline:{service}"), format!("结论：{}", x.headline))?)?;
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    match &x.ip {
        Some(ip) => {
            let copy_id = format!("copy:ai-ip:{service}");
            sub.append(&action(
                app,
                copy_id.clone(),
                &format!("出口 IP：{ip}（{}）· {}（点击复制）", x.ip_source, status_text(&x.ip_status)),
            )?)?;
            copies.insert(copy_id, ip.clone());
            for (status, expected, label) in [
                ("safe", crate::claude::Safety::Safe, "IP 标为可用"),
                ("risk", crate::claude::Safety::Risk, "IP 标为风险"),
                ("pending", crate::claude::Safety::Pending, "IP 标为待确认"),
            ] {
                let prefix = if x.ip_status.as_ref() == Some(&expected) { "✓ " } else { "" };
                sub.append(&action(app, format!("ai-mark:{service}:{status}:{ip}"), &format!("{prefix}{label}"))?)?;
            }
        }
        None => sub.append(&info(app, format!("ai-ip:{service}"), format!("出口 IP：未确认 · {}", x.ip_hint))?)?,
    }
    if !x.region_label.is_empty() {
        sub.append(&info(app, format!("ai-region:{service}"), format!("Google 判定地区：{}", x.region_label))?)?;
    } else if !x.region_hint.is_empty() {
        sub.append(&info(app, format!("ai-region:{service}"), format!("Google 判定地区：未知 · {}", x.region_hint))?)?;
    }
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    if x.node_name.is_empty() {
        sub.append(&info(app, format!("ai-node:{service}"), format!("节点：未确认 · {}", x.node_hint))?)?;
    } else {
        let age = if x.node_stale { " · 较早的连接记录" } else { "" };
        sub.append(&info(app, format!("ai-node:{service}"), format!("节点：{}（{}{age}）· {}", x.node_name, x.node_source, status_text(&x.node_status)))?)?;
    }
    if !x.node_key.is_empty() {
        for (status, expected, label) in [
            ("safe", crate::claude::Safety::Safe, "节点标为可用"),
            ("risk", crate::claude::Safety::Risk, "节点标为风险"),
            ("pending", crate::claude::Safety::Pending, "节点标为待确认"),
        ] {
            let prefix = if x.node_status.as_ref() == Some(&expected) { "✓ " } else { "" };
            sub.append(&action(
                app,
                format!("ai-node-mark:{service}:{status}:{}", x.node_key),
                &format!("{prefix}{label}"),
            )?)?;
        }
    }
    sub.append(&PredefinedMenuItem::separator(app)?)?;
    sub.append(&action(app, format!("ai-copy:{service}"), "复制节点信息")?)?;
    sub.append(&action(app, format!("ai-register:{service}:pending"), "手动登记 IP…")?)?;
    sub.append(&action(app, "ai-monitor".into(), "打开详情…")?)?;
    Ok(sub)
}

/// Tray menu clicks. Item ids are built in `build` and `ai_service_menu`.
pub fn on_event(app: &tauri::AppHandle, event: tauri::menu::MenuEvent) {
    // A right click that closed the menu may also land on the item under the pointer.
    #[cfg(target_os = "macos")]
    if crate::tray_right_click::swallow_item_event() {
        return;
    }
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
                Ok(()) => lock(&shared).view.ai_tests.iter().map(|t| format!("{}：{} · IPv4 {} · IPv6 {}", t.service, t.http_code.map(|c| format!("HTTP {c}")).unwrap_or_else(|| "连接失败".into()), t.ip.as_deref().unwrap_or("未确认"), t.ipv6.as_deref().unwrap_or("未确认"))).collect::<Vec<_>>().join("\n"),
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
            let _ = app.emit("ai-status-saved", &message);
            notify(app, &s, "出口哨兵 · IP 登记", &message);
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
    if let Some(group) = event.id.as_ref().strip_prefix("exit-detail:") {
        let probe = {
            let d = lock(&s);
            tray::exit_probe(&d.view.probes, group)
                .filter(|p| p.ip.is_some())
                .map(|p| p.id.clone())
        };
        if let Some(id) = probe {
            show(app);
            let _ = app.emit_to("main", "open-ip-detail", id);
        }
        return;
    }
    match event.id.as_ref() {
        "data-settings" => { show(app); let _ = app.emit_to("main", "open-data-settings", ()); },
        "autostart" => {
            let result = get_autostart(app.clone()).and_then(|enabled| {
                set_autostart(!enabled, app.clone(), app.state::<Shared>())
            });
            if let Err(error) = result {
                show(app);
                let _ = app.emit("autostart-error", error);
            }
        }
        "update" => { show(app); let _ = app.emit_to("main", "check-update", ()); },
        "open" => show(app),
        "wifi-permission" => fix_wifi_name(app, &s),
        "location-settings" => {
            if let Err(error) = crate::link::open_location_settings() {
                notify(app, &s, "出口哨兵 · 定位设置", &error);
            }
        }
        "check" => s.wake.notify_one(),
        "ack" => {
            crate::clear_pending_changes(&mut lock(&s).view);
            refresh(app, &s);
        }
        "pause" => {
            {
                let mut d = lock(&s);
                d.view.paused = !d.view.paused;
                if !d.view.paused { d.view.current_routes.clear(); }
                d.generation += 1;
            }
            // Same as the window's pause button: survive a restart.
            persist(&s);
            refresh(app, &s);
            s.wake.notify_one();
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::site_detail;

    #[test]
    fn google_and_gemini_show_google_assigned_region() {
        let mut m = crate::claude::Monitor::default();
        assert_eq!(site_detail("HTTP 200", "google", &m), "HTTP 200");
        m.country = "USA".into();
        assert_eq!(site_detail("HTTP 200", "google", &m), "HTTP 200 · 出口地区 美国");
        assert_eq!(site_detail("HTTP 200", "gemini", &m), "HTTP 200 · 出口地区 美国");
        assert_eq!(site_detail("HTTP 200 · 出口地区 US", "claude", &m), "HTTP 200 · 出口地区 US");
        m.country_source = "Gemini 帮助中心".into();
        assert_eq!(site_detail("HTTP 200", "antigravity", &m), "HTTP 200 · 出口地区 美国，来自Gemini 帮助中心");
        m.country.clear();
        m.country_error = Some("超时".into());
        assert_eq!(site_detail("HTTP 200", "gemini", &m), "HTTP 200 · 出口地区未读取到");
    }
}
