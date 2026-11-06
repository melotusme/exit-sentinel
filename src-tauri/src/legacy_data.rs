//! One-time copy of data written under the app's previous identifier.
//! Runs before Tauri starts so settings and WebView storage (theme, list
//! preferences) are in place when the first window loads. The old folders are
//! left untouched, so an older build still finds its data after a rollback.

use std::io;
use std::path::{Path, PathBuf};

pub const LEGACY_ID: &str = "local.mhzrm.exit-sentinel";
pub const CURRENT_ID: &str = "dev.exit-sentinel.desktop";

/// Copies every legacy folder whose new counterpart does not exist yet.
/// Returns readable errors; a failure never blocks startup.
pub fn migrate() -> Vec<String> {
    roots()
        .into_iter()
        .filter_map(|root| copy_if_missing(&root.join(LEGACY_ID), &root.join(CURRENT_ID)).err())
        .collect()
}

/// Parent folders that hold `<identifier>` directories on this platform.
fn roots() -> Vec<PathBuf> {
    let env = |key: &str| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = env("HOME") {
        out.push(home.join("Library/Application Support"));
        out.push(home.join("Library/WebKit"));
    }
    #[cfg(target_os = "windows")]
    out.extend([env("APPDATA"), env("LOCALAPPDATA")].into_iter().flatten());
    #[cfg(target_os = "linux")]
    if let Some(data) = env("XDG_DATA_HOME").or_else(|| env("HOME").map(|h| h.join(".local/share")))
    {
        out.push(data);
    }
    let _ = env;
    out
}

fn copy_if_missing(from: &Path, to: &Path) -> Result<(), String> {
    if !from.is_dir() || to.exists() {
        return Ok(());
    }
    let mut staging = to.as_os_str().to_owned();
    staging.push(".migrating");
    let staging = PathBuf::from(staging);
    let result = (|| {
        if staging.exists() {
            std::fs::remove_dir_all(&staging)?;
        }
        copy_dir(from, &staging)?;
        std::fs::rename(&staging, to)
    })();
    result.map_err(|e| {
        let _ = std::fs::remove_dir_all(&staging);
        format!(
            "旧配置迁移失败（{} → {}）：{e}",
            from.display(),
            to.display()
        )
    })
}

fn copy_dir(from: &Path, to: &Path) -> io::Result<()> {
    std::fs::create_dir_all(to)?;
    std::fs::set_permissions(to, std::fs::metadata(from)?.permissions())?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &target)?; // keeps permissions (0600 settings)
        }
        // Symlinks and sockets inside WebView storage are runtime artefacts; skip them.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "exit-sentinel-migrate-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copies_legacy_folder_and_keeps_original() {
        let root = temp("copy");
        let old = root.join(LEGACY_ID);
        std::fs::create_dir_all(old.join("WebsiteData/LocalStorage")).unwrap();
        std::fs::write(old.join("settings.json"), "{\"a\":1}").unwrap();
        std::fs::write(old.join("WebsiteData/LocalStorage/x.db"), "db").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(
                old.join("settings.json"),
                std::fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }

        copy_if_missing(&old, &root.join(CURRENT_ID)).unwrap();

        let new = root.join(CURRENT_ID);
        assert_eq!(
            std::fs::read_to_string(new.join("settings.json")).unwrap(),
            "{\"a\":1}"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("WebsiteData/LocalStorage/x.db")).unwrap(),
            "db"
        );
        assert!(old.join("settings.json").exists());
        assert!(!root.join(format!("{CURRENT_ID}.migrating")).exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(new.join("settings.json"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn never_overwrites_existing_new_folder() {
        let root = temp("keep");
        std::fs::create_dir_all(root.join(LEGACY_ID)).unwrap();
        std::fs::write(root.join(LEGACY_ID).join("settings.json"), "old").unwrap();
        std::fs::create_dir_all(root.join(CURRENT_ID)).unwrap();
        std::fs::write(root.join(CURRENT_ID).join("settings.json"), "new").unwrap();

        copy_if_missing(&root.join(LEGACY_ID), &root.join(CURRENT_ID)).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join(CURRENT_ID).join("settings.json")).unwrap(),
            "new"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_legacy_folder_is_a_no_op() {
        let root = temp("none");
        copy_if_missing(&root.join(LEGACY_ID), &root.join(CURRENT_ID)).unwrap();
        assert!(!root.join(CURRENT_ID).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "opt-in: run with HOME pointed at a throwaway folder"]
    fn migrates_platform_folders_under_home() {
        let errors = migrate();
        assert!(errors.is_empty(), "{errors:?}");
        for root in roots() {
            if root.join(LEGACY_ID).is_dir() {
                assert!(root.join(CURRENT_ID).is_dir(), "{} not migrated", root.display());
            }
        }
    }
}
