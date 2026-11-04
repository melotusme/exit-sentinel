use crate::model::{parse_ip, public_ip, Probe};
use reqwest::{Client, Proxy};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

pub fn client(proxy: &str, ipv6: bool) -> Result<Client, String> {
    client_for_probe(proxy, ipv6, false)
}
fn client_for_probe(proxy: &str, ipv6: bool, force_v6_direct: bool) -> Result<Client, String> {
    let mut b = client_builder(proxy)?;
    // Force IPv4 for comparable primary probes; IPv6 is a separate optional observation.
    if !ipv6 {
        b = b.local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
    } else if force_v6_direct && proxy == "direct" {
        b = b.local_address(std::net::IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED));
    }
    b.build().map_err(|e| format!("无法建立检测客户端：{e}"))
}
// Website availability uses the usable address family; IP probes remain independent.
pub fn connectivity_client(proxy: &str) -> Result<Client, String> {
    client_builder(proxy)?.build().map_err(|_| "无法建立连通性检测客户端".into())
}
fn client_builder(proxy: &str) -> Result<reqwest::ClientBuilder, String> {
    let mut b = Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .user_agent("ExitSentinel/0.1 (personal network monitor)")
        .redirect(reqwest::redirect::Policy::limited(3));
    if proxy == "direct" {
        b = b.no_proxy();
    } else if !proxy.is_empty() {
        b = b
            .no_proxy()
            .proxy(Proxy::all(proxy).map_err(|_| "无法配置代理")?);
    }
    Ok(b)
}
pub fn probes(_ipv6: bool) -> Vec<Probe> {
    let items = vec![
        (
            "cn-ipip",
            "国内 · IPIP",
            "domestic",
            "https://myip.ipip.net",
        ),
        ("cn-3322", "国内 · 3322", "domestic", "https://ip.3322.net"),
        (
            "global-cf",
            "国外 · Cloudflare",
            "foreign",
            "https://www.cloudflare.com/cdn-cgi/trace",
        ),
        (
            "global-ipify",
            "国外 · ipify",
            "foreign",
            "https://api.ipify.org?format=json",
        ),
        ("cn-v6", "国内 · IPv6", "domestic6", "https://6.ipw.cn"),
        ("global-v6", "国外 · IPv6", "foreign6", "https://api6.ipify.org?format=json"),
    ];
    items
        .into_iter()
        .map(|(id, label, group, url)| Probe {
            id: id.into(),
            label: label.into(),
            group: group.into(),
            url: url.into(),
            ..Default::default()
        })
        .collect()
}
pub async fn run_probe(mut p: Probe, proxy: String) -> Probe {
    let start = Instant::now();
    let result = async {
        let v6 = p.group.ends_with('6') || p.group == "ipv6";
        let c = client_for_probe(&proxy, v6, true)?;
        let response = c.get(&p.url).send().await.map_err(|e| {
            if e.is_timeout() {
                "连接超时（12 秒）".into()
            } else {
                "无法连接检测站（请检查路由、代理或 DNS）".to_string()
            }
        })?;
        let code = response.status();
        if !code.is_success() {
            return Err(format!("检测站返回 HTTP {code}"));
        }
        let body = response
            .text()
            .await
            .map_err(|_| "无法读取检测响应".to_string())?;
        if body.len() > 65536 {
            return Err("检测响应过大".into());
        }
        if p.id == "claude" && !body.lines().any(|l| l.trim() == "h=claude.ai") {
            return Err("Claude trace 响应域名不匹配，出口未确认".into());
        }
        let ip = parse_ip(&body)?;
        if v6 != ip.contains(':') {
            return Err("返回地址族与检测项不一致".into());
        }
        let detail = if p.id == "cn-ipip" {
            body.trim().to_string()
        } else if p.id == "global-cf" {
            body.lines()
                .filter(|l| l.starts_with("loc=") || l.starts_with("colo="))
                .collect::<Vec<_>>()
                .join(" · ")
        } else {
            String::new()
        };
        Ok((ip, detail))
    }
    .await;
    p.checked = chrono::Local::now().to_rfc3339();
    p.latency = start.elapsed().as_millis() as u64;
    match result {
        Ok((ip, detail)) => {
            p.last_good_ip = Some(ip.clone());
            p.ip = Some(ip);
            p.error = None;
            p.detail = detail;
        }
        Err(error) => {
            p.ip = None;
            p.error = Some(error);
            p.detail.clear();
        }
    }
    p
}
fn output(bin: &str, args: &[&str]) -> String {
    crate::command(bin)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Local source addresses of the default IPv4 / IPv6 routes. A UDP connect only asks the
/// kernel for a route: no packet is sent and no child process is started.
pub fn quick_signature() -> String {
    use std::net::UdpSocket;
    let local = |bind: &str, target: &str| {
        UdpSocket::bind(bind)
            .and_then(|s| {
                s.connect(target)?;
                s.local_addr()
            })
            .map(|a| a.ip().to_string())
            .unwrap_or_default()
    };
    format!(
        "{}|{}",
        local("0.0.0.0:0", "1.1.1.1:53"),
        local("[::]:0", "[2606:4700:4700::1111]:53")
    )
}

/// The full snapshot runs several system commands. Take it every 15 s, or right away when the
/// quick signature moves, then a couple of ticks in a row so the change tracker can confirm it.
const FULL_SNAPSHOT_EVERY: Duration = Duration::from_secs(15);
const CONFIRM_TICKS: u8 = 2;
#[derive(Default)]
pub struct NetworkSampler {
    quick: Option<String>,
    last_value: Option<String>,
    last_full: Option<Instant>,
    burst: u8,
}
impl NetworkSampler {
    pub fn full_due(&mut self, quick: &str, force: bool) -> bool {
        if self.quick.as_deref().is_some_and(|q| q != quick) {
            self.burst = CONFIRM_TICKS + 1;
        }
        self.quick = Some(quick.to_string());
        let due = force
            || self.burst > 0
            || self.last_full.map_or(true, |t| t.elapsed() >= FULL_SNAPSHOT_EVERY);
        self.burst = self.burst.saturating_sub(1);
        due
    }
    pub fn record_full(&mut self, full: &str) {
        if self.last_value.as_deref().is_some_and(|v| v != full) {
            self.burst = self.burst.max(CONFIRM_TICKS);
        }
        self.last_value = Some(full.to_string());
        self.last_full = Some(Instant::now());
    }
}

#[cfg(test)]
mod sampler_tests {
    use super::NetworkSampler;

    #[test]
    fn steady_network_skips_full_snapshot() {
        let mut s = NetworkSampler::default();
        assert!(s.full_due("a", false));
        s.record_full("net");
        assert!(!s.full_due("a", false));
        assert!(!s.full_due("a", false));
    }

    #[test]
    fn quick_change_samples_enough_ticks_to_confirm() {
        let mut s = NetworkSampler::default();
        assert!(s.full_due("a", false));
        s.record_full("net");
        assert!(s.full_due("b", false));
        s.record_full("net2");
        assert!(s.full_due("b", false));
        s.record_full("net2");
    }

    #[test]
    fn slow_full_change_gets_a_follow_up_sample() {
        let mut s = NetworkSampler::default();
        assert!(s.full_due("a", false));
        s.record_full("net");
        s.record_full("proxy-changed");
        assert!(s.full_due("a", false));
    }

    #[test]
    fn manual_check_forces_full_snapshot() {
        let mut s = NetworkSampler::default();
        assert!(s.full_due("a", false));
        s.record_full("net");
        assert!(s.full_due("a", true));
    }
}
#[cfg(not(target_os = "windows"))]
pub fn network_snapshot() -> String {
    // scutil output has no timestamps; do not store DNS cache, cookies, or Wi-Fi credentials.
    let nwi = output("/usr/sbin/scutil", &["--nwi"]);
    let route = output("/sbin/route", &["-n", "get", "default"]);
    let route = route
        .lines()
        .filter(|l| l.contains("interface:") || l.contains("gateway:"))
        .collect::<Vec<_>>()
        .join("\n");
    let proxy = output("/usr/sbin/scutil", &["--proxy"]);
    let route6 = output("/sbin/route", &["-n", "get", "-inet6", "default"]);
    let route6 = route6.lines().filter(|l| l.contains("interface:") || l.contains("gateway:")).collect::<Vec<_>>().join("\n");
    format!("{nwi}\n\nIPv4 默认路由\n{route}\n\nIPv6 默认路由\n{route6}\n\nmacOS 系统代理（仅展示，不自动导入 PAC）\n{proxy}")
}
pub async fn geo(ip: &str, proxy: &str) -> Result<Value, String> {
    let ip = public_ip(ip)?;
    let c = client(proxy, true)?;
    let r = c
        .get(format!("https://ipwho.is/{ip}"))
        .send()
        .await
        .map_err(|_| "IP 详情服务连接失败")?;
    if r.status().as_u16() == 429 {
        return Err("IP 详情服务达到额度，请稍后再试；出口检测仍继续".into());
    }
    let v: Value = r
        .error_for_status()
        .map_err(|e| {
            format!(
                "IP 详情服务：{}",
                e.status().map(|s| s.to_string()).unwrap_or_default()
            )
        })?
        .json()
        .await
        .map_err(|_| "IP 详情响应不是有效 JSON")?;
    if v["success"] != true {
        return Err(v["message"].as_str().unwrap_or("IP 定位未成功").into());
    }
    if v["ip"].as_str().and_then(|s| public_ip(s).ok()).as_deref() != Some(ip.as_str()) {
        return Err("IP 详情响应地址不匹配".into());
    }
    Ok(v)
}
/// Forward-geocode one user-typed address with OpenStreetMap Nominatim (single, user-triggered
/// request; the caller throttles). English names keep regions comparable with the place table.
pub async fn geocode(query: &str, proxy: &str) -> Result<Value, String> {
    let c = client(proxy, true)?;
    let v: Value = c
        .get("https://nominatim.openstreetmap.org/search")
        .query(&[("format", "jsonv2"), ("q", query), ("addressdetails", "1"), ("limit", "1"), ("accept-language", "en")])
        .send()
        .await
        .map_err(|_| "地址查询超时或不可达，请稍后重试")?
        .error_for_status()
        .map_err(|_| "OpenStreetMap 服务繁忙或限流，请稍后重试")?
        .json()
        .await
        .map_err(|_| "地址服务响应无效")?;
    v.as_array()
        .and_then(|a| a.first())
        .cloned()
        .ok_or_else(|| "没有找到这个地址，请换一种写法（如城市名、州名或完整地址）".into())
}
pub async fn nearby(lat: f64, lon: f64, proxy: &str) -> Result<Value, String> {
    if !lat.is_finite()
        || !lon.is_finite()
        || !(-90.0..=90.0).contains(&lat)
        || !(-180.0..=180.0).contains(&lon)
    {
        return Err("无有效定位坐标".into());
    }
    // Nominatim public service policy: user-triggered only, cache, identifying UA,
    // and far below one request/second. Never perform bulk/grid queries.
    let dy = 10.0 / 111.32;
    let dx = (10.0 / (111.32 * lat.to_radians().cos().abs().max(0.01))).min(180.0);
    let box_ = format!(
        "{},{},{},{}",
        (lon - dx).max(-180.0),
        (lat + dy).min(90.0),
        (lon + dx).min(180.0),
        (lat - dy).max(-90.0)
    );
    let c = client(proxy, true)?;
    let r = c
        .get("https://nominatim.openstreetmap.org/search")
        .query(&[
            ("format", "jsonv2"),
            ("amenity", "library"),
            ("viewbox", box_.as_str()),
            ("bounded", "1"),
            ("addressdetails", "1"),
            ("limit", "20"),
        ])
        .send()
        .await
        .map_err(|_| "公开地点查询超时或不可达，请稍后重试")?;
    let v: Value = r
        .error_for_status()
        .map_err(|_| "OpenStreetMap 服务繁忙或限流")?
        .json()
        .await
        .map_err(|_| "地点服务响应无效")?;
    let mut places = Vec::new();
    for e in v.as_array().ok_or("地点服务未返回地点列表")? {
        let t = &e["address"];
        if t["house_number"].as_str().is_none()
            || t["road"].as_str().is_none()
            || e["name"].as_str().is_none()
        {
            continue;
        }
        let plat = e["lat"].as_str().and_then(|s| s.parse::<f64>().ok());
        let plon = e["lon"].as_str().and_then(|s| s.parse::<f64>().ok());
        if let (Some(a), Some(b)) = (plat, plon) {
            let distance = haversine(lat, lon, a, b);
            if distance > 10.0 {
                continue;
            }
            let address = [
                "house_number",
                "road",
                "city",
                "town",
                "village",
                "state",
                "postcode",
                "country",
            ]
            .iter()
            .filter_map(|k| t[*k].as_str())
            .collect::<Vec<_>>()
            .join(", ");
            let osm_type = e["osm_type"].as_str().unwrap_or("node");
            let osm_id = e["osm_id"].as_u64().unwrap_or(0);
            if !["node", "way", "relation"].contains(&osm_type) || osm_id == 0 {
                continue;
            }
            places.push(json!({"name":e["name"],"address":address,"postal":t["postcode"],"distance_km":distance,
                "latitude":a,"longitude":b,"url":format!("https://www.openstreetmap.org/{osm_type}/{osm_id}")}));
        }
    }
    places.sort_by(|a, b| {
        a["distance_km"]
            .as_f64()
            .partial_cmp(&b["distance_km"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    places.truncate(3);
    Ok(
        json!({"places":places,"attribution":"© OpenStreetMap contributors · ODbL", "queried_at":chrono::Local::now().to_rfc3339()}),
    )
}
fn haversine(a: f64, b: f64, c: f64, d: f64) -> f64 {
    let x = ((c - a).to_radians() / 2.0).sin().powi(2)
        + a.to_radians().cos() * c.to_radians().cos() * ((d - b).to_radians() / 2.0).sin().powi(2);
    6371.0 * 2.0 * x.clamp(0.0, 1.0).sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // Real HTTP transport against a local stand-in, including protocol failure.
    async fn serve(body: &'static str, status: &str) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let status = status.to_string();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = [0; 4096];
            s.read(&mut buf).await.unwrap();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(response.as_bytes()).await.unwrap();
        });
        format!("http://{addr}")
    }
    #[tokio::test]
    async fn transport_handles_json_html_429_and_unreachable() {
        for (body, status, ok) in [
            ("{\"ip\":\"8.8.8.8\"}", "200 OK", true),
            ("<html>blocked</html>", "200 OK", false),
            ("{}", "429 Too Many Requests", false),
        ] {
            let p = Probe {
                url: serve(body, status).await,
                ..Default::default()
            };
            let got = run_probe(p, "direct".into()).await;
            assert_eq!(got.ip.is_some(), ok, "{got:?}");
        }
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let p = Probe {
            url: format!("http://{addr}"),
            ..Default::default()
        };
        assert!(run_probe(p, "direct".into()).await.error.is_some());
    }
    #[tokio::test]
    async fn claude_trace_must_identify_the_target_hostname() {
        for (body, valid) in [
            ("h=claude.ai\nip=8.8.8.8", true),
            ("h=www.cloudflare.com\nip=8.8.8.8", false),
            ("ip=8.8.8.8", false),
        ] {
            let probe = Probe {
                id: "claude".into(),
                url: serve(body, "200 OK").await,
                ..Default::default()
            };
            assert_eq!(run_probe(probe, "direct".into()).await.ip.is_some(), valid);
        }
    }
    #[test]
    fn distances() {
        assert!(haversine(0.0, 0.0, 0.0, 0.0) < 0.001);
        assert!((haversine(0.0, 0.0, 1.0, 0.0) - 111.19).abs() < 0.1);
    }
    #[tokio::test]
    #[ignore = "requires local Postman simulation"]
    async fn postman_simulation() {
        let base = std::env::var("SENTINEL_SIM_URL").expect("SENTINEL_SIM_URL");
        for (route, expected) in [
            ("json", Some("8.8.8.8")),
            ("trace", Some("1.1.1.1")),
            ("ipip", Some("223.5.5.5")),
            ("challenge", None),
            ("limited", None),
        ] {
            let p = Probe {
                url: format!("{base}/{route}"),
                ..Default::default()
            };
            let got = run_probe(p, "direct".into()).await;
            assert_eq!(got.ip.as_deref(), expected, "{route}: {got:?}");
        }
    }
    #[tokio::test]
    #[ignore = "opt-in live public endpoints"]
    async fn live_services() {
        let results =
            futures::future::join_all(probes(false).into_iter().map(|p| run_probe(p, "".into())))
                .await;
        for p in &results {
            assert!(p.ip.is_some(), "{p:?}");
            println!("{} {} {}ms", p.label, p.ip.as_deref().unwrap(), p.latency);
        }
        let ip = results
            .iter()
            .find(|p| p.group == "foreign")
            .unwrap()
            .ip
            .as_deref()
            .unwrap();
        let g = geo(ip, "").await.unwrap();
        println!("GEO {}", g);
        let places = nearby(
            g["latitude"].as_f64().unwrap(),
            g["longitude"].as_f64().unwrap(),
            "",
        )
        .await
        .unwrap();
        assert!(places["places"].is_array());
        println!("PLACES {}", places);
    }
}

#[cfg(target_os = "windows")]
pub fn network_snapshot() -> String {
    let route = output("route.exe", &["print", "-4"]);
    let route6 = output("route.exe", &["print", "-6"]);
    let proxy = output(
        "reg.exe",
        &[
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ],
    );
    format!("Windows IPv4 路由\n{route}\nWindows IPv6 路由\n{route6}\n系统代理（仅展示，不执行 PAC）\n{proxy}")
}
