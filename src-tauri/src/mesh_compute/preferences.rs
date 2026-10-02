//! Donor mesh-sharing.json checkpoints, bound to the selected viewer and community.
use super::sharing::Share;
use std::{io::Write, path::PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Config {
    pub viewer: String,
    pub community: String,
    pub model: String,
    pub max_vram_gb: Option<u64>,
    pub enabled: bool,
}
impl Config {
    pub fn pending(viewer: String, community: String, share: &Share) -> Self {
        Self {
            viewer,
            community,
            model: share.model.clone(),
            max_vram_gb: share.max_vram_gb,
            enabled: false,
        }
    }
}

#[derive(Default)]
pub(super) struct Preferences {
    path: Option<PathBuf>,
    config: Option<Config>,
    selected: Option<(String, String)>,
    error: Option<String>,
}
impl Preferences {
    pub fn initialize(&mut self, path: Result<PathBuf, String>) {
        match path.and_then(|path| {
            let config = match std::fs::read(&path) {
                Ok(bytes) => {
                    let mut config: Config = serde_json::from_slice(&bytes)
                        .map_err(|e| format!("Invalid Mesh sharing settings: {e}"))?;
                    config.model =
                        buzz_mesh_compute::catalog::canonical_curated_model_id(&config.model)
                            .to_owned();
                    if config.viewer.is_empty()
                        || config.community.is_empty()
                        || config.model.is_empty()
                        || config.max_vram_gb == Some(0)
                    {
                        return Err("Invalid Mesh sharing settings".into());
                    }
                    Some(config)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("Could not read Mesh sharing settings: {error}")),
            };
            Ok((path, config))
        }) {
            Ok((path, config)) => {
                self.path = Some(path);
                self.config = config;
            }
            Err(error) => self.error = Some(error),
        }
    }
    pub fn viewer_changed(&self, viewer: &str) -> bool {
        self.selected
            .as_ref()
            .is_some_and(|(selected, _)| selected != viewer)
    }
    pub fn select(&mut self, viewer: String, community: String) {
        self.selected = Some((viewer, community));
    }
    pub fn hint(&self) -> Option<&Config> {
        self.config.as_ref().filter(|config| {
            self.selected.as_ref() == Some(&(config.viewer.clone(), config.community.clone()))
        })
    }
    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
    }
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }
    pub fn checkpoint(&mut self, config: Config) -> Result<(), String> {
        let result = self.write(&config);
        match result {
            Ok(()) => {
                self.config = Some(config);
                self.error = None;
                Ok(())
            }
            Err(error) => {
                self.error = Some(error.clone());
                Err(error)
            }
        }
    }
    fn write(&self, config: &Config) -> Result<(), String> {
        let path = self
            .path
            .as_ref()
            .ok_or("Mesh settings storage unavailable")?;
        let parent = path.parent().ok_or("Mesh settings directory unavailable")?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create Mesh settings directory: {e}"))?;
        let bytes = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
        // Same atomic tempfile/rename pattern as agent-controller; never truncate the old file.
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
        temp.write_all(&bytes).map_err(|e| e.to_string())?;
        temp.as_file().sync_all().map_err(|e| e.to_string())?;
        temp.persist(path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| {
                "Mesh settings were replaced but durability is uncertain; reload before retrying"
            })?;
        Ok(())
    }
    pub fn disarm(&mut self) -> Result<(), String> {
        if let Some(mut config) = self.hint().cloned() {
            config.enabled = false;
            self.checkpoint(config)?;
        }
        Ok(())
    }
    pub fn phase(
        &mut self,
        expected: &Config,
        phase: &buzz_mesh_compute::lifecycle::Phase,
        reached_ready: bool,
    ) -> Result<(), String> {
        if self.hint().map_or(true, |current| {
            current.viewer != expected.viewer
                || current.community != expected.community
                || current.model != expected.model
                || current.max_vram_gb != expected.max_vram_gb
        }) {
            return Ok(());
        }
        // Normal shutdown deliberately leaves enabled armed for restore through Mesh.
        if *phase == buzz_mesh_compute::lifecycle::Phase::Ready
            || (matches!(phase, buzz_mesh_compute::lifecycle::Phase::Failed(_)) && !reached_ready)
        {
            let mut config = expected.clone();
            config.enabled = *phase == buzz_mesh_compute::lifecycle::Phase::Ready;
            self.checkpoint(config)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_mesh_compute::lifecycle::Phase;
    fn config() -> Config {
        Config::pending(
            "viewer".into(),
            "https://fixture.example".into(),
            &Share {
                model: "fixture".into(),
                max_vram_gb: None,
            },
        )
    }
    fn store(path: PathBuf) -> Preferences {
        let mut store = Preferences::default();
        store.initialize(Ok(path));
        store.select("viewer".into(), "https://fixture.example".into());
        store
    }
    #[test]
    fn ready_arms_quit_preserves_failed_disarms_and_model_hint_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path.clone());
        prefs.checkpoint(config()).unwrap();
        assert!(!store(path.clone()).hint().unwrap().enabled);
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        prefs.phase(&config(), &Phase::Stopped, false).unwrap();
        assert!(store(path.clone()).hint().unwrap().enabled);
        prefs
            .phase(&config(), &Phase::Failed("runtime crash".into()), true)
            .unwrap();
        assert!(store(path.clone()).hint().unwrap().enabled);
        prefs
            .phase(&config(), &Phase::Failed("load failed".into()), false)
            .unwrap();
        let reopened = store(path.clone());
        assert!(!reopened.hint().unwrap().enabled);
        assert_eq!(reopened.hint().unwrap().model, "fixture");
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        prefs.disarm().unwrap();
        assert!(!store(path).hint().unwrap().enabled);
    }
    #[test]
    fn different_viewer_or_community_cannot_restore_or_rearm_old_intent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path);
        prefs.checkpoint(config()).unwrap();
        for (viewer, community) in [
            ("other", "https://fixture.example"),
            ("viewer", "https://other.example"),
        ] {
            prefs.select(viewer.into(), community.into());
            assert!(prefs.hint().is_none());
            prefs.phase(&config(), &Phase::Ready, false).unwrap();
            assert!(!prefs.config.as_ref().unwrap().enabled);
        }
    }
    #[test]
    fn failed_write_preserves_prior_checkpoint_and_old_model_cannot_arm_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        let mut prefs = store(path.clone());
        prefs.checkpoint(config()).unwrap();
        let mut replacement = config();
        replacement.model = "replacement".into();
        prefs.checkpoint(replacement.clone()).unwrap();
        prefs.phase(&config(), &Phase::Ready, false).unwrap();
        assert!(!store(path.clone()).hint().unwrap().enabled);
        assert_eq!(store(path.clone()).hint().unwrap().model, "replacement");
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        prefs.path = Some(blocked.join("mesh-sharing.json"));
        assert!(prefs.phase(&replacement, &Phase::Ready, false).is_err());
        assert!(!prefs.hint().unwrap().enabled);
        assert!(!store(path).hint().unwrap().enabled);
    }
    #[test]
    fn invalid_settings_and_failed_write_do_not_silently_arm() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh-sharing.json");
        std::fs::write(&path, b"{invalid").unwrap();
        let mut prefs = store(path);
        assert!(prefs.error().is_some());
        assert!(prefs.hint().is_none());
        assert!(prefs.checkpoint(config()).is_err());
        let blocked = dir.path().join("blocked");
        std::fs::write(&blocked, b"not a directory").unwrap();
        let mut prefs = store(blocked.join("mesh-sharing.json"));
        assert!(prefs.checkpoint(config()).is_err());
        assert!(prefs.hint().is_none());
    }
}
