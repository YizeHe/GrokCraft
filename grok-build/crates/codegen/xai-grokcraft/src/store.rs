//! `$GROK_HOME/grokcraft.json` — machine identity, never mixed with `auth.json`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::protocol::default_origin;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrokcraftStore {
    pub machine_id: String,
    #[serde(default)]
    pub machine_token: Option<String>,
    pub origin: String,
    pub label: String,
}

pub fn store_path() -> Result<PathBuf> {
    let home = xai_dirs::resolve_grok_home().context("no grok home (set GROK_HOME)")?;
    fs::create_dir_all(&home).with_context(|| format!("create {}", home.display()))?;
    Ok(home.join("grokcraft.json"))
}

pub fn load() -> Result<GrokcraftStore> {
    let path = store_path()?;
    let bytes = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
    let store = serde_json::from_slice(&bytes).context("parse grokcraft.json")?;
    Ok(store)
}

pub fn save(store: &GrokcraftStore) -> Result<()> {
    let path = store_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_vec_pretty(store)?;
    {
        let mut f = fs::File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(&json)?;
        f.write_all(b"\n")?;
        f.sync_all().ok();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(windows)]
    {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
    fs::rename(&tmp, &path).with_context(|| format!("rename {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

pub fn load_or_create() -> Result<GrokcraftStore> {
    match load() {
        Ok(store) => Ok(store),
        Err(_) => {
            let hostname = hostname();
            let store = GrokcraftStore {
                machine_id: uuid::Uuid::new_v4().to_string(),
                machine_token: None,
                origin: default_origin(),
                label: hostname,
            };
            save(&store)?;
            Ok(store)
        }
    }
}

pub(crate) fn hostname() -> String {
    whoami::fallible::hostname()
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn load_or_create_roundtrip() {
        let _guard = ENV_LOCK.lock().unwrap();
        let dir = std::env::temp_dir().join(format!("grokcraft-store-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        unsafe {
            std::env::set_var("GROK_HOME", &dir);
        }
        let created = load_or_create().expect("create");
        assert!(!created.machine_id.is_empty());
        assert!(created.machine_token.is_none());
        let loaded = load().expect("load");
        assert_eq!(created, loaded);
        let mut updated = loaded;
        updated.machine_token = Some("tok".into());
        save(&updated).unwrap();
        assert_eq!(load().unwrap().machine_token.as_deref(), Some("tok"));
        unsafe {
            std::env::remove_var("GROK_HOME");
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
