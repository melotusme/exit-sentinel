//! Same-path exit IP for Claude (claude.ai trace) and, when configured, Gemini.
//! Runs whether or not Claude Desktop is open; the Desktop process only drives the
//! "first seen while Claude is running" alerts.
use crate::{claude, connectivity, lock, net, notify, now, persist, push_event, refresh, shadowrocket, Shared};
use crate::model::Probe;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_secs(3);
/// Re-check interval when nothing changed and Claude Desktop is closed.
const IDLE_RECHECK: Duration = Duration::from_secs(120);
const CLAUDE_TRACE: &str = "https://claude.ai/cdn-cgi/trace";
/// Google's view of the Gemini path downloads a ~140 KB page; refresh it sparingly.
const GOOGLE_RECHECK: Duration = Duration::from_secs(600);

#[derive(Default)]
struct Watch {
    last: Option<Instant>,
    path: String,
}
impl Watch {
    /// Probe on first run, when the network / proxy / node changes, or after `every`.
    /// After a probe the node snapshot may have been refreshed; adopt the new path so the
    /// refresh itself does not trigger a second probe.
    fn settle(&mut self, path: String) {
        self.path = path;
    }
    fn due(&mut self, path: &str, every: Duration, force: bool) -> bool {
        let due = force || self.path != path || self.last.map_or(true, |t| t.elapsed() >= every);
        if due {
            self.path = path.to_string();
            self.last = Some(Instant::now());
        }
        due
    }
}

/// Claude-only alert state across ticks.
#[derive(Default)]
struct Alerts {
    active: String,
    failed: bool,
    ip_changes: connectivity::IpChanges,
}

async fn probe_pair(id: &str, label: &str, url: &str, proxy: &str) -> (Probe, Probe) {
    let v4 = Probe { id: id.into(), label: label.into(), group: "foreign".into(), url: url.into(), ..Default::default() };
    let v6 = Probe { group: "foreign6".into(), ..v4.clone() };
    tokio::join!(net::run_probe(v4, proxy.to_string()), net::run_probe(v6, proxy.to_string()))
}

/// Settings are written only when IP records (status, observations, node history) changed.
fn records_signature(s: &Shared) -> String {
    serde_json::to_string(&lock(s).view.claude_ips).unwrap_or_default()
}

/// Gemini path as Google sees it: the country Google assigns, plus an exit address from either
/// the configured echo URL or Google's STUN server. A STUN answer equal to a domestic exit means
/// UDP went out the local line, so it is not used.
pub async fn observe_google(s: &Shared, settings: &crate::model::Settings, generation: u64) {
    let proxy = settings.gemini_proxy.as_str();
    let country = crate::google::judged_country(proxy);
    let (country, echo) = if settings.gemini_ip_url.is_empty() {
        let stun = async {
            if !proxy.is_empty() && proxy != "direct" {
                return Err("已设置 Gemini 显式代理，Google STUN（UDP）不经过该代理，无法代表 Gemini 出口".to_string());
            }
            tokio::task::spawn_blocking(crate::google::stun_ip).await.unwrap_or_else(|e| Err(e.to_string()))
        };
        let (country, ip) = tokio::join!(country, stun);
        (country, ip.map(|ip| (ip, "Google STUN 回显（UDP，经本机分流）".to_string())))
    } else {
        let (country, (v4, v6)) = tokio::join!(country, probe_pair("gemini", "Gemini 参考出口检测", &settings.gemini_ip_url, proxy));
        let ip = v4.ip.or(v6.ip).ok_or_else(|| v4.error.unwrap_or_else(|| "参考出口检测失败".into()));
        (country, ip.map(|ip| (ip, format!("参考出口：{}", settings.gemini_ip_url))))
    };
    let fresh = shadowrocket::selected_capture("gemini", proxy, settings.manual_nodes_only).await;
    let mut d = lock(s);
    if d.generation != generation || d.view.paused {
        return;
    }
    let domestic: Vec<String> = d.view.probes.iter().filter(|p| p.group.starts_with("domestic")).filter_map(|p| p.ip.clone()).collect();
    let echo = echo.and_then(|(ip, source)| {
        if domestic.contains(&ip) {
            Err(format!("Google STUN 回显的是国内出口 {ip}：UDP 没有经过代理，不能代表 Gemini 出口"))
        } else {
            Ok((ip, source))
        }
    });
    match d.view.current_routes.iter_mut().find(|r| r.service == "gemini") {
        Some(r) => *r = fresh.clone(),
        None => d.view.current_routes.push(fresh.clone()),
    }
    let now = now();
    let live = &mut d.view.gemini;
    live.route = Some(shadowrocket::correlate(&fresh, fresh.clone()));
    match &country {
        Ok(code) => {
            live.country = code.clone();
            live.country_error = None;
        }
        Err(e) => {
            live.country.clear();
            live.country_error = Some(e.clone());
        }
    }
    live.country_checked = now.clone();
    live.checked_ip = now;
    let (ip, ipv6) = match &echo {
        Ok((ip, _)) if ip.contains(':') => (None, Some(ip.clone())),
        Ok((ip, _)) => (Some(ip.clone()), None),
        Err(_) => (None, None),
    };
    live.ip = ip;
    live.ipv6 = ipv6;
    live.source = echo.as_ref().map(|(_, src)| src.clone()).unwrap_or_default();
    live.error = echo.as_ref().err().cloned();
    live.ipv6_error = None;
    if let Ok((ip, _)) = &echo {
        crate::ai::remember_observed_route(&mut d.view, "gemini", ip);
    }
}

