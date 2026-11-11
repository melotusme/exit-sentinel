use crate::model::public_ip;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Safety {
    #[default]
    Pending,
    Safe,
    Risk,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct IpRecord {
    #[serde(default)]
    pub routes: Vec<crate::shadowrocket::RouteSnapshot>,
    pub service: String,
    pub ip: String,
    pub status: Safety,
    pub note: String,
    pub added_at: String,
    pub first_open: Option<String>,
    pub last_open: Option<String>,
    pub source: String,
}
#[derive(Clone, Serialize, Default)]
pub struct Monitor {
    pub route: Option<crate::shadowrocket::RouteSnapshot>,
    pub running: Option<bool>,
    /// Process heartbeat (every few seconds).
    pub checked: String,
    /// Time of the last same-path exit IP probe.
    pub checked_ip: String,
    /// Gemini only: country Google assigns to this path (ISO alpha-3, e.g. "USA", "CHN").
    pub country: String,
    pub country_checked: String,
    /// Page the country was read from (Gemini page, or a fallback when that one is blocked).
    pub country_source: String,
    pub country_error: Option<String>,
    pub ip: Option<String>,
    pub ipv6: Option<String>,
    pub ipv6_error: Option<String>,
    pub source: String,
    pub error: Option<String>,
}
pub fn is_claude_process(line: &str) -> bool {
    let line = line.trim();
    line.ends_with("/Claude.app/Contents/MacOS/Claude")
        || line.ends_with("/Claude-3p.app/Contents/MacOS/Claude")
}
/// Linux has no official Claude Desktop; community packages (e.g. claude-desktop-debian,
/// claude-desktop-bin on the AUR) run Electron from a `claude-desktop` path. Claude Code (`claude`)
/// is a CLI and does not count.
#[cfg(any(test, not(any(target_os = "windows", target_os = "macos"))))]
pub fn is_linux_claude_cmdline(cmdline: &[u8]) -> bool {
    cmdline
        .split(|b| *b == 0)
        .take(2)
        .map(String::from_utf8_lossy)
        .any(|arg| arg.split('/').any(|part| part.eq_ignore_ascii_case("claude-desktop")))
}
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn running() -> Result<bool, String> {
    let dir = std::fs::read_dir("/proc").map_err(|e| format!("读取 Claude 进程失败：{e}"))?;
    Ok(dir.flatten().any(|entry| {
        entry.file_name().to_str().is_some_and(|n| n.bytes().all(|b| b.is_ascii_digit()))
            && std::fs::read(entry.path().join("cmdline"))
                .is_ok_and(|c| is_linux_claude_cmdline(&c))
    }))
}
#[cfg(target_os = "macos")]
pub fn running() -> Result<bool, String> {
    let out = crate::command("/bin/ps")
        .args(["-axo", "comm="])
        .output()
        .map_err(|e| format!("读取 Claude 进程失败：{e}"))?;
    if !out.status.success() {
        return Err("读取 Claude 进程失败".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(is_claude_process))
}
pub fn upsert(
    records: &mut Vec<IpRecord>,
    service: &str,
    ip: &str,
    status: Safety,
    note: String,
    now: &str,
) -> Result<(), String> {
    if !["claude", "gemini"].contains(&service) {
        return Err("未知 AI 服务".into());
    }
    let ip = public_ip(ip.trim())?;
    if note.chars().count() > 500 {
        return Err("备注最多 500 字".into());
    }
    if let Some(r) = records
        .iter_mut()
        .find(|r| r.service == service && r.ip == ip)
    {
        r.status = status;
        r.note = note;
    } else {
        records.push(IpRecord {
            routes: vec![],
            service: service.into(),
            ip,
            status,
            note,
            added_at: now.into(),
            first_open: None,
            last_open: None,
            source: String::new(),
        });
    }
    Ok(())
}
/// Called only on a fresh, successful probe while the main app process is running.
/// Returns a warning for first observation regardless of manually assigned safety.
pub fn observe(records: &mut Vec<IpRecord>, ip: &str, source: &str, now: &str) -> Option<String> {
    if !records.iter().any(|r| r.service == "claude" && r.ip == ip) {
        upsert(records, "claude", ip, Safety::Pending, String::new(), now).ok()?;
    }
    let r = records
        .iter_mut()
        .find(|r| r.service == "claude" && r.ip == ip)?;
    let first = r.first_open.is_none();
    if first {
        r.first_open = Some(now.into());
    }
    r.last_open = Some(now.into());
    r.source = source.into();
    if first {
        Some(format!(
            "首次观测：Claude 正在运行，{source} 出口为 {ip}。请核对分流并确认该 IP 状态。"
        ))
    } else if r.status != Safety::Safe {
        Some(format!(
            "Claude 正在运行，当前关联出口 {ip} 的状态为{}，请检查。",
            if r.status == Safety::Risk {
                "风险"
            } else {
                "待确认"
            }
        ))
    } else {
        None
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ServiceTest {
    #[serde(default)]
    pub route: Option<crate::shadowrocket::RouteSnapshot>,
    #[serde(default)]
    pub path: String,
    pub service: String,
    pub time: String,
    pub ip: Option<String>,
    #[serde(default)]
    pub ipv6: Option<String>,
    #[serde(default)]
    pub ipv6_basis: String,
    pub ip_basis: String,
    pub http_code: Option<u16>,
    pub latency: u64,
    pub error: Option<String>,
}
pub async fn test_service(service: &str, settings: &crate::model::Settings) -> ServiceTest {
    let (url, proxy, echo) = if service == "claude" {
        (
            "https://claude.ai/",
            &settings.claude_proxy,
            "https://claude.ai/cdn-cgi/trace",
        )
    } else {
        (
            "https://gemini.google.com/",
            &settings.gemini_proxy,
            settings.gemini_ip_url.as_str(),
        )
    };
    let mut report = ServiceTest {
        service: service.into(),
        path: if proxy.is_empty() {
            "本机路由 / TUN 与进程代理变量".into()
        } else if proxy == "direct" {
            "direct：忽略进程代理变量，仍遵循 TUN".into()
        } else {
            format!("显式代理：{proxy}")
        },
        time: crate::now(),
        ip_basis: if service == "claude" {
            "claude.ai 同域名 trace；本应用请求".into()
        } else if echo.is_empty() {
            "未配置 Gemini 同策略出口检测；IP 未确认".into()
        } else {
            format!("参考出口：{echo}；需确认与 Google 策略一致")
        },
        ..Default::default()
    };
    let before = crate::shadowrocket::selected_capture(service, proxy, settings.manual_nodes_only).await;
    let start = std::time::Instant::now();
    let client = match crate::net::client(proxy, false) {
        Ok(c) => c,
        Err(e) => {
            report.error = Some(e);
            return report;
        }
    };
    match client.get(url).send().await {
        Ok(r) => {
            report.http_code = Some(r.status().as_u16());
            if crate::google::is_sorry_redirect(&r) {
                report.error = Some(format!("{}；网络可达，不代表浏览器或账号不可用", crate::google::SORRY_NOTE));
            } else if !r.status().is_success() {
                report.error = Some(format!("主页 HTTP {}；不代表账号不可用", r.status()));
            }
        }
        Err(e) => {
            report.error = Some(format!("主页连接失败：{e}"));
        }
    }
    report.latency = start.elapsed().as_millis() as u64;
    if !echo.is_empty() {
        let p = crate::model::Probe {
            id: service.into(),
            url: echo.into(),
            group: "foreign".into(),
            ..Default::default()
        };
        let p = crate::net::run_probe(p, proxy.clone()).await;
        report.ip = p.ip;
        if let Some(e) = p.error {
            report.ip_basis = format!("{}；出口检测失败：{e}", report.ip_basis);
        }
        let v6 = crate::model::Probe { id: service.into(), url: echo.into(), group: "foreign6".into(), ..Default::default() };
        let v6 = crate::net::run_probe(v6, proxy.clone()).await;
        report.ipv6 = v6.ip;
        report.ipv6_basis = match v6.error {
            Some(e) => format!("IPv6 出口未确认：{e}"),
            None if service == "claude" => "claude.ai 同域名 trace 观测到 IPv6；仅代表本应用请求".into(),
            None => "参考检测站观测到 IPv6；需确认与 Google 策略一致".into(),
        };
    } else {
        report.ipv6_basis = "未配置同策略出口检测，IPv6 未确认".into();
    }
    let after = crate::shadowrocket::selected_capture(service, proxy, settings.manual_nodes_only).await;
    report.route = Some(crate::shadowrocket::correlate(&before, after));
    report
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "opt-in live Claude and Gemini service checks"]
    async fn live_ai_services() {
        println!("Claude Desktop running={:?}", running());
        let settings = crate::model::Settings::default();
        let (c, g) = tokio::join!(
            test_service("claude", &settings),
            test_service("gemini", &settings)
        );
        for r in [c, g] {
            assert!(!r.time.is_empty());
            assert!(r.http_code.is_some() || r.error.is_some());
            if r.service == "gemini" {
                assert!(r.ip.is_none());
            }
            println!("{}", serde_json::to_string(&r).unwrap());
        }
    }
    #[test]
    fn process_identity_excludes_code_and_helpers() {
        assert!(is_claude_process(
            "/Applications/Claude.app/Contents/MacOS/Claude"
        ));
        for p in ["claude", "/usr/local/bin/claude", "/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper", "/tmp/Claude"] {
            assert!(!is_claude_process(p));
        }
    }
    #[test]
    fn first_open_even_preapproved_then_durable_status_and_ip_change() {
        let mut records = vec![];
        upsert(
            &mut records,
            "claude",
            "8.8.8.8",
            Safety::Safe,
            "手动确认".into(),
            "t0",
        )
        .unwrap();
        assert!(observe(&mut records, "8.8.8.8", "Cloudflare", "t1")
            .unwrap()
            .contains("首次"));
        let mut records: Vec<IpRecord> =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        assert!(observe(&mut records, "8.8.8.8", "Cloudflare", "t2").is_none());
        assert!(observe(&mut records, "1.1.1.1", "Cloudflare", "t3").is_some());
        assert_eq!(records[1].status, Safety::Pending);
        upsert(
            &mut records,
            "gemini",
            "8.8.8.8",
            Safety::Pending,
            "独立状态".into(),
            "t3",
        )
        .unwrap();
        assert_eq!(records[0].status, Safety::Safe);
        assert_eq!(records[2].status, Safety::Pending);
        upsert(
            &mut records,
            "claude",
            "8.8.8.8",
            Safety::Risk,
            "".into(),
            "t4",
        )
        .unwrap();
        assert!(observe(&mut records, "8.8.8.8", "Cloudflare", "t5").is_some());
        assert_eq!(records[0].first_open.as_deref(), Some("t1"));
        assert_eq!(records[0].last_open.as_deref(), Some("t5"));
        assert!(upsert(
            &mut records,
            "claude",
            "127.0.0.1",
            Safety::Safe,
            "".into(),
            "t6"
        )
        .is_err());
    }
}

#[cfg(target_os = "windows")]
pub fn running() -> Result<bool, String> {
    let out = crate::command("tasklist.exe")
        .args(["/FI", "IMAGENAME eq Claude.exe", "/FO", "CSV", "/NH"])
        .output()
        .map_err(|_| "无法读取 Windows Claude 进程")?;
    if !out.status.success() {
        return Err("读取 Windows Claude 进程失败".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .any(|l| l.to_ascii_lowercase().starts_with("\"claude.exe\",")))
}

#[cfg(test)]
mod linux_process_tests {
    use super::is_linux_claude_cmdline;
    #[test]
    fn matches_community_claude_desktop_but_not_claude_code() {
        assert!(is_linux_claude_cmdline(b"/usr/lib/claude-desktop/electron\0/usr/lib/claude-desktop/app.asar\0"));
        assert!(is_linux_claude_cmdline(b"/usr/bin/claude-desktop\0--type=renderer\0"));
        assert!(is_linux_claude_cmdline(b"electron\0/usr/lib/claude-desktop\0"));
        assert!(!is_linux_claude_cmdline(b"/home/u/.local/bin/claude\0--resume\0"));
        assert!(!is_linux_claude_cmdline(b"node\0/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js\0"));
        assert!(!is_linux_claude_cmdline(b"vim\0notes\0/tmp/claude-desktop\0"));
    }
}
