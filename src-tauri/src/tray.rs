use crate::model::Probe;

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
}
