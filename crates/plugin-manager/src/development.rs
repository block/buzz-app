//! Explicit local development selections. Nothing here enters the installed registry.
use crate::{
    bundled_manifests, effective_grants, err, hash, imports::read_source_file, valid_hash,
    Artifact, Catalog, Manager, Manifest, PluginInfo, ReloadSource, Result, LIMIT,
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path, sync::MutexGuard};

#[derive(Default)]
pub(crate) struct Session {
    fingerprints: Option<BTreeMap<String, String>>,
    selected: BTreeMap<String, Selection>,
    // A monotonic observation, not the artifact hash: A -> B -> A must invalidate old previews.
    generation: u64,
}
#[derive(Clone)]
struct Selection {
    artifact: Artifact,
    revision: String,
    source: ReloadSource,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compatibility {
    version: u32,
    id: String,
    host_build_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub manifest: Manifest,
    pub revision: String,
    pub source: String,
}
pub struct PreparedDevelopment {
    pub preview: Preview,
    selection: Selection,
    observed: u64,
    host_build_id: String,
}
impl Manager {
    fn development_session(&self) -> Result<MutexGuard<'_, Session>> {
        if !cfg!(debug_assertions) || self.safe_mode {
            return Err(
                "Local bundled development requires a development host outside safe mode".into(),
            );
        }
        self.development
            .lock()
            .map_err(|_| "Local development state is unavailable; restart".into())
    }

    /// The running development frontend supplies its compiled projection once at startup.
    /// Runtime flags and dotenv cannot enable this in a release native host.
    pub fn initialize_development(&self, fingerprints: BTreeMap<String, String>) -> Result<()> {
        let mut session = self.development_session()?;
        for (id, fingerprint) in &fingerprints {
            if !crate::is_bundled(id) {
                return Err("Unknown development catalog identity".into());
            }
            valid_hash(fingerprint)?;
        }
        if let Some(existing) = &session.fingerprints {
            if existing != &fingerprints {
                return Err(
                    "Development host changed; restart before attaching local builds".into(),
                );
            }
        } else {
            session.fingerprints = Some(fingerprints);
        }
        Ok(())
    }

