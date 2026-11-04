use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(default)]
pub struct Settings {
    pub manual_nodes_only: bool,
    pub interval: u64,
    pub claude_proxy: String,
    pub gemini_proxy: String,
    pub gemini_ip_url: String,
    pub notifications: bool,
    pub retain_history: bool,
    pub ipv6: bool,
    pub ipv6_required: bool,
    pub domestic_proxy: String,
    pub foreign_proxy: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            manual_nodes_only: false,
            interval: 30,
            claude_proxy: String::new(),
            gemini_proxy: String::new(),
            gemini_ip_url: String::new(),
            notifications: true,
            retain_history: true,
            ipv6: false,
            ipv6_required: false,
            domestic_proxy: String::new(),
            foreign_proxy: String::new(),
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !self.gemini_ip_url.is_empty() {
            let u = url::Url::parse(&self.gemini_ip_url).map_err(|_| "Gemini 出口检测 URL 无效")?;
            if u.scheme() != "https"
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err("Gemini 出口检测只支持无认证 HTTPS URL".into());
            }
        }
        if !(10..=3600).contains(&self.interval) {
            return Err("检测间隔应为 10–3600 秒".into());
        }
        for p in [
            &self.domestic_proxy,
            &self.foreign_proxy,
            &self.claude_proxy,
            &self.gemini_proxy,
        ] {
            if p.is_empty() || p == "direct" {
                continue;
            }
            let u = url::Url::parse(p).map_err(|_| "代理地址格式不正确")?;
            if !["http", "https", "socks5", "socks5h"].contains(&u.scheme())
                || u.host_str().is_none()
            {
                return Err("支持 http://、https:// 或 socks5h:// 代理".into());
            }
            if !u.username().is_empty() || u.password().is_some() {
                return Err("请使用本地无认证代理；不在配置中保存代理密码".into());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct Probe {
    pub id: String,
    pub label: String,
    pub group: String,
    pub url: String,
    pub ip: Option<String>,
    pub last_good_ip: Option<String>,
    pub detail: String,
    pub latency: u64,
    pub checked: String,
    pub error: Option<String>,
    pub stable: bool,
    #[serde(skip)]
    pub tracker: Tracker,
}

/// Separate baselines for each hostname. None is an observed failure, not an empty IP.
#[derive(Clone, Debug, Default)]
pub struct Tracker {
    initialized: bool,
    committed: Option<String>,
    pending: Option<String>,
    count: u8,
}
impl Tracker {
    pub fn observe(&mut self, value: Option<String>) -> Option<(Option<String>, Option<String>)> {
        if !self.initialized {
            self.initialized = true;
            self.committed = value;
            return None;
        }
        if value == self.committed {
            self.count = 0;
            self.pending = None;
            return None;
        }
        if value == self.pending {
            self.count += 1;
        } else {
            self.pending = value.clone();
            self.count = 1;
        }
        if self.count < 2 {
            return None;
        }
        let old = self.committed.clone();
        self.committed = value.clone();
        self.pending = None;
        self.count = 0;
        Some((old, value))
    }
    pub fn settled(&self) -> bool {
        self.count == 0
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Event {
    pub time: String,
    pub title: String,
    pub detail: String,
}

pub fn parse_ip(body: &str) -> Result<String, String> {
    // ipify JSON, Cloudflare trace, ipip.net text, or plain address.
    if body.trim_start().starts_with('<') {
        return Err("检测站返回了网页/验证页，不是出口 IP".into());
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(ip) = v["ip"].as_str() {
            return public_ip(ip);
        }
        return Err("JSON 响应缺少 ip 字段".into());
    }
    for line in body.lines() {
        if let Some(ip) = line.strip_prefix("ip=") {
            return public_ip(ip.trim());
        }
    }
    for word in body.split(|c: char| c.is_whitespace() || "：,，\"[]{}".contains(c)) {
        if word.parse::<IpAddr>().is_ok() {
            return public_ip(word);
        }
    }
    Err("检测站未返回可识别的公网 IP（可能是验证页或协议变化）".into())
}
pub fn public_ip(s: &str) -> Result<String, String> {
    let ip: IpAddr = s.parse().map_err(|_| "IP 格式无效")?;
    let invalid = match ip {
        IpAddr::V4(a) => {
            a.is_private()
                || a.is_loopback()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_multicast()
                || a.is_documentation()
                || a.is_broadcast()
                || a.octets()[0] == 0
                || a.octets()[0] >= 240
                || (a.octets()[0] == 100 && (64..=127).contains(&a.octets()[1]))
                || (a.octets()[0] == 198 && [18, 19].contains(&a.octets()[1]))
        }
        IpAddr::V6(a) => {
            a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (a.segments()[0] & 0xfe00) == 0xfc00
                || (a.segments()[0] & 0xffc0) == 0xfe80
                || (a.segments()[0] == 0x2001 && a.segments()[1] == 0xdb8)
                || a.to_ipv4_mapped()
                    .map(|v| public_ip(&v.to_string()).is_err())
                    .unwrap_or(false)
        }
    };
    if invalid {
        Err("返回了私网、保留或 Fake-IP 地址，不能作为公网出口".into())
    } else {
        Ok(ip.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn formats_and_fake_ip() {
        assert_eq!(
            parse_ip("当前 IP：223.5.5.5  来自于：中国 北京").unwrap(),
            "223.5.5.5"
        );
        assert_eq!(parse_ip("h=x\nip=8.8.8.8\nloc=US").unwrap(), "8.8.8.8");
        assert_eq!(
            parse_ip("{\"ip\":\"2606:4700:4700::1111\"}").unwrap(),
            "2606:4700:4700::1111"
        );
        for bad in [
            "198.18.0.1",
            "10.0.0.1",
            "127.0.0.1",
            "100.64.0.1",
            "::ffff:127.0.0.1",
            "<html>client IP: 8.8.8.8 </html>",
            "{\"message\":\"8.8.8.8\"}",
        ] {
            assert!(parse_ip(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn changes_debounce_recovery_and_independent_hosts() {
        let mut a = Tracker::default();
        let mut b = Tracker::default();
        assert!(a.observe(Some("1.1.1.1".into())).is_none());
        assert!(b.observe(Some("8.8.8.8".into())).is_none());
        assert!(a.observe(None).is_none());
        assert!(!a.settled());
        assert!(a.observe(Some("1.1.1.1".into())).is_none()); // transient failure
        a.observe(None);
        assert_eq!(a.observe(None), Some((Some("1.1.1.1".into()), None)));
        a.observe(Some("9.9.9.9".into()));
        assert_eq!(
            a.observe(Some("9.9.9.9".into())),
            Some((None, Some("9.9.9.9".into())))
        );
        assert!(b.observe(Some("8.8.8.8".into())).is_none());
    }
    #[test]
    fn proxy_settings_validation() {
        let mut s = Settings::default();
        s.foreign_proxy = "socks5h://127.0.0.1:7890".into();
        assert!(s.validate().is_ok());
        s.foreign_proxy = "http://user:password@localhost:7890".into();
        assert!(s.validate().is_err());
        s.foreign_proxy.clear();
        s.interval = 0;
        assert!(s.validate().is_err());
    }
}
