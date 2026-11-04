//! Google's own view of the Gemini path.
//! - Country: gemini.google.com embeds the country Google assigns to the request IP
//!   (`,2,1,200,"USA"` in the One Google bar config). A "CHN" here is what breaks Gemini.
//! - IP: Google's public STUN server echoes the source address. It is UDP, so it only
//!   counts when it did not leave through the domestic line.
use std::io::Read;
use std::net::{ToSocketAddrs, UdpSocket};
use std::time::Duration;

const GEMINI_PAGE: &str = "https://gemini.google.com/app";
const STUN_SERVER: &str = "stun.l.google.com:19302";
const MAX_COMPRESSED: usize = 2 * 1024 * 1024;
const MAX_PAGE: u64 = 4 * 1024 * 1024;
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/// ISO 3166 alpha-3 codes Google uses here, with a Chinese name.
const COUNTRIES: &[(&str, &str)] = &[
    ("USA", "美国"), ("CHN", "中国"), ("HKG", "中国香港"), ("MAC", "中国澳门"), ("TWN", "中国台湾"),
    ("JPN", "日本"), ("KOR", "韩国"), ("SGP", "新加坡"), ("GBR", "英国"), ("DEU", "德国"),
    ("FRA", "法国"), ("NLD", "荷兰"), ("EST", "爱沙尼亚"), ("CAN", "加拿大"), ("AUS", "澳大利亚"),
    ("IND", "印度"), ("RUS", "俄罗斯"), ("MYS", "马来西亚"), ("THA", "泰国"), ("VNM", "越南"),
    ("PHL", "菲律宾"), ("IDN", "印度尼西亚"), ("TUR", "土耳其"), ("BRA", "巴西"), ("ARE", "阿联酋"),
    ("ITA", "意大利"), ("ESP", "西班牙"), ("CHE", "瑞士"), ("SWE", "瑞典"), ("POL", "波兰"),
];

pub fn country_name(code: &str) -> String {
    COUNTRIES.iter().find(|(c, _)| *c == code).map(|(_, n)| n.to_string()).unwrap_or_else(|| code.to_string())
}

/// Pull the Google-assigned country out of a Gemini page.
pub fn extract_country(page: &str) -> Option<String> {
    const MARK: &str = ",2,1,200,\"";
    let start = page.find(MARK)? + MARK.len();
    let code = page.get(start..start + 3)?;
    (code.chars().all(|c| c.is_ascii_uppercase()) && page.get(start + 3..start + 4) == Some("\"")).then(|| code.to_string())
}

fn decode(body: &[u8], gzip: bool) -> Result<String, String> {
    if !gzip {
        return Ok(String::from_utf8_lossy(body).into_owned());
    }
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(body)
        .take(MAX_PAGE)
        .read_to_end(&mut out)
        .map_err(|_| "Gemini 页面解压失败".to_string())?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Country Google assigns to this machine's Gemini path (ISO alpha-3), using the Gemini proxy setting.
pub async fn judged_country(proxy: &str) -> Result<String, String> {
    let client = crate::net::client(proxy, false)?;
    let r = client
        .get(GEMINI_PAGE)
        .header("User-Agent", BROWSER_UA)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "gzip")
        .send()
        .await
        .map_err(|_| "无法连接 gemini.google.com".to_string())?;
    let status = r.status();
    let gzip = r.headers().get("content-encoding").and_then(|v| v.to_str().ok()) == Some("gzip");
    let body = r.bytes().await.map_err(|_| "读取 Gemini 页面失败".to_string())?;
    if body.len() > MAX_COMPRESSED {
        return Err("Gemini 页面过大，已放弃解析".into());
    }
    let page = decode(&body, gzip)?;
    extract_country(&page).ok_or_else(|| format!("Gemini 页面（HTTP {}）里没有找到 Google 判定的地区", status.as_u16()))
}

