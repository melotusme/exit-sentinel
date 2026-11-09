//! AI service IP / node records: marking, manual tests and the per-service verdict.
use crate::{claude, copy_to_clipboard, lock, model, now, persist, push_event, refresh, shadowrocket, verdict, Shared, View};

/// Current exit IP of a service: the periodic same-path probe first, then the last manual test.
pub(crate) fn service_target(v: &View, service: &str) -> Option<(String, &'static str)> {
    exit_ip(v, service).map(|e| (e.ip, e.source))
}
pub(crate) fn exit_ip(v: &View, service: &str) -> Option<verdict::ExitIp> {
    let live = if service == "claude" { &v.claude } else { &v.gemini };
    if let Some(ip) = live.ip.as_ref().or(live.ipv6.as_ref()) {
        return Some(verdict::ExitIp { ip: ip.clone(), source: "实时观测", checked: live.checked_ip.clone() });
    }
    v.ai_tests.iter().find(|t| t.service == service).and_then(|t| {
        t.ip.as_ref().or(t.ipv6.as_ref()).map(|ip| verdict::ExitIp { ip: ip.clone(), source: "最近测试", checked: t.time.clone() })
    })
}
pub(crate) fn compute_verdicts(v: &View) -> Vec<verdict::Verdict> {
    [("claude", "Claude"), ("gemini", "Gemini")]
        .into_iter()
        .map(|(service, name)| {
            let live = if service == "claude" { &v.claude } else { &v.gemini };
            let ip_hint = live.error.clone().unwrap_or_else(|| "等待首次检测".into());
            let region = (service == "gemini" && !live.country_checked.is_empty()).then(|| verdict::Region {
                code: live.country.clone(),
                checked: live.country_checked.clone(),
                error: live.country_error.clone(),
            });
            verdict::compute(verdict::Input {
                service,
                name,
                ip: exit_ip(v, service),
                ip_hint,
                route: v.current_routes.iter().find(|r| r.service == service),
                ips: &v.claude_ips,
                nodes: &v.ai_nodes,
                health: v.service_health.iter().find(|r| r.id == service),
                region,
                paused: v.paused,
            })
        })
        .collect()
}
pub(crate) fn remember_observed_route(v: &mut View, service: &str, ip: &str) {
    let live = if service == "claude" { &v.claude } else { &v.gemini };
    let route = if live.ip.as_deref() == Some(ip) || live.ipv6.as_deref() == Some(ip) {
        live.route.clone()
    } else {
        v.ai_tests
            .iter()
            .find(|t| t.service == service && (t.ip.as_deref() == Some(ip) || t.ipv6.as_deref() == Some(ip)))
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
pub(crate) fn route_copy_text(v: &View, service: &str, ip: Option<&str>) -> Result<String, String> {
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
pub(crate) fn copy_ai_route(
    service: String,
    ip: Option<String>,
    s: tauri::State<Shared>,
) -> Result<(), String> {
    copy_to_clipboard(&route_copy_text(&lock(&s).view, &service, ip.as_deref())?)
}
pub(crate) fn safety_label(status: &claude::Safety) -> &'static str {
    match status {
        claude::Safety::Safe => "可用",
        claude::Safety::Risk => "风险 / 不可用",
        claude::Safety::Pending => "待确认",
    }
}
pub(crate) fn parse_safety(value: &str) -> Result<claude::Safety, String> {
    match value {
        "safe" => Ok(claude::Safety::Safe),
        "risk" => Ok(claude::Safety::Risk),
        "pending" => Ok(claude::Safety::Pending),
        _ => Err("未知状态".into()),
    }
}
pub(crate) fn mark_service_ip(
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
        if status != claude::Safety::Pending {
            crate::resolve_service_pending(&mut d.view, service);
        }
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
#[tauri::command]
pub(crate) async fn test_ai_services(
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<(), String> {
    run_ai_tests(app, s.inner().clone()).await
}
pub(crate) async fn run_ai_tests(app: tauri::AppHandle, s: Shared) -> Result<(), String> {
    let (settings, generation) = {
        let mut d = lock(&s);
        if d.view.ai_testing {
            return Err("AI 服务测试正在运行".into());
        }
        d.view.ai_testing = true;
        (d.view.settings.clone(), d.generation)
    };
    refresh(&app, &s);
    // The manual test also refreshes Google's view of the Gemini path (country + echo address).
    let (claude, gemini, _) = tokio::join!(
        claude::test_service("claude", &settings),
        claude::test_service("gemini", &settings),
        crate::exit_worker::observe_google(&s, &settings, generation)
    );
    let stale = {
        let mut d = lock(&s);
        d.view.ai_testing = false;
        let stale = d.generation != generation;
        if !stale {
            d.view.ai_tests = vec![claude, gemini];
            let ips = d.view.ai_tests.iter().flat_map(|t| {
                [t.ip.as_ref(), t.ipv6.as_ref()].into_iter().flatten()
                    .map(|ip| (t.service.clone(), ip.clone(), t.time.clone(), if ip.contains(':') { t.ipv6_basis.clone() } else { t.ip_basis.clone() }))
                    .collect::<Vec<_>>()
            }).collect::<Vec<_>>();
            for (service, ip, time, source) in ips {
                if !d.view.claude_ips.iter().any(|r| r.service == service && r.ip == ip) {
                    let _ = claude::upsert(&mut d.view.claude_ips, &service, &ip, claude::Safety::Pending, String::new(), &time);
                }
                if let Some(record) = d.view.claude_ips.iter_mut().find(|r| r.service == service && r.ip == ip) {
                    if record.source.is_empty() { record.source = format!("主动测试：{source}"); }
                }
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
pub(crate) async fn mark_node(
    s: &Shared,
    service: &str,
    key: &str,
    status: claude::Safety,
    note: Option<String>,
    current: bool,
) -> Result<(), String> {
    let generation = lock(s).generation;
    if !["claude", "gemini"].contains(&service) {
        return Err("未知 AI 服务".into());
    }
    let route = if current {
        let (proxy, manual_only) = {
            let d = lock(s);
            (if service == "claude" { d.view.settings.claude_proxy.clone() } else { d.view.settings.gemini_proxy.clone() }, d.view.settings.manual_nodes_only)
        };
        let route = shadowrocket::selected_capture(service, &proxy, manual_only).await;
        if route.fingerprint != key {
            return Err("代理客户端选择已变化或读取失败，请等待刷新后登记当前节点".into());
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
        if d.generation != generation { return Err("数据或设置已改变，请刷新后重新登记".into()); }
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
        shadowrocket::upsert_node(&mut d.view.ai_nodes, service, route, status.clone(), note, &now())?;
        if status != claude::Safety::Pending {
            crate::resolve_service_pending(&mut d.view, service);
        }
        push_event(&mut d, "手动设置 AI 服务节点", &detail);
    }
    persist(s);
    if let Some(e) = lock(s).view.storage_error.clone() {
        return Err(format!("状态已在内存生效，但保存失败：{e}"));
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn save_ai_node(
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
pub(crate) async fn save_claude_ip(
    service: String,
    ip: String,
    status: claude::Safety,
    note: String,
    attach_current: Option<bool>,
    app: tauri::AppHandle,
    s: tauri::State<'_, Shared>,
) -> Result<(), String> {
    let generation = lock(&s).generation;
    let normalized = model::public_ip(ip.trim())?;
    if !["claude", "gemini"].contains(&service.as_str()) {
        return Err("未知 AI 服务".into());
    }
    let manual_route = if attach_current.unwrap_or(false) {
        let (proxy, manual_only) = {
            let d = lock(&s);
            (if service == "claude" { d.view.settings.claude_proxy.clone() } else { d.view.settings.gemini_proxy.clone() }, d.view.settings.manual_nodes_only)
        };
        let mut route = shadowrocket::selected_capture(&service, &proxy, manual_only).await;
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
        if d.generation != generation { return Err("数据或设置已改变，请刷新后重新登记".into()); }
        claude::upsert(
            &mut d.view.claude_ips,
            &service,
            &normalized,
            status.clone(),
            note,
            &now(),
        )?;
        remember_observed_route(&mut d.view, &service, &normalized);
        if status != claude::Safety::Pending {
            crate::resolve_service_pending(&mut d.view, &service);
        }
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
