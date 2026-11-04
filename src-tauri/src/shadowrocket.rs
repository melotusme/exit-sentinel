use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct RouteSnapshot {
    #[serde(default)]
    pub evidence: String,
    #[serde(default)]
    pub observed_at: String,
    #[serde(default)]
    pub subscription_id: String,
    pub association: String,
    pub service: String,
    pub domain: String,
    pub config: String,
    pub mode: String,
    pub matched_rule: String,
    pub chain: Vec<String>,
    pub compiled_chain: Vec<String>,
    pub node_name: String,
    pub node_id: String,
    pub node_host: String,
    pub subscription: String,
    pub basis: String,
    pub error: String,
    pub consistent: bool,
    /// The connection log is older than a few minutes: last node seen, not necessarily current.
    pub stale: bool,
    pub fingerprint: String,
    pub first_seen: String,
    pub last_seen: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NodeRecord {
    pub key: String,
    pub service: String,
    pub route: RouteSnapshot,
    pub status: crate::claude::Safety,
    pub note: String,
    pub added_at: String,
    pub updated_at: String,
}
fn norm(s: &str) -> String {
    s.trim().to_lowercase()
}
/// The same physical node read from different clients (live Shadowrocket, Clash, imports)
/// gets different fingerprints. Match by name, and by server host when both sides know it.
pub fn same_node(a: &RouteSnapshot, b: &RouteSnapshot) -> bool {
    let (name_a, name_b) = (norm(&a.node_name), norm(&b.node_name));
    if name_a.is_empty() || name_a != name_b {
        return false;
    }
    let (host_a, host_b) = (norm(&a.node_host), norm(&b.node_host));
    host_a.is_empty() || host_b.is_empty() || host_a == host_b
}
/// Exact key first, then name + host, then name only (one side has no host).
pub fn find_node_index(records: &[NodeRecord], service: &str, route: &RouteSnapshot) -> Option<usize> {
    let mine = |r: &&NodeRecord| r.service == service;
    let by_key = records.iter().position(|r| mine(&r) && !route.fingerprint.is_empty() && r.key == route.fingerprint);
    let host = norm(&route.node_host);
    let by_host = || {
        records.iter().position(|r| {
            mine(&r) && !host.is_empty() && norm(&r.route.node_host) == host && same_node(&r.route, route)
        })
    };
    let by_name = || records.iter().position(|r| mine(&r) && same_node(&r.route, route));
    by_key.or_else(by_host).or_else(by_name)
}
pub fn find_node<'a>(records: &'a [NodeRecord], service: &str, route: &RouteSnapshot) -> Option<&'a NodeRecord> {
    find_node_index(records, service, route).map(|i| &records[i])
}
/// A node the user may register: identified, and not contradicted by the client state.
/// An old connection log (`stale`) is still the last node seen and stays registerable.
pub fn registerable(route: &RouteSnapshot) -> bool {
    route.consistent && route.error.is_empty() && !route.node_name.is_empty() && !route.fingerprint.is_empty()
}
pub fn upsert_node(
    records: &mut Vec<NodeRecord>,
    service: &str,
    mut route: RouteSnapshot,
    status: crate::claude::Safety,
    note: String,
    now: &str,
) -> Result<(), String> {
    if !["claude", "gemini"].contains(&service) || route.service != service {
        return Err("未知或不匹配的 AI 服务".into());
    }
    if !registerable(&route) {
        return Err("当前节点未确认，暂不能登记；请核对代理客户端选择".into());
    }
    if note.chars().count() > 500 {
        return Err("备注最多 500 字".into());
    }
    route.association = "手动登记节点；出口 IP 未关联".into();
    let existing = find_node_index(records, service, &route);
    if let Some(r) = existing.map(|i| &mut records[i]) {
        // Keep the stored key so imported / synced records stay addressable.
        route.fingerprint = r.key.clone();
        r.route = route;
        r.status = status;
        r.note = note;
        r.updated_at = now.into();
    } else {
        records.push(NodeRecord {
            key: route.fingerprint.clone(),
            service: service.into(),
            route,
            status,
            note,
            added_at: now.into(),
            updated_at: now.into(),
        });
    }
    Ok(())
}
impl RouteSnapshot {
    pub fn summary(&self) -> String {
        if !self.error.is_empty() {
            return format!("节点未确认：{}", self.error);
        }
        format!(
            "{} · {} · {}",
            self.config,
            self.chain.join(" → "),
            self.basis
        )
    }
}
pub async fn selected_capture(service: &str, proxy: &str, manual_only: bool) -> RouteSnapshot {
    if manual_only {
        return RouteSnapshot {
            service: service.into(),
            config: "仅手动导入".into(),
            error: "自动节点读取已关闭；导入节点请在节点库查看，当前出口与节点未关联".into(),
            ..Default::default()
        };
    }
    capture(service, proxy).await
}
/// Read several services' snapshots in one Python process (one JSON line per service).
#[cfg(not(target_os = "windows"))]
async fn read_snapshots(services: Vec<String>) -> Vec<Result<RouteSnapshot, String>> {
    let count = services.len();
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/python3")
            .args(["-I", "-c", include_str!("shadowrocket_snapshot.py")])
            .args(&services)
            .output()
            .map_err(|_| "无法启动本机 Python 3 读取 Shadowrocket 元数据".to_string())
            .and_then(|o| {
                if !o.status.success() || o.stdout.len() > 65536 * count {
                    return Err("Shadowrocket 元数据读取失败".to_string());
                }
                Ok(String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|line| serde_json::from_str::<RouteSnapshot>(line).map_err(|_| "Shadowrocket 元数据格式无效".to_string()))
                    .collect::<Vec<_>>())
            })
    })
    .await
    .unwrap_or_else(|_| Err("Shadowrocket 读取任务失败".into()));
    match result {
        Ok(rows) if rows.len() == count => rows,
        Ok(_) => vec![Err("Shadowrocket 元数据格式无效".into()); count],
        Err(e) => vec![Err(e); count],
    }
}
fn finish(service: &str, proxy: &str, read: Result<RouteSnapshot, String>) -> RouteSnapshot {
    let mut snapshot = read.unwrap_or_else(|error| RouteSnapshot { service: service.into(), error, ..Default::default() });
    if snapshot.error.is_empty() && !proxy.is_empty() && proxy != "direct" {
        snapshot.error = "本次使用显式代理，无法将 Shadowrocket 配置作为请求路径归属".into();
        snapshot.consistent = false;
        snapshot.fingerprint = format!("explicit:{proxy}");
    }
    snapshot.association = if snapshot.evidence == "connection-log" { "同域名实际连接记录；未关联出口 IP" } else { "当前配置快照，未关联出口 IP" }.into();
    snapshot.first_seen = if snapshot.observed_at.is_empty() { crate::now() } else { snapshot.observed_at.clone() };
    snapshot.last_seen = snapshot.first_seen.clone();
    snapshot
}
#[cfg(not(target_os = "windows"))]
pub async fn capture(service: &str, proxy: &str) -> RouteSnapshot {
    let read = read_snapshots(vec![service.to_string()]).await.pop().unwrap_or_else(|| Err("Shadowrocket 读取任务失败".into()));
    finish(service, proxy, read)
}
/// Snapshots for several (service, proxy) pairs; on macOS one Python process for all.
#[cfg(not(target_os = "windows"))]
pub async fn capture_many(targets: &[(&str, &str)]) -> Vec<RouteSnapshot> {
    let reads = read_snapshots(targets.iter().map(|(s, _)| s.to_string()).collect()).await;
    targets.iter().zip(reads).map(|((service, proxy), read)| finish(service, proxy, read)).collect()
}
#[cfg(target_os = "windows")]
pub async fn capture_many(targets: &[(&str, &str)]) -> Vec<RouteSnapshot> {
    let mut out = vec![];
    for (service, proxy) in targets {
        out.push(capture(service, proxy).await);
    }
    out
}
pub async fn selected_capture_many(targets: &[(&str, &str)], manual_only: bool) -> Vec<RouteSnapshot> {
    if manual_only {
        let mut out = vec![];
        for (service, proxy) in targets {
            out.push(selected_capture(service, proxy, true).await);
        }
        return out;
    }
    capture_many(targets).await
}
pub fn correlate(before: &RouteSnapshot, mut after: RouteSnapshot) -> RouteSnapshot {
    after.association = if after.evidence == "connection-log" { "请求同期同域名连接记录；非进程路径证明" } else { "请求同期配置快照" }.into();
    if before.fingerprint != after.fingerprint || before.config != after.config {
        after.error = "请求期间代理客户端选择发生变化，出口与节点无法关联".into();
        after.node_name.clear();
        after.node_id.clear();
        after.node_host.clear();
        after.consistent = false;
    }
    after
}
pub fn remember(history: &mut Vec<RouteSnapshot>, snapshot: RouteSnapshot) {
    if let Some(old) = history.iter_mut().find(|s| {
        s.fingerprint == snapshot.fingerprint
            && s.error == snapshot.error
            && s.association == snapshot.association
    }) {
        old.last_seen = snapshot.last_seen;
    } else {
        history.push(snapshot);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_registration_needs_no_ip_and_isolates_service_and_snapshot() {
        let route = RouteSnapshot {
            service: "gemini".into(),
            config: "test.conf".into(),
            node_name: "test-node".into(),
            fingerprint: "g1".into(),
            consistent: true,
            ..Default::default()
        };
        let mut records = vec![];
        upsert_node(
            &mut records,
            "gemini",
            route.clone(),
            crate::claude::Safety::Pending,
            "note".into(),
            "t1",
        )
        .unwrap();
        upsert_node(
            &mut records,
            "gemini",
            route.clone(),
            crate::claude::Safety::Safe,
            "confirmed".into(),
            "t2",
        )
        .unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].added_at, "t1");
        assert_eq!(records[0].updated_at, "t2");
        let mut claude = route.clone();
        claude.service = "claude".into();
        upsert_node(
            &mut records,
            "claude",
            claude,
            crate::claude::Safety::Risk,
            "".into(),
            "t2",
        )
        .unwrap();
        let mut next = route.clone();
        next.fingerprint = "g2".into();
        next.node_name = "other-node".into();
        upsert_node(
            &mut records,
            "gemini",
            next,
            crate::claude::Safety::Pending,
            "".into(),
            "t3",
        )
        .unwrap();
        let loaded: Vec<NodeRecord> =
            serde_json::from_str(&serde_json::to_string(&records).unwrap()).unwrap();
        assert_eq!(loaded.len(), 3);
        assert_eq!(loaded[0].status, crate::claude::Safety::Safe);
        assert_eq!(loaded[1].status, crate::claude::Safety::Risk);
        assert_eq!(loaded[2].status, crate::claude::Safety::Pending);
        let mut unknown = route.clone();
        unknown.error = "ambiguous".into();
        assert!(upsert_node(
            &mut records,
            "gemini",
            unknown,
            crate::claude::Safety::Safe,
            "".into(),
            "t4"
        )
        .is_err());
        assert!(upsert_node(
            &mut records,
            "claude",
            route.clone(),
            crate::claude::Safety::Safe,
            "".into(),
            "t4"
        )
        .is_err());
        assert!(upsert_node(
            &mut records,
            "gemini",
            route,
            crate::claude::Safety::Safe,
            "x".repeat(501),
            "t4"
        )
        .is_err());
        assert_eq!(records.len(), 3);
    }
    #[test]
    fn changing_route_is_not_attributed_and_distinct_nodes_are_retained() {
        let a = RouteSnapshot {
            fingerprint: "a".into(),
            node_name: "node-a".into(),
            first_seen: "t1".into(),
            last_seen: "t1".into(),
            ..Default::default()
        };
        let b = RouteSnapshot {
            fingerprint: "b".into(),
            node_name: "node-b".into(),
            first_seen: "t2".into(),
            last_seen: "t2".into(),
            ..Default::default()
        };
        let changed = correlate(&a, b.clone());
        assert!(!changed.consistent);
        assert!(changed.node_name.is_empty());
        assert!(!changed.error.is_empty());
        let mut history = vec![];
        remember(&mut history, a.clone());
        remember(&mut history, a);
        remember(&mut history, b);
        assert_eq!(history.len(), 2);
        let loaded: Vec<RouteSnapshot> =
            serde_json::from_str(&serde_json::to_string(&history).unwrap()).unwrap();
        assert_eq!(loaded[0].first_seen, "t1");
        assert_eq!(loaded[1].node_name, "node-b");
    }
}

