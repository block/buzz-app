//! Generic plugin secret slots: declared write-only values in the OS credential
//! store, and the one external, non-secret lifecycle inventory that desktop and
//! CLI share. Every account a writer could create is enumerable before the OS
//! write starts; retirement is permanent; deletion is confirmed before de-indexing.
//!
//! Metadata locks are the registry lock R, the inventory-wide lock G and one
//! lock I per home/profile namespace, taken R→G→I and never held across an OS
//! call. One completion lock W per enrollment slot (namespace, plugin, identity,
//! slot) is held through the OS mutation and its revalidation. Only a writer
//! holding no metadata waits for W, briefly; metadata holders only try it, so no
//! wait can cycle. All lock files are stable: never replaced or unlinked.
use crate::{err, valid_id, HostGrants, Installed, Manager, Manifest, Registry, Result};
use buzz_credential_store::Error;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

/// Keychain service and inventory root name, apart for debug builds.
pub const SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.plugin-secret.debug"
} else {
    "xyz.block.buzz.desktop.plugin-secret"
};
const VARIANT: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};
/// The other supported build: its fixed service, read only for its continuity witness.
pub const PEER_SERVICE: &str = if cfg!(debug_assertions) {
    "xyz.block.buzz.desktop.plugin-secret"
} else {
    "xyz.block.buzz.desktop.plugin-secret.debug"
};
const PEER_VARIANT: &str = if cfg!(debug_assertions) {
    "release"
} else {
    "debug"
};
pub const MAX_SLOTS: usize = 16;
pub const MAX_VALUE_BYTES: usize = 512;
pub const MAX_NAMESPACES: usize = 32;
pub const MAX_ENTRIES: usize = 256;
const MAX_RECORD_BYTES: usize = 256 * 1024;
/// Room each entry may need to be retired later (phase and cause), reserved
/// when an intent is admitted so a full record always stays cleanable.
const RETIRE_BYTES: usize = 32;
pub(crate) const STATE: &str = "state.json";
/// One deliberate cleanup attempt shares this caller-wait budget.
pub const CLEANUP_BUDGET: Duration = Duration::from_secs(30);
/// How long a new write waits out another holder's momentary W probe. A
/// stalled OS call on the same slot outlasts it and the write is refused.
const WRITER_WAIT: Duration = Duration::from_millis(250);

const UNREADABLE: &str =
    "Saved credential records are unreadable or incomplete; saved credentials stay unavailable";
const UNWRITABLE: &str = "Saved credential records could not be updated; try again";
const UNAVAILABLE: &str = "Saved credentials are unavailable";
const UNSUPPORTED: &str = "Saved credentials are not supported on this platform yet";
const FOREIGN: &str =
    "Plugin settings belong to another Buzz build with saved credentials; recover them with that build";
const UNINSPECTED: &str =
    "Plugin settings could not be checked for saved credentials, so they were not recovered";
const BUSY: &str = "The saved credential is busy; try again";
const FULL: &str = "Saved credential records are full; retry cleanup first";
const NOT_SAVED: &str = "The credential could not be saved";
const SIGNING_OUT: &str = "Buzz is signing out; saved credentials are unavailable";
const CLEANUP_INCOMPLETE: &str =
    "Saved credential cleanup is incomplete; allow secure storage access and retry";
pub const SIGN_OUT_INCOMPLETE: &str = "Buzz couldn't remove saved plugin credentials while signing out. Unlock or allow access to secure storage, then open Buzz again to retry.";
/// Metadata, not secure storage, failed: relaunching cannot repair lost records.
pub const SIGN_OUT_UNREADABLE: &str = "Buzz couldn't confirm saved plugin credentials were removed while signing out: their records are unreadable, incomplete or could not be updated. Sign-out stays incomplete.";

const WITHDRAWN: &str = "Plugin was disabled or updated; refresh the catalog";

/// A refused credential admission. Only another holder's momentary metadata
/// lock (`WouldBlock`) is `Busy`. `Withdrawn` is the terminal refusal of a
/// plugin no longer enabled at the reviewed revision; every other refusal is
/// `Terminal`. All keep the message string callers have always received.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Busy(String),
    Withdrawn(String),
    Terminal(String),
}
impl Refusal {
    pub fn message(self) -> String {
        match self {
            Self::Busy(message) | Self::Withdrawn(message) | Self::Terminal(message) => message,
        }
    }
}
impl From<String> for Refusal {
    fn from(message: String) -> Self {
        Self::Terminal(message)
    }
}
impl From<&str> for Refusal {
    fn from(message: &str) -> Self {
        Self::Terminal(message.into())
    }
}
type Admission<T> = std::result::Result<T, Refusal>;

// ---------------------------------------------------------------- manifest

