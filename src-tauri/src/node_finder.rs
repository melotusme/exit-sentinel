//! "Find nodes near this address": resolve the address, place every known node, rank by closeness.
use crate::region::{self, Place};
use crate::{cached_geo, lock, model, net, Shared};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Nominatim usage policy: well under one request per second.
const GEOCODE_GAP: Duration = Duration::from_secs(2);
static LAST_GEOCODE: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug)]
pub struct ServiceStatus {
    pub service: String,
    pub status: crate::claude::Safety,
}

#[derive(Serialize, Clone)]
pub struct NodeMatch {
    pub name: String,
    pub host: String,
    pub subscription: String,
    pub services: Vec<ServiceStatus>,
    pub place: Place,
    pub score: u8,
    pub distance_km: Option<f64>,
    pub reason: String,
}

#[derive(Serialize)]
pub struct FindResult {
    pub target: Place,
    pub matches: Vec<NodeMatch>,
    /// Nodes whose label names no recognisable place and that have no measured exit.
    pub unplaced: usize,
    pub total: usize,
}

fn place_from_geo(g: &Value, source: String) -> Place {
    let code = g["country_code"].as_str().unwrap_or("").to_uppercase();
    let city = g["city"].as_str().unwrap_or("").to_string();
    let country = if code.is_empty() { g["country"].as_str().unwrap_or("").to_string() } else { region::country_label(&code) };
    Place {
        label: [country.as_str(), g["region"].as_str().unwrap_or(""), city.as_str()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" · "),
        country_code: code,
        country,
        region: g["region"].as_str().unwrap_or("").to_string(),
        city,
        lat: g["latitude"].as_f64(),
        lon: g["longitude"].as_f64(),
        source,
    }
}

fn place_from_nominatim(v: &Value) -> Place {
    let a = &v["address"];
    let code = a["country_code"].as_str().unwrap_or("").to_uppercase();
    let city = ["city", "town", "village", "county"].iter().find_map(|k| a[*k].as_str()).unwrap_or("").to_string();
    let coord = |k: &str| v[k].as_str().and_then(|s| s.parse::<f64>().ok());
    Place {
        label: v["display_name"].as_str().unwrap_or("").to_string(),
        country: region::country_label(&code),
        country_code: code,
        region: a["state"].as_str().unwrap_or("").to_string(),
        city,
        lat: coord("lat"),
        lon: coord("lon"),
        source: "OpenStreetMap 地址查询".into(),
    }
}

async fn geocode_throttled(query: &str, proxy: &str) -> Result<Place, String> {
    {
        let mut last = LAST_GEOCODE.lock().unwrap_or_else(|e| e.into_inner());
        if last.is_some_and(|t| t.elapsed() < GEOCODE_GAP) {
            return Err("地址查询请间隔 2 秒".into());
        }
        *last = Some(Instant::now());
    }
    Ok(place_from_nominatim(&net::geocode(query, proxy).await?))
}

/// Where the user means: an IP (located with ipwho.is), a place name from the built-in table,
/// or anything else through OpenStreetMap.
async fn resolve_target(s: &Shared, query: &str) -> Result<Place, String> {
    if query.parse::<std::net::IpAddr>().is_ok() {
        let ip = model::public_ip(query)?;
        let g = cached_geo(s, &ip, false).await?;
        return Ok(place_from_geo(&g, format!("IP 定位（ipwho.is）：{ip}")));
    }
    let local = region::parse_query(query, "内置地名表");
    // A short name the table knows ("洛杉矶", "加州", "日本") needs no network request.
    let looks_like_address = query.chars().any(|c| c.is_ascii_digit()) || query.chars().count() > 16;
    if let Some(p) = &local {
        if !looks_like_address || !p.city.is_empty() {
            return Ok(p.clone());
        }
    }
    let proxy = lock(s).view.settings.foreign_proxy.clone();
    match geocode_throttled(query, &proxy).await {
        Ok(p) if !p.country_code.is_empty() => Ok(p),
        Ok(_) | Err(_) if local.is_some() => Ok(local.unwrap()),
        Ok(_) => Err("没有识别出这个地址所在的国家或地区".into()),
        Err(e) => Err(e),
    }
}

fn key(name: &str, host: &str) -> String {
    format!("{}|{}", name.trim().to_lowercase(), host.trim().to_lowercase())
}

