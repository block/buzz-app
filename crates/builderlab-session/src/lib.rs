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
use serde::Deserialize;
use std::{
    collections::VecDeque,
    fmt::Display,
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
const ATTEMPT_LIMIT: usize = 64;
const REFUSED_LIMIT: usize = 64;

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

enum Stored {
    Absent,
    Blank,
    Credential(SessionCredential),
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
    profile: String,
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
            profile,
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
    tokio::task::spawn_blocking(move || {
        let _lock = config.storage_lock.lock().map_err(|_| STORE_UNAVAILABLE)?;
        let storage = config.factory.open(&config, op)?;
        action(storage.as_ref(), &config.key)
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

async fn read(config: Arc<Config>) -> Result<Stored> {
    with_storage(config, Op::Read, |storage, key| {
        Ok(
            match storage
                .get(key)
                .map_err(|error| storage_error(Op::Read, error))?
            {
                None => Stored::Absent,
                Some(stored) => {
                    session_from_stored(stored).map_or(Stored::Blank, Stored::Credential)
                }
            },
        )
    })
    .await
}

fn delete_from(
    storage: &dyn SessionCredentialStorage,
    key: &SessionStorageKey,
    expected: &SessionCredential,
) -> Result<()> {
    let current = storage
        .get(key)
        .map_err(|error| storage_error(Op::Update, error))?
        .and_then(session_from_stored);
    if current.as_ref().is_none_or(|current| {
        current.credential() != expected.credential()
            || current.expires_at() != expected.expires_at()
    }) {
        return Ok(());
    }
    storage
        .delete(key)
        .map(drop)
        .map_err(|error| storage_error(Op::Update, error))
}

async fn write(
    config: Arc<Config>,
    credential: SessionCredential,
    owner: SessionOwner,
    id: String,
) -> Result<(bool, Option<SessionCredential>)> {
    with_storage(config, Op::Update, move |storage, key| {
        if !owner.owns(&id)? {
            return Err(CANCELED.into());
        }
        let previous = storage
            .get(key)
            .map_err(|error| storage_error(Op::Update, error))?
            .and_then(session_from_stored)
            .filter(|previous| {
                previous.credential() != credential.credential()
                    || previous.expires_at() != credential.expires_at()
            });
        let expected = credential.clone();
        let mut stored = StoredSessionCredential {
            session_credential: credential.credential().to_owned(),
            expires_at: credential.expires_at.clone(),
        };
        let set_result = storage.set(key, &stored);
        stored.session_credential.zeroize();
        if let Err(error) = set_result {
            owner.remember_refused(credential.credential());
            let cleanup = delete_from(storage, key, &expected);
            return match cleanup {
                Ok(()) => Err(storage_error(Op::Update, error)),
                Err(cleanup_error) => Err(cleanup_error),
            };
        }

        let current = {
            let mut state = owner.lock()?;
            let current = state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id);
            if current {
                state.pending = None;
                state.generation = state.generation.wrapping_add(1);
                state.adoption = state.adoption.wrapping_add(1);
                state.refused.clear();
            }
            current
        };
        if !current {
            owner.remember_refused(credential.credential());
            let cleanup = delete_from(storage, key, &expected);
            let fence = owner.bump_generation();
            if let Err(error) = cleanup {
                let _ = fence;
                return Err(error);
            }
            fence?;
            return Err(CANCELED.into());
        }
        Ok((true, previous))
    })
    .await
}

struct Pending {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

struct State {
    generation: u64,
    adoption: u64,
    canceled: VecDeque<String>,
    refused: VecDeque<Zeroizing<String>>,
    pending: Option<Pending>,
}

fn remember_canceled(canceled: &mut VecDeque<String>, id: &str) {
    if canceled.iter().any(|current| current == id) {
        return;
    }
    if canceled.len() >= ATTEMPT_LIMIT {
        canceled.pop_front();
    }
    canceled.push_back(id.to_owned());
}

fn remember_refused(refused: &mut VecDeque<Zeroizing<String>>, credential: &str) {
    if refused.iter().any(|current| current.as_str() == credential) {
        return;
    }
    if refused.len() >= REFUSED_LIMIT {
        refused.pop_front();
    }
    refused.push_back(Zeroizing::new(credential.to_owned()));
}

/// The single in-process lifecycle owner for the CLI session item.
#[derive(Clone)]
pub struct SessionOwner {
    config: std::result::Result<Arc<Config>, String>,
    state: Arc<Mutex<State>>,
}

impl SessionOwner {
    pub fn from_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        Self::new(Config::resolve(&Environment::from_process(), &home))
    }

    fn new(config: Result<Config>) -> Self {
        Self {
            config: config.map(Arc::new),
            state: Arc::new(Mutex::new(State {
                generation: 0,
                adoption: 0,
                canceled: VecDeque::new(),
                refused: VecDeque::new(),
                pending: None,
            })),
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

    pub fn profile(&self) -> Result<String> {
        Ok(self.config()?.profile.clone())
    }

    pub fn generation(&self) -> Result<u64> {
        Ok(self.lock()?.generation)
    }

    pub fn adoption(&self) -> Result<u64> {
        Ok(self.lock()?.adoption)
    }

    pub fn begin_attempt(&self, id: impl Into<String>) -> Result<SessionAttempt> {
        let id = id.into();
        validate_attempt_id(&id)?;
        let config = self.config()?;
        let (cancel, canceled) = oneshot::channel();
        let mut state = self.lock()?;
        if state.canceled.iter().any(|current| current == &id) {
            return Err(CANCELED.into());
        }
        state.generation = state.generation.wrapping_add(1);
        if let Some(previous) = state.pending.take() {
            remember_canceled(&mut state.canceled, &previous.id);
            if let Some(cancel) = previous.cancel {
                let _ = cancel.send(());
            }
        }
        state.pending = Some(Pending {
            id: id.clone(),
            cancel: Some(cancel),
        });
        Ok(SessionAttempt {
            config,
            id,
            canceled,
        })
    }

    pub fn cancel_attempt(&self, id: &str) -> Result<()> {
        validate_attempt_id(id)?;
        let mut state = self.lock()?;
        if state
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id)
        {
            let pending = state.pending.take();
            state.generation = state.generation.wrapping_add(1);
            remember_canceled(&mut state.canceled, id);
            if let Some(Pending {
                cancel: Some(cancel),
                ..
            }) = pending
            {
                let _ = cancel.send(());
            }
        } else {
            remember_canceled(&mut state.canceled, id);
        }
        Ok(())
    }

    pub fn retire_attempt(&self, id: &str) {
        if let Ok(mut state) = self.lock() {
            if state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
            {
                state.pending = None;
            }
        }
    }

    pub async fn shared_session(&self) -> Result<Option<SessionCredential>> {
        match self.shared_session_with_adoption().await? {
            Some((session, _)) => Ok(Some(session)),
            None => Ok(None),
        }
    }

    pub async fn shared_session_with_adoption(&self) -> Result<Option<(SessionCredential, u64)>> {
        let adoption = self.adoption()?;
        match read(self.config()?).await? {
            Stored::Credential(session) if !self.is_refused(session.credential()) => {
                Ok(Some((session, adoption)))
            }
            Stored::Absent | Stored::Blank | Stored::Credential(_) => Ok(None),
        }
    }

    pub async fn commit_attempt(&self, id: &str, session: SessionCredential) -> Result<()> {
        validate_attempt_id(id)?;
        write(self.config()?, session, self.clone(), id.to_owned())
            .await
            .map(|_| ())
    }

    pub async fn clear_shared_session(&self) -> Result<()> {
        let config = self.config()?;
        let adoption = self.begin_clear()?;
        self.clear_shared_session_after_fence(config, adoption)
            .await
    }

    async fn clear_shared_session_after_fence(
        &self,
        config: Arc<Config>,
        adoption: u64,
    ) -> Result<()> {
        let owner = self.clone();
        with_storage(config, Op::Update, move |storage, key| {
            if owner.adoption()? != adoption {
                return Ok(());
            }
            let current = storage
                .get(key)
                .map_err(|error| storage_error(Op::Update, error))?
                .and_then(session_from_stored);
            let deletion = current
                .as_ref()
                .map(|current| delete_from(storage, key, current))
                .unwrap_or(Ok(()));
            if deletion.is_ok() {
                owner.clear_refused();
            }
            let fence = owner.bump_generation();
            match (deletion, fence) {
                (Err(error), _) => Err(error),
                (Ok(()), Err(error)) => Err(error),
                (Ok(()), Ok(())) => Ok(()),
            }
        })
        .await
    }

    pub async fn invalidate_shared_session(
        &self,
        expected: SessionCredential,
        started_generation: u64,
    ) -> Result<bool> {
        let config = self.config()?;
        let owner = self.clone();
        with_storage(config, Op::Update, move |storage, key| {
            if owner.generation()? != started_generation {
                return Ok(false);
            }
            owner.bump_generation()?;
            let deletion = delete_from(storage, key, &expected);
            let fence = owner.bump_generation();
            match (deletion, fence) {
                (Err(error), _) => Err(error),
                (Ok(()), Err(error)) => Err(error),
                (Ok(()), Ok(())) => Ok(true),
            }
        })
        .await
    }

    pub async fn reject_shared_session(
        &self,
        expected: SessionCredential,
    ) -> Result<SharedSessionRejection> {
        self.remember_refused(expected.credential());
        self.bump_generation()?;
        let config = self.config()?;
        with_storage(config, Op::Update, move |storage, key| {
            let current = storage
                .get(key)
                .map_err(|error| storage_error(Op::Update, error))?
                .and_then(session_from_stored);
            if current.as_ref().is_none_or(|current| {
                current.credential() != expected.credential()
                    || current.expires_at() != expected.expires_at()
            }) {
                return Ok(SharedSessionRejection::Superseded);
            }
            Ok(match delete_from(storage, key, &expected) {
                Ok(()) => SharedSessionRejection::Removed,
                Err(_) => SharedSessionRejection::Retained,
            })
        })
        .await
    }

    pub fn is_refused(&self, credential: &str) -> bool {
        self.state
            .lock()
            .map(|state| {
                state
                    .refused
                    .iter()
                    .any(|current| current.as_str() == credential)
            })
            .unwrap_or(true)
    }

    /// Admit synchronous work while refusal remains mutually exclusive with it.
    /// Callers must not await inside `admitted`.
    pub fn admit<T>(&self, credential: &str, admitted: impl FnOnce() -> T) -> Option<T> {
        let state = self.state.lock().ok()?;
        if state
            .refused
            .iter()
            .any(|current| current.as_str() == credential)
        {
            return None;
        }
        Some(admitted())
    }

    fn owns(&self, id: &str) -> Result<bool> {
        Ok(self
            .lock()?
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id))
    }

    fn begin_clear(&self) -> Result<u64> {
        let mut state = self.lock()?;
        state.generation = state.generation.wrapping_add(1);
        if let Some(pending) = state.pending.take() {
            remember_canceled(&mut state.canceled, &pending.id);
            if let Some(cancel) = pending.cancel {
                let _ = cancel.send(());
            }
        }
        Ok(state.adoption)
    }

    fn bump_generation(&self) -> Result<()> {
        let mut state = self.lock()?;
        state.generation = state.generation.wrapping_add(1);
        Ok(())
    }

    fn remember_refused(&self, credential: &str) {
        if let Ok(mut state) = self.lock() {
            remember_refused(&mut state.refused, credential);
        }
    }

    fn clear_refused(&self) {
        if let Ok(mut state) = self.lock() {
            state.refused.clear();
        }
    }
}

pub struct SessionAttempt {
    config: Arc<Config>,
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
        fs,
        sync::{mpsc, Arc},
    };

    struct DeleteGate {
        started: oneshot::Sender<()>,
        release: mpsc::Receiver<()>,
    }

    struct GatedStore {
        path: PathBuf,
        delete: Mutex<Option<DeleteGate>>,
    }

    impl GatedStore {
        fn new(path: PathBuf) -> Arc<Self> {
            Arc::new(Self {
                path,
                delete: Mutex::new(None),
            })
        }

        fn hold_delete(&self) -> (oneshot::Receiver<()>, mpsc::Sender<()>) {
            let (started, started_receiver) = oneshot::channel();
            let (release_sender, release) = mpsc::channel();
            *self.delete.lock().unwrap() = Some(DeleteGate { started, release });
            (started_receiver, release_sender)
        }

        fn before_delete(&self) {
            let gate = self.delete.lock().unwrap().take();
            if let Some(gate) = gate {
                let _ = gate.started.send(());
                let _ = gate.release.recv();
            }
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
            FileSessionCredentialStorage::new(self.0.path.clone()).get(key)
        }

        fn set(
            &self,
            key: &SessionStorageKey,
            credential: &StoredSessionCredential,
        ) -> anyhow::Result<()> {
            FileSessionCredentialStorage::new(self.0.path.clone()).set(key, credential)
        }

        fn delete(&self, key: &SessionStorageKey) -> anyhow::Result<bool> {
            self.0.before_delete();
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

    fn owner(home: &Path, base_url: &str) -> SessionOwner {
        let mut config = Config::resolve(&environment(home, base_url), home).unwrap();
        config.storage = StorageSelection::File(home.join("auth-sessions.json"));
        SessionOwner::new(Ok(config))
    }

    fn gated_owner(home: &Path, base_url: &str) -> (SessionOwner, Arc<GatedStore>) {
        let mut config = Config::resolve(&environment(home, base_url), home).unwrap();
        let store = GatedStore::new(home.join("auth-sessions.json"));
        config.storage = StorageSelection::File(store.path.clone());
        config.factory = Arc::new(GatedFactory(store.clone()));
        (SessionOwner::new(Ok(config)), store)
    }

    fn credential(value: &str) -> SessionCredential {
        SessionCredential::new(
            Zeroizing::new(value.to_owned()),
            Some("2099-01-01T00:00:00Z".to_owned()),
        )
    }

    #[test]
    fn resolves_the_same_profile_and_service_key_as_bl() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".bl")).unwrap();
        fs::write(
            temp.path().join(".bl/skills.yaml"),
            "current_profile: review\n",
        )
        .unwrap();
        fs::write(temp.path().join(".bl/config.yaml"), "org: test\n").unwrap();
        let config = Config::resolve(
            &environment(temp.path(), "https://blockstaging.build"),
            temp.path(),
        )
        .unwrap();
        assert_eq!(config.profile, "review");
        assert_eq!(
            config.service_url.as_str(),
            "https://test.blockstaging.build/api/goose"
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn committed_record_is_read_back_from_the_cli_file_shape() {
        let temp = tempfile::tempdir().unwrap();
        let host = owner(temp.path(), "http://127.0.0.1:9000");
        let cli_record = FileSessionCredentialStorage::new(temp.path().join("auth-sessions.json"));
        let key = host.config().unwrap().key.clone();
        cli_record
            .set(
                &key,
                &StoredSessionCredential {
                    session_credential: "cli-seeded".into(),
                    expires_at: Some("2099-01-01T00:00:00Z".into()),
                },
            )
            .unwrap();
        assert_eq!(
            host.shared_session().await.unwrap().unwrap().credential(),
            "cli-seeded"
        );

        let attempt = host.begin_attempt("enterprise-1").unwrap();
        host.commit_attempt(attempt.id(), credential("session-a"))
            .await
            .unwrap();
        let stored = host.shared_session().await.unwrap().unwrap();
        assert_eq!(stored.credential(), "session-a");
        assert_eq!(stored.expires_at(), Some("2099-01-01T00:00:00Z"));
        let cli_record = cli_record.get(&key).unwrap().unwrap();
        assert_eq!(cli_record.session_credential, "session-a");

        let bytes = fs::read_to_string(temp.path().join("auth-sessions.json")).unwrap();
        assert!(bytes.contains("sessionCredential"));
        assert!(bytes.contains("expiresAt"));
        assert!(!bytes.contains("enterprise-1"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_checks_the_id_before_retiring_the_current_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let host = owner(temp.path(), "http://127.0.0.1:9000");
        let old = host.begin_attempt("old").unwrap();
        let current = host.begin_attempt("current").unwrap();
        host.cancel_attempt(old.id()).unwrap();
        assert!(host
            .commit_attempt(current.id(), credential("current"))
            .await
            .is_ok());
        assert_eq!(
            host.shared_session().await.unwrap().unwrap().credential(),
            "current"
        );
        drop(old);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_does_not_cancel_a_login_that_started_after_clear() {
        let temp = tempfile::tempdir().unwrap();
        let (host, store) = gated_owner(temp.path(), "http://127.0.0.1:9000");
        let first = host.begin_attempt("first").unwrap();
        host.commit_attempt(first.id(), credential("old"))
            .await
            .unwrap();
        host.retire_attempt(first.id());

        let (delete_started, release_delete) = store.hold_delete();
        let clear_host = host.clone();
        let clear = tokio::spawn(async move { clear_host.clear_shared_session().await });
        delete_started.await.unwrap();

        let newer = host.begin_attempt("newer").unwrap();
        let newer_id = newer.id().to_owned();
        let commit_host = host.clone();
        let commit = tokio::spawn(async move {
            commit_host
                .commit_attempt(&newer_id, credential("new"))
                .await
        });
        release_delete.send(()).unwrap();
        clear.await.unwrap().unwrap();
        commit.await.unwrap().unwrap();
        assert_eq!(
            host.shared_session().await.unwrap().unwrap().credential(),
            "new"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_preserves_a_session_adopted_before_its_storage_decision() {
        let temp = tempfile::tempdir().unwrap();
        let host = owner(temp.path(), "http://127.0.0.1:9000");
        let first = host.begin_attempt("first").unwrap();
        host.commit_attempt(first.id(), credential("old"))
            .await
            .unwrap();
        host.retire_attempt(first.id());
        let newer = host.begin_attempt("newer").unwrap();
        host.commit_attempt(newer.id(), credential("new"))
            .await
            .unwrap();
        host.retire_attempt(newer.id());

        let adoption = host.begin_clear().unwrap();
        let config = host.config().unwrap();
        let replacement = host.begin_attempt("replacement").unwrap();
        host.commit_attempt(replacement.id(), credential("replacement"))
            .await
            .unwrap();
        host.clear_shared_session_after_fence(config, adoption)
            .await
            .unwrap();

        assert_eq!(
            host.shared_session().await.unwrap().unwrap().credential(),
            "replacement"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rejection_marks_the_old_record_but_preserves_a_rotated_cli_record() {
        let temp = tempfile::tempdir().unwrap();
        let host = owner(temp.path(), "http://127.0.0.1:9000");
        let first = host.begin_attempt("first").unwrap();
        host.commit_attempt(first.id(), credential("old"))
            .await
            .unwrap();
        host.retire_attempt(first.id());

        let path = temp.path().join("auth-sessions.json");
        let key = SessionStorageKey::from_profile_and_kgoose_base_url(
            "default",
            "http://127.0.0.1:9000",
            "/api/goose",
        );
        let store = FileSessionCredentialStorage::new(path);
        store
            .set(
                &key,
                &StoredSessionCredential {
                    session_credential: "rotated-by-bl".into(),
                    expires_at: Some("2099-01-01T00:00:00Z".into()),
                },
            )
            .unwrap();
        assert_eq!(
            host.reject_shared_session(credential("old")).await.unwrap(),
            SharedSessionRejection::Superseded
        );
        assert_eq!(
            host.shared_session().await.unwrap().unwrap().credential(),
            "rotated-by-bl"
        );
    }
}