/// A declared slot. The value never appears in a manifest.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SecretSlot {
    pub id: String,
    pub label: String,
    pub origins: Vec<String>,
    pub header: String,
    /// `""` sends the raw value; otherwise `<scheme> <value>`.
    pub scheme: String,
}
/// The credential authority of a slot. Label, order and header case are not authority.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    origins: Vec<String>,
    header: String,
    scheme: String,
}
impl SecretSlot {
    pub fn policy(&self) -> Policy {
        let mut origins = self.origins.clone();
        origins.sort();
        Policy {
            origins,
            header: self.header.to_ascii_lowercase(),
            scheme: self.scheme.clone(),
        }
    }
}
fn token(text: &str) -> bool {
    text.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
pub(crate) fn validate_slots(host: &HostGrants) -> Result<()> {
    if host.secrets.len() > MAX_SLOTS {
        return Err("Too many host declarations".into());
    }
    let invalid = || "Invalid secret slot declaration".to_string();
    let mut ids = std::collections::HashSet::new();
    for slot in &host.secrets {
        valid_id(&slot.id).map_err(|_| invalid())?;
        let label = slot.label.trim();
        let mut origins = std::collections::HashSet::new();
        if !ids.insert(&slot.id)
            || label.is_empty()
            || label != slot.label
            || slot.label.len() > 80
            || slot.label.chars().any(char::is_control)
            || slot.origins.is_empty()
            || slot.origins.len() > 16
            || !slot
                .origins
                .iter()
                .all(|origin| host.network_origins.contains(origin) && origins.insert(origin))
            || !matches!(
                slot.header.to_ascii_lowercase().as_str(),
                "authorization" | "x-api-key"
            )
            || slot.scheme.len() > 32
            || !token(&slot.scheme)
        {
            return Err(invalid());
        }
    }
    Ok(())
}
/// Trimmed nonempty visible ASCII, at most 512 bytes; validated before any mutation.
pub fn valid_value(value: &str) -> Result<Zeroizing<String>> {
    let value = value.trim_matches(|c: char| c.is_ascii_whitespace());
    if value.is_empty()
        || value.len() > MAX_VALUE_BYTES
        || !value.bytes().all(|b| b.is_ascii_graphic())
    {
        return Err("Enter a credential of 1–512 visible ASCII characters".into());
    }
    Ok(Zeroizing::new(value.to_owned()))
}
/// 64 lowercase hex characters: a human public identity or a SHA-256 digest.
fn hex64(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_identity(identity: &str) -> Result<()> {
    if hex64(identity) {
        Ok(())
    } else {
        Err("Sign in to use saved credentials".into())
    }
}

// ---------------------------------------------------------------- storage

/// Exact create-only add, exact read and confirmed delete of one opaque account.
pub trait SecretStore: Send + Sync {
    fn read(&self, account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error>;
    fn add(&self, account: &str, value: &[u8]) -> std::result::Result<(), Error>;
    /// Absent is success.
    fn delete(&self, account: &str) -> std::result::Result<(), Error>;
}
/// The OS credential store under [`SERVICE`]. Unit tests compile it to a
/// fail-closed stub: the credential-store crate's own test denial does not
/// apply to its dependents' tests.
pub struct OsStore;
#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
impl SecretStore for OsStore {
    fn read(&self, account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
        buzz_credential_store::read(SERVICE, account)
    }
    fn add(&self, account: &str, value: &[u8]) -> std::result::Result<(), Error> {
        buzz_credential_store::add(SERVICE, account, value)
    }
    fn delete(&self, account: &str) -> std::result::Result<(), Error> {
        match buzz_credential_store::delete(SERVICE, account) {
            Err(Error::Absent) => Ok(()),
            other => other,
        }
    }
}
#[cfg(any(
    test,
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
impl SecretStore for OsStore {
    fn read(&self, _: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
        Err(Error::Unavailable)
    }
    fn add(&self, _: &str, _: &[u8]) -> std::result::Result<(), Error> {
        Err(Error::Unavailable)
    }
    fn delete(&self, _: &str) -> std::result::Result<(), Error> {
        Err(Error::Unavailable)
    }
}
/// The other supported build's continuity witness under [`PEER_SERVICE`], read
/// only: every other account, and every add or delete, refuses.
pub struct PeerStore;
impl SecretStore for PeerStore {
    fn read(&self, account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
        if account != continuity::ACCOUNT {
            return Err(Error::Denied);
        }
        peer_read(account)
    }
    fn add(&self, _: &str, _: &[u8]) -> std::result::Result<(), Error> {
        Err(Error::Denied)
    }
    fn delete(&self, _: &str) -> std::result::Result<(), Error> {
        Err(Error::Denied)
    }
}
#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
fn peer_read(account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
    buzz_credential_store::read(PEER_SERVICE, account)
}
#[cfg(any(
    test,
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn peer_read(_: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
    let _ = PEER_SERVICE;
    Err(Error::Unavailable)
}
/// Absent until a caller wires an inventory root and store: plugin-facing calls
/// then fail closed, and lifecycle changes to enrolled plugins are refused.
#[derive(Clone, Default)]
pub(crate) struct Storage {
    root: Option<PathBuf>,
    store: Option<Arc<dyn SecretStore>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SecretStatus {
    Saved,
    Missing,
    Unreadable,
}
/// Non-secret cleanup summary for one home/profile.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStatus {
    /// Retired accounts not yet confirmed absent.
    pub pending: usize,
    /// Of those, accounts an OS operation still owns.
    pub running: usize,
    /// The records could not be read or are missing; cleanup state is unknown.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unreadable: bool,
}
impl CleanupStatus {
    const UNKNOWN: Self = Self {
        pending: 0,
        running: 0,
        unreadable: true,
    };
}

/// Registry lineage: present only once a profile has H1 state (registry v3).
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Lineage {
    lineage: String,
    variant: String,
}
pub(crate) fn check_lineage(lineage: &Lineage) -> Result<()> {
    check_owned_lineage(lineage, VARIANT)
}
/// Structural lineage owned by exactly `variant`; owning is not use authority.
fn check_owned_lineage(lineage: &Lineage, variant: &str) -> Result<()> {
    if lineage.variant != variant {
        return Err(
            "Plugin settings belong to another Buzz build; use that build or recover settings"
                .into(),
        );
    }
    valid_uuid(&lineage.lineage)
}
pub(crate) fn valid_uuid(text: &str) -> Result<()> {
    uuid::Uuid::parse_str(text)
        .ok()
        .filter(|uuid| uuid.to_string() == text)
        .map(drop)
        .ok_or_else(|| "Invalid plugin settings lineage".into())
}
fn fresh() -> String {
    uuid::Uuid::new_v4().to_string()
}

// ---------------------------------------------------------------- inventory

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct State {
    version: u32,
    namespaces: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signed_out_seen: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    journal: Option<Journal>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation: Option<continuity::Record>,
}
impl State {
    fn valid(&self) -> bool {
        self.valid_for(VARIANT)
    }
    /// Namespace ids name files; a journal must target something. An
    /// installation record must belong to exactly `variant`'s inventory.
    fn valid_for(&self, variant: &str) -> bool {
        self.version == 1
            && self
                .installation
                .as_ref()
                .is_none_or(|record| record.valid_for(variant))
            && self.namespaces.len() <= MAX_NAMESPACES
            && self.namespaces.iter().all(|id| hex64(id))
            && self.journal.as_ref().is_none_or(|journal| {
                (journal.identity.is_some() || journal.home.is_some())
                    && journal.identity.as_deref().is_none_or(hex64)
                    && journal.home.as_deref().is_none_or(hex64)
            })
    }
}
/// A committed sign-out's scope: the departing identity, an erased home, or both.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    identity: Option<String>,
    home: Option<String>,
}
impl Journal {
    fn covers(&self, home: &str, identity: &str) -> bool {
        self.identity.as_deref() == Some(identity) || self.home.as_deref() == Some(home)
    }
    fn retire(&self, namespace: &mut Namespace) -> bool {
        let mut changed = false;
        for entry in &mut namespace.entries {
            if self.covers(&namespace.home, &entry.identity) {
                changed |= entry.retire(Cause::Signout);
            }
        }
        changed
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Namespace {
    version: u32,
    home: String,
    profile: String,
    lineage: Option<String>,
    entries: Vec<Entry>,
}
impl Namespace {
    /// The fields sign-out scopes select by are never skipped as unrelated.
    fn valid(&self) -> bool {
        self.version == 1
            && self.entries.len() <= MAX_ENTRIES
            && hex64(&self.home)
            && self.entries.iter().all(|entry| hex64(&entry.identity))
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    account: String,
    plugin: String,
    lineage: String,
    generation: String,
    identity: String,
    slot: String,
    policy: Policy,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cause: Option<Cause>,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Writing,
    Live,
    Retired,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Cause {
    Replaced,
    Cleared,
    Policy,
    Removed,
    Recovered,
    Lineage,
    Signout,
    Failed,
    Ineligible,
    Interrupted,
}
impl Entry {
    fn retire(&mut self, cause: Cause) -> bool {
        if self.phase == Phase::Retired {
            return false;
        }
        self.phase = Phase::Retired;
        self.cause = Some(cause);
        true
    }
    fn is(&self, plugin: &str, identity: &str, slot: &str) -> bool {
        self.plugin == plugin && self.identity == identity && self.slot == slot
    }
}

fn digest(parts: &[&[u8]]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update((part.len() as u64).to_be_bytes());
        hash.update(part);
    }
    format!("{:x}", hash.finalize())
}
/// Canonical paths are hashed: no absolute path appears in records or names.
/// A wiped home resolves through its deepest existing ancestor, keeping the
/// identity it was enrolled under; a path that cannot be resolved that way
/// (a dangling link, `..` past a missing component) is unknown.
fn home_hash(home: &Path) -> Result<String> {
    let mut missing = Vec::new();
    let mut existing = home;
    let mut canonical = loop {
        match fs::canonicalize(existing) {
            Ok(path) => break path,
            Err(error)
                if error.kind() == ErrorKind::NotFound
                    && fs::symlink_metadata(existing).is_err() =>
            {
                let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
                    return Err(UNREADABLE.into());
                };
                missing.push(name);
                existing = parent;
            }
            Err(_) => return Err(UNREADABLE.into()),
        }
    };
    canonical.extend(missing.iter().rev());
    Ok(digest(&[
        b"buzz-plugin-secret-home-v1",
        canonical.as_os_str().as_encoded_bytes(),
    ]))
}
/// Create `root` and make every link from its filesystem's mount point down to
/// its physical directory durable, as `atomic_write` does for files. A
/// directory's existence proves nothing (set, a failed attempt or a concurrent
/// one may have made it), so
/// every attempt syncs the whole chain until the first state exists: that is
/// written only after one attempt's chain was durable.
#[cfg(unix)]
fn establish(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    fs::create_dir_all(root)?;
    if root.join(STATE).exists() {
        return Ok(());
    }
    // The physical chain: another spelling's lexical parents can skip the
    // directory holding a link this or a concurrent attempt just created.
    let root = fs::canonicalize(root)?;
    let mut dir = root.as_path();
    while let Some(parent) = dir.parent() {
        if fs::metadata(parent)?.dev() != fs::metadata(dir)?.dev() {
            break;
        }
        sync_dir(parent)?;
        dir = parent;
    }
    Ok(())
}
/// Directory-link durability is not implemented here, so nothing that depends
/// on it is admitted: fail closed before creating anything.
#[cfg(not(unix))]
fn establish(_: &Path) -> std::io::Result<()> {
    Err(ErrorKind::Unsupported.into())
}
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(test)]
    tests::dir_synced(dir)?;
    File::open(dir)?.sync_all()
}
fn writer_key(namespace: &str, plugin: &str, identity: &str, slot: &str) -> String {
    digest(&[
        b"buzz-plugin-secret-writer-v1",
        namespace.as_bytes(),
        plugin.as_bytes(),
        identity.as_bytes(),
        slot.as_bytes(),
    ])
}

struct Held(File);
impl Drop for Held {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
fn open_lock(path: &Path) -> std::io::Result<File> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
}
fn lock(path: &Path) -> Result<Held> {
    let file = open_lock(path).map_err(|_| UNWRITABLE)?;
    file.lock().map_err(|_| UNWRITABLE)?;
    Ok(Held(file))
}
fn try_lock(path: &Path) -> Result<Option<Held>> {
    let file = open_lock(path).map_err(|_| UNWRITABLE)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(Held(file))),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(_)) => Err(UNWRITABLE.into()),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> std::result::Result<Option<T>, ()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_RECORD_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(drop)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(());
    }
    serde_json::from_slice(&bytes).map(Some).map_err(drop)
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(err)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(FULL.into());
    }
    crate::atomic_write(path, &bytes).map_err(|_| UNWRITABLE.into())
}

