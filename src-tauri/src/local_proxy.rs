//! Read registered local profiles, without touching subscription URLs or client settings.
use crate::{
    proxy_import::{self, Preview},
    shadowrocket::RouteSnapshot,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub const CLIENTS: &[(&str, &str)] = &[
    ("shadowrocket", "Shadowrocket"),
    ("clash_verge", "Clash Verge"),
    ("karing", "Karing"),
    ("clash_mi", "Clash Mi"),
];
#[derive(Serialize)]
pub struct Availability {
    pub id: String,
    pub state: String,
    pub message: String,
    pub nodes: usize,
}
fn read(path: &Path) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission_denied".to_string(),
        std::io::ErrorKind::NotFound => "missing".to_string(),
        _ => "unreadable".to_string(),
    })?;
    let mut bytes = vec![];
    file.take(proxy_import::LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "unreadable")?;
    if bytes.len() > proxy_import::LIMIT {
        return Err("too_large".into());
    }
    String::from_utf8(bytes).map_err(|_| "unreadable".into())
}
fn home() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let name = "USERPROFILE";
    #[cfg(not(target_os = "windows"))]
    let name = "HOME";
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or("unreadable".into())
}
fn roots(client: &str) -> Result<Vec<PathBuf>, String> {
    let h = home()?;
    #[cfg(target_os = "macos")]
    return Ok(match client {
        "shadowrocket" => {
            vec![h.join("Library/Group Containers/group.com.liguangming.Shadowrocket")]
        }
        "clash_verge" => vec![
            h.join("Library/Application Support/io.github.clash-verge-rev.clash-verge-rev"),
            h.join("Library/Application Support/io.github.zzzgydi.clash-verge"),
        ],
        "karing" => vec![h.join("Library/Group Containers/group.com.nebula.karing")],
        "clash_mi" => vec![h.join("Library/Group Containers/group.com.nebula.clashmi")],
        _ => return Err("unsupported".into()),
    });
    #[cfg(target_os = "windows")]
    {
        let roaming = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .ok_or("unreadable")?;
        Ok(match client {
            "clash_verge" => vec![
                roaming.join("io.github.clash-verge-rev.clash-verge-rev"),
                roaming.join("io.github.zzzgydi.clash-verge"),
            ],
            _ => return Err("unsupported".into()),
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let data = crate::clash_verge::data_root().unwrap_or_else(|| h.join(".local/share"));
        Ok(match client {
            "clash_verge" => vec![
                data.join("io.github.clash-verge-rev.clash-verge-rev"),
                data.join("io.github.zzzgydi.clash-verge"),
            ],
            _ => return Err("unsupported".into()),
        })
    }
}
fn profile_sources(root: &Path, client: &str) -> Result<(Vec<String>, usize), String> {
    let index = read(&root.join(if client == "clash_mi" {
        "profiles.json"
    } else {
        "profiles.yaml"
    }))?;
    let value: Value = serde_yaml::from_str(&index).map_err(|_| "unreadable")?;
    let rows = value[if client == "clash_mi" {
        "profiles"
    } else {
        "items"
    }]
    .as_array()
    .ok_or("unreadable")?;
    let mut sources = vec![];
    let mut failed = 0;
    let mut total = 0;
    for row in rows {
        let filename = if client == "clash_mi" {
            row["id"].as_str().ok_or("unreadable")?.to_string()
        } else {
            let Some(file) = row["file"].as_str() else {
                continue;
            };
            if !matches!(row["type"].as_str(), Some("remote" | "local")) {
                continue;
            }
            file.into()
        };
        // Index entries are untrusted; never allow a path outside the profiles directory.
        if filename.contains(['/', '\\'])
            || !filename.ends_with(".yaml") && !filename.ends_with(".yml")
        {
            failed += 1;
            continue;
        }
        let profiles = root.join("profiles");
        let path = profiles.join(filename);
        if let (Ok(base), Ok(file)) = (profiles.canonicalize(), path.canonicalize()) {
            if !file.starts_with(base) {
                failed += 1;
                continue;
            }
        }
        match read(&path) {
            Ok(content) => {
                total += content.len();
                if total > 32 * 1024 * 1024 || sources.len() >= 256 {
                    return Err("too_large".into());
                }
                let Ok(mut value) = serde_yaml::from_str::<Value>(&content) else { failed += 1; continue; };
                if value.is_object() {
                    value["sentinel_source"] = Value::String(proxy_import::source_label(
                        row["name"].as_str().or(row["remark"].as_str()).unwrap_or("未命名订阅")));
                    value["sentinel_source_id"] = Value::String(path.file_name().and_then(|p| p.to_str()).unwrap_or("").into());
                    sources.push(serde_json::to_string(&value).map_err(|_| "unreadable")?);
                } else { failed += 1; }
            }
            Err(e) if e == "permission_denied" => return Err(e),
            Err(_) => failed += 1,
        }
    }
    if sources.is_empty() {
        return Err("unconfigured".into());
    }
    Ok((sources, failed))
}
fn sources(client: &str) -> Result<(Vec<String>, usize), String> {
    let candidates = roots(client)?;
    let mut selected = None;
    for root in candidates {
        match root.try_exists() {
            Ok(true) => {
                selected = Some(root);
                break;
            }
            Ok(false) => (),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err("permission_denied".into())
            }
            Err(_) => return Err("unreadable".into()),
        }
    }
    let root = selected.ok_or("missing")?;
    if client == "shadowrocket" {
        #[cfg(target_os = "macos")]
        {
            let output = std::process::Command::new("/usr/bin/python3")
                .args(["-I", "-c", include_str!("shadowrocket_nodes.py")])
                .output()
                .map_err(|_| "python_unavailable")?;
            if !output.status.success() || output.stdout.len() > proxy_import::LIMIT {
                return Err("unreadable".into());
            }
            let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| "unreadable")?;
            if let Some(error) = value["error"].as_str() {
                return Err(error.into());
            }
            return Ok((
                vec![String::from_utf8(output.stdout).map_err(|_| "unreadable")?],
                0,
            ));
        }
        #[cfg(not(target_os = "macos"))]
        return Err("unsupported".into());
    }
    if client == "karing" {
        return Ok((vec![read(&root.join("karing_subscribe.json"))?], 0));
    }
    profile_sources(&root, client)
}
pub fn prepare(client: &str, service: &str) -> Result<(Preview, Vec<RouteSnapshot>), String> {
    let (sources, mut failed) = sources(client)?;
    let mut routes = vec![];
    let mut seen = std::collections::HashSet::new();
    let mut skipped = 0;
    for source in sources {
        match proxy_import::prepare(client, service, &source) {
            Ok((preview, nodes)) => {
                skipped += preview.skipped;
                for mut route in nodes {
                    if seen.insert((route.service.clone(), route.fingerprint.clone())) {
                        route.config = route.config.replace("手动导入", "本机读取");
                        route.basis =
                            "读取本机软件保存的节点定义；未确认当前选择、实时连接或可用性".into();
                        routes.push(route);
                    }
                }
            }
            Err(_) => failed += 1,
        }
    }
    if routes.is_empty() {
        return Err("unconfigured".into());
    }
    if routes.len() > 10000 {
        return Err("too_large".into());
    }
    let nodes = routes
        .iter()
        .map(|r| &r.fingerprint)
        .collect::<std::collections::HashSet<_>>()
        .len();
    Ok((
        Preview {
            id: 0,
            nodes,
            records: routes.len(),
            skipped,
            format: "本机节点库（已自动定位）".into(),
            warnings: if failed > 0 {
                format!("有 {failed} 份配置无法解析或没有节点，未导入这些配置。")
            } else {
                String::new()
            },
        },
        routes,
    ))
}
pub fn explain(code: &str) -> String {
    match code {
        "missing" => "未找到本机配置；可能尚未安装或尚未在此电脑完成首次配置。",
        "unconfigured" => "未找到可导入节点；请先在该软件中添加订阅并更新节点。",
        "permission_denied" => "系统拒绝访问该软件数据；请在系统设置中检查文件访问权限后重试。",
        "unsupported" => "当前平台无法自动读取此软件，仍可使用备用文件导入。",
        "python_unavailable" => "Shadowrocket 读取组件 Python 3 不可用，仍可使用备用文件导入。",
        "too_large" => "本机配置过大或节点超过上限，请使用备用文件分批导入。",
        _ => "配置无法读取或格式已变化；请先打开该软件完成配置，再重新检测。",
    }
    .into()
}
pub fn discover() -> Vec<Availability> {
    CLIENTS
        .iter()
        .map(|(id, _)| match prepare(id, "claude") {
            Ok((preview, _)) => Availability {
                id: (*id).into(),
                state: "ready".into(),
                message: format!("可读取 {} 个节点。{}", preview.nodes, preview.warnings),
                nodes: preview.nodes,
            },
            Err(code) => Availability {
                id: (*id).into(),
                state: code.clone(),
                message: explain(&code),
                nodes: 0,
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_only_registered_profiles_and_uses_existing_filename() {
        let root =
            std::env::temp_dir().join(format!("sentinel-local-profiles-{}", std::process::id()));
        std::fs::create_dir_all(root.join("profiles")).unwrap();
        std::fs::write(
            root.join("profiles.json"),
            r#"{"profiles":[{"id":"123.yaml"},{"id":"../outside.yaml"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("profiles/123.yaml"), "proxies: []").unwrap();
        std::fs::write(
            root.join("profiles/orphan.yaml"),
            "do not import deleted profiles",
        )
        .unwrap();
        let (sources, failed) = profile_sources(&root, "clash_mi").unwrap();
        assert_eq!(serde_json::from_str::<Value>(&sources[0]).unwrap()["proxies"], serde_json::json!([]));
        assert_eq!(failed, 1);
        std::fs::write(
            root.join("profiles.yaml"),
            "items:\n - {type: remote, file: 123.yaml}\n - {type: script, file: orphan.yaml}\n",
        )
        .unwrap();
        assert_eq!(profile_sources(&root, "clash_verge").unwrap().0.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "opt-in read-only discovery of local proxy client node counts"]
    fn live_local_client_counts() {
        for item in discover() {
            println!(
                "{}: {} nodes={} {}",
                item.id, item.state, item.nodes, item.message
            );
            assert_eq!(item.state, "ready");
            assert!(item.nodes > 0);
        }
    }
}
