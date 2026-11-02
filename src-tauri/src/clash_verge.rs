//! Read-only Clash Verge configuration and Mihomo snapshots. Never modifies proxy rules.
#[cfg(target_os = "windows")]
use crate::shadowrocket::RouteSnapshot;
use serde_json::Value;
#[cfg(target_os = "windows")]
use sha2::{Digest, Sha256};
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::time::Duration;
pub fn directory() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(target_os = "windows"))]
    let root =
        std::env::var_os("HOME").map(|p| PathBuf::from(p).join("Library/Application Support"));
    root.map(|p| p.join("io.github.clash-verge-rev.clash-verge-rev"))
        .filter(|p| p.is_dir())
        .ok_or("未找到 Clash Verge Rev 配置；可能尚未安装或完成首次配置。节点快照不可用，出口检测仍可使用。".into())
}
pub fn yaml(name: &str) -> Result<Value, String> {
    let bytes = std::fs::read(directory()?.join(name))
        .map_err(|_| format!("无法读取 Clash Verge {name}"))?;
    serde_yaml::from_slice(&bytes).map_err(|_| format!("Clash Verge {name} 格式无效"))
}
#[cfg(target_os = "windows")]
pub fn local_proxy() -> Option<String> {
    let config = yaml("clash-verge.yaml").ok()?;
    let port = config["mixed-port"]
        .as_u64()
        .filter(|p| (1..=65535).contains(p))?;
    Some(format!("http://127.0.0.1:{port}"))
}
#[cfg(target_os = "windows")]
async fn api(config: &Value, path: &str) -> Result<Value, String> {
    let address = config["external-controller"].as_str().unwrap_or("");
    let secret = config["secret"].as_str().unwrap_or("");
    if !address.is_empty() {
        let url =
            url::Url::parse(&format!("http://{address}{path}")).map_err(|_| "控制器地址无效")?;
        if !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("只允许本机 Clash 控制器".into());
        }
        let response = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| "控制器初始化失败")?
            .get(url)
            .bearer_auth(secret)
            .send()
            .await
            .map_err(|_| "无法连接 Clash 控制器")?;
        if !response.status().is_success() {
            return Err(format!("Clash 控制器 HTTP {}", response.status().as_u16()));
        }
        let bytes = response.bytes().await.map_err(|_| "控制器响应失败")?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("控制器响应过大".into());
        }
        return serde_json::from_slice(&bytes).map_err(|_| "控制器响应格式无效".into());
    }
    #[cfg(target_os = "windows")]
    {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let pipe = config["external-controller-pipe"]
            .as_str()
            .ok_or("Clash Verge 未提供控制器管道")?;
        if !pipe.starts_with(r"\\.\pipe\") || secret.contains(['\r', '\n']) {
            return Err("Clash 控制器管道无效".into());
        }
        let future = async {
            let mut stream = tokio::net::windows::named_pipe::ClientOptions::new()
                .open(pipe)
                .map_err(|_| "无法连接 Clash Verge 管道")?;
            stream.write_all(format!("GET {path} HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer {secret}\r\nConnection: close\r\n\r\n").as_bytes()).await.map_err(|_| "控制器请求失败")?;
            let mut bytes = Vec::new();
            stream
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "控制器读取失败")?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("控制器响应过大".to_string());
            }
            let split = bytes
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .ok_or("控制器 HTTP 格式无效")?;
            let header = String::from_utf8_lossy(&bytes[..split]);
            if !header.lines().next().unwrap_or("").contains(" 200 ") {
                return Err("控制器请求未成功".into());
            }
            serde_json::from_slice(&bytes[split + 4..])
                .map_err(|_| "控制器 JSON 格式无效".to_string())
        };
        return tokio::time::timeout(Duration::from_secs(4), future)
            .await
            .map_err(|_| "Clash 控制器超时")?;
    }
    #[cfg(not(target_os = "windows"))]
    Err("此平台使用 Shadowrocket 节点读取；Clash 管道读取仅限 Windows".into())
}
#[cfg(any(test, target_os = "windows"))]
pub fn resolve(proxies: &Value, start: &str) -> Result<Vec<String>, String> {
    let mut chain = Vec::new();
    let mut name = start.to_string();
    for _ in 0..24 {
        if chain.contains(&name) {
            return Err("Clash 策略循环".into());
        }
        chain.push(name.clone());
        match proxies[&name]["now"].as_str() {
            Some(next) => name = next.into(),
            None if !proxies[&name].is_null() => return Ok(chain),
            _ => return Err("Clash 节点已失效".into()),
        }
    }
    Err("Clash 策略层级过深".into())
}
#[cfg(target_os = "windows")]
pub async fn capture(service: &str, proxy: &str) -> RouteSnapshot {
    let mut r = RouteSnapshot {
        service: service.into(),
        domain: if service == "claude" {
            "claude.ai"
        } else {
            "gemini.google.com"
        }
        .into(),
        config: "Clash Verge Rev / Mihomo".into(),
        association: "当前配置快照，未关联出口 IP".into(),
        first_seen: crate::now(),
        last_seen: crate::now(),
        ..Default::default()
    };
    let result: Result<(), String> = async {
        let config = yaml("clash-verge.yaml")?;
        let live = api(&config, "/configs").await?;
        r.mode = live["mode"].as_str().unwrap_or("unknown").into();
        let proxies = api(&config, "/proxies").await?;
        let connections = api(&config, "/connections").await?;
        let connection = connections["connections"].as_array().and_then(|a| {
            a.iter()
                .filter(|c| {
                    let h = c["metadata"]["host"].as_str().unwrap_or("");
                    h == r.domain || (service == "claude" && h.ends_with(".claude.ai"))
                })
                .max_by_key(|c| c["start"].as_str().unwrap_or(""))
        });
        if let Some(c) = connection {
            r.chain = c["chains"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            r.chain.reverse();
            r.matched_rule = format!(
                "{} {}",
                c["rule"].as_str().unwrap_or(""),
                c["rulePayload"].as_str().unwrap_or("")
            );
            r.basis = "Clash Verge 同域名活动连接的策略链；不证明其他进程使用相同出口".into();
        } else if r.mode == "global" {
            r.chain = resolve(&proxies["proxies"], "GLOBAL")?;
            r.basis = "Clash Verge 全局选择配置；未观测到同域名活动连接".into();
        } else {
            return Err(
                "暂无此服务的活动连接；请在 Clash Verge 开启连接记录并访问该服务后重试".into(),
            );
        }
        let node = r
            .chain
            .last()
            .filter(|n| !matches!(n.as_str(), "DIRECT" | "REJECT"))
            .ok_or("当前为直连、拒绝或无节点")?
            .clone();
        r.node_name = node.clone();
        r.node_host = proxies["proxies"][&node]["server"]
            .as_str()
            .or_else(|| {
                config["proxies"]
                    .as_array()
                    .and_then(|a| a.iter().find(|p| p["name"].as_str() == Some(node.as_str())))
                    .and_then(|p| p["server"].as_str())
            })
            .unwrap_or("")
            .into();
        r.node_id = node;
        r.fingerprint = format!(
            "clash:{:x}",
            Sha256::digest(format!(
                "{}|{}|{}",
                r.service,
                r.chain.join("|"),
                r.node_host
            ))
        );
        if !proxy.is_empty() && proxy != "direct" {
            let port = url::Url::parse(proxy)
                .ok()
                .filter(|u| matches!(u.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
                .and_then(|u| u.port());
            if port.map(u64::from) != live["mixed-port"].as_u64() {
                return Err("显式代理不是当前 Clash Verge mixed-port，无法关联节点".into());
            }
        }
        r.consistent = true;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        r.error = e;
        r.consistent = false;
    }
    r
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn reads_native_mihomo_pipe_without_http_listener() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let name = format!(r"\\.\pipe\exit-sentinel-test-{}", std::process::id());
        let mut server = tokio::net::windows::named_pipe::ServerOptions::new()
            .create(&name)
            .unwrap();
        let handler = tokio::spawn(async move {
            server.connect().await.unwrap();
            let mut request = [0u8; 2048];
            let n = server.read(&mut request).await.unwrap();
            assert!(String::from_utf8_lossy(&request[..n]).starts_with("GET /configs HTTP/1.0"));
            server
                .write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 17\r\n\r\n{\"mode\":\"global\"}")
                .await
                .unwrap();
            server.flush().await.unwrap();
        });
        let config = serde_json::json!({"external-controller-pipe":name,"secret":"test-only"});
        assert_eq!(api(&config, "/configs").await.unwrap()["mode"], "global");
        handler.await.unwrap();
    }
    #[test]
    fn follows_nested_groups_and_rejects_cycles() {
        let p = serde_json::json!({"GLOBAL":{"now":"AI"},"AI":{"now":"node"},"node":{"type":"ss"}});
        assert_eq!(resolve(&p, "GLOBAL").unwrap(), ["GLOBAL", "AI", "node"]);
        assert!(resolve(&serde_json::json!({"a":{"now":"b"},"b":{"now":"a"}}), "a").is_err());
        assert!(resolve(&p, "missing").is_err());
    }
}