struct Inventory<'a> {
    root: &'a Path,
}
impl Inventory<'_> {
    /// The global index. Its absence is a fresh start only while no namespace
    /// record survives: the index is written before the first record.
    fn state(&self) -> Result<State> {
        match read_json::<State>(&self.root.join(STATE)) {
            Ok(Some(state)) if state.valid() => Ok(state),
            Ok(None) if !self.has_records()? => Ok(State::default()),
            _ => Err(UNREADABLE.into()),
        }
    }
    fn has_records(&self) -> Result<bool> {
        Ok(self.records()?.next().transpose()?.is_some())
    }
    /// The ids of the namespace records on disk, listed or not, read lazily.
    fn records(&self) -> Result<impl Iterator<Item = Result<String>>> {
        let entries = match fs::read_dir(self.root) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(_) => return Err(UNREADABLE.into()),
        };
        Ok(entries.into_iter().flatten().filter_map(|entry| {
            let Ok(entry) = entry else {
                return Some(Err(UNREADABLE.into()));
            };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let id = name.strip_prefix("ns-")?.strip_suffix(".json")?;
            Some(Ok(id.to_owned()))
        }))
    }
    fn members(&self, listed: &[String]) -> Result<Vec<String>> {
        members_of(listed, self.records()?)
    }
    /// Durably creates the root: every caller is about to write something an
    /// OS add or a sign-out acknowledgement depends on.
    fn establish(&self) -> Result<()> {
        establish(self.root).map_err(|error| {
            if error.kind() == ErrorKind::Unsupported {
                UNSUPPORTED.into()
            } else {
                UNWRITABLE.into()
            }
        })
    }
    /// G, on an established root.
    fn global(&self) -> Result<Held> {
        self.establish()?;
        lock(&self.root.join("state.lock"))
    }
    fn save_state(&self, state: &mut State) -> Result<()> {
        state.version = 1;
        write_json(&self.root.join(STATE), state)
    }
    fn namespace_lock(&self, id: &str) -> Result<Held> {
        lock(&self.root.join(format!("ns-{id}.lock")))
    }
    /// Membership is authority. A listed record that is gone is lost, and so is
    /// an `owed` one (a v3 registry vouches for it). An unlisted record, left by
    /// a crash before listing, is never continuity: its entries stay owed.
    fn read(&self, id: &str, owed: bool) -> Result<Option<Namespace>> {
        let listed = self.state()?.namespaces.iter().any(|known| known == id);
        match read_json::<Namespace>(&self.root.join(format!("ns-{id}.json"))) {
            Ok(Some(mut namespace)) if namespace.valid() => {
                if !listed {
                    namespace.lineage = None;
                }
                Ok(Some(namespace))
            }
            Ok(None) if !listed && !owed => Ok(None),
            _ => Err(UNREADABLE.into()),
        }
    }
    fn write(&self, id: &str, namespace: &Namespace) -> Result<()> {
        write_json(&self.root.join(format!("ns-{id}.json")), namespace)
    }
    /// Apply `change` under I; `None` when no record exists and none is `owed`.
    fn update<T>(
        &self,
        id: &str,
        owed: bool,
        change: impl FnOnce(&mut Namespace) -> (bool, T),
    ) -> Result<Option<T>> {
        if !self.root.exists() {
            return if owed {
                Err(UNREADABLE.into())
            } else {
                Ok(None)
            };
        }
        let _i = self.namespace_lock(id)?;
        let Some(mut namespace) = self.read(id, owed)? else {
            return Ok(None);
        };
        let (changed, value) = change(&mut namespace);
        if changed {
            self.write(id, &namespace)?;
        }
        Ok(Some(value))
    }
    fn try_writer(&self, key: &str) -> Result<Option<Held>> {
        try_lock(&self.root.join(format!("w-{key}.lock")))
    }
    /// Whether an OS operation owns this entry's slot. Live entries are never
    /// probed, so routine reads do not contend with writers.
    fn busy(&self, id: &str, entry: &Entry) -> bool {
        entry.phase != Phase::Live
            && !matches!(
                self.try_writer(&writer_key(id, &entry.plugin, &entry.identity, &entry.slot)),
                Ok(Some(_))
            )
    }
    /// A write intent whose W is free was never completed by its writer.
    fn interrupt(&self, id: &str, namespace: &mut Namespace) -> bool {
        let mut changed = false;
        for index in 0..namespace.entries.len() {
            let entry = &namespace.entries[index];
            if entry.phase == Phase::Writing && !self.busy(id, entry) {
                changed |= namespace.entries[index].retire(Cause::Interrupted);
            }
        }
        changed
    }
    /// Delete the retired accounts `select` names, confirming absence before
    /// de-indexing. Busy W is running, never absence. One worker per namespace.
    fn cleanup(
        &self,
        store: &dyn SecretStore,
        id: &str,
        select: &dyn Fn(&Namespace, &Entry) -> bool,
        deadline: Instant,
    ) -> Result<CleanupStatus> {
        if !self.root.exists() {
            return Ok(CleanupStatus::default());
        }
        let worker = try_lock(&self.root.join(format!("ns-{id}.worker.lock")))?;
        self.cleanup_owned(store, id, select, deadline, worker)
    }
    // Transfer the already acquired namespace guard; never unlock/reacquire at spawn.
    fn cleanup_owned(
        &self,
        store: &dyn SecretStore,
        id: &str,
        select: &dyn Fn(&Namespace, &Entry) -> bool,
        deadline: Instant,
        worker: Option<Held>,
    ) -> Result<CleanupStatus> {
        let candidates = self
            .update(id, false, |namespace| {
                let changed = self.interrupt(id, namespace);
                let selected: Vec<(String, String)> = namespace
                    .entries
                    .iter()
                    .filter(|e| e.phase == Phase::Retired && select(namespace, e))
                    .map(|e| {
                        let key = writer_key(id, &e.plugin, &e.identity, &e.slot);
                        (e.account.clone(), key)
                    })
                    .collect();
                (changed, selected)
            })?
            .unwrap_or_default();
        if worker.is_some() {
            for (account, key) in candidates {
                if Instant::now() >= deadline {
                    break;
                }
                let Some(_w) = self.try_writer(&key)? else {
                    continue;
                };
                if store.delete(&account).is_ok() {
                    self.update(id, false, |namespace| {
                        let before = namespace.entries.len();
                        namespace.entries.retain(|e| e.account != account);
                        (namespace.entries.len() != before, ())
                    })?;
                }
            }
        }
        self.summary(id, select)
    }
    fn summary(
        &self,
        id: &str,
        select: &dyn Fn(&Namespace, &Entry) -> bool,
    ) -> Result<CleanupStatus> {
        let Some(namespace) = self.read(id, false)? else {
            return Ok(CleanupStatus::default());
        };
        let mut status = CleanupStatus::default();
        for entry in &namespace.entries {
            let busy = self.busy(id, entry);
            let stale = entry.phase == Phase::Writing && !busy;
            if (entry.phase == Phase::Retired || stale) && select(&namespace, entry) {
                status.pending += 1;
                status.running += usize::from(busy);
            }
        }
        Ok(status)
    }
}
fn any(_: &Namespace, _: &Entry) -> bool {
    true
}
/// Every namespace record a sign-out must visit and a new namespace counts
/// against: the listed ones, then any a crash or lost membership left unlisted.
/// Those are cleanup-only ([`Inventory::read`] never makes them continuity).
/// Both share one bound; the first record past it, or one that is not a
/// namespace id, is unknown, and nothing after it is read.
fn members_of(
    listed: &[String],
    records: impl IntoIterator<Item = Result<String>>,
) -> Result<Vec<String>> {
    let mut members = listed.to_vec();
    for id in records {
        let id = id?;
        if !members.contains(&id) {
            if !hex64(&id) || members.len() >= MAX_NAMESPACES {
                return Err(UNREADABLE.into());
            }
            members.push(id);
        }
    }
    Ok(members)
}
/// Wait out momentary probes for a new write's W; refuse a stalled owner.
fn acquire_writer(inventory: &Inventory, key: &str) -> Result<Held> {
    let deadline = Instant::now() + WRITER_WAIT;
    loop {
        if let Some(held) = inventory.try_writer(key)? {
            return Ok(held);
        }
        if Instant::now() >= deadline {
            return Err(BUSY.into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Retire what the registry no longer vouches for. Returns whether anything changed.
fn reconcile(
    namespace: &mut Namespace,
    registry: &Registry,
    inventory: &Inventory,
    id: &str,
) -> bool {
    let mut changed = inventory.interrupt(id, namespace);
    let registered = registry.secrets.as_ref().map(|l| &l.lineage);
    if namespace.lineage.is_some() && namespace.lineage.as_ref() != registered {
        // An older recover/overwrite or lost registry broke continuity.
        namespace.lineage = None;
        changed = true;
    }
    for entry in &mut namespace.entries {
        let current = registry.installed.get(&entry.plugin).filter(|p| {
            registered == Some(&entry.lineage)
                && namespace.lineage.as_ref() == Some(&entry.lineage)
                && p.generation.as_ref() == Some(&entry.generation)
        });
        changed |= match current {
            None => entry.retire(Cause::Lineage),
            Some(p) if slots(&p.manifest).get(&entry.slot) != Some(&entry.policy) => {
                entry.retire(Cause::Policy)
            }
            Some(_) => false,
        };
    }
    changed
}
fn slots(manifest: &Manifest) -> BTreeMap<String, Policy> {
    manifest
        .host
        .iter()
        .flat_map(|host| &host.secrets)
        .map(|slot| (slot.id.clone(), slot.policy()))
        .collect()
}
/// The installed plugin only while it is enabled at `revision`.
fn current<'r>(registry: &'r Registry, id: &str, revision: &str) -> Option<&'r Installed> {
    registry
        .installed
        .get(id)
        .filter(|p| p.enabled && p.current == revision)
}

/// Native preparation input, not dispatch authority.
pub struct SecretRequest<'a> {
    pub plugin: &'a str,
    pub revision: &'a str,
    pub slot: &'a str,
    pub identity: &'a str,
    pub origin: &'a str,
    pub deadline: Instant,
}
#[derive(PartialEq, Eq)]
struct SecretBinding {
    home: String,
    profile: String,
    namespace: String,
    plugin: String,
    revision: String,
    identity: String,
    slot: String,
    origin: String,
    lineage: String,
    generation: String,
    account: String,
    policy: Policy,
}
/// Sensitive native material only; neither eligibility nor permission to send.
pub struct PreparedSecret {
    binding: SecretBinding,
    value: Zeroizing<String>,
    header: Zeroizing<String>,
    deadline: Instant,
}
impl PreparedSecret {
    /// Trusted native credential access: callers can copy; this is not an effect fence.
    pub fn with_header<T>(&self, use_header: impl FnOnce(&str, &str) -> T) -> T {
        use_header(&self.binding.policy.header, &self.header)
    }
    /// Exact native reflection check only. This does not detect encoded or
    /// transformed disclosures by the reviewed recipient.
    pub fn reflects_secret(&self, bytes: &[u8]) -> bool {
        bytes
            .windows(self.value.len())
            .any(|part| part == self.value.as_bytes())
    }
}
impl Manager {
    fn with_qualified_secret<T>(
        &self,
        request: &SecretRequest<'_>,
        qualified: impl FnOnce(SecretBinding, &Registry) -> Admission<T>,
    ) -> Admission<T> {
        read::with_structural(self, |evidence| {
            let authority = self
                .authority(
                    evidence.registry,
                    request.plugin,
                    request.revision,
                    request.slot,
                )
                .map_err(|message| {
                    if !self.safe_mode
                        && current(evidence.registry, request.plugin, request.revision).is_none()
                    {
                        Refusal::Withdrawn(message)
                    } else {
                        Refusal::Terminal(message)
                    }
                })?;
            // Verified Manifest::validate requires every slot origin in networkOrigins.
            if !authority.policy.origins.iter().any(|v| v == request.origin)
                || evidence.state.journal.as_ref().is_some_and(|journal| {
                    journal.covers(&evidence.namespace.home, request.identity)
                })
            {
                return Err(UNAVAILABLE.into());
            }
            let entry = Self::live(
                evidence.namespace,
                &authority,
                request.plugin,
                request.identity,
                request.slot,
            )
            .ok_or(UNAVAILABLE)?;
            if evidence
                .installed
                .get(request.plugin)
                .and_then(|v| v.generation.as_ref())
                != Some(&entry.generation)
            {
                return Err(UNAVAILABLE.into());
            }
            qualified(
                SecretBinding {
                    home: evidence.namespace.home.clone(),
                    profile: evidence.namespace.profile.clone(),
                    namespace: self.namespace_id()?,
                    plugin: entry.plugin.clone(),
                    revision: request.revision.into(),
                    identity: entry.identity.clone(),
                    slot: entry.slot.clone(),
                    origin: request.origin.into(),
                    lineage: entry.lineage.clone(),
                    generation: entry.generation.clone(),
                    account: entry.account.clone(),
                    policy: authority.policy,
                },
                evidence.registry,
            )
        })?
    }
    fn qualify_secret(&self, request: &SecretRequest<'_>) -> Result<SecretBinding> {
        self.with_qualified_secret(request, |binding, _| Ok(binding))
            .map_err(Refusal::message)
    }
    /// Requalify the exact prepared enrollment at synchronous effect admission.
    /// R→G→I remain held through `admit`: it must only admit/start bounded work,
    /// never wait for OS/network completion or re-enter Manager metadata APIs.
    /// Callers must also hold their page, identity and operation-lifetime fences;
    /// this check grants no review authority and does not consume an operation.
    pub fn with_prepared_secret<T>(
        &self,
        prepared: &PreparedSecret,
        admit: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.with_current_prepared_secret(prepared, |_| Ok(admit()?))
            .map_err(Refusal::message)
    }
    /// Compose review and exact enrollment qualification under the existing R→G→I.
    /// The same callback restrictions as `with_prepared_secret` apply.
    pub fn with_reviewed_secret<T>(
        &self,
        prepared: &PreparedSecret,
        expected: &crate::ReviewedInvocation,
        witness: &crate::ReviewedInvocationWitness,
        admit: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.try_reviewed_secret(prepared, expected, witness, admit)
            .map_err(Refusal::message)
    }
    /// `with_reviewed_secret` for a caller that may come back when the only
    /// refusal was a momentarily held metadata lock.
    #[cfg(target_os = "macos")]
    pub fn try_reviewed_secret<T>(
        &self,
        prepared: &PreparedSecret,
        expected: &crate::ReviewedInvocation,
        witness: &crate::ReviewedInvocationWitness,
        admit: impl FnOnce() -> Result<T>,
    ) -> Admission<T> {
        self.with_current_prepared_secret(prepared, |registry| {
            let binding = &prepared.binding;
            let http = expected.credential_http.as_ref().ok_or(UNAVAILABLE)?;
            if expected.artifact.is_some() || http.version != 1 || http.slot != binding.slot {
                return Err(UNAVAILABLE.into());
            }
            let plugin = registry.installed.get(&binding.plugin).ok_or(UNAVAILABLE)?;
            let artifact = self.artifact(
                &binding.plugin,
                &binding.revision,
                plugin.current_signature.as_ref(),
            )?;
            if !artifact
                .manifest
                .host
                .unwrap_or_default()
                .reviewed_invocations
                .contains(expected)
            {
                return Err(UNAVAILABLE.into());
            }
            self.check_reviewed_witness(witness)?;
            Ok(admit()?)
        })
    }
    #[cfg(not(target_os = "macos"))]
    pub fn try_reviewed_secret<T>(
        &self,
        _: &PreparedSecret,
        _: &crate::ReviewedInvocation,
        _: &crate::ReviewedInvocationWitness,
        _: impl FnOnce() -> Result<T>,
    ) -> Admission<T> {
        Err("Native private review requires macOS".into())
    }
    fn with_current_prepared_secret<T>(
        &self,
        prepared: &PreparedSecret,
        admit: impl FnOnce(&Registry) -> Admission<T>,
    ) -> Admission<T> {
        let binding = &prepared.binding;
        let request = SecretRequest {
            plugin: &binding.plugin,
            revision: &binding.revision,
            slot: &binding.slot,
            identity: &binding.identity,
            origin: &binding.origin,
            deadline: prepared.deadline,
        };
        self.with_qualified_secret(&request, |current, registry| {
            if current != *binding || Instant::now() >= prepared.deadline {
                return Err(UNAVAILABLE.into());
            }
            admit(registry)
        })
    }
    pub fn prepare_secret(&self, request: SecretRequest<'_>) -> Result<PreparedSecret> {
        let prepare = || -> Result<PreparedSecret> {
            valid_id(request.plugin)?;
            valid_id(request.slot)?;
            valid_identity(request.identity)?;
            let origin = url::Url::parse(request.origin).map_err(err)?;
            if origin.scheme() != "https"
                || !origin.username().is_empty()
                || origin.password().is_some()
                || origin.origin().ascii_serialization() != request.origin
                || Instant::now() >= request.deadline
            {
                return Err(UNAVAILABLE.into());
            }
            let binding = self.qualify_secret(&request)?;
            let (_, store) = self.parts()?;
            if Instant::now() >= request.deadline {
                return Err(UNAVAILABLE.into());
            }
            let bytes = store.read(&binding.account).map_err(|_| UNAVAILABLE)?;
            let text = std::str::from_utf8(&bytes).map_err(|_| UNAVAILABLE)?;
            let value = valid_value(text)?;
            if value.as_str() != text
                || self.qualify_secret(&request)? != binding
                || Instant::now() >= request.deadline
            {
                return Err(UNAVAILABLE.into());
            }
            let mut prepared = PreparedSecret {
                binding,
                value,
                header: Zeroizing::new(String::new()),
                deadline: request.deadline,
            };
            let scheme = &prepared.binding.policy.scheme;
            if !scheme.is_empty() {
                prepared.header.push_str(scheme);
                prepared.header.push(' ');
            }
            prepared.header.push_str(&prepared.value);
            if Instant::now() >= request.deadline {
                return Err(UNAVAILABLE.into());
            }
            Ok(prepared)
        };
        prepare().map_err(|_| UNAVAILABLE.into())
    }
}

// ---------------------------------------------------------------- manager

/// What one plugin-facing call is entitled to, read under R.
struct Authority {
    lineage: Option<String>,
    generation: Option<String>,
    policy: Policy,
}

impl Manager {
    /// Use this inventory root and store (desktop/CLI wiring and tests).
    pub fn with_secret_storage(mut self, root: PathBuf, store: Arc<dyn SecretStore>) -> Self {
        self.secrets = Storage {
            root: Some(root),
            store: Some(store),
        };
        self
    }
    fn namespace_id(&self) -> Result<String> {
        Ok(digest(&[
            b"buzz-plugin-secret-namespace-v1",
            home_hash(&self.home)?.as_bytes(),
            self.profile.as_bytes(),
        ]))
    }
    fn inventory(&self) -> Option<Inventory<'_>> {
        self.secrets.root.as_deref().map(|root| Inventory { root })
    }
    fn parts(&self) -> Result<(Inventory<'_>, &dyn SecretStore)> {
        // Nothing a plugin-facing call depends on is durable off Unix (see `establish`).
        if cfg!(not(unix)) {
            return Err(UNSUPPORTED.into());
        }
        match (self.inventory(), self.secrets.store.as_deref()) {
            (Some(inventory), Some(store)) => Ok((inventory, store)),
            _ => Err(UNAVAILABLE.into()),
        }
    }
    /// Plugin-facing calls are external-only: safe mode refuses them all. Slots
    /// come from the artifact the host would load, verified under the caller's R.
    fn authority(
        &self,
        registry: &Registry,
        id: &str,
        revision: &str,
        slot: &str,
    ) -> Result<Authority> {
        if self.safe_mode {
            return Err("External plugins are disabled in safe mode".into());
        }
        let plugin = current(registry, id, revision).ok_or(WITHDRAWN)?;
        let artifact = self.artifact(id, revision, plugin.current_signature.as_ref())?;
        let slot = slots(&artifact.manifest)
            .remove(slot)
            .ok_or("Secret slot is not declared")?;
        Ok(Authority {
            lineage: registry.secrets.as_ref().map(|l| l.lineage.clone()),
            generation: plugin.generation.clone(),
            policy: slot,
        })
    }
    fn live<'n>(
        namespace: &'n Namespace,
        authority: &Authority,
        id: &str,
        identity: &str,
        slot: &str,
    ) -> Option<&'n Entry> {
        let lineage = authority.lineage.as_ref()?;
        let generation = authority.generation.as_ref()?;
        if namespace.lineage.as_ref() != Some(lineage) {
            return None;
        }
        namespace.entries.iter().find(|e| {
            e.phase == Phase::Live
                && e.is(id, identity, slot)
                && &e.lineage == lineage
                && &e.generation == generation
                && e.policy == authority.policy
        })
    }
    fn fenced(
        inventory: &Inventory,
        namespace: Option<&Namespace>,
        identity: &str,
    ) -> Result<bool> {
        Ok(inventory
            .state()?
            .journal
            .is_some_and(|journal| match namespace {
                Some(namespace) => journal.covers(&namespace.home, identity),
                None => journal.identity.as_deref() == Some(identity),
            }))
    }

    pub fn secret_status(
        &self,
        id: &str,
        revision: &str,
        slot: &str,
        identity: &str,
    ) -> Result<SecretStatus> {
        valid_identity(identity)?;
        let (inventory, store) = self.parts()?;
        // The live account under R, or why there is none. Taken again after
        // the OS read: bytes read across a retirement are never "saved".
        let live = || -> Result<std::result::Result<String, SecretStatus>> {
            let _r = self.lock()?;
            let registry = self.read()?;
            let authority = self.authority(&registry, id, revision, slot)?;
            let owed = registry.secrets.is_some();
            let Ok(namespace) = self
                .namespace_id()
                .and_then(|namespace| inventory.read(&namespace, owed))
            else {
                return Ok(Err(SecretStatus::Unreadable));
            };
            Ok(
                match Self::fenced(&inventory, namespace.as_ref(), identity) {
                    Err(_) => Err(SecretStatus::Unreadable),
                    Ok(true) => Err(SecretStatus::Missing),
                    Ok(false) => namespace
                        .as_ref()
                        .and_then(|n| Self::live(n, &authority, id, identity, slot))
                        .map(|entry| entry.account.clone())
                        .ok_or(SecretStatus::Missing),
                },
            )
        };
        let account = match live()? {
            Ok(account) => account,
            Err(status) => return Ok(status),
        };
        let status = match store.read(&account) {
            Ok(value) => match std::str::from_utf8(&value).map(valid_value) {
                Ok(Ok(_)) => SecretStatus::Saved,
                _ => SecretStatus::Unreadable,
            },
            Err(Error::Absent) => SecretStatus::Missing,
            Err(_) => SecretStatus::Unreadable,
        };
        if status != SecretStatus::Saved {
            return Ok(status);
        }
        Ok(match live()? {
            Ok(current) if current == account => SecretStatus::Saved,
            Ok(_) => SecretStatus::Missing,
            Err(status) => status,
        })
    }

    /// Write-ahead enrollment of a fresh account. `still_current` is a short,
    /// try-only identity check evaluated under metadata after the OS write.
    pub fn secret_set(
        &self,
        id: &str,
        revision: &str,
        slot: &str,
        identity: &str,
        value: &str,
        still_current: &dyn Fn() -> bool,
    ) -> Result<()> {
        valid_identity(identity)?;
        let value = valid_value(value)?;
        let (inventory, store) = self.parts()?;
        let namespace_id = self.namespace_id()?;
        let account = format!("v1.{}", uuid::Uuid::new_v4().simple());
        inventory.establish()?;
        let w = acquire_writer(&inventory, &writer_key(&namespace_id, id, identity, slot))?;
        self.register_intent(
            &inventory,
            &namespace_id,
            id,
            revision,
            slot,
            identity,
            &account,
        )?;
        let added = store.add(&account, value.as_bytes());
        drop(value);
        let (promoted, retired) = {
            let _r = self.lock()?;
            let authority = self
                .read()
                .ok()
                .and_then(|registry| self.authority(&registry, id, revision, slot).ok());
            let _i = inventory.namespace_lock(&namespace_id)?;
            let mut namespace = inventory.read(&namespace_id, true)?.ok_or(UNREADABLE)?;
            let fenced = Self::fenced(&inventory, Some(&namespace), identity).unwrap_or(true);
            let index = namespace
                .entries
                .iter()
                .position(|e| e.account == account)
                .ok_or(UNREADABLE)?;
            let entry = namespace.entries[index].clone();
            let eligible = added.is_ok()
                && entry.phase == Phase::Writing
                && !fenced
                && authority.is_some_and(|a| {
                    a.lineage.as_ref() == Some(&entry.lineage)
                        && namespace.lineage.as_ref() == Some(&entry.lineage)
                        && a.generation.as_ref() == Some(&entry.generation)
                        && a.policy == entry.policy
                })
                && still_current();
            let mut retired = false;
            if eligible {
                for other in &mut namespace.entries {
                    if other.phase == Phase::Live
                        && other.is(id, identity, slot)
                        && other.generation == entry.generation
                    {
                        retired |= other.retire(Cause::Replaced);
                    }
                }
                namespace.entries[index].phase = Phase::Live;
            } else {
                retired = true;
                namespace.entries[index].retire(if added.is_ok() {
                    Cause::Ineligible
                } else {
                    Cause::Failed
                });
            }
            inventory.write(&namespace_id, &namespace)?;
            (eligible, retired)
        };
        drop(w);
        if retired {
            // This slot's own superseded or failed account only; failures stay
            // indexed for a deliberate retry.
            let mine = |_: &Namespace, e: &Entry| e.is(id, identity, slot);
            let _ = inventory.cleanup(store, &namespace_id, &mine, Instant::now() + CLEANUP_BUDGET);
        }
        if promoted {
            Ok(())
        } else {
            Err(NOT_SAVED.into())
        }
    }
    /// Under R→G→I: durably index the write intent before any OS write. The
    /// inventory is written before the registry, so a crash leaves an
    /// unreferenced, unusable generation rather than a reusable enrollment.
    #[allow(clippy::too_many_arguments)]
    fn register_intent(
        &self,
        inventory: &Inventory,
        namespace_id: &str,
        id: &str,
        revision: &str,
        slot: &str,
        identity: &str,
        account: &str,
    ) -> Result<()> {
        let _r = self.lock()?;
        let mut registry = self.read()?;
        let policy = self.authority(&registry, id, revision, slot)?.policy;
        let _g = inventory.global()?;
        let mut state = inventory.state()?;
        let _i = inventory.namespace_lock(namespace_id)?;
        let listed = state.namespaces.iter().any(|known| known == namespace_id);
        // A lifetime cap over every record, listed or not: cleanup does not
        // free a namespace record. This one's own unlisted record is reused.
        if !listed {
            let members = inventory.members(&state.namespaces)?;
            if !members.iter().any(|known| known == namespace_id) && members.len() >= MAX_NAMESPACES
            {
                return Err(
                    "Too many Buzz profiles have used saved credentials on this device".into(),
                );
            }
        }
        let mut namespace = match inventory.read(namespace_id, registry.secrets.is_some())? {
            Some(namespace) => namespace,
            None => Namespace {
                version: 1,
                home: home_hash(&self.home)?,
                profile: self.profile.clone(),
                lineage: None,
                entries: Vec::new(),
            },
        };
        if state
            .journal
            .as_ref()
            .is_some_and(|journal| journal.covers(&namespace.home, identity))
        {
            return Err(SIGNING_OUT.into());
        }
        if namespace.entries.len() >= MAX_ENTRIES {
            return Err(
                "Too many saved credential records for this profile; retry cleanup first".into(),
            );
        }
        reconcile(&mut namespace, &registry, inventory, namespace_id);
        let mut registry_changed = false;
        let lineage = match (&registry.secrets, &namespace.lineage) {
            (Some(registered), Some(known)) if registered.lineage == *known => known.clone(),
            // Continuity the inventory cannot vouch for starts a fresh lineage.
            _ => {
                let lineage = fresh();
                for entry in &mut namespace.entries {
                    entry.retire(Cause::Lineage);
                }
                namespace.lineage = Some(lineage.clone());
                registry.secrets = Some(Lineage {
                    lineage: lineage.clone(),
                    variant: VARIANT.into(),
                });
                registry.version = 3;
                registry_changed = true;
                lineage
            }
        };
        let plugin = registry.installed.get_mut(id).ok_or(UNAVAILABLE)?;
        let generation = match &plugin.generation {
            Some(generation) => generation.clone(),
            None => {
                registry_changed = true;
                plugin.generation.insert(fresh()).clone()
            }
        };
        namespace.entries.push(Entry {
            account: account.into(),
            plugin: id.into(),
            lineage,
            generation,
            identity: identity.into(),
            slot: slot.into(),
            policy,
            phase: Phase::Writing,
            cause: None,
        });
        let bytes = serde_json::to_vec(&namespace).map_err(err)?.len();
        if bytes + namespace.entries.len() * RETIRE_BYTES > MAX_RECORD_BYTES {
            return Err(FULL.into());
        }
        if state.version == 0 {
            // The index precedes the first record, so losing it is detectable.
            inventory.save_state(&mut state)?;
        }
        inventory.write(namespace_id, &namespace)?;
        if !listed {
            state.namespaces.push(namespace_id.into());
            inventory.save_state(&mut state)?;
        }
        if registry_changed {
            self.save(&registry)?;
        }
        Ok(())
    }

    pub fn secret_clear(&self, id: &str, revision: &str, slot: &str, identity: &str) -> Result<()> {
        valid_identity(identity)?;
        let (inventory, store) = self.parts()?;
        let namespace_id = self.namespace_id()?;
        {
            let _r = self.lock()?;
            let registry = self.read()?;
            self.authority(&registry, id, revision, slot)?;
            inventory.update(&namespace_id, registry.secrets.is_some(), |namespace| {
                let mut changed = false;
                for entry in &mut namespace.entries {
                    if entry.is(id, identity, slot) {
                        changed |= entry.retire(Cause::Cleared);
                    }
                }
                (changed, ())
            })?;
        }
        let mine = |_: &Namespace, e: &Entry| e.is(id, identity, slot);
        let status =
            inventory.cleanup(store, &namespace_id, &mine, Instant::now() + CLEANUP_BUDGET)?;
        if status.pending > 0 {
            return Err(CLEANUP_INCOMPLETE.into());
        }
        Ok(())
    }

    /// Under R: retire what `registry` no longer vouches for here, then
    /// summarize. The one reconciliation the catalog and the administrative
    /// status/retry share; unknown authority is never a clean default.
    fn reconciled(&self, inventory: &Inventory, registry: &Registry) -> CleanupStatus {
        let Ok(id) = self.namespace_id() else {
            return CleanupStatus::UNKNOWN;
        };
        match inventory.update(&id, registry.secrets.is_some(), |namespace| {
            (reconcile(namespace, registry, inventory, &id), ())
        }) {
            Ok(Some(())) => inventory
                .summary(&id, &any)
                .unwrap_or(CleanupStatus::UNKNOWN),
            Ok(None) => CleanupStatus::default(),
            Err(_) => CleanupStatus::UNKNOWN,
        }
    }
    /// Pending cleanup for this home/profile, without any OS call.
    pub fn credential_cleanup_status(&self) -> Result<CleanupStatus> {
        let inventory = self.inventory().ok_or(UNAVAILABLE)?;
        let _r = self.lock()?;
        Ok(self.reconciled(&inventory, &self.read()?))
    }
    /// Metadata-only observation, distinguishing an unwired legacy profile from
    /// unavailable tracked history. Absence of an adapter is not a clean scan.
    pub fn credential_cleanup_observation(&self) -> Result<Option<CleanupStatus>> {
        let _r = self.lock()?;
        let registry = self.read()?;
        if let Some(inventory) = self.inventory() {
            return inventory
                .read(&self.namespace_id()?, registry.secrets.is_some())
                .map(|record| record.map(|_| self.reconciled(&inventory, &registry)));
        }
        Ok(registry.secrets.map(|_| CleanupStatus::UNKNOWN))
    }
    /// One deliberate bounded attempt over this home/profile's retired accounts.
    pub fn credential_cleanup(&self, budget: Duration) -> Result<CleanupStatus> {
        self.credential_cleanup_owned(budget, None)
    }
    fn credential_cleanup_owned(
        &self,
        budget: Duration,
        worker: Option<Held>,
    ) -> Result<CleanupStatus> {
        let deadline = Instant::now() + budget;
        let (inventory, store) = self.parts()?;
        let status = {
            let _r = self.lock()?;
            self.reconciled(&inventory, &self.read()?)
        };
        if status.unreadable {
            return Ok(status);
        }
        if inventory.state()?.journal.is_some() {
            return Err("A sign-out is still finishing; open Buzz to complete it first".into());
        }
        let id = self.namespace_id()?;
        match worker {
            Some(worker) => inventory.cleanup_owned(store, &id, &any, deadline, Some(worker)),
            None => inventory.cleanup(store, &id, &any, deadline),
        }
    }
    /// A deliberate batch starts once, returns immediately, and is observed
    /// through catalog/status. The reply is a pre-start snapshot, not progress
    /// or success; raced refusal/failure retains debt. An active batch refuses
    /// another retry rather than silently losing it. Dropping the caller never cancels OS work.
    pub fn start_credential_cleanup(&self) -> Result<CleanupStatus> {
        let (inventory, _) = self.parts()?;
        let status = self.credential_cleanup_status()?;
        if status.unreadable || status.pending == 0 {
            return Ok(status);
        }
        if inventory.state()?.journal.is_some() {
            return Err("A sign-out is still finishing; open Buzz to complete it first".into());
        }
        let id = self.namespace_id()?;
        let worker = try_lock(&inventory.root.join(format!("ns-{id}.worker.lock")))?
            .ok_or("Saved credential cleanup is already running; try again after it finishes")?;
        let manager = self.clone();
        std::thread::Builder::new()
            .name("plugin credential cleanup".into())
            .spawn(move || {
                let _ = manager.credential_cleanup_owned(CLEANUP_BUDGET, Some(worker));
            })
            .map_err(|_| "Saved credential cleanup could not start; try again")?;
        Ok(status)
    }
    /// Under R: reconcile against the registry and summarize for the catalog.
    pub(crate) fn catalog_cleanup(&self, registry: &Registry) -> Option<CleanupStatus> {
        let status = self.reconciled(&self.inventory()?, registry);
        (status != CleanupStatus::default()).then_some(status)
    }
    /// Under R, before saving a changed registry entry: permanently retire every
    /// enrollment whose authority changed or whose installation ended.
    pub(crate) fn retire_changed(
        &self,
        registry: &Registry,
        id: &str,
        before: Option<&Installed>,
    ) -> Result<bool> {
        let (Some(generation), Some(lineage)) = (
            before.and_then(|before| before.generation.as_ref()),
            registry.secrets.as_ref(),
        ) else {
            return Ok(false);
        };
        let after = registry
            .installed
            .get(id)
            .filter(|after| after.generation.as_ref() == Some(generation))
            .map(|after| slots(&after.manifest));
        if after.as_ref() == before.map(|before| slots(&before.manifest)).as_ref() {
            return Ok(false);
        }
        // Changing an enrolled plugin's authority without its inventory, or
        // with its record lost, would skip retirement.
        let inventory = self.inventory().ok_or(UNAVAILABLE)?;
        inventory
            .update(&self.namespace_id()?, true, |namespace| {
                let mut changed = false;
                for entry in &mut namespace.entries {
                    if entry.plugin == id
                        && entry.lineage == lineage.lineage
                        && entry.generation == *generation
                    {
                        changed |= match &after {
                            None => entry.retire(Cause::Removed),
                            Some(policies) if policies.get(&entry.slot) != Some(&entry.policy) => {
                                entry.retire(Cause::Policy)
                            }
                            Some(_) => false,
                        };
                    }
                }
                (changed, changed)
            })
            .map(|changed| changed.unwrap_or(false))
    }
    /// Under R: the registry `recover` saves. Everything here is retired
    /// without parsing the registry, which may be the corrupt thing. Recovery
    /// still proceeds when that cannot be confirmed: an unreadable record stays
    /// in place, and the reset keeps a readable v3 lineage, which may be the
    /// only surviving witness that cleanup is owed. Another build's lineage is
    /// a witness this build can neither discharge nor keep, so it refuses.
    pub(crate) fn recovered_registry(&self) -> Result<Registry> {
        // Only absence or a complete bounded read may find no witness; bytes
        // that are not JSON are the corruption being recovered from.
        let bytes = match File::open(self.root.join("registry.json")) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(crate::LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| UNINSPECTED)?;
                if bytes.len() as u64 > crate::LIMIT {
                    return Err(UNINSPECTED.into());
                }
                bytes
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Vec::new(),
            Err(_) => return Err(UNINSPECTED.into()),
        };
        let witness = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|registry| {
                serde_json::from_value::<Lineage>(registry.get("secrets")?.clone()).ok()
            })
            .filter(|lineage| {
                matches!(lineage.variant.as_str(), "debug" | "release")
                    && valid_uuid(&lineage.lineage).is_ok()
            });
        if witness
            .as_ref()
            .is_some_and(|lineage| lineage.variant != VARIANT)
        {
            return Err(FOREIGN.into());
        }
        let retired =
            self.inventory()
                .zip(self.namespace_id().ok())
                .is_some_and(|(inventory, id)| {
                    let retired = inventory.update(&id, false, |namespace| {
                        namespace.lineage = None;
                        for entry in &mut namespace.entries {
                            entry.retire(Cause::Recovered);
                        }
                        (true, ())
                    });
                    matches!(retired, Ok(Some(())))
                });
        let mut reset = Registry::default();
        if !retired {
            reset.secrets = witness;
            if reset.secrets.is_some() {
                reset.version = 3;
            }
        }
        Ok(reset)
    }
}

