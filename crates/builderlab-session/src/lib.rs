//! Native ownership of the session item shared with the `bl` CLI.
//!
//! This crate deliberately contains no browser, Tauri, BuilderLab card, or
//! enterprise protocol code. Consumers own those flows; this crate owns the
//! profile/service resolution, CLI-compatible storage item, and the lifecycle
//! fences that keep consumers from adopting or removing stale credentials.

use builderlab_auth::{
    auth_storage::{
        default_session_storage_for_bl_home, FileSessionCredentialStorage,
        SessionCredentialStorage, SessionStorageKey, StoredSessionCredential,
        BL_AUTH_STORAGE_ENV_VAR, BL_AUTH_STORAGE_FILE_ENV_VAR,
    },
    config::{
        default_kgoose_service_path, default_preferences_path, kgoose_service_url,
        normalize_kgoose_service_path, read_preferences_file, BL_HOME_ENV_VAR,
        BL_SKILLS_PROFILE_ENV_VAR, DEFAULT_PROFILE_NAME, KGOOSE_SERVICE_PATH_ENV_VAR,
    },
    org_routing::resolve_org_kgoose_base_url,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::{
    collections::HashSet,
    fmt::Display,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::sync::oneshot;
use url::{Host, Url};
use zeroize::{Zeroize, Zeroizing};

const BL_SKILLS_CONFIG_ENV_VAR: &str = "BL_SKILLS_CONFIG";
const DEFAULT_BASE_URL: &str = "https://kgoose.sqprod.co";
const INVALID_SETTINGS: &str =
    "BuilderLab session settings are invalid; check BL_HOME, BL_SKILLS_CONFIG, BL_SKILLS_PROFILE, KGOOSE_BASE_URL, and KGOOSE_SERVICE_PATH.";
const MEMORY_STORAGE: &str =
    "BL_AUTH_STORAGE=memory cannot be shared with Buzz; use keyring or file.";
const STATE_UNAVAILABLE: &str = "BuilderLab session state is unavailable; restart the app";
const STORE_UNAVAILABLE: &str = "The BuilderLab session store is unavailable.";
const STORE_READ: &str = "The BuilderLab session store could not be read.";
const STORE_UPDATE: &str = "The BuilderLab session store could not be updated.";
const KEYCHAIN_DENIED: &str =
    "Keychain access was denied. Allow access to the BuilderLab session in Keychain and retry.";
const KEYCHAIN_FAILED: &str = "The BuilderLab session could not be accessed in Keychain.";
const CANCELED: &str = "BuilderLab session operation was canceled";
const REFUSAL_DIRECTORY: &str = "enterprise-refused-sessions";

type Result<T> = std::result::Result<T, String>;

/// A credential and expiry read from the exact record that `bl` uses.
///
/// The credential intentionally has no `Debug`, `Serialize`, or IPC-facing
/// representation. Protocol consumers may borrow it only at their native
/// boundary.
#[derive(Clone)]
pub struct SessionCredential {
    credential: Zeroizing<String>,
    expires_at: Option<String>,
}

impl SessionCredential {
    pub fn new(credential: Zeroizing<String>, expires_at: Option<String>) -> Self {
        Self {
            credential,
            expires_at,
        }
    }

    pub fn credential(&self) -> &str {
        &self.credential
    }

    pub fn expires_at(&self) -> Option<&str> {
        self.expires_at.as_deref()
    }
}

/// A credential read with the owner's current lifecycle revision.
///
/// Its value is private to native consumers and is valid only while the same
/// owner continues to recognize this snapshot. It has no debug or IPC form.
pub struct SessionSnapshot {
    owner: Arc<()>,
    revision: u64,
    session: SessionCredential,
}

impl SessionSnapshot {
    pub fn credential(&self) -> &str {
        self.session.credential()
    }

    pub fn expires_at(&self) -> Option<&str> {
        self.session.expires_at()
    }
}

/// Safe, non-secret outcome flags for refusing or removing a saved session.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCleanup {
    pub retained: bool,
    pub unrecorded: bool,
    pub unpruned: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SharedSessionRejection {
    Removed,
    Retained,
    Superseded,
}

#[derive(Default)]
struct Environment {
    bl_home: Option<PathBuf>,
    profile: Option<String>,
    skills_config: Option<PathBuf>,
    base_url: Option<String>,
    service_path: Option<String>,
    storage: Option<String>,
    storage_file: Option<PathBuf>,
}

impl Environment {
    fn from_process() -> Self {
        let value = |name: &str| std::env::var(name).ok();
        Self {
            bl_home: value(BL_HOME_ENV_VAR).map(PathBuf::from),
            profile: value(BL_SKILLS_PROFILE_ENV_VAR),
            skills_config: value(BL_SKILLS_CONFIG_ENV_VAR).map(PathBuf::from),
            base_url: value("KGOOSE_BASE_URL"),
            service_path: value(KGOOSE_SERVICE_PATH_ENV_VAR),
            storage: value(BL_AUTH_STORAGE_ENV_VAR),
            storage_file: value(BL_AUTH_STORAGE_FILE_ENV_VAR).map(PathBuf::from),
        }
    }
}

#[derive(Deserialize)]
struct SkillsFile {
    current_profile: Option<String>,
}

enum StorageSelection {
    CrateDefault,
    File(PathBuf),
}

/// Resolved once when the native owner is created. The service URL and storage
/// key are derived from the same base/profile/path inputs, so a credential can
/// never be read from one service and sent to another by this owner.
struct Config {
    service_url: Url,
    bl_home: PathBuf,
    key: SessionStorageKey,
    storage: StorageSelection,
    storage_lock: Mutex<()>,
    factory: Arc<dyn StoreFactory>,
}

impl Config {
    fn resolve(environment: &Environment, app_home: &Path) -> Result<Self> {
        let bl_home = environment
            .bl_home
            .clone()
            .unwrap_or_else(|| app_home.join(".bl"));
        let skills_config = environment
            .skills_config
            .clone()
            .unwrap_or_else(|| bl_home.join("skills.yaml"));
        let configured_profile = read_profile(&skills_config)?;
        let profile = environment
            .profile
            .clone()
            .or(configured_profile)
            .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_owned());
        let preferences = read_preferences_file(&default_preferences_path(&bl_home))
            .map_err(|_| INVALID_SETTINGS)?;
        let configured_base_url = environment
            .base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let service_path = environment
            .service_path
            .as_deref()
            .map(|path| normalize_kgoose_service_path(path).map_err(|_| INVALID_SETTINGS))
            .transpose()?
            .unwrap_or_else(|| default_kgoose_service_path(false, &configured_base_url).to_owned());
        let base_url = resolve_org_kgoose_base_url(
            &configured_base_url,
            preferences.org.as_deref(),
            false,
            &service_path,
        )
        .map_err(|_| INVALID_SETTINGS)?;
        let service_url = Url::parse(&kgoose_service_url(&base_url, &service_path))
            .map_err(|_| INVALID_SETTINGS)?;
        validate_service_url(&service_url)?;

        let storage = if environment.storage.is_some() || environment.storage_file.is_some() {
            if environment.storage.as_deref() == Some("memory") {
                return Err(MEMORY_STORAGE.into());
            }
            StorageSelection::CrateDefault
        } else if cfg!(target_os = "macos") {
            StorageSelection::CrateDefault
        } else {
            // This is the same non-macOS fallback used by `bl`; the CLI keyring
            // backend is macOS-specific at this pinned public revision.
            StorageSelection::File(bl_home.join("auth-sessions.json"))
        };

        Ok(Self {
            key: SessionStorageKey::from_profile_and_kgoose_base_url(
                &profile,
                &base_url,
                &service_path,
            ),
            service_url,
            bl_home,
            storage,
            storage_lock: Mutex::new(()),
            factory: Arc::new(SharedStore),
        })
    }

    fn endpoint(&self, path: &str) -> Url {
        let mut url = self.service_url.clone();
        url.set_path(&format!(
            "{}{path}",
            self.service_url.path().trim_end_matches('/')
        ));
        url.set_query(None);
        url.set_fragment(None);
        url
    }
}

fn read_profile(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| INVALID_SETTINGS)?;
    serde_yaml::from_slice::<SkillsFile>(&bytes)
        .map(|file| file.current_profile)
        .map_err(|_| INVALID_SETTINGS.into())
}