#[cfg(target_os = "windows")]
pub async fn capture(service: &str, proxy: &str) -> RouteSnapshot {
    crate::clash_verge::capture(service, proxy).await
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    use crate::claude::Safety;

    fn route(fingerprint: &str, name: &str, host: &str) -> RouteSnapshot {
        RouteSnapshot {
            service: "claude".into(),
            node_name: name.into(),
            node_host: host.into(),
            fingerprint: fingerprint.into(),
            consistent: true,
            ..Default::default()
        }
    }

    #[test]
    fn imported_status_applies_to_live_node() {
        let mut records = vec![];
        upsert_node(&mut records, "claude", route("import:abc", "US-N-5", "a.example"), Safety::Safe, "ok".into(), "t1").unwrap();
        let live = route("sha-live", "us-n-5 ", "A.example");
        let hit = find_node(&records, "claude", &live).expect("same node from another source");
        assert_eq!(hit.status, Safety::Safe);
    }

    #[test]
    fn same_name_on_other_server_is_another_node() {
        let records = vec![NodeRecord {
            key: "import:1".into(),
            service: "claude".into(),
            route: route("import:1", "HK-01", "hk1.example"),
            status: Safety::Risk,
            note: String::new(),
            added_at: "t".into(),
            updated_at: "t".into(),
        }];
        assert!(find_node(&records, "claude", &route("live", "HK-01", "hk2.example")).is_none());
        assert!(find_node(&records, "gemini", &route("live", "HK-01", "hk1.example")).is_none());
    }

    #[test]
    fn host_match_wins_over_name_only() {
        let mk = |key: &str, host: &str, status: Safety| NodeRecord {
            key: key.into(),
            service: "claude".into(),
            route: route(key, "JP", host),
            status,
            note: String::new(),
            added_at: "t".into(),
            updated_at: "t".into(),
        };
        let records = vec![mk("a", "", Safety::Pending), mk("b", "jp.example", Safety::Safe)];
        assert_eq!(find_node(&records, "claude", &route("live", "JP", "jp.example")).unwrap().key, "b");
    }

    #[test]
    fn marking_live_node_updates_imported_record_and_keeps_key() {
        let mut records = vec![];
        upsert_node(&mut records, "claude", route("import:abc", "US-N-5", "a.example"), Safety::Pending, "".into(), "t1").unwrap();
        upsert_node(&mut records, "claude", route("sha-live", "US-N-5", "a.example"), Safety::Risk, "".into(), "t2").unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].key, "import:abc");
        assert_eq!(records[0].route.fingerprint, records[0].key);
        assert_eq!(records[0].status, Safety::Risk);
    }

    #[test]
    fn stale_connection_log_is_still_registerable() {
        let mut stale = route("live", "US-N-5", "a.example");
        stale.stale = true;
        assert!(registerable(&stale));
        stale.error = "选择变化".into();
        assert!(!registerable(&stale));
    }
}
