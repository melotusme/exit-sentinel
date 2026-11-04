//! Background website reachability, independent of IP echo and desktop process state.
use serde::Serialize;
use std::{collections::HashMap, time::Instant};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Reachable,
    Restricted,
    Unreachable,
}
impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Self::Reachable => "访问正常",
            Self::Restricted => "访问异常 / 受限",
            Self::Unreachable => "连接失败",
        }
    }
}
#[derive(Clone, Serialize)]
pub struct Reading {
    pub id: String,
    pub name: String,
    pub url: String,
    pub checked: String,
    pub status: Status,
    pub confirmed: Option<Status>,
    pub stable: bool,
    pub http_code: Option<u16>,
    pub latency: u64,
    pub detail: String,
    #[serde(skip)]
    proxy: String,
}
impl Reading {
    pub fn summary(&self) -> String {
        format!(
            "{} · {}{}",
            self.name,
            self.status.label(),
            if self.stable { "" } else { "（复核中）" }
        )
    }
    pub fn has_confirmed_problem(&self) -> bool {
        self.confirmed.is_some_and(|s| s != Status::Reachable)
    }
}

#[derive(Default)]
struct Watch {
    confirmed: Option<Status>,
    pending: Option<Status>,
    count: u8,
}
impl Watch {
    fn observe(&mut self, status: Status) -> bool {
        if self.confirmed == Some(status) {
            self.pending = None;
            self.count = 0;
            return false;
        }
        // A healthy startup establishes a baseline. A failed startup must still alert.
        if self.confirmed.is_none() && status == Status::Reachable {
            self.confirmed = Some(status);
            self.pending = None;
            self.count = 0;
            return false;
        }
        // A site that is already restricted (403 / 429) when monitoring starts is a known state,
        // not a new incident: confirm it silently so every app launch does not re-notify.
        let silent_baseline = self.confirmed.is_none() && status == Status::Restricted;
        if self.pending == Some(status) {
            self.count += 1;
        } else {
            self.pending = Some(status);
            self.count = 1;
        }
        if self.count < 2 {
            return false;
        }
        self.confirmed = Some(status);
        self.pending = None;
        self.count = 0;
        !silent_baseline
    }
}
pub struct Alert {
    pub title: String,
    pub detail: String,
}
#[derive(Default)]
pub struct Monitor {
    watches: HashMap<String, (String, Watch)>,
}
#[derive(Default)]
pub struct IpChanges {
    families: [crate::model::Tracker; 2],
}
impl IpChanges {
    pub fn observe(&mut self, ipv4: Option<String>, ipv6: Option<String>) -> Vec<String> {
        [ipv4, ipv6]
            .into_iter()
            .enumerate()
            .filter_map(|(i, value)| {
                self.families[i]
                    .observe(value)
                    .and_then(|(old, new)| match (old, new) {
                        (Some(old), Some(new)) => Some(format!(
                            "Claude {} 出口 IP 变化：{old} → {new}",
                            if i == 0 { "IPv4" } else { "IPv6" }
                        )),
                        _ => None,
                    })
            })
            .collect()
    }
}
impl Monitor {
    pub fn apply(&mut self, readings: &mut [Reading]) -> Vec<Alert> {
        let mut alerts = vec![];
        for r in readings {
            let (path, watch) = self.watches.entry(r.id.clone()).or_default();
            if *path != r.proxy {
                *path = r.proxy.clone();
                *watch = Watch::default();
            }
            if watch.observe(r.status) {
                let title = format!(
                    "{}{}",
                    r.name,
                    match r.status {
                        Status::Reachable => "访问恢复",
                        Status::Restricted => "访问异常",
                        Status::Unreachable => "无法连接",
                    }
                );
                alerts.push(Alert {
                    title,
                    detail: format!(
                        "{}：{}。连续两次检测确认；{}。本应用请求，不代表登录或账号状态。",
                        r.name,
                        r.detail,
                        if r.proxy.is_empty() {
                            "使用本机路由 / TUN 与进程代理"
                        } else if r.proxy == "direct" {
                            "忽略代理变量，仍遵循本机路由 / TUN"
                        } else {
                            "使用此服务的显式代理"
                        }
                    ),
                });
            }
            r.confirmed = watch.confirmed;
            r.stable = watch.confirmed == Some(r.status);
        }
        alerts
    }
}
fn classify(code: Option<u16>) -> Status {
    match code {
        Some(200..=399) => Status::Reachable,
        Some(_) => Status::Restricted,
        None => Status::Unreachable,
    }
}
async fn check(id: &str, name: &str, url: &str, proxy: &str) -> Reading {
    let start = Instant::now();
    let response = match crate::net::connectivity_client(proxy) {
        Ok(client) => client.get(url).send().await.map_err(|e| {
            if e.is_timeout() {
                "连接超时（12 秒）".to_string()
            } else {
                "无法建立 HTTPS 连接，请检查 DNS、TLS、路由或代理".to_string()
            }
        }),
        Err(e) => Err(e),
    };
    let (http_code, detail) = match response {
        Ok(r) => {
            let code = r.status().as_u16();
            (
                Some(code),
                match code {
                    200..=399 => format!("HTTP {code}"),
                    403 => "HTTP 403：验证页或访问受限；不代表账号不可用".into(),
                    429 => "HTTP 429：请求受到限流".into(),
                    _ => format!("HTTP {code}：服务返回异常状态"),
                },
            )
        }
        Err(e) => (None, e),
    };
    Reading {
        id: id.into(),
        name: name.into(),
        url: url.into(),
        checked: crate::now(),
        status: classify(http_code),
        confirmed: None,
        stable: false,
        http_code,
        latency: start.elapsed().as_millis() as u64,
        detail,
        proxy: proxy.into(),
    }
}
pub async fn check_all(settings: &crate::model::Settings) -> Vec<Reading> {
    let (google, claude, gemini) = tokio::join!(
        check(
            "google",
            "Google",
            "https://www.google.com/",
            &settings.gemini_proxy
        ),
        check(
            "claude",
            "Claude",
            "https://claude.ai/",
            &settings.claude_proxy
        ),
        check(
            "gemini",
            "Gemini",
            "https://gemini.google.com/",
            &settings.gemini_proxy
        ),
    );
    vec![google, claude, gemini]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "opt-in real website requests plus isolated refused-proxy fault and recovery"]
    async fn live_background_checks_and_fault_recovery() {
        let settings = crate::model::Settings::default();
        let mut monitor = Monitor::default();
        let mut initial = check_all(&settings).await;
        for r in &initial {
            println!("{} HTTP={:?} status={:?}", r.name, r.http_code, r.status);
        }
        assert!(
            initial.iter().all(|r| r.http_code.is_some()),
            "real sites must return an HTTP response for this verification"
        );
        assert!(monitor.apply(&mut initial).is_empty());
        let fault = crate::model::Settings {
            claude_proxy: "http://127.0.0.1:9".into(),
            gemini_proxy: "http://127.0.0.1:9".into(),
            ..settings.clone()
        };
        let mut down = check_all(&fault).await;
        assert!(down.iter().all(|r| r.status == Status::Unreachable));
        assert!(monitor.apply(&mut down).is_empty());
        let mut down = check_all(&fault).await;
        let alerts = monitor.apply(&mut down);
        assert_eq!(alerts.len(), 3);
        assert!(alerts.iter().all(|a| a.title.contains("无法连接")));
        assert!(monitor.apply(&mut down).is_empty());
        // Restore the configured path, then establish a fresh baseline on that path.
        let mut recovered = check_all(&settings).await;
        assert!(recovered.iter().all(|r| r.http_code.is_some()));
        monitor.apply(&mut recovered);
        // Also exercise recovery without a path change, matching a real outage.
        for r in &mut down {
            r.proxy.clear();
        }
        monitor.apply(&mut down);
        monitor.apply(&mut down);
        let healthy = recovered
            .iter()
            .filter(|r| r.status == Status::Reachable)
            .count();
        monitor.apply(&mut recovered);
        let recovered_alerts = monitor.apply(&mut recovered);
        assert_eq!(
            recovered_alerts
                .iter()
                .filter(|a| a.title.contains("访问恢复"))
                .count(),
            healthy
        );
        println!("isolated fault: 3 one-shot alerts; recovery: {healthy} website recovery alerts; user settings untouched");
    }
    #[test]
    fn startup_failure_alerts_once_then_recovers_and_can_fail_again() {
        let mut w = Watch::default();
        assert!(!w.observe(Status::Unreachable));
        assert!(w.observe(Status::Unreachable));
        for _ in 0..20 {
            assert!(!w.observe(Status::Unreachable));
        }
        assert!(!w.observe(Status::Reachable));
        assert!(w.observe(Status::Reachable));
        assert!(!w.observe(Status::Unreachable));
        assert!(w.observe(Status::Unreachable));
    }
    #[test]
    fn restricted_at_startup_is_a_silent_baseline_but_later_changes_alert() {
        let mut w = Watch::default();
        assert!(!w.observe(Status::Restricted));
        assert!(!w.observe(Status::Restricted));
        assert_eq!(w.confirmed, Some(Status::Restricted));
        assert!(!w.observe(Status::Reachable));
        assert!(w.observe(Status::Reachable));
        assert!(!w.observe(Status::Restricted));
        assert!(w.observe(Status::Restricted));
    }
    #[test]
    fn healthy_start_and_transient_failure_are_silent_and_hosts_are_independent() {
        let mut google = Watch::default();
        let mut claude = Watch::default();
        assert!(!google.observe(Status::Reachable));
        assert!(!claude.observe(Status::Reachable));
        assert!(!google.observe(Status::Unreachable));
        assert!(!google.observe(Status::Reachable));
        assert!(!claude.observe(Status::Restricted));
        assert!(claude.observe(Status::Restricted));
        assert_eq!(google.confirmed, Some(Status::Reachable));
        assert_eq!(classify(Some(403)), Status::Restricted);
        assert_eq!(classify(Some(429)), Status::Restricted);
        assert_eq!(classify(Some(503)), Status::Restricted);
        assert_eq!(classify(None), Status::Unreachable);
        assert_eq!(classify(Some(200)), Status::Reachable);
    }
    #[test]
    fn changing_explicit_proxy_resets_baseline_and_keeps_initial_failure_alerts() {
        let mut m = Monitor::default();
        let mut r = Reading {
            id: "google".into(),
            name: "Google".into(),
            url: String::new(),
            checked: String::new(),
            status: Status::Unreachable,
            confirmed: None,
            stable: false,
            http_code: None,
            latency: 0,
            detail: "超时".into(),
            proxy: String::new(),
        };
        assert!(m.apply(std::slice::from_mut(&mut r)).is_empty());
        assert_eq!(m.apply(std::slice::from_mut(&mut r)).len(), 1);
        r.proxy = "direct".into();
        assert!(m.apply(std::slice::from_mut(&mut r)).is_empty());
        assert!(!r.stable);
        assert_eq!(m.apply(std::slice::from_mut(&mut r)).len(), 1);
    }
    #[test]
    fn ip_changes_include_returning_addresses_and_keep_families_independent() {
        let mut ips = IpChanges::default();
        let a = Some("1.1.1.1".into());
        let b = Some("8.8.8.8".into());
        let six = Some("2606:4700:4700::1111".into());
        assert!(ips.observe(a.clone(), six.clone()).is_empty());
        assert!(ips.observe(b.clone(), six.clone()).is_empty());
        let change = ips.observe(b.clone(), six.clone());
        assert_eq!(change.len(), 1);
        assert!(change[0].contains("1.1.1.1 → 8.8.8.8"));
        assert!(ips.observe(a.clone(), None).is_empty());
        assert_eq!(ips.observe(a, None).len(), 1);
        assert!(ips.observe(None, None).is_empty());
        assert!(ips.observe(None, None).is_empty());
    }
}