fn validate_service_url(url: &Url) -> Result<()> {
    let secure = match url.scheme() {
        "https" => true,
        "http" => match url.host() {
            Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            Some(Host::Ipv4(host)) => host.is_loopback(),
            Some(Host::Ipv6(host)) => host.is_loopback(),
            None => false,
        },
        _ => false,
    };
    if !secure
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(INVALID_SETTINGS.into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum Op {
    Read,
    Update,
}

fn storage_error(op: Op, error: impl Display) -> String {
    let text = format!("{error:#}");
    match text
        .rsplit_once("OSStatus ")
        .and_then(|(_, code)| code.trim().parse::<i32>().ok())
    {
        Some(-128 | -25293 | -25308) => KEYCHAIN_DENIED,
        Some(_) => KEYCHAIN_FAILED,
        None => match op {
            Op::Read => STORE_READ,
            Op::Update => STORE_UPDATE,
        },
    }
    .into()
}

trait StoreFactory: Send + Sync {
    fn open(&self, config: &Config, op: Op) -> Result<Box<dyn SessionCredentialStorage>>;
}

struct SharedStore;

impl StoreFactory for SharedStore {
    fn open(&self, config: &Config, op: Op) -> Result<Box<dyn SessionCredentialStorage>> {
        match &config.storage {
            StorageSelection::File(path) => {
                Ok(Box::new(FileSessionCredentialStorage::new(path.clone())))
            }
            StorageSelection::CrateDefault => {
                default_session_storage_for_bl_home(config.bl_home.clone())
                    .map_err(|error| storage_error(op, error))
            }
        }
    }
}

async fn with_storage<T: Send + 'static>(
    config: Arc<Config>,
    op: Op,
    action: impl FnOnce(&dyn SessionCredentialStorage, &SessionStorageKey) -> Result<T> + Send + 'static,
) -> Result<T> {
    let operation_config = config.clone();
    with_storage_lock(config, move || {
        let storage = operation_config.factory.open(&operation_config, op)?;
        action(storage.as_ref(), &operation_config.key)
    })
    .await
}

async fn with_storage_lock<T: Send + 'static>(
    config: Arc<Config>,
    action: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || {
        let _lock = config.storage_lock.lock().map_err(|_| STORE_UNAVAILABLE)?;
        action()
    })
    .await
    .map_err(|_| STORE_UNAVAILABLE)?
}

fn session_from_stored(mut stored: StoredSessionCredential) -> Option<SessionCredential> {
    let credential = stored.session_credential_header_value();
    let expires_at = stored.expires_at;
    stored.session_credential.zeroize();
    credential.map(|credential| SessionCredential {
        credential: Zeroizing::new(credential),
        expires_at,
    })
}

fn delete_from(
    storage: &dyn SessionCredentialStorage,
    key: &SessionStorageKey,
    expected: &SessionCredential,
) -> Result<bool> {
    let current = storage
        .get(key)
        .map_err(|error| storage_error(Op::Update, error))?
        .and_then(session_from_stored);
    if current.as_ref().is_none_or(|current| {
        current.credential() != expected.credential()
            || current.expires_at() != expected.expires_at()
    }) {
        return Ok(false);
    }
    storage
        .delete(key)
        .map_err(|error| storage_error(Op::Update, error))
}

fn stored_digest_is(
    storage: &dyn SessionCredentialStorage,
    key: &SessionStorageKey,
    digest: [u8; 32],
) -> Result<bool> {
    Ok(storage
        .get(key)
        .map_err(|error| storage_error(Op::Read, error))?
        .and_then(session_from_stored)
        .is_some_and(|session| token_digest(session.credential()) == digest))
}

#[derive(Clone)]
struct RefusalRecords {
    root: Option<PathBuf>,
    service: String,
    lock: Arc<Mutex<()>>,
}

impl RefusalRecords {
    fn new(app_data_dir: Option<PathBuf>, service: String) -> Self {
        Self {
            root: app_data_dir.map(|path| path.join(REFUSAL_DIRECTORY)),
            service,
            lock: Arc::new(Mutex::new(())),
        }
    }

    fn load(&self) -> io::Result<Vec<[u8; 32]>> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("refusal record lock poisoned"))?;
        let root = self.root.as_deref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "refusal records unavailable")
        })?;
        if !valid_refusal_service(&self.service) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid refusal service",
            ));
        }
        load_refusal_records(root)
    }

    fn add(&self, digest: [u8; 32]) -> io::Result<()> {
        let _lock = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("refusal record lock poisoned"))?;
        let path = self.path(digest)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::File::create(path).map(drop)
    }

    fn remove(&self, digest: [u8; 32]) -> io::Result<()> {
        let Some(root) = self.root.as_ref() else {
            return Ok(());
        };
        let _lock = self
            .lock
            .lock()
            .map_err(|_| io::Error::other("refusal record lock poisoned"))?;
        let path = self.path_from_root(root, digest)?;
        fs::remove_file(path).or_else(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
    }

    fn path(&self, digest: [u8; 32]) -> io::Result<PathBuf> {
        let root = self.root.as_ref().ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "refusal records unavailable")
        })?;
        self.path_from_root(root, digest)
    }

    fn path_from_root(&self, root: &Path, digest: [u8; 32]) -> io::Result<PathBuf> {
        if !valid_refusal_service(&self.service) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid refusal service",
            ));
        }
        Ok(root.join(&self.service).join(hex_digest(&digest)))
    }
}

fn valid_refusal_service(service: &str) -> bool {
    !service.is_empty()
        && service != "."
        && service != ".."
        && service
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn load_refusal_records(root: &Path) -> io::Result<Vec<[u8; 32]>> {
    let services = match fs::read_dir(root) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        services => services?,
    };
    let mut digests = Vec::new();
    for service in services {
        let service = service?;
        if !service.file_type()?.is_dir() {
            continue;
        }
        for record in fs::read_dir(service.path())? {
            let name = record?.file_name();
            if let Some(digest) = name.to_str().and_then(decode_digest) {
                digests.push(digest);
            }
        }
    }
    Ok(digests)
}

fn decode_digest(name: &str) -> Option<[u8; 32]> {
    if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let mut digest = [0; 32];
    for (index, byte) in digest.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&name[2 * index..2 * index + 2], 16).ok()?;
    }
    Some(digest)
}

fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

