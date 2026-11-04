//! One answer per AI service: "can I use it on this exit right now?"
//! Combines the current exit IP status, the current node status and reachability.
use crate::claude::{IpRecord, Safety};
use crate::connectivity::{Reading, Status};
use crate::shadowrocket::{self, NodeRecord, RouteSnapshot};
use serde::Serialize;

#[derive(Clone, Copy, Serialize, Default, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    #[default]
    Unknown,
    Safe,
    Warn,
    Risk,
}

#[derive(Clone, Serialize, Default, Debug)]
pub struct Verdict {
    pub service: String,
    pub name: String,
    pub level: Level,
    pub headline: String,
    pub ip: Option<String>,
    /// "实时观测" or "最近测试"; empty when there is no IP.
    pub ip_source: String,
    pub ip_checked: String,
    pub ip_status: Option<Safety>,
    pub ip_hint: String,
    pub node_name: String,
    /// "最近连接" or "配置候选"; empty when no node is known.
    pub node_source: String,
    pub node_seen: String,
    pub node_stale: bool,
    /// Live fingerprint to pass to `save_ai_node(current=true)`; empty when not registerable.
    pub node_key: String,
    pub node_record: Option<String>,
    pub node_status: Option<Safety>,
    pub node_hint: String,
    pub health: Option<Status>,
    pub health_detail: String,
    /// Gemini: country Google assigns to this path (ISO alpha-3) and its Chinese name.
    pub region_code: String,
    pub region_label: String,
    pub region_checked: String,
    pub region_hint: String,
}

/// Google's country judgement for the Gemini path.
pub struct Region {
    pub code: String,
    pub checked: String,
    pub error: Option<String>,
}

pub struct ExitIp {
    pub ip: String,
    pub source: &'static str,
    pub checked: String,
}

pub struct Input<'a> {
    pub service: &'a str,
    pub name: &'a str,
    pub ip: Option<ExitIp>,
    pub ip_hint: String,
    pub route: Option<&'a RouteSnapshot>,
    pub ips: &'a [IpRecord],
    pub nodes: &'a [NodeRecord],
    pub health: Option<&'a Reading>,
    pub region: Option<Region>,
    pub paused: bool,
}

fn settled_health(r: &Reading) -> Option<Status> {
    if r.stable {
        Some(r.status)
    } else {
        r.confirmed
    }
}

fn node_part(v: &mut Verdict, input: &Input) {
    let Some(route) = input.route else {
        v.node_hint = "尚未读取代理客户端".into();
        return;
    };
    if route.node_name.is_empty() || (!route.error.is_empty() && !route.consistent) {
        v.node_hint = if route.error.is_empty() { "当前节点未确认".into() } else { route.error.clone() };
        return;
    }
    v.node_name = route.node_name.clone();
    v.node_source = if route.evidence == "connection-log" { "最近连接" } else { "配置候选" }.into();
    v.node_seen = route.observed_at.clone();
    v.node_stale = route.stale;
    if shadowrocket::registerable(route) {
        v.node_key = route.fingerprint.clone();
    } else {
        v.node_hint = route.error.clone();
    }
    if let Some(record) = shadowrocket::find_node(input.nodes, input.service, route) {
        v.node_record = Some(record.key.clone());
        v.node_status = Some(record.status.clone());
    }
}

fn subject_label(status: &Option<Safety>, what: &str) -> String {
    match status {
        None => format!("当前{what}尚未登记"),
        Some(Safety::Pending) => format!("当前{what}待确认"),
        Some(Safety::Safe) => format!("当前{what}已确认可用"),
        Some(Safety::Risk) => format!("当前{what}已标记为风险"),
    }
}

/// Places where Google's country decides that Gemini does not work.
fn region_blocks(code: &str) -> Option<&'static str> {
    match code {
        "CHN" => Some("有风险：Google 把当前出口判定为中国，Gemini 无法使用"),
        "HKG" | "MAC" => Some("有风险：Google 判定为中国香港 / 澳门，Gemini 可能无法使用"),
        _ => None,
    }
}

fn decide(v: &mut Verdict) {
    if let Some(headline) = region_blocks(&v.region_code) {
        v.level = Level::Risk;
        v.headline = headline.into();
        return;
    }
    if v.ip_status == Some(Safety::Risk) || v.node_status == Some(Safety::Risk) {
        v.level = Level::Risk;
        let what = if v.ip_status == Some(Safety::Risk) { " IP " } else { "节点" };
        v.headline = format!("有风险：当前{what}已标记为风险");
        return;
    }
    if v.health == Some(Status::Unreachable) {
        v.level = Level::Warn;
        v.headline = format!("当前无法访问 {}", v.name);
        return;
    }
    // The exit IP is what the service sees; the node decides only when no IP is known.
    let (status, what) = if v.ip.is_some() {
        (&v.ip_status, " IP ")
    } else if !v.node_name.is_empty() {
        (&v.node_status, "节点")
    } else {
        v.level = Level::Unknown;
        v.headline = "出口未确认".into();
        return;
    };
    v.level = if *status == Some(Safety::Safe) { Level::Safe } else { Level::Warn };
    v.headline = match v.level {
        Level::Safe => format!("可以使用：{}", subject_label(status, what)),
        _ => format!("需要确认：{}", subject_label(status, what)),
    };
}