fn route_of(s: &Shared, service: &str) -> shadowrocket::RouteSnapshot {
    lock(s).view.current_routes.iter().find(|r| r.service == service).cloned().unwrap_or_default()
}

/// Probe one service and store the reading. Returns the reading for alert handling.
async fn observe_exit(s: &Shared, service: &str, url: &str, proxy: &str, manual_only: bool, generation: u64) -> Option<(Probe, Probe, shadowrocket::RouteSnapshot)> {
    let label = if service == "claude" { "claude.ai 同域名 trace" } else { "Gemini 参考出口检测" };
    let (v4, v6) = probe_pair(service, label, url, proxy).await;
    // The snapshot taken right after the request is the best evidence. The cached one can be
    // up to a poll interval old (or empty at startup), so comparing against it would report
    // a node change that did not happen.
    let fresh = shadowrocket::selected_capture(service, proxy, manual_only).await;
    let route = shadowrocket::correlate(&fresh, fresh.clone());
    let mut d = lock(s);
    if d.generation != generation || d.view.paused {
        return None;
    }
    match d.view.current_routes.iter_mut().find(|r| r.service == service) {
        Some(r) => *r = fresh,
        None => d.view.current_routes.push(fresh),
    }
    let live = if service == "claude" { &mut d.view.claude } else { &mut d.view.gemini };
    live.route = Some(route.clone());
    live.source = v4.label.clone();
    live.ip = v4.ip.clone();
    live.ipv6 = v6.ip.clone();
    live.error = v4.error.clone();
    live.ipv6_error = v6.error.clone();
    live.checked_ip = now();
    for ip in [v4.ip.clone(), v6.ip.clone()].into_iter().flatten() {
        crate::ai::remember_observed_route(&mut d.view, service, &ip);
    }
    Some((v4, v6, route))
}

/// First-seen / not-yet-safe / IP-change alerts, only while Claude Desktop is running.
fn claude_alerts(s: &Shared, alerts: &mut Alerts, v4: &Probe, v6: &Probe, route: &shadowrocket::RouteSnapshot) -> Option<String> {
    let mut d = lock(s);
    let mut warning = None;
    if v4.ip.is_some() || v6.ip.is_some() {
        alerts.failed = false;
        let key = format!("{:?}:{:?}:{}:{}", v4.ip, v6.ip, route.fingerprint, route.error);
        if alerts.active != key {
            let stamp = now();
            let warnings: Vec<String> = [v4.ip.as_ref(), v6.ip.as_ref()]
                .into_iter()
                .flatten()
                .filter_map(|ip| {
                    let body = claude::observe(&mut d.view.claude_ips, ip, &v4.label, &stamp);
                    crate::ai::remember_observed_route(&mut d.view, "claude", ip);
                    body
                })
                .collect();
            if !warnings.is_empty() {
                warning = Some(format!("{}\n节点快照：{}", warnings.join("\n"), route.summary()));
            }
            alerts.active = key;
        }
    } else {
        alerts.active.clear();
        if !alerts.failed {
            warning = Some(format!(
                "Claude 正在运行，但 IPv4 和 IPv6 出口均未确认：IPv4 {}；IPv6 {}",
                v4.error.clone().unwrap_or_default(),
                v6.error.clone().unwrap_or_default()
            ));
        }
        alerts.failed = true;
    }
    let changes = alerts.ip_changes.observe(v4.ip.clone(), v6.ip.clone());
    if !changes.is_empty() {
        let change = format!("{}；本应用同域名请求，连续两次确认", changes.join("；"));
        warning = Some(match warning { Some(w) => format!("{w}\n{change}"), None => change });
    }
    if let Some(body) = &warning {
        d.view.unacknowledged = true;
        push_event(&mut d, "Claude 出口告警", body);
    }
    warning
}