fn hex_digest(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

async fn write(
    config: Arc<Config>,
    credential: SessionCredential,
    owner: SessionOwner,
    identity: Arc<()>,
    records: RefusalRecords,
) -> Result<()> {
    with_storage(config, Op::Update, move |storage, key| {
        if !owner.owns_identity(&identity)? {
            return Err(CANCELED.into());
        }
        let previous = storage
            .get(key)
            .map_err(|error| storage_error(Op::Update, error))?
            .and_then(session_from_stored)
            .map(|previous| token_digest(previous.credential()));
        {
            let mut state = owner.lock()?;
            if !state
                .pending
                .as_ref()
                .is_some_and(|pending| Arc::ptr_eq(&pending.identity, &identity))
            {
                return Err(CANCELED.into());
            }
            state.revision = state.revision.wrapping_add(1);
        }
        let expected = credential.clone();
        let mut stored = StoredSessionCredential {
            session_credential: credential.credential().to_owned(),
            expires_at: credential.expires_at.clone(),
        };
        let set_result = storage.set(key, &stored);
        stored.session_credential.zeroize();
        if let Err(error) = set_result {
            let digest = token_digest(expected.credential());
            if previous != Some(digest) {
                owner.refuse_digest(digest)?;
                let recorded = records.add(digest).is_ok();
                owner.note_recorded(digest, recorded)?;
                let cleanup =
                    cleanup_failed_write(storage, key, &expected, digest, &owner, &records);
                return match cleanup {
                    Ok(()) => Err(storage_error(Op::Update, error)),
                    Err(cleanup_error) => Err(cleanup_error),
                };
            }
            return Err(storage_error(Op::Update, error));
        }

        let Some(mut prune) = owner.adopt(&identity)? else {
            let digest = token_digest(expected.credential());
            owner.refuse_digest(digest)?;
            let recorded = records.add(digest).is_ok();
            owner.note_recorded(digest, recorded)?;
            cleanup_failed_write(storage, key, &expected, digest, &owner, &records)?;
            return Err(CANCELED.into());
        };
        if let Some(previous) = previous {
            prune.push(previous);
        }
        owner.prune_refusals(prune, &records)?;
        Ok(())
    })
    .await
}

fn cleanup_failed_write(
    storage: &dyn SessionCredentialStorage,
    key: &SessionStorageKey,
    expected: &SessionCredential,
    digest: [u8; 32],
    owner: &SessionOwner,
    records: &RefusalRecords,
) -> Result<()> {
    match delete_from(storage, key, expected) {
        Ok(true) => owner.prune_refusals(vec![digest], records),
        Ok(false) => match stored_digest_is(storage, key, digest) {
            Ok(true) => owner.retain_refusal(digest),
            Ok(false) => owner.prune_refusals(vec![digest], records),
            Err(error) => {
                owner.retain_refusal(digest)?;
                Err(error)
            }
        },
        Err(error) => {
            owner.retain_refusal(digest)?;
            Err(error)
        }
    }
}

struct Pending {
    id: String,
    identity: Arc<()>,
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct Refusals {
    refused: HashSet<[u8; 32]>,
    retained: HashSet<[u8; 32]>,
    unrecorded: bool,
    unpruned: HashSet<[u8; 32]>,
    distrust_stored: bool,
    trusted_after_login: bool,
}

impl Refusals {
    fn blocks_stored(&self) -> bool {
        self.distrust_stored && !self.trusted_after_login
    }

    fn cleanup(&self) -> Option<SessionCleanup> {
        let cleanup = SessionCleanup {
            retained: !self.retained.is_empty(),
            unrecorded: self.unrecorded,
            unpruned: !self.unpruned.is_empty(),
        };
        (cleanup.retained || cleanup.unrecorded || cleanup.unpruned).then_some(cleanup)
    }
}

struct State {
    revision: u64,
    adoption: u64,
    clear_count: usize,
    attempt_ids: HashSet<String>,
    pending: Option<Pending>,
    refusals: Refusals,
}

struct ClearMarker(Arc<Mutex<State>>);

impl Drop for ClearMarker {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.lock() {
            state.clear_count = state.clear_count.saturating_sub(1);
        }
    }
}

/// The single in-process lifecycle owner for the CLI session item.
#[derive(Clone)]
pub struct SessionOwner {
    config: std::result::Result<Arc<Config>, String>,
    state: Arc<Mutex<State>>,
    identity: Arc<()>,
    refusal_records: RefusalRecords,
}

impl SessionOwner {
    /// `refusal_service` preserves #562's existing per-service directory under
    /// `<app_data>/enterprise-refused-sessions`.
    pub fn from_home(
        home: impl Into<PathBuf>,
        app_data_dir: Option<PathBuf>,
        refusal_service: impl Into<String>,
    ) -> Self {
        let home = home.into();
        Self::new(
            Config::resolve(&Environment::from_process(), &home),
            RefusalRecords::new(app_data_dir, refusal_service.into()),
        )
    }

    fn new(config: Result<Config>, refusal_records: RefusalRecords) -> Self {
        let mut refusals = Refusals::default();
        match refusal_records.load() {
            Ok(digests) => refusals.refused.extend(digests),
            Err(_) => refusals.distrust_stored = true,
        }
        Self {
            config: config.map(Arc::new),
            state: Arc::new(Mutex::new(State {
                revision: 0,
                adoption: 0,
                clear_count: 0,
                attempt_ids: HashSet::new(),
                pending: None,
                refusals,
            })),
            identity: Arc::new(()),
            refusal_records,
        }
    }

    fn config(&self) -> Result<Arc<Config>> {
        self.config.clone()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>> {
        self.state.lock().map_err(|_| STATE_UNAVAILABLE.into())
    }

    pub fn service_url(&self) -> Result<Url> {
        Ok(self.config()?.service_url.clone())
    }

    pub fn endpoint(&self, path: &str) -> Result<Url> {
        Ok(self.config()?.endpoint(path))
    }

    pub fn begin_attempt(&self, id: impl Into<String>) -> Result<SessionAttempt> {
        let id = id.into();
        validate_attempt_id(&id)?;
        let config = self.config()?;
        let (cancel, canceled) = oneshot::channel();
        let identity = Arc::new(());
        let mut state = self.lock()?;
        if !state.attempt_ids.insert(id.clone()) {
            return Err(CANCELED.into());
        }
        if let Some(previous) = state.pending.take() {
            if let Some(cancel) = previous.cancel {
                let _ = cancel.send(());
            }
        }
        state.pending = Some(Pending {
            id: id.clone(),
            identity: identity.clone(),
            cancel: Some(cancel),
        });
        Ok(SessionAttempt {
            config,
            owner: self.identity.clone(),
            identity,
            id,
            canceled,
        })
    }

    /// IDs are one-shot for this owner, including cancellation before start.
    pub fn cancel_attempt(&self, id: &str) -> Result<()> {
        validate_attempt_id(id)?;
        let mut state = self.lock()?;
        state.attempt_ids.insert(id.to_owned());
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            if let Some(Pending {
                cancel: Some(cancel),
                ..
            }) = state.pending.take()
            {
                let _ = cancel.send(());
            }
        }
        Ok(())
    }

    pub fn retire_attempt(&self, attempt: &SessionAttempt) {
        if !Arc::ptr_eq(&self.identity, &attempt.owner) {
            return;
        }
        if let Ok(mut state) = self.state.lock() {
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| Arc::ptr_eq(&pending.identity, &attempt.identity))
            {
                state.pending = None;
            }
        }
    }

    /// Reads the CLI item and captures its lifecycle revision under the same
    /// process-local storage lock.
    pub async fn session_snapshot(&self) -> Result<Option<SessionSnapshot>> {
        let owner = self.clone();
        let config = self.config()?;
        with_storage(config, Op::Read, move |storage, key| {
            let revision = {
                let state = owner.lock()?;
                if state.clear_count > 0 || state.refusals.blocks_stored() {
                    return Ok(None);
                }
                state.revision
            };
            let stored = storage
                .get(key)
                .map_err(|error| storage_error(Op::Read, error))?
                .and_then(session_from_stored);
            let Some(session) = stored else {
                return Ok(None);
            };
            let digest = token_digest(session.credential());
            let refused = {
                let mut state = owner.lock()?;
                if state.revision != revision
                    || state.clear_count > 0
                    || state.refusals.blocks_stored()
                {
                    return Ok(None);
                }
                if state.refusals.refused.contains(&digest) {
                    state.refusals.retained.insert(digest);
                    true
                } else {
                    false
                }
            };
            if refused {
                owner.cleanup_refused_read(storage, key, &session, digest)?;
                return Ok(None);
            }
            Ok(Some(SessionSnapshot {
                owner: owner.identity.clone(),
                revision,
                session,
            }))
        })
        .await
    }

    pub fn is_current(&self, snapshot: &SessionSnapshot) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| self.snapshot_is_current(&state, snapshot))
    }

    /// Admits short synchronous cache or return work while the snapshot is
    /// current. `admitted` must not await or start network work.
    pub fn admit<T>(&self, snapshot: &SessionSnapshot, admitted: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().ok()?;
        self.snapshot_is_current(&state, snapshot).then(admitted)
    }

    pub async fn commit_attempt(
        &self,
        attempt: &SessionAttempt,
        session: SessionCredential,
    ) -> Result<()> {
        if !Arc::ptr_eq(&self.identity, &attempt.owner) {
            return Err(CANCELED.into());
        }
        write(
            self.config()?,
            session,
            self.clone(),
            attempt.identity.clone(),
            self.refusal_records.clone(),
        )
        .await
    }

    pub async fn clear_shared_session(&self) -> Result<()> {
        let config = self.config()?;
        let (adoption, marker) = self.begin_clear()?;
        self.clear_shared_session_after_fence(config, adoption, marker)
            .await
    }

    async fn clear_shared_session_after_fence(
        &self,
        config: Arc<Config>,
        adoption: u64,
        marker: ClearMarker,
    ) -> Result<()> {
        let owner = self.clone();
        let records = self.refusal_records.clone();
        with_storage(config, Op::Update, move |storage, key| {
            let _marker = marker;
            if owner.lock()?.adoption != adoption {
                return Ok(());
            }
            let current = storage
                .get(key)
                .map_err(|error| storage_error(Op::Update, error))?
                .and_then(session_from_stored);
            let Some(current) = current else {
                owner.prune_retained(&records)?;
                return Ok(());
            };
            let digest = token_digest(current.credential());
            let was_refused = owner.is_refused_digest(digest)?;
            match delete_from(storage, key, &current) {
                Ok(true) => {
                    if was_refused {
                        owner.prune_refusals(vec![digest], &records)?;
                    }
                    owner.prune_retained(&records)
                }
                Ok(false) => match stored_digest_is(storage, key, digest) {
                    Ok(true) => {
                        if was_refused {
                            owner.retain_refusal(digest)?;
                        }
                        Err(STORE_UPDATE.into())
                    }
                    Ok(false) => {
                        if was_refused {
                            owner.prune_refusals(vec![digest], &records)?;
                        }
                        owner.prune_retained(&records)
                    }
                    Err(error) => Err(error),
                },
                Err(error) => {
                    if was_refused {
                        owner.retain_refusal(digest)?;
                    }
                    Err(error)
                }
            }
        })
        .await
    }

    pub async fn invalidate_shared_session(&self, snapshot: &SessionSnapshot) -> Result<bool> {
        match self.refuse_snapshot(snapshot).await? {
            SharedSessionRejection::Removed => Ok(true),
            SharedSessionRejection::Superseded => Ok(false),
            SharedSessionRejection::Retained => Err(STORE_UPDATE.into()),
        }
    }

    pub async fn reject_shared_session(
        &self,
        snapshot: &SessionSnapshot,
    ) -> Result<SharedSessionRejection> {
        self.refuse_snapshot(snapshot).await
    }

    async fn refuse_snapshot(&self, snapshot: &SessionSnapshot) -> Result<SharedSessionRejection> {
        let digest = token_digest(snapshot.credential());
        {
            let mut state = self.lock()?;
            if !self.snapshot_is_current(&state, snapshot) {
                return Ok(SharedSessionRejection::Superseded);
            }
            state.revision = state.revision.wrapping_add(1);
            state.refusals.refused.insert(digest);
            state.refusals.retained.insert(digest);
        }

        let recorded = self.refusal_records.add(digest).is_ok();
        self.note_recorded(digest, recorded)?;

        let owner = self.clone();
        let records = self.refusal_records.clone();
        let result = with_storage(self.config()?, Op::Update, move |storage, key| {
            let current = storage
                .get(key)
                .map_err(|error| storage_error(Op::Update, error))?
                .and_then(session_from_stored);
            let Some(current) = current else {
                owner.prune_refusals(vec![digest], &records)?;
                return Ok(SharedSessionRejection::Superseded);
            };
            if token_digest(current.credential()) != digest {
                owner.prune_refusals(vec![digest], &records)?;
                return Ok(SharedSessionRejection::Superseded);
            }
            match delete_from(storage, key, &current) {
                Ok(true) => {
                    owner.prune_refusals(vec![digest], &records)?;
                    Ok(SharedSessionRejection::Removed)
                }
                Ok(false) => match stored_digest_is(storage, key, digest) {
                    Ok(true) => {
                        owner.retain_refusal(digest)?;
                        Ok(SharedSessionRejection::Retained)
                    }
                    Ok(false) => {
                        owner.prune_refusals(vec![digest], &records)?;
                        Ok(SharedSessionRejection::Superseded)
                    }
                    Err(_) => {
                        owner.retain_refusal(digest)?;
                        Ok(SharedSessionRejection::Retained)
                    }
                },
                Err(_) => {
                    owner.retain_refusal(digest)?;
                    Ok(SharedSessionRejection::Retained)
                }
            }
        })
        .await;
        if result.is_err() {
            self.retain_refusal(digest)?;
        }
        result
    }

    pub async fn cleanup_status(&self) -> Result<Option<SessionCleanup>> {
        let owner = self.clone();
        with_storage_lock(self.config()?, move || Ok(owner.lock()?.refusals.cleanup())).await
    }

    fn snapshot_is_current(&self, state: &State, snapshot: &SessionSnapshot) -> bool {
        Arc::ptr_eq(&self.identity, &snapshot.owner)
            && state.revision == snapshot.revision
            && state.clear_count == 0
            && !state.refusals.blocks_stored()
            && !state
                .refusals
                .refused
                .contains(&token_digest(snapshot.credential()))
    }

    fn owns_identity(&self, identity: &Arc<()>) -> Result<bool> {
        Ok(self
            .lock()?
            .pending
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(&pending.identity, identity)))
    }

    fn adopt(&self, identity: &Arc<()>) -> Result<Option<Vec<[u8; 32]>>> {
        let mut state = self.lock()?;
        if !state
            .pending
            .as_ref()
            .is_some_and(|pending| Arc::ptr_eq(&pending.identity, identity))
        {
            return Ok(None);
        }
        state.pending = None;
        state.adoption = state.adoption.wrapping_add(1);
        state.refusals.trusted_after_login = true;
        let prune = state.refusals.retained.drain().collect();
        if state.refusals.retained.is_empty() {
            state.refusals.unrecorded = false;
        }
        Ok(Some(prune))
    }

    fn begin_clear(&self) -> Result<(u64, ClearMarker)> {
        let mut state = self.lock()?;
        let clear_count = state
            .clear_count
            .checked_add(1)
            .ok_or_else(|| STATE_UNAVAILABLE.to_owned())?;
        state.revision = state.revision.wrapping_add(1);
        state.clear_count = clear_count;
        if let Some(pending) = state.pending.take() {
            if let Some(cancel) = pending.cancel {
                let _ = cancel.send(());
            }
        }
        Ok((state.adoption, ClearMarker(self.state.clone())))
    }

    fn refuse_digest(&self, digest: [u8; 32]) -> Result<()> {
        self.lock()?.refusals.refused.insert(digest);
        Ok(())
    }

    fn note_recorded(&self, _digest: [u8; 32], recorded: bool) -> Result<()> {
        if !recorded {
            self.lock()?.refusals.unrecorded = true;
        }
        Ok(())
    }

    fn retain_refusal(&self, digest: [u8; 32]) -> Result<()> {
        self.lock()?.refusals.retained.insert(digest);
        Ok(())
    }

    fn is_refused_digest(&self, digest: [u8; 32]) -> Result<bool> {
        Ok(self.lock()?.refusals.refused.contains(&digest))
    }

    fn cleanup_refused_read(
        &self,
        storage: &dyn SessionCredentialStorage,
        key: &SessionStorageKey,
        session: &SessionCredential,
        digest: [u8; 32],
    ) -> Result<()> {
        match delete_from(storage, key, session) {
            Ok(true) => self.prune_refusals(vec![digest], &self.refusal_records),
            Ok(false) => match stored_digest_is(storage, key, digest) {
                Ok(true) => self.retain_refusal(digest),
                Ok(false) => self.prune_refusals(vec![digest], &self.refusal_records),
                Err(_) => self.retain_refusal(digest),
            },
            Err(_) => self.retain_refusal(digest),
        }
    }

    fn prune_retained(&self, records: &RefusalRecords) -> Result<()> {
        let digests = self.lock()?.refusals.retained.iter().copied().collect();
        self.prune_refusals(digests, records)
    }

    fn prune_refusals(&self, digests: Vec<[u8; 32]>, records: &RefusalRecords) -> Result<()> {
        let pending = {
            let mut state = self.lock()?;
            for digest in digests {
                state.refusals.retained.remove(&digest);
                state.refusals.unpruned.insert(digest);
            }
            if state.refusals.retained.is_empty() {
                state.refusals.unrecorded = false;
            }
            state.refusals.unpruned.iter().copied().collect::<Vec<_>>()
        };
        for digest in pending {
            if records.remove(digest).is_ok() {
                self.lock()?.refusals.unpruned.remove(&digest);
            }
        }
        Ok(())
    }
}

