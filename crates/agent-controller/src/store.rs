use crate::config::{Agent, AgentEdit, MAX_AGENTS, MAX_BYTES};
use crate::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Document {
    version: u32,
    agents: Vec<Agent>,
    #[serde(default)]
    parked: BTreeMap<String, ParkedIdentity>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}
/// Keyless inventory. Provenance is not proof of present key custody or membership.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParkedIdentity {
    pub pubkey: String,
    pub name: String,
    pub sources: Vec<crate::LegacySource>,
}
/// One native host owns this profile for its entire lifetime. A corrupt store is
/// an error, never a fresh library; there is no auto-reset or legacy write path.
pub struct Store {
    root: PathBuf,
    _lock: File,
    importing: Arc<AtomicBool>,
}
// Hold across unlocked credential I/O and the final store write. Dropping any
// intermediate import value releases the reservation, including on failure.
pub(crate) struct ImportReservation(Arc<AtomicBool>);
impl ImportReservation {
    pub(crate) fn belongs_to(&self, store: &Store) -> bool {
        Arc::ptr_eq(&self.0, &store.importing)
    }
}
impl Drop for ImportReservation {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        if !root.is_absolute() {
            return Err("Agent storage requires an absolute directory".into());
        }
        fs::create_dir_all(&root).map_err(|_| "Could not create agent storage")?;
        if fs::symlink_metadata(&root)
            .map_err(|_| "Could not inspect agent storage")?
            .file_type()
            .is_symlink()
        {
            return Err("Agent storage cannot be a symbolic link".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|_| "Could not protect agent storage")?;
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = options
            .open(root.join("controller.lock"))
            .map_err(|_| "Could not open agent storage lock")?;
        lock.try_lock()
            .map_err(|_| "Another Buzz app owns this agent storage")?;
        let store = Self {
            root,
            _lock: lock,
            importing: Arc::default(),
        };
        store.read()?;
        Ok(store)
    }
    pub(crate) fn reserve_import(&self) -> Result<ImportReservation> {
        self.importing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Another import is in progress; wait for it to finish")?;
        Ok(ImportReservation(self.importing.clone()))
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    fn path(&self) -> PathBuf {
        self.root.join("agents.json")
    }
    fn read(&self) -> Result<Document> {
        let path = self.path();
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Document {
                    version: 1,
                    ..Document::default()
                });
            }
            Err(_) => return Err("Could not inspect saved agents".into()),
            Ok(meta) if !meta.is_file() || meta.len() > MAX_BYTES as u64 => {
                return Err("Saved agents must be a bounded regular file; left unchanged".into());
            }
            Ok(_) => {}
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| "Could not read saved agents")?;
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read saved agents")?;
        if bytes.len() > MAX_BYTES {
            return Err("Saved agents exceed the size limit; left unchanged".into());
        }
        let doc: Document = serde_json::from_slice(&bytes)
            .map_err(|_| "Saved agents are malformed; left unchanged")?;
        validate(&doc)?;
        Ok(doc)
    }
    fn write(&self, doc: &Document) -> Result<()> {
        validate(doc)?;
        let bytes =
            serde_json::to_vec_pretty(doc).map_err(|_| "Could not encode agent settings")?;
        if bytes.len() > MAX_BYTES {
            return Err("Agent settings exceed the size limit".into());
        }
        // Validate/read first: never replace a newly corrupted file on a later save.
        let old = self.read()?;
        if self.path().exists() {
            let backup =
                serde_json::to_vec_pretty(&old).map_err(|_| "Could not back up agent settings")?;
            atomic_write(&self.root.join("agents.previous.json"), &backup)?;
        }
        atomic_write(&self.path(), &bytes)
    }
    pub(crate) fn agents(&self) -> Result<Vec<Agent>> {
        Ok(self.read()?.agents)
    }
    pub fn snapshot(&self) -> Result<crate::ControlSnapshot> {
        let doc = self.read()?;
        Ok(crate::ControlSnapshot {
            agents: doc.agents.iter().map(Agent::view).collect(),
            parked: doc.parked.into_values().collect(),
            runtime_available: false,
            runtime_message: Some("Native runtime has not been connected".into()),
        })
    }
    /// Merge only safe metadata, independently per source. Missing or damaged legacy
    /// files never erase saved inventory or prevent managing existing agents.
    pub fn migrate_legacy(&mut self, parent: &Path) -> Vec<String> {
        let mut warnings = Vec::new();
        for source in [
            crate::LegacySource::Installed,
            crate::LegacySource::Development,
        ] {
            let path = parent
                .join(source.app_directory())
                .join("agents/managed-agents.json");
            if matches!(fs::symlink_metadata(&path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            {
                continue;
            }
            let result = (|| -> Result<()> {
                let preview = crate::Imports::default().preview(
                    source,
                    parent.into(),
                    self.root.clone(),
                    "",
                )?;
                let mut doc = self.read()?;
                let before = doc.parked.clone();
                for candidate in preview.candidates {
                    let row = doc
                        .parked
                        .entry(candidate.pubkey.clone())
                        .or_insert_with(|| ParkedIdentity {
                            pubkey: candidate.pubkey,
                            name: candidate.name,
                            sources: Vec::new(),
                        });
                    if !row.sources.contains(&source) {
                        row.sources.push(source);
                    }
                }
                if doc.parked != before {
                    self.write(&doc)?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(format!(
                    "Could not update inventory from {}: {error}",
                    source.app_directory()
                ));
            }
        }
        warnings
    }
    pub fn save(&mut self, id: &str, revision: u64, edit: AgentEdit) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err(
                "Agent settings changed. Reload before saving; your draft was not applied".into(),
            );
        }
        agent.apply(edit)?;
        self.write(&doc)
    }
    pub(crate) fn enabled(&mut self, id: &str, enabled: bool) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        agent.enabled = enabled;
        self.write(&doc)
    }
    pub(crate) fn profile_published(&mut self, id: &str, revision: u64) -> Result<()> {
        let mut doc = self.read()?;
        let agent = doc
            .agents
            .iter_mut()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.revision != revision {
            return Err("Saved settings changed; retry the profile".into());
        }
        agent.extra.remove("profilePending");
        self.write(&doc)
    }
    pub(crate) fn insert(&mut self, agents: Vec<Agent>) -> Result<()> {
        let mut doc = self.read()?;
        doc.agents.extend(agents);
        self.write(&doc)
    }
}
impl Drop for Store {
    fn drop(&mut self) {
        // fork/dup shares the lock's open-file description until exec/close.
        // Releasing only our descriptor can leave the profile spuriously owned.
        let _ = self._lock.unlock();
    }
}
fn validate(doc: &Document) -> Result<()> {
    if doc.version != 1 || doc.agents.len() > MAX_AGENTS {
        return Err("Unsupported agent storage version or size; left unchanged".into());
    }
    if doc.parked.len() > MAX_AGENTS
        || doc.parked.iter().any(|(key, row)| {
            key != &row.pubkey || !crate::config::canonical_key(key) || row.sources.is_empty()
        })
    {
        return Err("Invalid parked identity inventory; left unchanged".into());
    }
    let mut ids = BTreeSet::new();
    for agent in &doc.agents {
        agent.validate()?;
        if !ids.insert(&agent.id) {
            return Err("Duplicate saved agent identity; left unchanged".into());
        }
    }
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing agent storage directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)
        .map_err(|_| "Could not prepare agent settings write")?;
    temp.write_all(bytes)
        .map_err(|_| "Could not write agent settings")?;
    temp.as_file()
        .sync_all()
        .map_err(|_| "Could not sync agent settings")?;
    temp.persist(path)
        .map_err(|_| "Could not replace agent settings")?;
    // A successful rename is visible even if directory fsync fails. Surface that
    // uncertainty, do not claim that a failed return means nothing was persisted.
    #[cfg(unix)]
    File::open(parent)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| {
            "Settings were replaced but durability is uncertain; reload before retrying"
        })?;
    Ok(())
}

#[cfg(test)]
mod tests;