    pub fn prepare_development(&self, id: &str, directory: &Path) -> Result<PreparedDevelopment> {
        let (observed, fingerprint) = {
            let session = self.development_session()?;
            let fingerprint = session
                .fingerprints
                .as_ref()
                .and_then(|map| map.get(id))
                .ok_or("This host has no development compatibility for that plugin; rebuild it")?;
            (session.generation, fingerprint.clone())
        };
        // Use the same capability-relative bounded reader as ordinary folder import,
        // but never the ordinary import's bundled-identity bypass or registry.
        if !fs::symlink_metadata(directory)
            .map_err(err)?
            .file_type()
            .is_dir()
        {
            return Err("Choose a regular development build folder".into());
        }
        let root = directory.canonicalize().map_err(err)?;
        let source = ReloadSource::folder(root.clone(), ".".into())?;
        let folder =
            cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority()).map_err(err)?;
        let compatibility: Compatibility =
            serde_json::from_str(&read_source_file(&folder, Path::new("plugin.dev.json"))?)
                .map_err(err)?;
        if compatibility.version != 1
            || compatibility.id != id
            || compatibility.host_build_id != fingerprint
        {
            return Err(
                "Local build is incompatible with this host; rebuild the host and plugin together"
                    .into(),
            );
        }
        let manifest: Manifest =
            serde_json::from_str(&read_source_file(&folder, Path::new("manifest.json"))?)
                .map_err(err)?;
        manifest.validate()?;
        if manifest.id != id || !bundled_manifests().iter().any(|entry| entry.id == id) {
            return Err(
                "Development build identity does not match the selected bundled plugin".into(),
            );
        }
        let code = read_source_file(&folder, Path::new("plugin.js"))?;
        if code.trim().is_empty() {
            return Err("Plugin module is empty".into());
        }
        let artifact = Artifact {
            manifest: manifest.clone(),
            code,
        };
        let bytes = serde_json::to_vec(&artifact).map_err(err)?;
        if bytes.len() as u64 > LIMIT {
            return Err("Plugin artifact exceeds 8 MiB".into());
        }
        let revision = hash(&bytes);
        let nonce = tempfile::NamedTempFile::new().map_err(err)?;
        Ok(PreparedDevelopment {
            preview: Preview {
                token: hash(nonce.path().as_os_str().as_encoded_bytes()),
                manifest,
                revision: revision.clone(),
                source: root.display().to_string(),
            },
            selection: Selection {
                artifact,
                revision,
                source,
            },
            observed,
            host_build_id: fingerprint,
        })
    }

    pub fn attach_development(
        &self,
        prepared: &PreparedDevelopment,
        token: &str,
    ) -> Result<Catalog> {
        self.select_development(prepared, token, false)?;
        self.catalog()
    }
    fn select_development(
        &self,
        prepared: &PreparedDevelopment,
        token: &str,
        reload: bool,
    ) -> Result<()> {
        let mut session = self.development_session()?;
        let id = &prepared.selection.artifact.manifest.id;
        if prepared.preview.token != token {
            return Err("Development preview expired; choose the folder again".into());
        }
        if session.generation != prepared.observed
            || session.fingerprints.as_ref().and_then(|map| map.get(id))
                != Some(&prepared.host_build_id)
        {
            return Err("Local selection changed while reading the folder; try again".into());
        }
        if reload {
            let old = session
                .selected
                .get(id)
                .ok_or("No local build is attached")?;
            if effective_grants(old.artifact.manifest.host.clone().unwrap_or_default())
                != effective_grants(
                    prepared
                        .selection
                        .artifact
                        .manifest
                        .host
                        .clone()
                        .unwrap_or_default(),
                )
            {
                return Err("Host access changed; use Use local dev build to review it".into());
            }
        }
        let generation = session
            .generation
            .checked_add(1)
            .ok_or("Development selection exhausted; restart")?;
        session
            .selected
            .insert(id.clone(), prepared.selection.clone());
        session.generation = generation;
        Ok(())
    }
    pub(crate) fn reload_development(&self, id: &str) -> Result<Catalog> {
        let (source, observed) = {
            let session = self.development_session()?;
            (
                session
                    .selected
                    .get(id)
                    .ok_or("No local build is attached")?
                    .source
                    .clone(),
                session.generation,
            )
        };
        let prepared = self.prepare_development(id, &source.root)?;
        if prepared.observed != observed {
            return Err("Local selection changed while reading the folder; try again".into());
        }
        self.select_development(&prepared, &prepared.preview.token, true)?;
        self.catalog()
    }
    pub fn use_compiled(&self, id: &str) -> Result<Catalog> {
        if !crate::is_bundled(id) {
            return Err("Choose a bundled plugin".into());
        }
        {
            let mut session = self.development_session()?;
            let generation = session
                .generation
                .checked_add(1)
                .ok_or("Development selection exhausted; restart")?;
            session.selected.remove(id);
            session.generation = generation;
        }
        self.catalog()
    }
    pub(crate) fn project_development(&self, plugins: &mut [PluginInfo]) -> Result<()> {
        if !cfg!(debug_assertions) || self.safe_mode {
            return Ok(());
        }
        let session = self.development_session()?;
        for plugin in plugins
            .iter_mut()
            .filter(|plugin| plugin.source == "bundled")
        {
            plugin.development_supported = session
                .fingerprints
                .as_ref()
                .is_some_and(|map| map.contains_key(&plugin.manifest.id));
            if let Some(selection) = session.selected.get(&plugin.manifest.id) {
                plugin.manifest = selection.artifact.manifest.clone();
                plugin.source = "development";
                plugin.revision = selection.revision.clone();
                plugin.reloadable = true;
            }
        }
        Ok(())
    }
    pub(crate) fn development_artifact(&self, id: &str, revision: &str) -> Result<Artifact> {
        let enabled = self.catalog()?.plugins.into_iter().any(|plugin| {
            plugin.manifest.id == id
                && plugin.enabled
                && plugin.revision == revision
                && plugin.source == "development"
        });
        if !enabled {
            return Err(
                "Local build is disabled or no longer selected; refresh the catalog".into(),
            );
        }
        let session = self.development_session()?;
        let selection = session
            .selected
            .get(id)
            .filter(|selection| selection.revision == revision)
            .ok_or("Local build is no longer selected")?;
        Ok(selection.artifact.clone())
    }
}
