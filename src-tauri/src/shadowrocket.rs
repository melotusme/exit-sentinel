use serde::{Deserialize, Serialize};

#[derive(Clone, Default, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct RouteSnapshot {
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
    if !route.consistent
        || !route.error.is_empty()
        || route.node_name.is_empty()
        || route.fingerprint.is_empty()
    {
        return Err("当前节点未确认，暂不能登记；请核对 Shadowrocket 选择".into());
    }
    if note.chars().count() > 500 {
        return Err("备注最多 500 字".into());
    }
    route.association = "手动登记节点；出口 IP 未关联".into();
    if let Some(r) = records
        .iter_mut()
        .find(|r| r.service == service && r.key == route.fingerprint)
    {
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
pub async fn capture(service: &str, proxy: &str) -> RouteSnapshot {
    let service_owned = service.to_string();
    let result = tokio::task::spawn_blocking(move || {
        std::process::Command::new("/usr/bin/python3")
            .args([
                "-I",
                "-c",
                include_str!("shadowrocket_snapshot.py"),
                &service_owned,
            ])
            .output()
            .map_err(|_| "无法启动本机 Python 3 读取 Shadowrocket 元数据".to_string())
            .and_then(|o| {
                if !o.status.success() || o.stdout.len() > 65536 {
                    return Err("Shadowrocket 元数据读取失败".into());
                }
                serde_json::from_slice::<RouteSnapshot>(&o.stdout)
                    .map_err(|_| "Shadowrocket 元数据格式无效".into())
            })
    })
    .await;
    let mut snapshot = match result {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => RouteSnapshot {
            service: service.into(),
            error: e,
            ..Default::default()
        },
        Err(_) => RouteSnapshot {
            service: service.into(),
            error: "Shadowrocket 读取任务失败".into(),
            ..Default::default()
        },
    };
    if !proxy.is_empty() && proxy != "direct" {
        snapshot.error = "本次使用显式代理，无法将 Shadowrocket 配置作为请求路径归属".into();
        snapshot.consistent = false;
        snapshot.fingerprint = format!("explicit:{proxy}");
    }
    snapshot.association = "当前配置快照，未关联出口 IP".into();
    snapshot.first_seen = crate::now();
    snapshot.last_seen = snapshot.first_seen.clone();
    snapshot
}
pub fn correlate(before: &RouteSnapshot, mut after: RouteSnapshot) -> RouteSnapshot {
    after.association = "请求同期配置快照".into();
    if before.fingerprint != after.fingerprint || before.config != after.config {
        after.error = "请求期间 Shadowrocket 选择发生变化，出口与节点无法关联".into();
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
