use crate::claude::Safety;
use crate::connectivity::Status;
use crate::model::Probe;
use crate::verdict::{Level, Verdict};
use serde_json::Value;
use std::collections::BTreeMap;

/// Keep geography and address family together, using only the latest probe result.
pub fn exit_probe<'a>(probes: &'a [Probe], group: &str) -> Option<&'a Probe> {
    probes
        .iter()
        .find(|p| p.group == group && p.ip.is_some())
        .or_else(|| {
            probes
                .iter()
                .find(|p| p.group == group && !p.checked.is_empty())
        })
        .or_else(|| probes.iter().find(|p| p.group == group))
}

pub fn exit_title(family: &str, probe: Option<&Probe>, paused: bool, checking: bool) -> String {
    if let Some(ip) = probe.and_then(|p| p.ip.as_deref()) {
        return if paused {
            format!("{family} · 上次检测 · {ip}")
        } else {
            format!("{family} · {ip}")
        };
    }
    let status = if paused {
        "已暂停"
    } else if checking {
        "检测中…"
    } else if probe.is_some_and(|p| !p.checked.is_empty()) {
        "检测失败"
    } else {
        "等待检测"
    };
    format!("{family} · {status}")
}

/// Top-level submenu title for 国内出口 / 国外出口 with the primary IP and region when known.
pub fn exit_group_title(
    title: &str,
    group4: &str,
    group6: &str,
    probes: &[Probe],
    geodata: &BTreeMap<String, Value>,
    paused: bool,
    checking: bool,
) -> String {
    let p4 = exit_probe(probes, group4);
    let p6 = exit_probe(probes, group6);
    if let Some(ip) = p4
        .and_then(|p| p.ip.as_deref())
        .or_else(|| p6.and_then(|p| p.ip.as_deref()))
    {
        let loc = geodata
            .get(ip)
            .map(|g| {
                let country = g["country"].as_str().unwrap_or("");
                let region = g["region"].as_str().unwrap_or("");
                if !country.is_empty() && !region.is_empty() && country != region {
                    format!("{country} / {region}")
                } else if !country.is_empty() {
                    country.to_string()
                } else {
                    region.to_string()
                }
            })
            .unwrap_or_default();
        return match (paused, loc.is_empty()) {
            (true, true) => format!("{title} · 上次 {ip}"),
            (true, false) => format!("{title} · 上次 {ip}（{loc}）"),
            (false, true) => format!("{title} · {ip}"),
            (false, false) => format!("{title} · {ip}（{loc}）"),
        };
    }
    if paused {
        format!("{title} · 已暂停")
    } else if checking {
        format!("{title} · 检测中…")
    } else if p4.is_some_and(|p| !p.checked.is_empty()) {
        format!("{title} · 检测失败")
    } else {
        format!("{title} · 等待检测")
    }
}

/// Concise first-level menu label for an AI service: verdict + region/node/IP at a glance.
pub fn ai_service_title(mark: &str, x: &Verdict) -> String {
    if x.headline == "监控已暂停" {
        return format!("{mark} {} · 已暂停", x.name);
    }
    let state = match x.level {
        Level::Safe => "可用",
        Level::Warn => {
            if x.health == Some(Status::Unreachable) {
                "无法连接"
            } else if x.ip.is_some() {
                match x.ip_status {
                    Some(Safety::Pending) => "IP 待确认",
                    None => "IP 未登记",
                    _ => "需要确认",
                }
            } else if !x.node_name.is_empty() {
                match x.node_status {
                    Some(Safety::Pending) => "节点待确认",
                    None => "节点未登记",
                    _ => "需要确认",
                }
            } else {
                "需要确认"
            }
        }
        Level::Risk => {
            if !x.region_code.is_empty() && ["CHN", "HKG", "MAC"].contains(&x.region_code.as_str()) {
                "地区受限"
            } else if x.ip_status == Some(Safety::Risk) {
                "风险 IP"
            } else if x.node_status == Some(Safety::Risk) {
                "风险节点"
            } else {
                "有风险"
            }
        }
        Level::Unknown => "出口未确认",
    };
    let mut parts = vec![format!("{mark} {}", x.name), state.to_string()];
    if !x.region_label.is_empty() {
        parts.push(x.region_label.clone());
    }
    if !x.node_name.is_empty() {
        parts.push(x.node_name.clone());
    }
    if let Some(ip) = &x.ip {
        if !ip.contains(':') || x.node_name.is_empty() {
            parts.push(ip.clone());
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn families_and_regions_never_fall_back_to_each_other_or_history() {
        let mut probes = crate::net::probes(true);
        for (group, ip) in [
            ("domestic", "223.5.5.5"),
            ("foreign", "8.8.8.8"),
            ("domestic6", "2400:3200::1"),
            ("foreign6", "2606:4700:4700::1111"),
        ] {
            let p = probes.iter_mut().find(|p| p.group == group).unwrap();
            p.ip = Some(ip.into());
            p.checked = "2026-11-04T16:00:00+08:00".into();
        }
        for group in ["domestic", "foreign", "domestic6", "foreign6"] {
            assert!(exit_probe(&probes, group).unwrap().ip.is_some());
            for p in probes.iter_mut().filter(|p| p.group == group) {
                p.last_good_ip = p.ip.take();
                p.checked = "2026-11-04T16:01:00+08:00".into();
                p.error = Some("连接超时".into());
            }
            let p = exit_probe(&probes, group).unwrap();
            assert!(p.ip.is_none());
            assert_eq!(exit_title("IPv6", Some(p), false, false), "IPv6 · 检测失败");
        }
    }

    #[test]
    fn waiting_checking_failure_and_paused_are_distinct() {
        let mut p = Probe::default();
        assert_eq!(
            exit_title("IPv4", Some(&p), false, false),
            "IPv4 · 等待检测"
        );
        assert_eq!(exit_title("IPv4", Some(&p), false, true), "IPv4 · 检测中…");
        p.checked = "t1".into();
        assert_eq!(
            exit_title("IPv4", Some(&p), false, false),
            "IPv4 · 检测失败"
        );
        assert_eq!(exit_title("IPv4", Some(&p), true, false), "IPv4 · 已暂停");
        p.ip = Some("8.8.8.8".into());
        assert_eq!(
            exit_title("IPv4", Some(&p), true, false),
            "IPv4 · 上次检测 · 8.8.8.8"
        );
    }

    #[test]
    fn group_and_ai_titles_surface_ip_node_and_region_on_first_level() {
        let mut probes = crate::net::probes(false);
        probes.iter_mut().find(|p| p.group == "foreign").unwrap().ip = Some("8.8.8.8".into());
        let mut geo = BTreeMap::new();
        geo.insert("8.8.8.8".into(), serde_json::json!({"country": "United States", "region": "California"}));
        assert_eq!(
            exit_group_title("国外出口", "foreign", "foreign6", &probes, &geo, false, false),
            "国外出口 · 8.8.8.8（United States / California）"
        );
        let v = Verdict {
            service: "claude".into(),
            name: "Claude".into(),
            level: Level::Safe,
            headline: "可以使用：当前 IP 已确认可用".into(),
            ip: Some("8.8.8.8".into()),
            ip_status: Some(Safety::Safe),
            node_name: "US-01".into(),
            ..Default::default()
        };
        assert_eq!(ai_service_title("🟢", &v), "🟢 Claude · 可用 · US-01 · 8.8.8.8");
    }
}