pub fn compute(input: Input) -> Verdict {
    let mut v = Verdict {
        service: input.service.into(),
        name: input.name.into(),
        ip_hint: input.ip_hint.clone(),
        ..Default::default()
    };
    if input.paused {
        v.headline = "监控已暂停".into();
        return v;
    }
    if let Some(exit) = &input.ip {
        v.ip = Some(exit.ip.clone());
        v.ip_source = exit.source.into();
        v.ip_checked = exit.checked.clone();
        v.ip_status = input
            .ips
            .iter()
            .find(|r| r.service == input.service && r.ip == exit.ip)
            .map(|r| r.status.clone());
    }
    node_part(&mut v, &input);
    if let Some(r) = input.health {
        v.health = settled_health(r);
        v.health_detail = r.detail.clone();
    }
    if let Some(region) = &input.region {
        v.region_code = region.code.clone();
        v.region_label = if region.code.is_empty() { String::new() } else { crate::google::country_name(&region.code) };
        v.region_checked = region.checked.clone();
        v.region_hint = region.error.clone().unwrap_or_default();
    }
    decide(&mut v);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(status: Safety) -> IpRecord {
        IpRecord {
            routes: vec![],
            service: "claude".into(),
            ip: "8.8.8.8".into(),
            status,
            note: String::new(),
            added_at: "t".into(),
            first_open: None,
            last_open: None,
            source: String::new(),
        }
    }
    fn node(status: Safety) -> NodeRecord {
        NodeRecord {
            key: "import:1".into(),
            service: "claude".into(),
            route: RouteSnapshot { node_name: "US-1".into(), node_host: "us.example".into(), ..Default::default() },
            status,
            note: String::new(),
            added_at: "t".into(),
            updated_at: "t".into(),
        }
    }
    fn live_route() -> RouteSnapshot {
        RouteSnapshot {
            service: "claude".into(),
            node_name: "US-1".into(),
            node_host: "us.example".into(),
            fingerprint: "live".into(),
            consistent: true,
            evidence: "connection-log".into(),
            ..Default::default()
        }
    }
    fn input<'a>(ips: &'a [IpRecord], nodes: &'a [NodeRecord], route: Option<&'a RouteSnapshot>, with_ip: bool) -> Input<'a> {
        Input {
            service: "claude",
            name: "Claude",
            ip: with_ip.then(|| ExitIp { ip: "8.8.8.8".into(), source: "实时观测", checked: "t".into() }),
            ip_hint: String::new(),
            route,
            ips,
            nodes,
            health: None,
            region: None,
            paused: false,
        }
    }

    #[test]
    fn safe_ip_gives_green() {
        let ips = [ip(Safety::Safe)];
        let v = compute(input(&ips, &[], None, true));
        assert_eq!(v.level, Level::Safe);
        assert!(v.headline.contains("可以使用"));
    }

    #[test]
    fn any_risk_wins() {
        let ips = [ip(Safety::Safe)];
        let nodes = [node(Safety::Risk)];
        let route = live_route();
        let v = compute(input(&ips, &nodes, Some(&route), true));
        assert_eq!(v.level, Level::Risk);
        assert_eq!(v.node_record.as_deref(), Some("import:1"));
    }

    #[test]
    fn unregistered_ip_needs_confirmation() {
        let v = compute(input(&[], &[], None, true));
        assert_eq!(v.level, Level::Warn);
        assert!(v.headline.contains("尚未登记"));
    }

    #[test]
    fn node_decides_without_ip() {
        let nodes = [node(Safety::Safe)];
        let route = live_route();
        let v = compute(input(&[], &nodes, Some(&route), false));
        assert_eq!(v.level, Level::Safe);
        assert_eq!(v.node_key, "live");
    }

    #[test]
    fn nothing_known_is_unknown() {
        let v = compute(input(&[], &[], None, false));
        assert_eq!(v.level, Level::Unknown);
    }

    #[test]
    fn google_judging_china_is_risk_even_with_safe_node() {
        let nodes = [node(Safety::Safe)];
        let route = live_route();
        let mut i = input(&[], &nodes, Some(&route), false);
        i.region = Some(Region { code: "CHN".into(), checked: "t".into(), error: None });
        let v = compute(i);
        assert_eq!(v.level, Level::Risk);
        assert!(v.headline.contains("中国"));
        assert_eq!(v.region_label, "中国");
        let mut ok = input(&[], &nodes, Some(&route), false);
        ok.region = Some(Region { code: "USA".into(), checked: "t".into(), error: None });
        let v = compute(ok);
        assert_eq!(v.level, Level::Safe);
        assert_eq!(v.region_label, "美国");
    }

    #[test]
    fn paused_has_no_verdict() {
        let ips = [ip(Safety::Safe)];
        let mut i = input(&ips, &[], None, true);
        i.paused = true;
        assert_eq!(compute(i).level, Level::Unknown);
    }
}