pub struct SessionAttempt {
    config: Arc<Config>,
    owner: Arc<()>,
    identity: Arc<()>,
    id: String,
    canceled: oneshot::Receiver<()>,
}

impl SessionAttempt {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn endpoint(&self, path: &str) -> Url {
        self.config.endpoint(path)
    }

    pub fn canceled(&mut self) -> &mut oneshot::Receiver<()> {
        &mut self.canceled
    }
}

fn validate_attempt_id(id: &str) -> Result<()> {
    if (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(CANCELED.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        process::Command,
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc, Mutex,
        },
    };

    const TEST_SERVICE: &str = "test-enterprise-session";
    const TEST_BASE_URL: &str = "http://127.0.0.1:9000";
    const PROCESS_HOME: &str = "BUZZ_BUILDERLAB_FIXTURE_HOME";
    const PROCESS_TOKEN: &str = "BUZZ_BUILDERLAB_FIXTURE_TOKEN";
    const PROCESS_MARKER: &str = "BUZZ_BUILDERLAB_FIXTURE_MARKER";

    #[derive(Clone, Copy)]
    enum Operation {
        Get,
        Set,
        Delete,
    }

    #[derive(Clone, Copy)]
    enum StorageFailure {
        Denied,
        Unavailable,
    }

    enum SetFailure {
        Before(StorageFailure),
        After(StorageFailure),
    }

    struct Gate {
        started: oneshot::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    #[derive(Default)]
    struct Controls {
        get_gate: Option<Gate>,
        set_gate: Option<Gate>,
        delete_gate: Option<Gate>,
        get_failure: Option<StorageFailure>,
        set_failure: Option<SetFailure>,
        delete_failure: Option<StorageFailure>,
        delete_noop: bool,
    }

    impl Controls {
        fn gate(&mut self, operation: Operation) -> &mut Option<Gate> {
            match operation {
                Operation::Get => &mut self.get_gate,
                Operation::Set => &mut self.set_gate,
                Operation::Delete => &mut self.delete_gate,
            }
        }
    }

    struct GatedStore {
        path: PathBuf,
        controls: Mutex<Controls>,
        delete_calls: AtomicUsize,
    }

    impl GatedStore {
        fn new(path: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                path,
                controls: Mutex::new(Controls::default()),
                delete_calls: AtomicUsize::new(0),
            })
        }

        fn hold(&self, operation: Operation) -> (oneshot::Receiver<()>, mpsc::Sender<()>) {
            let (started, started_receiver) = oneshot::channel();
            let (release_sender, release) = mpsc::channel();
            *self.controls.lock().unwrap().gate(operation) = Some(Gate { started, release });
            (started_receiver, release_sender)
        }

        fn before(&self, operation: Operation) {
            let gate = self.controls.lock().unwrap().gate(operation).take();
            if let Some(gate) = gate {
                let _ = gate.started.send(());
                let _ = gate.release.recv();
            }
        }

        fn fail_get(&self, failure: Option<StorageFailure>) {
            self.controls.lock().unwrap().get_failure = failure;
        }

        fn fail_set(&self, failure: Option<SetFailure>) {
            self.controls.lock().unwrap().set_failure = failure;
        }

        fn fail_delete(&self, failure: Option<StorageFailure>) {
            self.controls.lock().unwrap().delete_failure = failure;
        }

        fn noop_delete(&self) {
            self.controls.lock().unwrap().delete_noop = true;
        }

        fn delete_calls(&self) -> usize {
            self.delete_calls.load(Ordering::SeqCst)
        }
    }

    fn storage_failure(failure: StorageFailure) -> anyhow::Error {
        match failure {
            StorageFailure::Denied => anyhow::anyhow!("OSStatus -25293"),
            StorageFailure::Unavailable => anyhow::anyhow!("fixture storage unavailable"),
        }
    }

    struct GatedFactory(Arc<GatedStore>);

    impl StoreFactory for GatedFactory {
        fn open(&self, _config: &Config, _op: Op) -> Result<Box<dyn SessionCredentialStorage>> {
            Ok(Box::new(GatedStorage(self.0.clone())))
        }
    }

    struct GatedStorage(Arc<GatedStore>);

    impl SessionCredentialStorage for GatedStorage {
        fn kind(&self) -> &'static str {
            "file"
        }

        fn get(&self, key: &SessionStorageKey) -> anyhow::Result<Option<StoredSessionCredential>> {
            self.0.before(Operation::Get);
            if let Some(failure) = self.0.controls.lock().unwrap().get_failure.take() {
                return Err(storage_failure(failure));
            }
            FileSessionCredentialStorage::new(self.0.path.clone()).get(key)
        }

        fn set(
            &self,
            key: &SessionStorageKey,
            credential: &StoredSessionCredential,
        ) -> anyhow::Result<()> {
            self.0.before(Operation::Set);
            match self.0.controls.lock().unwrap().set_failure.take() {
                Some(SetFailure::Before(failure)) => Err(storage_failure(failure)),
                Some(SetFailure::After(failure)) => {
                    FileSessionCredentialStorage::new(self.0.path.clone()).set(key, credential)?;
                    Err(storage_failure(failure))
                }
                None => FileSessionCredentialStorage::new(self.0.path.clone()).set(key, credential),
            }
        }

        fn delete(&self, key: &SessionStorageKey) -> anyhow::Result<bool> {
            self.0.delete_calls.fetch_add(1, Ordering::SeqCst);
            self.0.before(Operation::Delete);
            if let Some(failure) = self.0.controls.lock().unwrap().delete_failure.take() {
                return Err(storage_failure(failure));
            }
            if std::mem::take(&mut self.0.controls.lock().unwrap().delete_noop) {
                return Ok(false);
            }
            FileSessionCredentialStorage::new(self.0.path.clone()).delete(key)
        }
    }

    fn environment(home: &Path, base_url: &str) -> Environment {
        Environment {
            bl_home: Some(home.join(".bl")),
            base_url: Some(base_url.to_owned()),
            ..Environment::default()
        }
    }

    fn config(home: &Path, base_url: &str) -> Config {
        let mut config = Config::resolve(&environment(home, base_url), home).unwrap();
        config.storage = StorageSelection::File(home.join("auth-sessions.json"));
        config
    }

    fn records(home: &Path) -> RefusalRecords {
        RefusalRecords::new(Some(home.join("app-data")), TEST_SERVICE.to_owned())
    }

    fn owner(home: &Path, base_url: &str) -> SessionOwner {
        SessionOwner::new(Ok(config(home, base_url)), records(home))
    }

    fn gated_owner(home: &Path, base_url: &str) -> (SessionOwner, Arc<GatedStore>) {
        let store = GatedStore::new(home.join("auth-sessions.json"));
        (gated_owner_with_store(home, base_url, store.clone()), store)
    }

    fn plain_fixture() -> (tempfile::TempDir, SessionOwner) {
        let home = tempfile::tempdir().unwrap();
        let host = owner(home.path(), TEST_BASE_URL);
        (home, host)
    }

    fn seeded_plain_fixture(
        token: &str,
        expires_at: Option<&str>,
    ) -> (tempfile::TempDir, SessionOwner) {
        let (home, host) = plain_fixture();
        seed(&host, token, expires_at);
        (home, host)
    }

    fn gated_fixture() -> (tempfile::TempDir, SessionOwner, Arc<GatedStore>) {
        let home = tempfile::tempdir().unwrap();
        let (host, store) = gated_owner(home.path(), TEST_BASE_URL);
        (home, host, store)
    }

    fn seeded_gated_fixture(token: &str) -> (tempfile::TempDir, SessionOwner, Arc<GatedStore>) {
        let (home, host, store) = gated_fixture();
        seed(&host, token, None);
        (home, host, store)
    }

    fn gated_owner_with_store(home: &Path, base_url: &str, store: Arc<GatedStore>) -> SessionOwner {
        let mut config = config(home, base_url);
        config.factory = Arc::new(GatedFactory(store));
        SessionOwner::new(Ok(config), records(home))
    }

    fn credential(value: &str) -> SessionCredential {
        SessionCredential::new(
            Zeroizing::new(value.to_owned()),
            Some("2099-01-01T00:00:00Z".to_owned()),
        )
    }

    fn seed(owner: &SessionOwner, credential: &str, expires_at: Option<&str>) {
        let config = owner.config().unwrap();
        FileSessionCredentialStorage::new(match &config.storage {
            StorageSelection::File(path) => path.clone(),
            StorageSelection::CrateDefault => unreachable!(),
        })
        .set(
            &config.key,
            &StoredSessionCredential {
                session_credential: credential.to_owned(),
                expires_at: expires_at.map(str::to_owned),
            },
        )
        .unwrap();
    }

    fn stored_token(owner: &SessionOwner) -> Option<String> {
        let config = owner.config().unwrap();
        FileSessionCredentialStorage::new(match &config.storage {
            StorageSelection::File(path) => path.clone(),
            StorageSelection::CrateDefault => unreachable!(),
        })
        .get(&config.key)
        .unwrap()
        .and_then(session_from_stored)
        .map(|session| session.credential().to_owned())
    }

    fn refusal_root(home: &Path) -> PathBuf {
        home.join("app-data").join(REFUSAL_DIRECTORY)
    }

    fn refusal_path(home: &Path, service: &str, credential: &str) -> PathBuf {
        refusal_root(home)
            .join(service)
            .join(hex_digest(&token_digest(credential)))
    }

    fn assert_profile_key(config: &Config, profile: &str, file_path: &Path) {
        let storage = FileSessionCredentialStorage::new(file_path.to_owned());
        storage
            .set(
                &config.key,
                &StoredSessionCredential {
                    session_credential: "profile-key-fixture".to_owned(),
                    expires_at: None,
                },
            )
            .unwrap();
        let expected = SessionStorageKey::from_profile_and_kgoose_base_url(
            profile,
            "https://test.blockstaging.build",
            "/api/goose",
        );
        assert_eq!(
            storage.get(&expected).unwrap().unwrap().session_credential,
            "profile-key-fixture"
        );
    }

    fn expected_error(failure: StorageFailure, operation: Op) -> &'static str {
        match failure {
            StorageFailure::Denied => KEYCHAIN_DENIED,
            StorageFailure::Unavailable => match operation {
                Op::Read => STORE_READ,
                Op::Update => STORE_UPDATE,
            },
        }
    }

    #[test]
    fn resolves_profile_precedence_and_public_and_direct_service_prefixes() {
        let temp = tempfile::tempdir().unwrap();
        let bl_home = temp.path().join("configured-bl");
        fs::create_dir_all(&bl_home).unwrap();
        fs::write(bl_home.join("config.yaml"), "org: test\n").unwrap();
        let skills_override = temp.path().join("profiles/custom-skills.yaml");
        fs::create_dir_all(skills_override.parent().unwrap()).unwrap();
        fs::write(&skills_override, "current_profile: from-file\n").unwrap();

        let mut env = Environment {
            bl_home: Some(bl_home),
            skills_config: Some(skills_override),
            profile: Some("from-env".to_owned()),
            base_url: Some("https://blockstaging.build".to_owned()),
            ..Environment::default()
        };
        let config = Config::resolve(&env, temp.path()).unwrap();
        assert_profile_key(&config, "from-env", &temp.path().join("profile-env.json"));
        assert_eq!(
            config.service_url.as_str(),
            "https://test.blockstaging.build/api/goose"
        );

        env.profile = None;
        let file_profile = Config::resolve(&env, temp.path()).unwrap();
        assert_profile_key(
            &file_profile,
            "from-file",
            &temp.path().join("profile-file.json"),
        );

        env.profile = Some("direct-profile".to_owned());
        env.base_url = Some("https://kgoose.sqprod.co/api/goose".to_owned());
        env.service_path = None;
        let direct = Config::resolve(&env, temp.path()).unwrap();
        assert_eq!(
            direct.service_url.as_str(),
            "https://kgoose.sqprod.co/cash-app/goose"
        );
        let cli_key = SessionStorageKey::from_profile_and_kgoose_base_url(
            "direct-profile",
            "https://kgoose.sqprod.co",
            "/cash-app/goose",
        );
        let file = FileSessionCredentialStorage::new(temp.path().join("direct-sessions.json"));
        file.set(
            &direct.key,
            &StoredSessionCredential {
                session_credential: "direct-fixture".to_owned(),
                expires_at: None,
            },
        )
        .unwrap();
        assert_eq!(
            file.get(&cli_key)
                .unwrap()
                .unwrap()
                .session_credential_header_value()
                .as_deref(),
            Some("direct-fixture")
        );

        env.base_url = Some("https://identity.example/tenant/goose".to_owned());
        env.service_path = Some("tenant/goose".to_owned());
        assert_eq!(
            Config::resolve(&env, temp.path())
                .unwrap()
                .service_url
                .as_str(),
            "https://identity.example/tenant/goose"
        );
    }

    #[test]
    fn rejects_memory_storage_and_non_loopback_http() {
        let temp = tempfile::tempdir().unwrap();
        let mut env = environment(temp.path(), "http://identity.example");
        assert_eq!(
            Config::resolve(&env, temp.path()).err().as_deref(),
            Some(INVALID_SETTINGS)
        );
        env.base_url = Some("https://identity.example".to_owned());
        env.storage = Some("memory".to_owned());
        assert_eq!(
            Config::resolve(&env, temp.path()).err().as_deref(),
            Some(MEMORY_STORAGE)
        );
    }

    #[tokio::test]
    async fn reads_cli_records_and_preserves_optional_expiry() {
        let (temp, host) = seeded_plain_fixture("cli-seeded", None);
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        assert_eq!(snapshot.credential(), "cli-seeded");
        assert_eq!(snapshot.expires_at(), None);
        assert!(host.admit(&snapshot, || "admitted").is_some());

        let attempt = host.begin_attempt("enterprise-1").unwrap();
        host.commit_attempt(&attempt, credential("session-a"))
            .await
            .unwrap();
        host.retire_attempt(&attempt);
        let saved = host.session_snapshot().await.unwrap().unwrap();
        assert_eq!(saved.credential(), "session-a");
        assert_eq!(saved.expires_at(), Some("2099-01-01T00:00:00Z"));
        assert!(!host.is_current(&snapshot));
        assert!(host.admit(&snapshot, || ()).is_none());

        let config = host.config().unwrap();
        let cli_record = FileSessionCredentialStorage::new(temp.path().join("auth-sessions.json"));
        let stored = cli_record.get(&config.key).unwrap().unwrap();
        assert_eq!(stored.session_credential, "session-a");
        assert_eq!(stored.expires_at.as_deref(), Some("2099-01-01T00:00:00Z"));
        let bytes = fs::read_to_string(temp.path().join("auth-sessions.json")).unwrap();
        assert!(bytes.contains("sessionCredential"));
        assert!(bytes.contains("expiresAt"));
        assert!(!bytes.contains("enterprise-1"));
    }

    #[tokio::test]
    async fn beginning_a_login_keeps_the_saved_snapshot_current() {
        let (_temp, host) = seeded_plain_fixture("old-session", None);
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        let _attempt = host.begin_attempt("login-pending").unwrap();
        assert!(host.is_current(&snapshot));
        assert_eq!(host.admit(&snapshot, || 42), Some(42));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn storage_read_and_commit_cannot_pair_a_record_with_an_old_revision() {
        let (_temp, host, store) = seeded_gated_fixture("old-session");
        let (read_started, release_read) = store.hold(Operation::Get);
        let read_host = host.clone();
        let read = tokio::spawn(async move { read_host.session_snapshot().await });
        read_started.await.unwrap();

        let attempt = host.begin_attempt("replace-session").unwrap();
        let commit_host = host.clone();
        let commit = tokio::spawn(async move {
            commit_host
                .commit_attempt(&attempt, credential("new-session"))
                .await
        });
        release_read.send(()).unwrap();

        let snapshot = read.await.unwrap().unwrap().unwrap();
        commit.await.unwrap().unwrap();
        assert_eq!(snapshot.credential(), "old-session");
        assert!(!host.is_current(&snapshot));
        assert!(host.admit(&snapshot, || ()).is_none());
        let current = host.session_snapshot().await.unwrap().unwrap();
        assert_eq!(current.credential(), "new-session");
        assert!(host.is_current(&current));
    }

    #[tokio::test]
    async fn clear_retires_snapshots_and_does_not_delete_a_newer_adoption() {
        let (_temp, host) = seeded_plain_fixture("old-session", None);
        let old = host.session_snapshot().await.unwrap().unwrap();
        host.clear_shared_session().await.unwrap();
        assert!(!host.is_current(&old));
        assert!(host.admit(&old, || ()).is_none());
        assert!(host.session_snapshot().await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_deletes_the_old_item_while_a_later_login_is_pending() {
        let (_temp, host, store) = seeded_gated_fixture("old-session");
        let old = host.session_snapshot().await.unwrap().unwrap();
        let (delete_started, release_delete) = store.hold(Operation::Delete);
        let clear_host = host.clone();
        let clear = tokio::spawn(async move { clear_host.clear_shared_session().await });
        delete_started.await.unwrap();

        let newer = host.begin_attempt("login-after-clear").unwrap();
        let commit_host = host.clone();
        let commit = tokio::spawn(async move {
            commit_host
                .commit_attempt(&newer, credential("new-session"))
                .await
        });
        assert!(!host.is_current(&old));
        release_delete.send(()).unwrap();
        clear.await.unwrap().unwrap();
        commit.await.unwrap().unwrap();

        assert_eq!(store.delete_calls(), 1);
        assert_eq!(stored_token(&host).as_deref(), Some("new-session"));
        assert!(host.admit(&old, || ()).is_none());
    }

    #[tokio::test]
    async fn clear_preserves_a_session_adopted_before_its_storage_decision() {
        let (_temp, host, store) = seeded_gated_fixture("old-session");
        let (adoption, marker) = host.begin_clear().unwrap();
        let newer = host.begin_attempt("login-before-clear-read").unwrap();
        host.commit_attempt(&newer, credential("new-session"))
            .await
            .unwrap();

        let config = host.config().unwrap();
        host.clear_shared_session_after_fence(config, adoption, marker)
            .await
            .unwrap();
        assert_eq!(store.delete_calls(), 0);
        assert_eq!(stored_token(&host).as_deref(), Some("new-session"));
    }

    #[tokio::test]
    async fn stale_invalidation_cannot_remove_a_newer_adoption() {
        let (_temp, host) = seeded_plain_fixture("old-session", None);
        let old = host.session_snapshot().await.unwrap().unwrap();
        let attempt = host.begin_attempt("newer-login").unwrap();
        host.commit_attempt(&attempt, credential("new-session"))
            .await
            .unwrap();

        assert!(!host.invalidate_shared_session(&old).await.unwrap());
        assert_eq!(stored_token(&host).as_deref(), Some("new-session"));
        assert_eq!(
            host.session_snapshot().await.unwrap().unwrap().credential(),
            "new-session"
        );
    }

    #[tokio::test]
    async fn attempt_ids_are_one_shot_and_old_handles_cannot_retire_replacements() {
        let (_temp, host) = plain_fixture();
        let original = host.begin_attempt("same-id").unwrap();
        assert_eq!(
            host.begin_attempt("same-id").err().as_deref(),
            Some(CANCELED)
        );
        host.commit_attempt(&original, credential("original-session"))
            .await
            .unwrap();
        host.retire_attempt(&original);
        assert_eq!(
            host.begin_attempt("same-id").err().as_deref(),
            Some(CANCELED)
        );

        let stale = host.begin_attempt("stale-handle").unwrap();
        let current = host.begin_attempt("current-handle").unwrap();
        host.retire_attempt(&stale);
        assert_eq!(
            host.commit_attempt(&stale, credential("stale-session"))
                .await
                .err()
                .as_deref(),
            Some(CANCELED)
        );
        host.commit_attempt(&current, credential("current-session"))
            .await
            .unwrap();
        host.retire_attempt(&current);
        assert_eq!(stored_token(&host).as_deref(), Some("current-session"));

        host.cancel_attempt("canceled-before-start").unwrap();
        assert_eq!(
            host.begin_attempt("canceled-before-start").err().as_deref(),
            Some(CANCELED)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancellation_during_a_held_set_cleans_the_unadopted_record() {
        let (_temp, host, store) = gated_fixture();
        let attempt = host.begin_attempt("cancel-held-write").unwrap();
        let id = attempt.id().to_owned();
        let (set_started, release_set) = store.hold(Operation::Set);
        let commit_host = host.clone();
        let commit = tokio::spawn(async move {
            commit_host
                .commit_attempt(&attempt, credential("unadopted-session"))
                .await
        });
        set_started.await.unwrap();
        host.cancel_attempt(&id).unwrap();
        release_set.send(()).unwrap();

        assert_eq!(commit.await.unwrap().err().as_deref(), Some(CANCELED));
        assert!(stored_token(&host).is_none());
        assert!(host.session_snapshot().await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_during_a_held_set_cleans_the_login_and_the_old_item() {
        let (_temp, host, store) = seeded_gated_fixture("old-session");
        let old = host.session_snapshot().await.unwrap().unwrap();
        let attempt = host.begin_attempt("clear-held-write").unwrap();
        let (set_started, release_set) = store.hold(Operation::Set);
        let commit_host = host.clone();
        let commit = tokio::spawn(async move {
            commit_host
                .commit_attempt(&attempt, credential("unadopted-session"))
                .await
        });
        set_started.await.unwrap();

        let (adoption, marker) = host.begin_clear().unwrap();
        assert!(host.admit(&old, || ()).is_none());
        let clear_config = host.config().unwrap();
        let clear_host = host.clone();
        let clear = tokio::spawn(async move {
            clear_host
                .clear_shared_session_after_fence(clear_config, adoption, marker)
                .await
        });
        release_set.send(()).unwrap();
        assert_eq!(commit.await.unwrap().err().as_deref(), Some(CANCELED));
        clear.await.unwrap().unwrap();
        assert!(stored_token(&host).is_none());
        assert!(host.session_snapshot().await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_retained_refusal_survives_restart_and_retries_cleanup() {
        let (temp, host, store) = seeded_gated_fixture("refused-session");
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        let marker = refusal_path(temp.path(), TEST_SERVICE, "refused-session");
        let (delete_started, release_delete) = store.hold(Operation::Delete);
        let reject_host = host.clone();
        let rejection = tokio::spawn(async move {
            let result = reject_host.reject_shared_session(&snapshot).await;
            assert!(reject_host.admit(&snapshot, || ()).is_none());
            result
        });
        delete_started.await.unwrap();
        assert!(marker.is_file());
        store.fail_delete(Some(StorageFailure::Unavailable));
        release_delete.send(()).unwrap();
        assert_eq!(
            rejection.await.unwrap().unwrap(),
            SharedSessionRejection::Retained
        );
        assert!(marker.is_file());
        assert_eq!(fs::metadata(&marker).unwrap().len(), 0);
        assert_eq!(
            host.cleanup_status().await.unwrap(),
            Some(SessionCleanup {
                retained: true,
                unrecorded: false,
                unpruned: false,
            })
        );

        store.fail_delete(Some(StorageFailure::Unavailable));
        let restarted = gated_owner_with_store(temp.path(), "http://127.0.0.1:9000", store.clone());
        assert!(restarted.session_snapshot().await.unwrap().is_none());
        assert!(marker.is_file());
        assert!(restarted.cleanup_status().await.unwrap().unwrap().retained);

        store.fail_delete(None);
        assert!(restarted.session_snapshot().await.unwrap().is_none());
        assert!(!marker.exists());
        assert_eq!(restarted.cleanup_status().await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_new_login_preserves_its_session_and_only_prunes_its_refusal_scope() {
        let (temp, host, store) = seeded_gated_fixture("old-refused-session");
        let old = host.session_snapshot().await.unwrap().unwrap();
        store.fail_delete(Some(StorageFailure::Denied));
        assert_eq!(
            host.reject_shared_session(&old).await.unwrap(),
            SharedSessionRejection::Retained
        );
        let old_marker = refusal_path(temp.path(), TEST_SERVICE, "old-refused-session");
        assert!(old_marker.is_file());

        let other_records = RefusalRecords::new(
            Some(temp.path().join("app-data")),
            "other-service".to_owned(),
        );
        other_records
            .add(token_digest("another-scope-token"))
            .unwrap();
        store.fail_delete(None);
        let attempt = host.begin_attempt("new-login-after-refusal").unwrap();
        host.commit_attempt(&attempt, credential("new-session"))
            .await
            .unwrap();

        assert!(!old_marker.exists());
        assert!(refusal_path(temp.path(), "other-service", "another-scope-token").is_file());
        assert!(!host.is_current(&old));
        let current = host.session_snapshot().await.unwrap().unwrap();
        assert_eq!(current.credential(), "new-session");
        assert!(host.admit(&current, || "new session").is_some());
    }

    #[tokio::test]
    async fn refusal_records_from_other_services_still_block_the_matching_token() {
        let temp = tempfile::tempdir().unwrap();
        let other_records = RefusalRecords::new(
            Some(temp.path().join("app-data")),
            "other-service".to_owned(),
        );
        other_records
            .add(token_digest("shared-refused-token"))
            .unwrap();

        let host = owner(temp.path(), TEST_BASE_URL);
        seed(&host, "shared-refused-token", None);
        assert!(host.session_snapshot().await.unwrap().is_none());
        assert!(stored_token(&host).is_none());
        assert!(refusal_path(temp.path(), "other-service", "shared-refused-token").is_file());
    }

    #[tokio::test]
    async fn unreadable_refusal_records_fail_closed_until_a_new_login() {
        let (temp, _) = seeded_plain_fixture("stored-session", None);
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        fs::write(app_data.join(REFUSAL_DIRECTORY), "not a directory").unwrap();
        let host = SessionOwner::new(
            Ok(config(temp.path(), "http://127.0.0.1:9000")),
            RefusalRecords::new(Some(app_data), TEST_SERVICE.to_owned()),
        );
        assert!(host.session_snapshot().await.unwrap().is_none());

        let attempt = host
            .begin_attempt("fresh-login-after-unreadable-journal")
            .unwrap();
        host.commit_attempt(&attempt, credential("fresh-session"))
            .await
            .unwrap();
        assert_eq!(
            host.session_snapshot().await.unwrap().unwrap().credential(),
            "fresh-session"
        );
    }

    #[tokio::test]
    async fn an_unrecorded_retained_refusal_reports_only_cleanup_flags() {
        let (temp, host, store) = seeded_gated_fixture("unrecorded-refusal-fixture");
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        let app_data = temp.path().join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        fs::write(app_data.join(REFUSAL_DIRECTORY), "blocks journal writes").unwrap();
        store.fail_delete(Some(StorageFailure::Unavailable));

        assert_eq!(
            host.reject_shared_session(&snapshot).await.unwrap(),
            SharedSessionRejection::Retained
        );
        assert_eq!(
            host.cleanup_status().await.unwrap(),
            Some(SessionCleanup {
                retained: true,
                unrecorded: true,
                unpruned: false,
            })
        );
        assert!(host.admit(&snapshot, || ()).is_none());

        let restarted = owner(temp.path(), "http://127.0.0.1:9000");
        assert!(restarted.session_snapshot().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unpruned_refusal_records_retry_on_the_next_successful_login() {
        let (temp, host, store) = seeded_gated_fixture("old-refused-session");
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        store.fail_delete(Some(StorageFailure::Unavailable));
        assert_eq!(
            host.reject_shared_session(&snapshot).await.unwrap(),
            SharedSessionRejection::Retained
        );

        let marker = refusal_path(temp.path(), TEST_SERVICE, "old-refused-session");
        fs::remove_file(&marker).unwrap();
        fs::create_dir(&marker).unwrap();
        fs::write(marker.join("held"), "fixture").unwrap();
        store.fail_delete(None);
        let attempt = host.begin_attempt("replace-retained-session").unwrap();
        host.commit_attempt(&attempt, credential("replacement-session"))
            .await
            .unwrap();
        assert_eq!(
            host.cleanup_status().await.unwrap(),
            Some(SessionCleanup {
                retained: false,
                unrecorded: false,
                unpruned: true,
            })
        );
        assert_eq!(stored_token(&host).as_deref(), Some("replacement-session"));

        fs::remove_dir_all(&marker).unwrap();
        let retry = host.begin_attempt("retry-pruned-record").unwrap();
        host.commit_attempt(&retry, credential("second-replacement"))
            .await
            .unwrap();
        assert_eq!(host.cleanup_status().await.unwrap(), None);
    }

    #[tokio::test]
    async fn denied_and_unavailable_reads_and_writes_are_sanitized() {
        let (temp, host, store) = seeded_gated_fixture("stored-session");
        for failure in [StorageFailure::Denied, StorageFailure::Unavailable] {
            store.fail_get(Some(failure));
            let error = host.session_snapshot().await.err().unwrap();
            assert_eq!(error, expected_error(failure, Op::Read));
            assert!(!error.contains("stored-session"));
        }

        for (index, failure) in [StorageFailure::Denied, StorageFailure::Unavailable]
            .into_iter()
            .enumerate()
        {
            let id = format!("failed-write-{index}");
            let attempt = host.begin_attempt(id).unwrap();
            store.fail_set(Some(SetFailure::Before(failure)));
            let error = host
                .commit_attempt(&attempt, credential("write-secret-fixture"))
                .await
                .unwrap_err();
            assert_eq!(error, expected_error(failure, Op::Update));
            assert!(!error.contains("write-secret-fixture"));
            host.retire_attempt(&attempt);
            assert_eq!(stored_token(&host).as_deref(), Some("stored-session"));
        }

        let saved = host.session_snapshot().await.unwrap().unwrap();
        let attempt = host.begin_attempt("failed-same-session-refresh").unwrap();
        store.fail_set(Some(SetFailure::Before(StorageFailure::Unavailable)));
        assert_eq!(
            host.commit_attempt(&attempt, credential("stored-session"))
                .await
                .unwrap_err(),
            STORE_UPDATE
        );
        assert!(!host.is_current(&saved));
        assert_eq!(stored_token(&host).as_deref(), Some("stored-session"));
        assert!(!refusal_path(temp.path(), TEST_SERVICE, "stored-session").exists());
        assert_eq!(
            host.session_snapshot().await.unwrap().unwrap().credential(),
            "stored-session"
        );
    }

    #[tokio::test]
    async fn denied_and_unavailable_deletes_report_only_safe_status() {
        for failure in [StorageFailure::Denied, StorageFailure::Unavailable] {
            let (_temp, host, store) = seeded_gated_fixture("delete-secret-fixture");
            store.fail_delete(Some(failure));
            let error = host.clear_shared_session().await.unwrap_err();
            assert_eq!(error, expected_error(failure, Op::Update));
            assert!(!error.contains("delete-secret-fixture"));
            assert_eq!(
                stored_token(&host).as_deref(),
                Some("delete-secret-fixture")
            );
        }
    }

    #[tokio::test]
    async fn a_noop_delete_is_not_reported_as_a_successful_clear() {
        let (_temp, host, store) = seeded_gated_fixture("clear-retained-session");
        let snapshot = host.session_snapshot().await.unwrap().unwrap();
        store.noop_delete();

        assert_eq!(host.clear_shared_session().await.unwrap_err(), STORE_UPDATE);
        assert!(!host.is_current(&snapshot));
        assert_eq!(
            stored_token(&host).as_deref(),
            Some("clear-retained-session")
        );
    }

    #[tokio::test]
    async fn a_refusal_read_failure_stays_recorded_and_denied_deletes_stay_retained() {
        for failure in [StorageFailure::Denied, StorageFailure::Unavailable] {
            let (temp, host, store) = seeded_gated_fixture("refused-session");
            let snapshot = host.session_snapshot().await.unwrap().unwrap();
            store.fail_get(Some(failure));
            let error = host.reject_shared_session(&snapshot).await.unwrap_err();
            assert_eq!(error, expected_error(failure, Op::Update));
            assert!(!error.contains("refused-session"));
            assert!(refusal_path(temp.path(), TEST_SERVICE, "refused-session").is_file());
            assert!(host.cleanup_status().await.unwrap().unwrap().retained);
        }

        for failure in [StorageFailure::Denied, StorageFailure::Unavailable] {
            let (_temp, host, store) = seeded_gated_fixture("refused-session");
            let snapshot = host.session_snapshot().await.unwrap().unwrap();
            store.fail_delete(Some(failure));
            assert_eq!(
                host.reject_shared_session(&snapshot).await.unwrap(),
                SharedSessionRejection::Retained
            );
            assert!(host.cleanup_status().await.unwrap().unwrap().retained);
        }
    }

    #[tokio::test]
    async fn persist_then_error_cleanup_removes_or_durably_refuses_the_record() {
        let (temp, host, store) = gated_fixture();
        let attempt = host.begin_attempt("persist-then-error-cleanup").unwrap();
        store.fail_set(Some(SetFailure::After(StorageFailure::Unavailable)));
        let error = host
            .commit_attempt(&attempt, credential("persisted-then-error"))
            .await
            .unwrap_err();
        assert_eq!(error, STORE_UPDATE);
        assert!(stored_token(&host).is_none());
        assert!(!refusal_path(temp.path(), TEST_SERVICE, "persisted-then-error").exists());
        assert_eq!(host.cleanup_status().await.unwrap(), None);

        let attempt = host.begin_attempt("persist-then-error-retained").unwrap();
        store.fail_set(Some(SetFailure::After(StorageFailure::Unavailable)));
        store.fail_delete(Some(StorageFailure::Denied));
        let error = host
            .commit_attempt(&attempt, credential("retained-after-error"))
            .await
            .unwrap_err();
        assert_eq!(error, KEYCHAIN_DENIED);
        assert!(refusal_path(temp.path(), TEST_SERVICE, "retained-after-error").is_file());
        store.fail_delete(Some(StorageFailure::Denied));
        assert!(host.session_snapshot().await.unwrap().is_none());

        store.fail_delete(Some(StorageFailure::Denied));
        let restarted = gated_owner_with_store(temp.path(), "http://127.0.0.1:9000", store.clone());
        assert!(restarted.session_snapshot().await.unwrap().is_none());
        assert!(restarted.cleanup_status().await.unwrap().unwrap().retained);
    }

    #[test]
    fn cli_fixture_child() {
        let (Ok(home), Ok(expected), Ok(marker)) = (
            std::env::var(PROCESS_HOME),
            std::env::var(PROCESS_TOKEN),
            std::env::var(PROCESS_MARKER),
        ) else {
            return;
        };
        let host = owner(Path::new(&home), "http://127.0.0.1:9000");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let snapshot = runtime.block_on(host.session_snapshot()).unwrap().unwrap();
        assert!(snapshot.credential() == expected);
        fs::write(marker, "read").unwrap();
    }

    #[test]
    fn a_fresh_process_reads_the_cli_file_fixture() {
        let (temp, _host) =
            seeded_plain_fixture("disposable-cli-fixture", Some("2099-01-01T00:00:00Z"));
        let marker = temp.path().join("child-read-marker");
        let output = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("tests::cli_fixture_child")
            .arg("--test-threads=1")
            .env_clear()
            .env(PROCESS_HOME, temp.path())
            .env(PROCESS_TOKEN, "disposable-cli-fixture")
            .env(PROCESS_MARKER, &marker)
            .output()
            .unwrap();
        assert!(output.status.success(), "fixture subprocess failed");
        assert_eq!(fs::read(marker).unwrap(), b"read");
    }
}