/// Every distinct node the app knows, with its per-service status and best-known place.
fn collect_nodes(s: &Shared) -> (Vec<(String, String, String, Vec<ServiceStatus>, Option<Place>)>, usize) {
    let d = lock(s);
    let v = &d.view;
    // A node whose exit IP was actually measured and located beats its label.
    let mut measured: HashMap<String, Place> = HashMap::new();
    for record in &v.claude_ips {
        let Some((_, g)) = d.geocache.get(&record.ip) else { continue };
        for r in record.routes.iter().filter(|r| !r.node_name.is_empty()) {
            measured.entry(key(&r.node_name, &r.node_host)).or_insert_with(|| place_from_geo(g, format!("实测出口 {}", record.ip)));
        }
    }
    let mut order: Vec<String> = vec![];
    let mut nodes: HashMap<String, (String, String, String, Vec<ServiceStatus>)> = HashMap::new();
    let routes = v.ai_nodes.iter().map(|n| (&n.route, Some((&n.service, &n.status)))).chain(v.current_routes.iter().map(|r| (r, None)));
    for (route, status) in routes {
        if route.node_name.is_empty() {
            continue;
        }
        let k = key(&route.node_name, &route.node_host);
        let entry = nodes.entry(k.clone()).or_insert_with(|| {
            order.push(k.clone());
            (route.node_name.clone(), route.node_host.clone(), route.subscription.clone(), vec![])
        });
        if let Some((service, status)) = status {
            if !entry.3.iter().any(|x| &x.service == service) {
                entry.3.push(ServiceStatus { service: service.clone(), status: status.clone() });
            }
        }
    }
    let total = order.len();
    let list = order
        .into_iter()
        .filter_map(|k| {
            let (name, host, sub, services) = nodes.remove(&k)?;
            let place = measured.remove(&k).or_else(|| region::parse(&name, "节点名称"));
            Some((name, host, sub, services, place))
        })
        .collect();
    (list, total)
}

pub fn rank(target: &Place, nodes: Vec<(String, String, String, Vec<ServiceStatus>, Option<Place>)>) -> (Vec<NodeMatch>, usize) {
    let mut unplaced = 0;
    let mut matches: Vec<NodeMatch> = nodes
        .into_iter()
        .filter_map(|(name, host, subscription, services, place)| {
            let Some(place) = place else {
                unplaced += 1;
                return None;
            };
            let (score, distance_km, reason) = region::closeness(target, &place);
            (score > 0).then_some(NodeMatch { name, host, subscription, services, place, score, distance_km, reason })
        })
        .collect();
    matches.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(a.distance_km.unwrap_or(f64::MAX).total_cmp(&b.distance_km.unwrap_or(f64::MAX)))
            .then(a.name.cmp(&b.name))
    });
    (matches, unplaced)
}

#[tauri::command]
pub async fn find_nodes_near(query: String, s: tauri::State<'_, Shared>) -> Result<FindResult, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("请输入地址、城市或 IP（最多 200 字）".into());
    }
    let target = resolve_target(&s, query).await?;
    let (nodes, total) = collect_nodes(&s);
    let (matches, unplaced) = rank(&target, nodes);
    Ok(FindResult { target, matches, unplaced, total })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str) -> (String, String, String, Vec<ServiceStatus>, Option<Place>) {
        (name.into(), String::new(), String::new(), vec![], region::parse(name, "节点名称"))
    }

    #[test]
    fn ranks_same_city_then_region_then_country() {
        let target = region::parse_query("洛杉矶", "输入").unwrap();
        let (matches, unplaced) = rank(
            &target,
            vec![node("🇺🇸亚特兰大01"), node("US-N-5"), node("洛杉矶 LA-01"), node("日本-TY-1"), node("圣何塞 01"), node("剩余流量")],
        );
        let names: Vec<_> = matches.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names[0], "洛杉矶 LA-01");
        assert_eq!(names[1], "圣何塞 01");
        assert!(names.contains(&"US-N-5") && names.contains(&"🇺🇸亚特兰大01"));
        assert!(!names.contains(&"日本-TY-1"));
        assert_eq!(unplaced, 1);
    }

    #[test]
    fn nominatim_result_becomes_place() {
        let v = serde_json::json!({"lat": "34.05", "lon": "-118.24", "display_name": "Los Angeles, CA, USA",
            "address": {"city": "Los Angeles", "state": "California", "country_code": "us"}});
        let p = place_from_nominatim(&v);
        assert_eq!(p.country_code, "US");
        assert_eq!(p.region, "California");
        assert_eq!(region::closeness(&p, &region::parse("圣何塞", "t").unwrap()).0, 85);
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;

    #[test]
    #[ignore = "opt-in: ranks this machine's saved nodes"]
    fn rank_local_nodes() {
        let path = std::env::var("HOME").unwrap() + "/Library/Application Support/local.mhzrm.exit-sentinel/settings.json";
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let nodes: Vec<crate::shadowrocket::NodeRecord> = serde_json::from_value(saved["ai_nodes"].clone()).unwrap();
        let mut seen = std::collections::HashSet::new();
        let list: Vec<_> = nodes
            .iter()
            .filter(|n| seen.insert(key(&n.route.node_name, &n.route.node_host)))
            .map(|n| (n.route.node_name.clone(), n.route.node_host.clone(), String::new(), vec![], region::parse(&n.route.node_name, "节点名称")))
            .collect();
        for q in ["洛杉矶", "东京都新宿区", "加州", "伦敦", "台北"] {
            let target = region::parse_query(q, "输入").unwrap();
            let (m, unplaced) = rank(&target, list.clone());
            println!("{q}: {} 个匹配，{unplaced} 个无地区；前 5：{:?}", m.len(), m.iter().take(5).map(|x| format!("{}（{}）", x.name, x.reason)).collect::<Vec<_>>());
        }
    }
}