/// Source address as seen by Google's STUN server (RFC 5389 binding request, IPv4).
pub fn stun_ip() -> Result<String, String> {
    let server = STUN_SERVER
        .to_socket_addrs()
        .map_err(|_| "无法解析 Google STUN 服务器".to_string())?
        .find(|a| a.is_ipv4())
        .ok_or("Google STUN 服务器没有 IPv4 地址")?;
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    socket.set_read_timeout(Some(Duration::from_secs(4))).map_err(|e| e.to_string())?;
    let mut request = vec![0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42];
    // Transaction id only has to differ between requests; nanoseconds are enough.
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let id: [u8; 12] = std::array::from_fn(|i| (seed >> (i * 8)) as u8);
    request.extend_from_slice(&id);
    socket.send_to(&request, server).map_err(|_| "Google STUN 请求发送失败".to_string())?;
    let mut buf = [0u8; 512];
    let (n, _) = socket.recv_from(&mut buf).map_err(|_| "Google STUN 没有响应（UDP 可能被代理丢弃）".to_string())?;
    parse_stun(&buf[..n], &id).ok_or_else(|| "Google STUN 响应无效".into())
}

fn parse_stun(data: &[u8], id: &[u8; 12]) -> Option<String> {
    if data.len() < 20 || data[0..2] != [0x01, 0x01] || data[8..20] != id[..] {
        return None;
    }
    let mut i = 20;
    while i + 4 <= data.len() {
        let kind = u16::from_be_bytes([data[i], data[i + 1]]);
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        let value = data.get(i + 4..i + 4 + len)?;
        if kind == 0x0020 || kind == 0x0001 {
            // XOR-MAPPED-ADDRESS masks with the magic cookie, then (IPv6) the transaction id.
            let mask: Vec<u8> = [0x21, 0x12, 0xA4, 0x42].into_iter().chain(id.iter().copied()).collect();
            let unmask = |bytes: &[u8]| -> Vec<u8> {
                bytes.iter().zip(&mask).map(|(b, m)| if kind == 0x0020 { b ^ m } else { *b }).collect()
            };
            match (value.get(1), len) {
                (Some(0x01), 8..) => {
                    let ip: [u8; 4] = unmask(&value[4..8]).try_into().ok()?;
                    return Some(std::net::Ipv4Addr::from(ip).to_string());
                }
                (Some(0x02), 20..) => {
                    let ip: [u8; 16] = unmask(&value[4..20]).try_into().ok()?;
                    return Some(std::net::Ipv6Addr::from(ip).to_string());
                }
                _ => {}
            }
        }
        i += 4 + len + (4 - len % 4) % 4;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_country_in_one_google_bar_config() {
        let page = r#"..."AA2YrTvJwWT","",2,1,200,"USA",null,null,"269"..."#;
        assert_eq!(extract_country(page).as_deref(), Some("USA"));
        assert_eq!(extract_country(r#",2,1,200,"CHN","#).as_deref(), Some("CHN"));
        assert!(extract_country("no marker").is_none());
        assert!(extract_country(r#",2,1,200,"us","#).is_none());
        assert_eq!(country_name("HKG"), "中国香港");
    }

    #[test]
    fn decodes_xor_mapped_address() {
        let id = [7u8; 12];
        // Binding success, one XOR-MAPPED-ADDRESS for 203.0.113.64.
        let ip = [203u8 ^ 0x21, 0 ^ 0x12, 113 ^ 0xA4, 64 ^ 0x42];
        let mut msg = vec![0x01, 0x01, 0x00, 0x0C, 0x21, 0x12, 0xA4, 0x42];
        msg.extend_from_slice(&id);
        msg.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0x95, 0x44]);
        msg.extend_from_slice(&ip);
        assert_eq!(parse_stun(&msg, &id).as_deref(), Some("203.0.113.64"));
        assert!(parse_stun(&msg, &[0u8; 12]).is_none());
    }

    #[test]
    fn decodes_ipv6_mapped_address() {
        // Captured from Google STUN on this machine.
        let msg = hex("010100182112a442358d4f83e6ea300eff5b73c2002000140002f76e07160c02358e4e63e6ea300eff5b633d");
        let id: [u8; 12] = msg[8..20].try_into().unwrap();
        let ip = parse_stun(&msg, &id).unwrap();
        assert!(ip.contains(':'), "{ip}");
        assert!(ip.parse::<std::net::Ipv6Addr>().is_ok());
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[tokio::test]
    #[ignore = "opt-in live request to gemini.google.com and Google STUN"]
    async fn live_google_view() {
        println!("country={:?}", judged_country("").await);
        println!("stun={:?}", tokio::task::spawn_blocking(stun_ip).await.unwrap());
    }
}