pub async fn run(app: tauri::AppHandle, s: Shared) {
    let (mut claude_watch, mut gemini_watch) = (Watch::default(), Watch::default());
    let mut alerts = Alerts::default();
    let mut previous_running = false;
    loop {
        let (paused, settings, generation, network) = {
            let d = lock(&s);
            (d.view.paused, d.view.settings.clone(), d.generation, d.view.network.clone())
        };
        if paused {
            alerts = Alerts::default();
            previous_running = false;
            tokio::time::sleep(TICK).await;
            continue;
        }
        let running = tokio::task::spawn_blocking(claude::running).await.unwrap_or_else(|e| Err(e.to_string()));
        {
            let mut d = lock(&s);
            if d.generation != generation || d.view.paused {
                continue;
            }
            d.view.claude.running = running.as_ref().ok().copied();
            d.view.claude.checked = now();
        }
        let is_running = running == Ok(true);
        if !is_running {
            alerts.active.clear();
            alerts.failed = false;
            alerts.ip_changes = connectivity::IpChanges::default();
        }
        let just_started = is_running && !previous_running;
        previous_running = is_running;
        let interval = Duration::from_secs(settings.interval);
        let fingerprint = |service: &str| route_of(&s, service).fingerprint;

        let claude_path = |fp: String| format!("{}|{}|{}", settings.claude_proxy, network, fp);
        let every = if is_running { interval } else { interval.max(IDLE_RECHECK) };
        if claude_watch.due(&claude_path(fingerprint("claude")), every, just_started) {
            let records_before = records_signature(&s);
            let observed = observe_exit(&s, "claude", CLAUDE_TRACE, &settings.claude_proxy, settings.manual_nodes_only, generation).await;
            // Re-check the process after the round trip; never alert for a closed app.
            let still_running = tokio::task::spawn_blocking(claude::running).await.ok().and_then(Result::ok) == Some(true);
            let warning = match observed {
                Some((v4, v6, route)) if still_running => claude_alerts(&s, &mut alerts, &v4, &v6, &route),
                _ => None,
            };
            if let Some(body) = &warning {
                notify(&app, &s, "出口哨兵 · Claude 出口告警", body);
            }
            if warning.is_some() || records_signature(&s) != records_before {
                persist(&s);
            }
            claude_watch.settle(claude_path(fingerprint("claude")));
        }

        let gemini_path = |fp: String| format!("{}|{}|{}|{}", settings.gemini_proxy, settings.gemini_ip_url, network, fp);
        if gemini_watch.due(&gemini_path(fingerprint("gemini")), interval.max(GOOGLE_RECHECK), false) {
            let records_before = records_signature(&s);
            observe_google(&s, &settings, generation).await;
            if records_signature(&s) != records_before {
                persist(&s);
            }
            gemini_watch.settle(gemini_path(fingerprint("gemini")));
        }
        refresh(&app, &s);
        tokio::time::sleep(TICK).await;
    }
}

#[cfg(test)]
mod tests {
    use super::Watch;
    use std::time::Duration;

    #[test]
    fn watch_probes_on_change_or_schedule_only() {
        let mut w = Watch::default();
        assert!(w.due("a", Duration::from_secs(60), false));
        assert!(!w.due("a", Duration::from_secs(60), false));
        assert!(w.due("b", Duration::from_secs(60), false));
        assert!(w.due("b", Duration::from_secs(60), true));
        assert!(w.due("b", Duration::ZERO, false));
        // A snapshot refreshed by the probe itself must not cause another probe.
        assert!(w.due("c", Duration::from_secs(60), false));
        w.settle("c2".into());
        assert!(!w.due("c2", Duration::from_secs(60), false));
    }
}
