//! Import only node identity. Passwords, subscriptions and controller secrets are discarded.
use crate::shadowrocket::{NodeRecord, RouteSnapshot};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, sync::Mutex};

pub const LIMIT: usize = 8 * 1024 * 1024;
#[derive(Default)]
pub struct State(pub Mutex<(u64, Option<Prepared>)>);
#[derive(Clone)]
pub struct Prepared {
    pub id: u64,
    pub routes: Vec<RouteSnapshot>,
}
#[derive(Serialize)]
pub struct Preview {
    pub id: u64,
    pub nodes: usize,
    pub records: usize,
    pub skipped: usize,
    pub format: String,
    pub warnings: String,
}
#[derive(Clone)]
struct Node {
    name: String,
    host: String,
    port: u16,
    protocol: String,
    source: String,
    source_id: String,
}
fn clean(s: &str) -> Result<String, String> {
    let s = s.trim();
    if s.is_empty() || s.chars().count() > 300 || s.chars().any(char::is_control) {
        return Err("节点名称或服务器字段无效".into());
    }
    Ok(s.into())
}
fn node(name: &str, host: &str, port: u64, protocol: &str) -> Result<Node, String> {
    if !(1..=65535).contains(&port) {
        return Err("节点端口无效".into());
    }
    let host = clean(host)?;
    if host.contains(['/', '@', '?', '#', '=', ' ']) {
        return Err("节点服务器无效".into());
    }
    Ok(Node {
        name: clean(name)?,
        host: host.to_lowercase(),
        port: port as u16,
        protocol: clean(protocol)?.to_lowercase(),
        source: String::new(),
        source_id: String::new(),
    })
}
pub fn source_label(s: &str) -> String {
    s.split("http").next().unwrap_or("").split_whitespace().filter(|s| !s.contains("://") && !s.contains('@') && !s.contains("token=")).collect::<Vec<_>>().join(" ")
        .trim_matches(|c: char| c.is_whitespace() || "｜|·".contains(c)).chars().filter(|c| !c.is_control()).take(100).collect()
}
fn sourced(mut n: Node, row: &Value, root: &Value) -> Node {
    n.source = source_label(row["sentinel_provider"].as_str().or(root["sentinel_source"].as_str()).unwrap_or(""));
    let id = row["sentinel_provider_id"].as_str().or(root["sentinel_source_id"].as_str()).unwrap_or("");
    if !id.is_empty() { n.source_id = format!("{:x}", Sha256::digest(id.as_bytes())); }
    n
}
fn decode(s: &str) -> Result<String, String> {
    for engine in [STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD] {
        if let Ok(b) = engine.decode(s) {
            if let Ok(s) = String::from_utf8(b) {
                return Ok(s);
            }
        }
    }
    Err("订阅 Base64 格式无效".into())
}
fn uri(line: &str) -> Result<Node, String> {
    let (protocol, rest) = line.split_once("://").ok_or("节点链接格式无效")?;
    if protocol == "vmess" {
        let v: Value = serde_json::from_str(&decode(rest.split('#').next().unwrap_or(rest))?)
            .map_err(|_| "VMess 格式无效")?;
        let port = v["port"]
            .as_u64()
            .or_else(|| v["port"].as_str()?.parse().ok())
            .unwrap_or(0);
        return node(
            v["ps"].as_str().unwrap_or("VMess"),
            v["add"].as_str().unwrap_or(""),
            port,
            protocol,
        );
    }
    if ![
        "ss",
        "ssr",
        "vless",
        "trojan",
        "hysteria",
        "hysteria2",
        "hy2",
        "tuic",
        "socks",
        "socks5",
        "http",
        "https",
    ]
    .contains(&protocol)
    {
        return Err("不支持的节点链接类型".into());
    }
    if protocol == "ssr" {
        let decoded = decode(rest)?;
        let parts: Vec<_> = decoded
            .split("/?")
            .next()
            .unwrap_or("")
            .rsplitn(6, ':')
            .collect();
        if parts.len() != 6 {
            return Err("SSR 格式无效".into());
        }
        let name = decoded
            .split("remarks=")
            .nth(1)
            .and_then(|s| decode(s.split('&').next().unwrap_or("")).ok())
            .unwrap_or_else(|| parts[5].into());
        return node(&name, parts[5], parts[4].parse().unwrap_or(0), protocol);
    }
    let (authority, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let authority = if protocol == "ss" && !authority.contains('@') {
        decode(authority)?
    } else {
        authority.into()
    };
    let endpoint = authority.rsplit('@').next().unwrap_or("");
    let u = url::Url::parse(&format!("http://{endpoint}")).map_err(|_| "节点地址无效")?;
    if ["http", "https"].contains(&protocol)
        && (u.path() != "/"
            || u.query().is_some()
            || endpoint
                .rsplit(':')
                .next()
                .and_then(|p| p.parse::<u16>().ok())
                .is_none())
    {
        return Err("HTTP 节点需显式端口；不导入远程订阅 URL".into());
    }
    let port = u.port().unwrap_or(if protocol == "https" {
        443
    } else if protocol == "http" {
        80
    } else {
        0
    });
    // URL form decoding is sufficient for a display name; never retain the original URI.
    let name =
        url::form_urlencoded::parse(format!("n={}", fragment.replace('+', "%2B")).as_bytes())
            .next()
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
    node(
        if name.is_empty() {
            u.host_str().unwrap_or("")
        } else {
            &name
        },
        u.host_str().unwrap_or(""),
        port.into(),
        protocol,
    )
}
fn parse(content: &str) -> Result<(Vec<Node>, usize, String), String> {
    if content.is_empty() || content.len() > LIMIT {
        return Err("请选择非空且不超过 8 MB 的配置文件".into());
    }
    let content = content.trim_start_matches('\u{feff}').trim();
    if content.starts_with('{')
        || content.starts_with('[')
            && !content.starts_with("[Proxy]")
            && !content.starts_with("[General]")
    {
        if let Ok(mut v) = serde_json::from_str::<Value>(content) {
            if let Some(items) = v["items"].as_array() {
                let outbounds = items
                    .iter()
                    .flat_map(|item| item["servers"].as_array().into_iter().flatten().cloned().map(|mut row| {
                        row["sentinel_provider"] = Value::String(source_label(item["remark"].as_str().or(item["name"].as_str()).or(item["tag"].as_str()).unwrap_or("未命名订阅")));
                        row["sentinel_provider_id"] = Value::String(format!("{:x}", Sha256::digest(item["urlOrPath"].as_str().unwrap_or("").as_bytes())));
                        row
                    }))
                    .collect::<Vec<_>>();
                v["outbounds"] = Value::Array(outbounds);
            }
            if let Some(rows) = v["outbounds"].as_array() {
                let mut nodes = vec![];
                let mut skipped = 0;
                for r in rows {
                    let kind = r["type"].as_str().unwrap_or("");
                    if ["direct", "block", "dns", "selector", "urltest"].contains(&kind) {
                        continue;
                    }
                    match node(
                        r["tag"].as_str().unwrap_or(""),
                        r["server"].as_str().unwrap_or(""),
                        r["server_port"].as_u64().unwrap_or(0),
                        kind,
                    ) {
                        Ok(n) => nodes.push(sourced(n, r, &v)),
                        Err(_) => skipped += 1,
                    }
                }
                return Ok((nodes, skipped, "sing-box JSON".into()));
            }
        }
    }
    if let Ok(v) = serde_yaml::from_str::<Value>(content) {
        if let Some(rows) = v["proxies"].as_array() {
            let mut nodes = vec![];
            let mut skipped = 0;
            for r in rows {
                match node(
                    r["name"].as_str().unwrap_or(""),
                    r["server"].as_str().unwrap_or(""),
                    r["port"]
                        .as_u64()
                        .or_else(|| r["port"].as_str()?.parse().ok())
                        .unwrap_or(0),
                    r["type"].as_str().unwrap_or(""),
                ) {
                    Ok(n) => nodes.push(sourced(n, r, &v)),
                    Err(_) => skipped += 1,
                }
            }
            return Ok((nodes, skipped, "Clash / Mihomo YAML".into()));
        }
    }
    if content
        .lines()
        .any(|l| l.trim().eq_ignore_ascii_case("[Proxy]"))
    {
        let mut nodes = vec![];
        let mut skipped = 0;
        let mut inside = false;
        for line in content.lines().map(str::trim) {
            if line.starts_with('[') {
                inside = line.eq_ignore_ascii_case("[Proxy]");
                continue;
            }
            if !inside || line.is_empty() || line.starts_with(['#', ';']) {
                continue;
            }
            if let Some((name, value)) = line.split_once('=') {
                let parts: Vec<_> = value.split(',').map(str::trim).collect();
                if ["direct", "reject", "reject-tinygif"]
                    .contains(&parts[0].to_lowercase().as_str())
                {
                    continue;
                }
                let result = if parts.len() >= 3 {
                    node(name, parts[1], parts[2].parse().unwrap_or(0), parts[0])
                } else {
                    Err("无效节点".into())
                };
                match result {
                    Ok(n) => nodes.push(n),
                    Err(_) => skipped += 1,
                }
            } else {
                skipped += 1;
            }
        }
        return Ok((nodes, skipped, "Shadowrocket / Surge CONF".into()));
    }
    let decoded;
    let text = if !content.contains("://") {
        decoded = decode(&content.split_whitespace().collect::<String>())?;
        decoded.as_str()
    } else {
        content
    };
    let mut nodes = vec![];
    let mut skipped = 0;
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        match uri(line) {
            Ok(n) => nodes.push(n),
            Err(_) => skipped += 1,
        }
    }
    Ok((nodes, skipped, "节点分享链接 / Base64 订阅".into()))
}
pub fn prepare(
    client: &str,
    service: &str,
    content: &str,
) -> Result<(Preview, Vec<RouteSnapshot>), String> {
    let label = match client {
        "shadowrocket" => "Shadowrocket",
        "clash_verge" => "Clash Verge",
        "karing" => "Karing",
        "clash_mi" => "Clash Mi",
        "other" => "其他代理客户端",
        _ => return Err("请选择代理软件".into()),
    };
    let services = match service {
        "both" => vec!["claude", "gemini"],
        "claude" => vec!["claude"],
        "gemini" => vec!["gemini"],
        _ => return Err("请选择导入服务".into()),
    };
    let (nodes, mut skipped, format) = parse(content)?;
    let mut seen = HashSet::new();
    let mut routes = vec![];
    let time = crate::now();
    for n in nodes {
        let identity = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&(client, &n.name, &n.host, n.port, &n.protocol)).unwrap()
            )
        );
        let identity = if n.source_id.is_empty() { identity } else { format!("{identity}:{}", n.source_id) };
        if !seen.insert(identity.clone()) {
            skipped += 1;
            continue;
        }
        for service in &services {
            routes.push(RouteSnapshot {
                service: (*service).into(),
                config: format!("{label} · 手动导入"),
                mode: "imported".into(),
                node_name: n.name.clone(),
                node_host: n.host.clone(),
                node_id: format!("{}:{}", n.protocol, n.port),
                subscription: n.source.clone(),
                subscription_id: n.source_id.clone(),
                evidence: "manual-import".into(),
                fingerprint: format!("import:{identity}"),
                consistent: true,
                association: "手动导入节点；未确认当前选择，出口 IP 未关联".into(),
                basis: format!("{format} 中的节点定义；未读取实时连接或验证可用性"),
                first_seen: time.clone(),
                last_seen: time.clone(),
                ..Default::default()
            });
        }
        if routes.len() > 10000 {
            return Err("最多导入 10000 条服务节点记录，请拆分文件".into());
        }
    }
    if routes.is_empty() {
        return Err("未找到可导入节点。请导出 Clash YAML、sing-box JSON、Shadowrocket CONF 或节点分享链接；不支持加密备份和仅含远程订阅地址的文件。".into());
    }
    Ok((
        Preview {
            id: 0,
            nodes: seen.len(),
            records: routes.len(),
            skipped,
            format,
            warnings: String::new(),
        },
        routes,
    ))
}
pub fn merge(
    records: &mut Vec<NodeRecord>,
    routes: Vec<RouteSnapshot>,
) -> Result<(usize, usize), String> {
    let mut merged = records.clone();
    let mut index: HashMap<(String, String), usize> = merged.iter().enumerate()
        .map(|(i, n)| ((n.service.clone(), n.key.clone()), i)).collect();
    let mut added = 0;
    for route in routes {
        let identity = (route.service.clone(), route.fingerprint.clone());
        let legacy = (route.service.clone(), route.fingerprint.split(':').take(2).collect::<Vec<_>>().join(":"));
        let existing = index.get(&identity).copied().or_else(|| {
            if route.subscription_id.is_empty() { return None; }
            index.get(&legacy).copied().filter(|i| merged[*i].route.subscription_id.is_empty())
        });
        if let Some(i) = existing {
            index.remove(&(merged[i].service.clone(), merged[i].key.clone()));
            merged[i].key = route.fingerprint.clone();
            merged[i].route = route;
            index.insert(identity, i);
            continue;
        }
        if merged.len() >= 10000 { return Err("节点库超过 10000 条，请先清理数据".into()); }
        index.insert(identity, merged.len());
        added += 1;
        merged.push(NodeRecord {
            key: route.fingerprint.clone(), service: route.service.clone(),
            status: crate::claude::Safety::Pending, note: String::new(),
            added_at: route.first_seen.clone(), updated_at: route.last_seen.clone(), route,
        });
    }
    *records = merged;
    Ok((added, records.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn subscription_backfill_preserves_marks_and_separates_airports() {
        let body = |source: &str| format!(r#"{{"sentinel_source":"{source}","sentinel_source_id":"{source}","proxies":[{{"name":"US","type":"ss","server":"same.example","port":443}}]}}"#);
        let (_, legacy) = prepare("clash_verge", "both", r#"{"proxies":[{"name":"US","type":"ss","server":"same.example","port":443}]}"#).unwrap();
        let mut records = vec![];
        merge(&mut records, legacy).unwrap();
        records[0].note = "keep".into();
        records[0].status = crate::claude::Safety::Safe;
        let original_time = records[0].added_at.clone();
        let (_, first) = prepare("clash_verge", "both", &body("Airport A")).unwrap();
        assert_eq!(merge(&mut records, first.clone()).unwrap().0, 0);
        assert_eq!(records[0].note, "keep");
        assert_eq!(records[0].status, crate::claude::Safety::Safe);
        assert_eq!(records[0].added_at, original_time);
        let (_, second) = prepare("clash_verge", "both", &body("Airport B")).unwrap();
        assert_eq!(merge(&mut records, second).unwrap().0, 2);
        assert_eq!(merge(&mut records, first).unwrap().0, 0);
        assert_eq!(records.len(), 4);
    }
    #[test]
    fn native_karing_subscription_library_discards_url_uuid_and_old_exit() {
        let body = r#"{"items":[{"urlOrPath":"https://private.example/PRIVATE_SUBSCRIPTION","servers":[{"tag":"日本","type":"vless","server":"node.example","server_port":443,"uuid":"PRIVATE_UUID","outlet_ip":"8.8.8.8","outlet_region":"PRIVATE_REGION"}]}]}"#;
        let (_, routes) = prepare("karing", "both", body).unwrap();
        assert_eq!(routes.len(), 2);
        let serialized = serde_json::to_string(&routes).unwrap();
        assert!(!serialized.contains("PRIVATE_") && !serialized.contains("8.8.8.8"));
    }
    #[test]
    fn formats_discard_secrets_and_do_not_attribute_ips() {
        for (client, body) in [
            ("clash_verge", "proxies:\n  - {name: JP, type: ss, server: node.example, port: 443, password: PRIVATE_PASSWORD}\nsecret: PRIVATE_CONTROLLER"),
            ("clash_mi", "{\"proxies\":[{\"name\":\"JP\",\"type\":\"trojan\",\"server\":\"node.example\",\"port\":443,\"password\":\"PRIVATE_PASSWORD\"}]}"),
            ("karing", "{\"outbounds\":[{\"type\":\"selector\",\"tag\":\"auto\"},{\"type\":\"vless\",\"tag\":\"JP\",\"server\":\"node.example\",\"server_port\":443,\"uuid\":\"PRIVATE_PASSWORD\"}]}"),
            ("shadowrocket", "[General]\n[Proxy]\nJP = trojan, node.example, 443, password=PRIVATE_PASSWORD\n[Rule]\nFINAL,JP"),
            ("shadowrocket", "trojan://PRIVATE_PASSWORD@node.example:443#JP"),
        ] {
            let (p, routes) = prepare(client, "both", body).unwrap();
            assert_eq!(p.nodes, 1); assert_eq!(routes.len(), 2);
            let json = serde_json::to_string(&routes).unwrap();
            assert!(!json.contains("PRIVATE_")); assert!(routes[0].association.contains("未确认当前选择"));
            assert_ne!(routes[0].service, routes[1].service);
        }
    }
    #[test]
    fn dedup_preserves_marks_and_node_identity_uses_port() {
        let (_, routes) = prepare("karing", "claude", "trojan://pw@a.example:443#A\ntrojan://other@a.example:443#A\ntrojan://pw@a.example:444#A").unwrap();
        assert_eq!(routes.len(), 2);
        let mut records = vec![];
        merge(&mut records, routes.clone()).unwrap();
        records[0].status = crate::claude::Safety::Safe;
        records[0].note = "keep".into();
        assert_eq!(merge(&mut records, routes).unwrap().0, 0);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].note, "keep");
        assert_eq!(records[0].status, crate::claude::Safety::Safe);
    }
    #[test]
    fn rejects_invalid_and_remote_only_and_accepts_base64() {
        assert!(prepare(
            "karing",
            "both",
            "{\"outbounds\":[{\"type\":\"direct\",\"tag\":\"direct\"}]}"
        )
        .is_err());
        assert!(prepare("other", "both", "https://subscription.example/token").is_err());
        assert!(prepare("other", "both", &"x".repeat(LIMIT + 1)).is_err());
        let body = STANDARD.encode("ss://YWVzOnB3@node.example:443#%E6%97%A5%E6%9C%AC");
        let (_, routes) = prepare("shadowrocket", "gemini", &body).unwrap();
        assert_eq!(routes[0].node_name, "日本");
        assert!(prepare("other", "oops", &body).is_err());
    }
}
