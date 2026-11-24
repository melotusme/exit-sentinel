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
/// Up to 3 redirects, but stop at Google's bot check so callers can see it instead of a loop
/// between gemini.google.com and www.google.com/sorry.
fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|a| {
        if crate::google::is_sorry(a.url()) {
            a.stop()
        } else if a.previous().len() >= 3 {
            a.error("重定向次数过多")
        } else {
            a.follow()
        }
    })
}
fn client_builder(proxy: &str) -> Result<reqwest::ClientBuilder, String> {
    let mut b = Client::builder()
        .timeout(Duration::from_secs(12))
        .connect_timeout(Duration::from_secs(6))
        .user_agent("ExitSentinel/0.1 (personal network monitor)")
        .redirect(redirect_policy());
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
/// Only addresses assigned to this host are probed. Binding never changes system routing.
pub fn lan_probes(previous: &[Probe]) -> Vec<Probe> {
    let mut sources: Vec<_> = if_addrs::get_if_addrs().unwrap_or_default().into_iter()
        .filter(|i| !i.is_loopback() && !crate::link::is_virtual(&i.name))
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_link_local() && !ip.is_unspecified() => Some((i.name, ip)),
            _ => None,
        }).collect();
    sources.sort();
    sources.dedup();
    sources.into_iter().flat_map(|(interface, ip)| {
        probes(false).into_iter().filter(|p| p.group == "domestic").map(move |mut p| {
            let id = format!("lan:{}:{}:{}", interface, ip, p.id);
            if let Some(old) = previous.iter().find(|old| old.id == id) { return old.clone(); }
            p.id = id;
            p.group = "domestic-lan".into();
            p.source_ip = Some(ip.to_string());
            p.source_interface = interface.clone();
            p.label = format!("{} · {} · {}", interface, ip, p.label);
            p
        })
    }).collect()
}

/// IPIP supplies an operator alongside the exact observed IP, so it remains usable if
/// the separate geography service is unavailable. Do not guess an operator from an IP prefix.
fn ipip_isp(body: &str) -> String {
    let Some((_, location)) = body.split_once("来自于：").or_else(|| body.split_once("来自于:")) else {
        return String::new();
    };
    let parts: Vec<_> = location.split_whitespace().collect();
    // IPIP's domestic format is country, province, city, then the complete operator name.
    let operator = if parts.len() >= 4 { parts[3..].join(" ") } else { String::new() };
    match operator.as_str() {
        "电信" => "中国电信".into(),
        "联通" => "中国联通".into(),
        "移动" => "中国移动".into(),
        "广电" => "中国广电".into(),
        "铁通" => "中国铁通".into(),
        _ => operator,
    }
}

/// Resolve only the fixed public echo hosts when the system returns a TUN Fake-IP.
/// The answer is pinned on this HTTP client; TLS still verifies the original hostname.
async fn real_probe_addresses(host: &str) -> Result<Vec<std::net::SocketAddr>, String> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    type Answer = Result<Vec<std::net::SocketAddr>, String>;
    static CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, (Instant, Answer)>>> = OnceLock::new();
    if !["myip.ipip.net", "ip.3322.net"].contains(&host) {
        return Err("仅固定国内检测站支持 Fake-IP 真实解析".into());
    }
    let mut cache = CACHE.get_or_init(Default::default).lock().await;
    if let Some((at, answer)) = cache.get(host) {
        let ttl = if answer.is_ok() { 300 } else { 60 };
        if at.elapsed() < Duration::from_secs(ttl) { return answer.clone(); }
    }
    let result = async {
        let value: Value = client("direct", false)?.get("https://dns.alidns.com/resolve")
            .query(&[("name", host), ("type", "A")]).timeout(Duration::from_secs(6))
            .send().await.map_err(|_| "AliDNS 真实解析连接失败")?
            .error_for_status().map_err(|_| "AliDNS 真实解析返回错误")?
            .json().await.map_err(|_| "AliDNS 真实解析响应无效")?;
        let addresses: Vec<_> = value["Answer"].as_array().into_iter().flatten()
            .filter(|a| a["type"] == 1)
            .filter_map(|a| a["data"].as_str().and_then(|ip| public_ip(ip).ok()))
            .filter_map(|ip| ip.parse::<std::net::Ipv4Addr>().ok())
            .map(|ip| std::net::SocketAddr::new(ip.into(), 443)).collect();
        if value["Status"] != 0 || addresses.is_empty() { return Err("AliDNS 未返回有效公网 IPv4".into()); }
        Ok(addresses)
    }.await;
    cache.insert(host.into(), (Instant::now(), result.clone()));
    result
}