// ---------------------------------------------------------------- sign-out

/// Commit the scope before the sign-out marker, then retire it. The journal is
/// written even before any inventory exists, so it fences writes already in
/// flight. A committed journal is never replaced or withdrawn: only
/// [`finish_sign_out`] clears it, once every target is confirmed absent.
pub fn begin_sign_out(root: &Path, identity: Option<&str>, erase: Option<&Path>) -> Result<()> {
    if let Some(identity) = identity {
        valid_identity(identity)?;
    }
    if identity.is_none() && erase.is_none() {
        return Ok(());
    }
    let inventory = Inventory { root };
    let journal = Journal {
        identity: identity.map(str::to_owned),
        home: erase.map(home_hash).transpose()?,
    };
    let namespaces = {
        let _g = inventory.global()?;
        let mut state = inventory.state()?;
        if state.journal.is_some() {
            return Err(SIGNING_OUT.into());
        }
        state.journal = Some(journal.clone());
        inventory.save_state(&mut state)?;
        inventory.members(&state.namespaces)?
    };
    for id in namespaces {
        inventory.update(&id, false, |namespace| (journal.retire(namespace), ()))?;
    }
    Ok(())
}
/// The prelaunch attempt: delete every account in the journal's scope, then
/// clear it. Idempotent; incomplete or unknown cleanup keeps the journal.
pub fn finish_sign_out(root: &Path, store: &dyn SecretStore, budget: Duration) -> Result<()> {
    let inventory = Inventory { root };
    let state = inventory.state().map_err(|_| SIGN_OUT_UNREADABLE)?;
    let Some(journal) = state.journal else {
        return Ok(());
    };
    let deadline = Instant::now() + budget;
    let scope =
        |namespace: &Namespace, entry: &Entry| journal.covers(&namespace.home, &entry.identity);
    let (mut pending, mut unknown) = (0, false);
    let members = inventory
        .members(&state.namespaces)
        .map_err(|_| SIGN_OUT_UNREADABLE)?;
    for id in &members {
        // Resume an interrupted begin before deleting.
        match inventory
            .update(id, false, |namespace| (journal.retire(namespace), ()))
            .and_then(|_| inventory.cleanup(store, id, &scope, deadline))
        {
            Ok(status) => pending += status.pending,
            Err(_) => unknown = true,
        }
    }
    if unknown {
        return Err(SIGN_OUT_UNREADABLE.into());
    }
    if pending > 0 {
        return Err(SIGN_OUT_INCOMPLETE.into());
    }
    // The finished-sign-out count is left as last observed: the native append
    // that may follow is recorded only by observing it.
    let _g = inventory.global().map_err(|_| SIGN_OUT_UNREADABLE)?;
    let mut state = inventory.state().map_err(|_| SIGN_OUT_UNREADABLE)?;
    state.journal = None;
    inventory
        .save_state(&mut state)
        .map_err(|_| SIGN_OUT_UNREADABLE.into())
}
/// Whether a committed sign-out still owes cleanup. Reads only: boot asks
/// before taking any lock, and asking creates nothing.
pub fn sign_out_pending(root: &Path) -> Result<bool> {
    let state = Inventory { root }
        .state()
        .map_err(|_| SIGN_OUT_UNREADABLE)?;
    Ok(state.journal.is_some())
}
/// A conservative observation at boot, not an authority: any change in the
/// finished sign-out count this inventory did not journal (an older build's
/// sign-out or erase) retires every enrollment, as do enrollments made before
/// any observation.
pub fn observe_sign_outs(root: &Path, seen: u64) -> Result<()> {
    let inventory = Inventory { root };
    let _g = inventory.global()?;
    let mut state = inventory.state()?;
    if state.signed_out_seen == Some(seen) {
        return Ok(());
    }
    if state.signed_out_seen.is_some() || !state.namespaces.is_empty() {
        for id in &state.namespaces {
            inventory.update(id, false, |namespace| {
                let mut changed = false;
                for entry in &mut namespace.entries {
                    changed |= entry.retire(Cause::Signout);
                }
                (changed, ())
            })?;
        }
    }
    state.signed_out_seen = Some(seen);
    inventory.save_state(&mut state)
}

pub mod continuity;
pub mod preflight;
mod read;
#[cfg(test)]
pub(crate) mod tests;