pub async fn run_probe(mut p: Probe, proxy: String) -> Probe {
    let start = Instant::now();
    let result = async {
        let v6 = p.group.ends_with('6') || p.group == "ipv6";
        p.source_dns.clear();
        let c = if let Some(source) = &p.source_ip {
            let addr: std::net::IpAddr = source.parse().map_err(|_| "源地址无效")?;
            let mut builder = client_builder("direct")?.local_address(addr);
            let target = url::Url::parse(&p.url).ok();
            p.source_dns = "系统 DNS".into();
            if let Some(host) = target.as_ref().and_then(|u| u.host_str()) {
                let fake = tokio::time::timeout(Duration::from_secs(2), tokio::net::lookup_host((host, 443))).await
                    .ok().and_then(Result::ok).is_some_and(|mut ips| ips.any(|a| match a.ip() {
                        std::net::IpAddr::V4(ip) => ip.octets()[0] == 198 && [18, 19].contains(&ip.octets()[1]),
                        _ => false,
                    }));
                if fake {
                    p.source_dns = "AliDNS（规避 Fake-IP）".into();
                    let addresses = real_probe_addresses(host).await
                        .map_err(|e| format!("检测站为 Fake-IP；{e}；未回退默认源地址"))?;
                    builder = builder.resolve_to_addrs(host, &addresses);
                }
            }
            builder.build().map_err(|_| "无法绑定局域网源地址")?
        } else {
            client_for_probe(&proxy, v6, true)?
        };
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
        let detail = if p.url == "https://myip.ipip.net" {
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
            p.isp = ipip_isp(&detail);
            p.detail = detail;
        }
        Err(error) => {
            p.ip = None;
            p.error = Some(error);
            p.detail.clear();
            p.isp.clear();
        }
    }
    p
}
fn output(bin: &str, args: &[&str]) -> String {
    crate::process_guard::output(bin, args)
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
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn network_snapshot() -> String {
    let ip = ["/usr/bin/ip", "/usr/sbin/ip", "/sbin/ip", "/bin/ip"]
        .into_iter()
        .find(|p| std::path::Path::new(p).is_file())
        .unwrap_or("ip");
    let route = output(ip, &["-4", "route", "show", "default"]);
    let route6 = output(ip, &["-6", "route", "show", "default"]);
    let addrs = output(ip, &["-brief", "address", "show", "up"]);
    let proxy = env_proxy_summary(|k| std::env::var(k).ok());
    format!("Linux 网络接口\n{addrs}\n\nIPv4 默认路由\n{route}\n\nIPv6 默认路由\n{route6}\n\n环境代理变量（仅展示，已去除账号密码）\n{proxy}")
}
/// Proxy environment variables with any user:password removed.
#[cfg(any(test, not(any(target_os = "windows", target_os = "macos"))))]
pub fn env_proxy_summary(get: impl Fn(&str) -> Option<String>) -> String {
    let rows: Vec<String> = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
        .into_iter()
        .filter_map(|k| get(k).filter(|v| !v.is_empty()).map(|v| (k, v)))
        .map(|(k, v)| {
            let shown = match url::Url::parse(&v) {
                Ok(mut u) if !k.eq_ignore_ascii_case("no_proxy") => {
                    let _ = u.set_username("");
                    let _ = u.set_password(None);
                    u.to_string()
                }
                _ if v.contains('@') => "（含账号信息，已隐藏）".into(),
                _ => v,
            };
            format!("{k}={shown}")
        })
        .collect();
    if rows.is_empty() { "未设置".into() } else { rows.join("\n") }
}
#[cfg(target_os = "macos")]
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
/// Summarize which parts of the local network snapshot changed between two readings.
pub fn describe_network_change(old: Option<&str>, new: &str) -> String {
    let Some(old) = old else {
        return "本机网络已初始化".into();
    };
    let split = |s: &str| -> [String; 5] {
        let mut parts: [String; 5] = Default::default();
        let mut idx = 0usize;
        for line in s.lines() {
            if line == "出口链路" {
                idx = 4;
            } else if idx == 4 && line.trim().is_empty() {
                idx = 0;
            } else if line.contains("IPv4 默认路由") || line.contains("Windows IPv4 路由") {
                idx = 1;
            } else if line.contains("IPv6 默认路由") || line.contains("Windows IPv6 路由") {
                idx = 2;
            } else if line.contains("系统代理") || line.contains("环境代理变量") {
                idx = 3;
            } else {
                parts[idx].push_str(line.trim());
                parts[idx].push('\n');
            }
        }
        parts
    };
    let a = split(old);
    let b = split(new);
    let labels = ["局域网接口 / 地址", "IPv4 默认路由", "IPv6 默认路由", "系统代理"];
    let mut changed: Vec<String> = (0..4).filter(|&i| a[i] != b[i]).map(|i| labels[i].to_string()).collect();
    if a[4] != b[4] {
        let link = |p: &str| p.trim().to_string();
        changed.insert(0, if a[4].is_empty() { format!("出口链路（{}）", link(&b[4])) } else { format!("出口链路（{} → {}）", link(&a[4]), link(&b[4])) });
    }
    if changed.is_empty() {
        "本机网络状态更新".into()
    } else {
        format!("变化项：{}", changed.join("、"))
    }
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
    #[test]
    fn operator_is_extracted_only_from_ipip_location() {
        assert_eq!(ipip_isp("当前 IP：8.8.8.8 来自于：中国 北京 北京 联通"), "中国联通");
        assert_eq!(ipip_isp("当前 IP：8.8.8.8 来自于：中国 广东 广州 电信"), "中国电信");
        assert_eq!(ipip_isp("当前 IP：8.8.8.8 来自于：中国 北京 北京"), "");
        assert_eq!(ipip_isp("loc=CN\ncolo=PEK"), "");
    }

    #[tokio::test]
    async fn fake_ip_resolution_is_limited_to_fixed_probe_hosts() {
        assert!(real_probe_addresses("example.com").await.is_err());
        assert!(real_probe_addresses("127.0.0.1").await.is_err());
    }

    #[tokio::test]
    async fn bound_source_is_used_and_unassigned_source_never_falls_back() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, peer) = listener.accept().await.unwrap();
            assert_eq!(peer.ip().to_string(), "127.0.0.1");
            let mut buf = [0; 4096];
            stream.read(&mut buf).await.unwrap();
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\n8.8.8.8").await.unwrap();
        });
        let probe = Probe { url: format!("http://{addr}"), source_ip: Some("127.0.0.1".into()), ..Default::default() };
        // A per-LAN probe must not accidentally use the configured proxy.
        assert_eq!(run_probe(probe, "http://127.0.0.1:1".into()).await.ip.as_deref(), Some("8.8.8.8"));
        server.await.unwrap();
        let probe = Probe { url: serve("8.8.8.8", "200 OK").await, source_ip: Some("192.0.2.99".into()), ..Default::default() };
        let result = run_probe(probe, "direct".into()).await;
        assert!(result.ip.is_none());
        assert!(result.error.is_some());
    }

    #[tokio::test]
    #[ignore = "opt-in live per-source domestic observations"]
    async fn live_lan_observations() {
        let targets = lan_probes(&[]);
        assert!(!targets.is_empty(), "no assigned physical IPv4 sources");
        let results = futures::future::join_all(targets.into_iter().map(|p| run_probe(p, "direct".into()))).await;
        let successes = results.iter().filter(|p| p.ip.is_some()).count();
        let operators = results.iter().filter(|p| !p.isp.is_empty()).count();
        println!("LAN observations: {} sources/targets, {} successful, {} with operator", results.len(), successes, operators);
        assert!(results.iter().all(|p| p.ip.is_some() || p.error.is_some()));
        let default = run_probe(probes(false).remove(0), "direct".into()).await;
        assert!(default.ip.is_some(), "default domestic path unavailable");
        assert!(!default.isp.is_empty(), "default path has no IPIP operator");
        println!("Default domestic operator: {}; per-source failures preserved without fallback", default.isp);
        let restored = lan_probes(&results);
        assert!(restored.iter().all(|p| results.iter().any(|r| r.id == p.id && r.checked == p.checked)));
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

#[cfg(test)]
mod env_proxy_tests {
    #[test]
    fn hides_proxy_credentials() {
        let out = super::env_proxy_summary(|k| match k {
            "https_proxy" => Some("http://user:secret@127.0.0.1:7897".into()),
            "no_proxy" => Some("localhost,127.0.0.1".into()),
            _ => None,
        });
        assert!(out.contains("https_proxy=http://127.0.0.1:7897"));
        assert!(out.contains("no_proxy=localhost,127.0.0.1"));
        assert!(!out.contains("secret") && !out.contains("user"));
        assert_eq!(super::env_proxy_summary(|_| None), "未设置");
    }

    #[test]
    fn describes_specific_network_snapshot_sections_that_changed() {
        let a = "局域网接口 / 地址\nen0 192.168.1.2\nIPv4 默认路由\ngateway: 192.168.1.1\nIPv6 默认路由\nnone\n系统代理（仅展示，不执行 PAC）\nHTTPEnable : 0";
        let b = "局域网接口 / 地址\nen0 192.168.1.2\nIPv4 默认路由\ngateway: 192.168.1.1\nIPv6 默认路由\nnone\n系统代理（仅展示，不执行 PAC）\nHTTPEnable : 1";
        assert_eq!(super::describe_network_change(Some(a), b), "变化项：系统代理");
    }

    #[test]
    fn link_switch_names_both_sides_and_ignores_unchanged_sections() {
        let wired = "出口链路\n有线 · USB LAN\n\n局域网接口 / 地址\nen6\nIPv4 默认路由\ngateway: 10.0.0.1";
        let wifi = "出口链路\n无线 · Home\n\n局域网接口 / 地址\nen6\nIPv4 默认路由\ngateway: 10.0.0.1";
        assert_eq!(super::describe_network_change(Some(wired), wifi), "变化项：出口链路（有线 · USB LAN → 无线 · Home）");
    }
}
