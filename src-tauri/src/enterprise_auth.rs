use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
    time::Duration,
};

use axum::{
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
#[cfg(test)]
use axum::{response::Json, routing::post};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use zeroize::Zeroizing;

use crate::identity::IdentityHost;

const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CALLBACK_CODE: usize = 4096;
const MAX_CALLBACK_ERROR: usize = 1024;
const MAX_SESSION_TOKEN: usize = 4096;
const MAX_SESSION_EXPIRY: usize = 128;
const MAX_SESSION_BODY: usize = 64 * 1024;
const CANCELED_ATTEMPT_LIMIT: usize = 64;
const RELEASE_SERVICE: &str = "dev.local.buzz.foundation.enterprise-session";
const DEBUG_SERVICE: &str = "dev.local.buzz.foundation.enterprise-session.debug";
const ACCOUNT_PREFIX: &str = "session-";
const AUTHORIZATION: &str = "Authorization";
const COMPLETE_HTML: &str = "<!doctype html><title>Buzz authentication complete</title><p>You can close this window and return to Buzz.</p>";

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StoreError {
    Absent,
    Denied,
    Corrupt,
    Unavailable,
    Busy,
}

trait CredentialStore: Send + Sync {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError>;
    fn replace(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> std::result::Result<(), StoreError>;
    fn delete_if_matches(
        &self,
        service: &str,
        account: &str,
        expected: &[u8],
    ) -> std::result::Result<(), StoreError>;
}

#[cfg(not(test))]
struct OsStore;

#[cfg(all(
    not(test),
    any(target_os = "macos", target_os = "windows", target_os = "linux")
))]
impl CredentialStore for OsStore {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError> {
        buzz_credential_store::read(service, account).map_err(store_error)
    }

    fn replace(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> std::result::Result<(), StoreError> {
        buzz_credential_store::replace(service, account, value).map_err(store_error)
    }

    fn delete_if_matches(
        &self,
        service: &str,
        account: &str,
        expected: &[u8],
    ) -> std::result::Result<(), StoreError> {
        buzz_credential_store::delete_if_matches(service, account, expected).map_err(store_error)
    }
}

#[cfg(all(
    not(test),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
impl CredentialStore for OsStore {
    fn read(&self, _: &str, _: &str) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError> {
        Err(StoreError::Unavailable)
    }

    fn replace(&self, _: &str, _: &str, _: &[u8]) -> std::result::Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }

    fn delete_if_matches(&self, _: &str, _: &str, _: &[u8]) -> std::result::Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}

#[cfg(not(test))]
fn store_error(error: buzz_credential_store::Error) -> StoreError {
    match error {
        buzz_credential_store::Error::Absent => StoreError::Absent,
        buzz_credential_store::Error::Denied => StoreError::Denied,
        buzz_credential_store::Error::Corrupt => StoreError::Corrupt,
        buzz_credential_store::Error::Busy => StoreError::Busy,
        buzz_credential_store::Error::Occupied | buzz_credential_store::Error::Unavailable => {
            StoreError::Unavailable
        }
    }
}

#[derive(Clone)]
struct Scope {
    service: &'static str,
    account: String,
    adapter: String,
}

#[derive(Clone)]
struct StoredSession {
    token: Zeroizing<String>,
    expires_at: String,
}

/// A saved session as a relay badge request read it, so a refusal of it can
/// be matched against whatever session is current when the refusal arrives.
pub(crate) struct SavedSession {
    scope: Scope,
    persisted: PersistedSession,
}

impl SavedSession {
    pub(crate) fn adapter(&self) -> &str {
        &self.scope.adapter
    }

    pub(crate) fn token(&self) -> &str {
        &self.persisted.session.token
    }
}

/// What a refusal of a saved session did.
#[derive(Debug, PartialEq)]
pub(crate) enum Rejection {
    /// The refused session was current and is now gone; sign-in is required.
    Removed,
    /// The refused session was current and is no longer used, but secure
    /// storage could not remove it; sign-in is required, and `cleanup`
    /// reports the failure.
    Retained,
    /// The refused session was no longer current (already removed, or
    /// replaced by a newer login), so nothing was changed.
    Superseded,
}

struct PersistedSession {
    raw: Zeroizing<Vec<u8>>,
    session: StoredSession,
}

// Zeroizing covers buffers and fields owned here; HTTP, serde, and OS storage
// implementations may retain internal copies outside this module's boundary.
#[derive(Serialize)]
struct StoredRecordRef<'a> {
    version: u8,
    session_token: &'a str,
    expires_at: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRecord {
    version: u8,
    session_token: Zeroizing<String>,
    expires_at: String,
}

#[derive(Deserialize)]
struct ExchangeResponse {
    session_token: Zeroizing<String>,
    expires_at: String,
}

#[derive(Serialize)]
struct ExchangeRequest<'a> {
    code: &'a str,
    handoff_secret: &'a str,
}

#[derive(Debug, Deserialize)]
struct SessionResponse {
    expires_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnterpriseAuthInfo {
    expires_at: String,
}

#[derive(Default)]
struct LoginState {
    active: Option<ActiveLogin>,
    canceled: VecDeque<String>,
    generation: u64,
}

struct ActiveLogin {
    id: String,
    cancel: oneshot::Sender<()>,
}

/// Sessions the adapter refused, by token digest, and the outcome of removing
/// them from secure storage.
///
/// A refusal is one short step under the login state lock: the digest joins
/// `tokens`, the login generation advances and the in-memory session is
/// cleared, so a session check validating at the same moment cannot adopt the
/// token again. Every reader skips a refused token, and every use of a token
/// is admitted under this owner's lock (`admit`): a badge request or session
/// check about to send it, and a badge being reused, cached or returned. Once
/// a refusal returns, no use of the token is admitted; one admitted just
/// before it may still go out and finish, and a request admitted is not
/// necessarily on the wire yet.
///
/// The refusal is also recorded on disk, one empty file per digest under the
/// keychain service's directory, before secure storage is asked to remove the
/// session; the file is removed only once removal succeeds or a new login
/// replaces that session. Each update creates or removes one file, so other
/// Buzz processes and scopes sharing the directory never lose each other's
/// records. If the records cannot be resolved or read at startup, stored
/// sessions are not used (`distrusts`) until a new login in that scope.
///
/// Not covered: if Buzz quits before the record is written (removal has not
/// started then), or if writing the record and removing the session from
/// secure storage both fail and Buzz then restarts, the stored session reads
/// as saved again and can be sent to the adapter.
#[derive(Default)]
struct Refusals {
    tokens: HashSet<[u8; 32]>,
    /// Refusals secure storage failed to remove.
    kept: HashSet<[u8; 32]>,
    /// Writing a refusal that still mattered to disk failed.
    unrecorded: bool,
    /// Removing a refusal record that no longer mattered failed.
    unpruned: bool,
    /// The records could not be read at startup: stored sessions are not
    /// used, except in scopes a new login has replaced since.
    distrust_stored: bool,
    trusted: HashSet<(&'static str, String)>,
    records: RefusalRecords,
}

#[derive(Clone, Default)]
enum RefusalRecords {
    /// Not configured (tests); nothing is persisted.
    #[default]
    Untracked,
    At(PathBuf),
    /// The app data directory could not be resolved.
    Unavailable,
}

impl RefusalRecords {
    /// Writes the record of `digest`'s refusal in `service`.
    fn add(&self, service: &str, digest: [u8; 32]) -> std::io::Result<()> {
        let Some(path) = self.path(service, digest)? else {
            return Ok(());
        };
        path.parent().map_or(Ok(()), std::fs::create_dir_all)?;
        std::fs::File::create(path).map(drop)
    }

    fn remove(&self, service: &str, digest: [u8; 32]) -> std::io::Result<()> {
        // Nothing is written where records are unavailable.
        let Ok(Some(path)) = self.path(service, digest) else {
            return Ok(());
        };
        std::fs::remove_file(path).or_else(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Ok(()),
            _ => Err(error),
        })
    }

    fn path(&self, service: &str, digest: [u8; 32]) -> std::io::Result<Option<PathBuf>> {
        match self {
            Self::Untracked => Ok(None),
            Self::Unavailable => Err(std::io::ErrorKind::NotFound.into()),
            // Hex, since the file system may ignore case.
            Self::At(root) => Ok(Some(
                root.join(service).join(
                    digest
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>(),
                ),
            )),
        }
    }

    /// Every recorded digest, across services. Unrelated file names are
    /// ignored; an unreadable directory is an error.
    fn load(root: &std::path::Path) -> std::io::Result<Vec<[u8; 32]>> {
        let services = match std::fs::read_dir(root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            services => services?,
        };
        let mut digests = Vec::new();
        for service in services {
            let service = service?;
            if !service.file_type()?.is_dir() {
                continue;
            }
            for record in std::fs::read_dir(service.path())? {
                let name = record?.file_name();
                if let Some(digest) = name.to_str().and_then(decode_digest) {
                    digests.push(digest);
                }
            }
        }
        Ok(digests)
    }
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

impl Refusals {
    fn distrusts(&self, scope: &Scope) -> bool {
        self.distrust_stored
            && !self
                .trusted
                .contains(&(scope.service, scope.account.clone()))
    }

    fn cleanup(&self) -> Option<EnterpriseCleanup> {
        let cleanup = EnterpriseCleanup {
            retained: !self.kept.is_empty(),
            unrecorded: self.unrecorded,
            unpruned: self.unpruned,
        };
        (cleanup.retained || cleanup.unrecorded || cleanup.unpruned).then_some(cleanup)
    }
}

/// A refused session's removal that did not fully succeed, without storage
/// details: `retained` when secure storage still holds it, `unrecorded` when
/// the refusal could not be saved for after a restart, `unpruned` when an
/// outdated refusal record could not be removed.
#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct EnterpriseCleanup {
    retained: bool,
    unrecorded: bool,
    unpruned: bool,
}

fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

#[derive(Clone)]
pub(crate) struct EnterpriseAuthHost {
    session: Arc<Mutex<Option<(Scope, StoredSession)>>>,
    refusals: Arc<Mutex<Refusals>>,
    login: Arc<Mutex<LoginState>>,
    commit: Arc<tokio::sync::Mutex<()>>,
    store: Arc<dyn CredentialStore>,
}

#[cfg(not(test))]
impl Default for EnterpriseAuthHost {
    fn default() -> Self {
        Self::with_store(Arc::new(OsStore))
    }
}

#[cfg(test)]
impl Default for EnterpriseAuthHost {
    fn default() -> Self {
        Self::with_store(Arc::new(FixtureStore::default()))
    }
}

impl EnterpriseAuthHost {
    fn with_store(store: Arc<dyn CredentialStore>) -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            refusals: Arc::default(),
            login: Arc::new(Mutex::new(LoginState::default())),
            commit: Arc::new(tokio::sync::Mutex::new(())),
            store,
        }
    }

    pub(crate) async fn get(&self, identity: &IdentityHost) -> Result<Option<EnterpriseAuthInfo>> {
        let scope = scope_for_identity(identity).await?;
        self.get_scope(scope).await
    }

    async fn get_scope(&self, scope: Scope) -> Result<Option<EnterpriseAuthInfo>> {
        let http_client = client()?;
        self.get_scope_with_client(scope, http_client).await
    }

    async fn get_scope_with_client(
        &self,
        scope: Scope,
        http_client: &reqwest::Client,
    ) -> Result<Option<EnterpriseAuthInfo>> {
        let generation = self.current_generation()?;
        if let Some(session) = self.cached(&scope) {
            let raw = encode_session(&session)?;
            return match check_session(
                http_client,
                &scope.adapter,
                &session,
                Some(&session.expires_at),
                &|| self.admit(&session.token, || ()).is_some(),
            )
            .await
            {
                SessionCheck::Refused => Ok(self.cached_info(&scope)),
                SessionCheck::Valid(info) => {
                    let _commit = self.commit.lock().await;
                    let state = self
                        .login
                        .lock()
                        .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
                    if state.generation != generation {
                        return Ok(self.cached_info(&scope));
                    }
                    if let Some(current) = self.cached(&scope) {
                        if current.token.as_str() != session.token.as_str() {
                            return Ok(Some(EnterpriseAuthInfo {
                                expires_at: current.expires_at,
                            }));
                        }
                    }
                    Ok(Some(info))
                }
                SessionCheck::Invalid | SessionCheck::Inconsistent => {
                    self.invalidate_session(&scope, raw, &session.token, generation)
                        .await
                }
                SessionCheck::Transient(error) => Err(error),
            };
        }
        let Some(persisted) = self.read(&scope).await? else {
            let _commit = self.commit.lock().await;
            let state = self
                .login
                .lock()
                .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
            if state.generation != generation {
                return Ok(self.cached_info(&scope));
            }
            self.clear_memory(&scope, None);
            return Ok(None);
        };
        if self.refusals().distrusts(&scope) {
            return Ok(None);
        }
        if self.is_refused(&persisted.session.token) {
            self.remove_retained(&scope, persisted).await;
            return Ok(self.cached_info(&scope));
        }
        match check_session(
            http_client,
            &scope.adapter,
            &persisted.session,
            Some(&persisted.session.expires_at),
            &|| self.admit(&persisted.session.token, || ()).is_some(),
        )
        .await
        {
            SessionCheck::Refused => Ok(self.cached_info(&scope)),
            SessionCheck::Valid(info) => {
                let _commit = self.commit.lock().await;
                let state = self
                    .login
                    .lock()
                    .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
                if state.generation != generation {
                    return Ok(self.cached_info(&scope));
                }
                if let Some(current) = self.cached(&scope) {
                    if current.token.as_str() != persisted.session.token.as_str() {
                        return Ok(Some(EnterpriseAuthInfo {
                            expires_at: current.expires_at,
                        }));
                    }
                } else if self.is_refused(&persisted.session.token) {
                    // A refusal takes this lock too, so it lands wholly
                    // before or after this check.
                    return Ok(None);
                } else {
                    self.remember(scope, persisted.session);
                }
                Ok(Some(info))
            }
            SessionCheck::Invalid | SessionCheck::Inconsistent => {
                self.invalidate_session(&scope, persisted.raw, &persisted.session.token, generation)
                    .await
            }
            SessionCheck::Transient(error) => Err(error),
        }
    }

    /// The saved session for this identity, without contacting the adapter.
    /// Relay badge issuance validates the session itself and hands a refusal
    /// back to `reject`.
    pub(crate) async fn saved_session(
        &self,
        identity: &IdentityHost,
    ) -> Result<Option<SavedSession>> {
        self.saved_scope(scope_for_identity(identity).await?).await
    }

    async fn saved_scope(&self, scope: Scope) -> Result<Option<SavedSession>> {
        let persisted = match self.cached(&scope) {
            Some(session) => Some(PersistedSession {
                raw: encode_session(&session)?,
                session,
            }),
            None if self.refusals().distrusts(&scope) => None,
            None => self.read(&scope).await?,
        };
        Ok(persisted
            .filter(|persisted| !self.is_refused(&persisted.session.token))
            .map(|persisted| SavedSession { scope, persisted }))
    }

    /// Whether a newer login has already been adopted in place of `saved`;
    /// answers at once, without waiting on secure storage.
    pub(crate) fn superseded(&self, saved: &SavedSession) -> bool {
        self.cached(&saved.scope)
            .is_some_and(|current| current.token.as_str() != saved.token())
    }

    /// Whether `saved` was refused since it was read.
    pub(crate) fn refused(&self, saved: &SavedSession) -> bool {
        self.is_refused(saved.token())
    }

    /// Runs `admitted`, a use of `token` that must not start once it is
    /// refused, unless it already was; one step with `refuse`. `admitted`
    /// must not wait: it may create a request but not await it.
    pub(crate) fn admit<T>(&self, token: &str, admitted: impl FnOnce() -> T) -> Option<T> {
        let refusals = self.refusals();
        (!refusals.tokens.contains(&token_digest(token))).then(admitted)
    }

    /// Forgets `saved` after the adapter said it is gone, but only while it
    /// is still the current session. The token itself is compared, not the
    /// login generation, which starting or canceling a login also advances.
    /// The token is refused and recorded on disk before secure storage is
    /// touched, so later reads and uses skip it while removal waits or after
    /// removal fails (see `Refusals`); a newer adopted token is a different
    /// token and stays in use.
    pub(crate) async fn reject(&self, saved: SavedSession) -> Result<Rejection> {
        let SavedSession { scope, persisted } = saved;
        let token = persisted.session.token;
        let digest = token_digest(&token);
        let cached = self.is_cached(&scope, &token);
        let records = self.refuse(&scope, &token, digest)?;
        if records.add(scope.service, digest).is_err() {
            self.refusals().unrecorded = true;
        }
        // Commits and clears hold this owner, so the session cannot change
        // between the comparison and the deletion.
        let _commit = self.commit.lock().await;
        let removal = match self.read(&scope).await {
            Ok(Some(stored)) if stored.session.token.as_str() == token.as_str() => {
                self.delete_if_matches(&scope, stored.raw).await
            }
            Ok(_) => {
                // Secure storage no longer holds the refused session.
                self.settle(&scope, digest, true);
                // Held only in memory, which is now cleared.
                return Ok(if cached && self.cached(&scope).is_none() {
                    Rejection::Removed
                } else {
                    // Already removed, or replaced by a newer login.
                    Rejection::Superseded
                });
            }
            Err(error) => Err(error),
        };
        self.settle(&scope, digest, removal.is_ok());
        Ok(match removal {
            Ok(()) => Rejection::Removed,
            Err(_) => Rejection::Retained,
        })
    }

    /// Refuses `token` in memory as one step under the login state lock,
    /// which adoption also holds across its generation check and cache
    /// update. Returns where to record it; the caller writes the record
    /// outside the lock.
    fn refuse(
        &self,
        scope: &Scope,
        token: &Zeroizing<String>,
        digest: [u8; 32],
    ) -> Result<RefusalRecords> {
        let mut state = self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
        let records = {
            let mut refusals = self.refusals();
            refusals.tokens.insert(digest);
            refusals.records.clone()
        };
        Self::bump_generation(&mut state);
        self.clear_memory(scope, Some(token));
        Ok(records)
    }

    /// Records the outcome of removing a refused session from secure storage;
    /// a removed session's record is no longer needed.
    fn settle(&self, scope: &Scope, digest: [u8; 32], removed: bool) {
        let records = {
            let mut refusals = self.refusals();
            if !removed {
                refusals.kept.insert(digest);
                return;
            }
            refusals.kept.remove(&digest);
            // Nothing still stored depends on an unwritten refusal.
            if refusals.kept.is_empty() {
                refusals.unrecorded = false;
            }
            refusals.records.clone()
        };
        if records.remove(scope.service, digest).is_err() {
            self.refusals().unpruned = true;
        }
    }

    /// The refusal records, kept across restarts under `root`. When they
    /// cannot be read, stored sessions are not used until a new login.
    pub(crate) fn keep_refusals_at(&self, root: PathBuf) {
        let loaded = RefusalRecords::load(&root);
        let mut refusals = self.refusals();
        match loaded {
            Ok(digests) => refusals.tokens.extend(digests),
            Err(_) => refusals.distrust_stored = true,
        }
        refusals.records = RefusalRecords::At(root);
    }

    /// The app data directory is unavailable: refusals cannot be kept across
    /// restarts, so stored sessions are not used until a new login.
    pub(crate) fn refusals_unavailable(&self) {
        let mut refusals = self.refusals();
        refusals.distrust_stored = true;
        refusals.records = RefusalRecords::Unavailable;
    }

    /// How removing refused sessions went, once removal in progress settles.
    pub(crate) async fn cleanup(&self) -> Option<EnterpriseCleanup> {
        let _commit = self.commit.lock().await;
        self.refusals().cleanup()
    }

    fn refusals(&self) -> MutexGuard<'_, Refusals> {
        self.refusals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn is_refused(&self, token: &str) -> bool {
        self.refusals().tokens.contains(&token_digest(token))
    }

    /// Retries removing a refused session that secure storage kept.
    async fn remove_retained(&self, scope: &Scope, persisted: PersistedSession) {
        let _commit = self.commit.lock().await;
        let removed = self.delete_if_matches(scope, persisted.raw).await.is_ok();
        self.settle(scope, token_digest(&persisted.session.token), removed);
    }

    fn cached_info(&self, scope: &Scope) -> Option<EnterpriseAuthInfo> {
        self.cached(scope).map(|session| EnterpriseAuthInfo {
            expires_at: session.expires_at,
        })
    }

    async fn invalidate_session(
        &self,
        scope: &Scope,
        raw: Zeroizing<Vec<u8>>,
        token: &Zeroizing<String>,
        generation: u64,
    ) -> Result<Option<EnterpriseAuthInfo>> {
        let _commit = self.commit.lock().await;
        let invalidation_generation = {
            let mut state = self
                .login
                .lock()
                .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
            if state.generation != generation {
                None
            } else {
                Some(Self::bump_generation(&mut state))
            }
        };
        let Some(_) = invalidation_generation else {
            return Ok(self.cached_info(scope));
        };
        let deletion = self.delete_if_matches(scope, raw).await;
        if deletion.is_ok() {
            self.clear_memory(scope, Some(token));
        }
        match (deletion, self.fence_generation()) {
            (Err(error), _) => Err(error),
            (Ok(()), Ok(())) => Ok(None),
            (Ok(()), Err(error)) => Err(error),
        }
    }

    pub(crate) async fn start<R: Runtime>(
        &self,
        app: AppHandle<R>,
        identity: &IdentityHost,
        attempt_id: Option<String>,
    ) -> Result<EnterpriseAuthInfo> {
        let scope = scope_for_identity(identity).await?;
        let id = attempt_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        validate_attempt_id(&id)?;
        let (cancel, mut canceled) = oneshot::channel();
        if !self.begin(id.clone(), cancel)? {
            return Err("Enterprise authentication was canceled".into());
        }

        let result = self.run_login(&app, &scope, &id, &mut canceled).await;
        self.finish(&id);
        result
    }

    pub(crate) async fn cancel(&self, id: &str) -> Result<()> {
        validate_attempt_id(id)?;
        let mut state = self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
        if state.active.as_ref().is_some_and(|active| active.id == id) {
            let active = state.active.take().expect("active login checked above");
            remember_canceled(&mut state.canceled, id);
            Self::bump_generation(&mut state);
            drop(state);
            let _ = active.cancel.send(());
        } else {
            remember_canceled(&mut state.canceled, id);
        }
        Ok(())
    }

    pub(crate) async fn clear(&self, identity: &IdentityHost) -> Result<()> {
        let scope = scope_for_identity(identity).await?;
        self.clear_scope(scope).await
    }

    async fn clear_scope(&self, scope: Scope) -> Result<()> {
        // Cancel and fence as one state transition before waiting for storage.
        let generation = {
            let mut state = self
                .login
                .lock()
                .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
            Self::bump_generation(&mut state);
            if let Some(active) = state.active.take() {
                remember_canceled(&mut state.canceled, &active.id);
                let _ = active.cancel.send(());
            }
            state.generation
        };
        let _commit = self.commit.lock().await;
        let clear_generation = {
            let mut state = self
                .login
                .lock()
                .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
            if state.generation != generation {
                None
            } else {
                let clear_generation = Self::bump_generation(&mut state);
                self.clear_memory(&scope, None);
                Some(clear_generation)
            }
        };
        let Some(_) = clear_generation else {
            return Ok(());
        };
        let storage = match self.read(&scope).await {
            Ok(Some(persisted)) => {
                let digest = token_digest(&persisted.session.token);
                let removed = self.delete_if_matches(&scope, persisted.raw).await;
                if self.refusals().tokens.contains(&digest) {
                    self.settle(&scope, digest, removed.is_ok());
                }
                removed
            }
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        match (storage, self.fence_generation()) {
            (Err(error), _) => Err(error),
            (Ok(()), Ok(())) => Ok(()),
            (Ok(()), Err(error)) => Err(error),
        }
    }

    async fn run_login<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        scope: &Scope,
        id: &str,
        canceled: &mut oneshot::Receiver<()>,
    ) -> Result<EnterpriseAuthInfo> {
        let handoff_secret = random_secret()?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| "Could not start the enterprise login callback".to_owned())?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not start the enterprise login callback")?
            .port();
        let nonce = random_secret()?;
        let callback_url = format!("http://127.0.0.1:{port}/callback/{}", nonce.as_str());
        let (sender, callback) = oneshot::channel();
        let state = Arc::new(CallbackState {
            nonce,
            sender: Mutex::new(Some(sender)),
        });
        let router = Router::new()
            .route("/callback/{nonce}", get(login_callback))
            .with_state(state);
        let login_url = login_url(&scope.adapter, &callback_url, &handoff_secret)?;
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });

        if app
            .opener()
            .open_url(login_url.as_str(), None::<&str>)
            .is_err()
        {
            server.abort();
            return Err("Could not open the enterprise sign-in browser".to_owned());
        }

        let callback_result = wait_for_callback(callback, canceled).await;
        server.abort();
        let code = callback_result?;

        let (session, info) = tokio::select! {
            result = exchange(&scope.adapter, &code, &handoff_secret) => result?,
            _ = &mut *canceled => return Err("Enterprise authentication was canceled".into()),
        };
        self.commit_session(scope, id, session, info).await
    }

    fn begin(&self, id: String, cancel: oneshot::Sender<()>) -> Result<bool> {
        let mut state = self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
        if state.canceled.iter().any(|canceled| canceled == &id) {
            return Ok(false);
        }
        if let Some(previous) = state.active.take() {
            remember_canceled(&mut state.canceled, &previous.id);
            let _ = previous.cancel.send(());
        }
        Self::bump_generation(&mut state);
        state.active = Some(ActiveLogin { id, cancel });
        Ok(true)
    }

    fn current_generation(&self) -> Result<u64> {
        Ok(self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?
            .generation)
    }

    fn bump_generation(state: &mut LoginState) -> u64 {
        state.generation = state.generation.wrapping_add(1);
        state.generation
    }

    fn fence_generation(&self) -> Result<()> {
        // The commit owner remains held by both invalidation callers while this
        // final fence closes the window around their storage operation. A newer
        // login may have begun without this owner, but its active id is checked
        // separately when it commits and must not disable this reader fence.
        let mut state = self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
        Self::bump_generation(&mut state);
        Ok(())
    }

    fn finish(&self, id: &str) {
        if let Ok(mut state) = self.login.lock() {
            if state.active.as_ref().is_some_and(|active| active.id == id) {
                state.active = None;
            }
        }
    }

    fn is_active(&self, id: &str) -> Result<bool> {
        Ok(self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?
            .active
            .as_ref()
            .is_some_and(|active| active.id == id))
    }

    async fn commit_session(
        &self,
        scope: &Scope,
        id: &str,
        session: StoredSession,
        info: EnterpriseAuthInfo,
    ) -> Result<EnterpriseAuthInfo> {
        let raw = encode_session(&session)?;
        let _commit = self.commit.lock().await;
        if !self.is_active(id)? {
            self.delete_if_matches(scope, raw).await?;
            return Err("Enterprise authentication was canceled".into());
        }
        // The session this login replaces, whose refusal record it prunes.
        let replaced = match self.read(scope).await {
            Ok(Some(previous)) => Some(token_digest(&previous.session.token)),
            _ => None,
        };
        self.replace(scope, raw.clone()).await?;
        let adopted = {
            // This is the adoption linearization point. begin/cancel use the
            // same owner lock, so neither can interleave the final active
            // check, generation fence, and cache update.
            let mut state = self
                .login
                .lock()
                .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
            if state.active.as_ref().is_some_and(|active| active.id == id) {
                Self::bump_generation(&mut state);
                self.remember(scope.clone(), session);
                true
            } else {
                false
            }
        };
        if !adopted {
            self.delete_if_matches(scope, raw).await?;
            return Err("Enterprise authentication was canceled".into());
        }
        self.adopted(scope, replaced);
        Ok(info)
    }

    /// A new login replaced the stored session in `scope`: that scope's
    /// stored session is trusted again, and the refusal record and outcome of
    /// the session it replaced, if any, are pruned. Other scopes keep theirs.
    fn adopted(&self, scope: &Scope, replaced: Option<[u8; 32]>) {
        let records = {
            let mut refusals = self.refusals();
            refusals
                .trusted
                .insert((scope.service, scope.account.clone()));
            refusals.unpruned = false;
            if let Some(replaced) = replaced {
                refusals.kept.remove(&replaced);
            }
            if refusals.kept.is_empty() {
                refusals.unrecorded = false;
            }
            refusals.records.clone()
        };
        if let Some(replaced) = replaced {
            if records.remove(scope.service, replaced).is_err() {
                self.refusals().unpruned = true;
            }
        }
    }

    fn remember(&self, scope: Scope, session: StoredSession) {
        if let Ok(mut stored) = self.session.lock() {
            *stored = Some((scope, session));
        }
    }

    /// The in-memory session, unless it was refused.
    fn cached(&self, scope: &Scope) -> Option<StoredSession> {
        self.cached_raw(scope)
            .filter(|session| !self.is_refused(&session.token))
    }

    fn is_cached(&self, scope: &Scope, token: &str) -> bool {
        self.cached_raw(scope)
            .is_some_and(|session| session.token.as_str() == token)
    }

    fn cached_raw(&self, scope: &Scope) -> Option<StoredSession> {
        self.session.lock().ok().and_then(|stored| {
            stored
                .as_ref()
                .filter(|(current, _)| {
                    current.service == scope.service
                        && current.account == scope.account
                        && current.adapter == scope.adapter
                })
                .map(|(_, session)| session.clone())
        })
    }

    fn clear_memory(&self, scope: &Scope, token: Option<&Zeroizing<String>>) {
        if let Ok(mut stored) = self.session.lock() {
            if stored.as_ref().is_some_and(|(current, session)| {
                current.service == scope.service
                    && current.account == scope.account
                    && current.adapter == scope.adapter
                    && token.map_or(true, |token| session.token.as_str() == token.as_str())
            }) {
                *stored = None;
            }
        }
    }

    async fn read(&self, scope: &Scope) -> Result<Option<PersistedSession>> {
        let store = self.store.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || read_sync(store.as_ref(), &scope))
            .await
            .map_err(|_| "Enterprise secure storage could not be accessed".to_owned())?
    }

    async fn replace(&self, scope: &Scope, raw: Zeroizing<Vec<u8>>) -> Result<()> {
        let store = self.store.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || {
            store
                .replace(scope.service, &scope.account, &raw)
                .map_err(storage_message)
        })
        .await
        .map_err(|_| "Enterprise secure storage could not be accessed".to_owned())?
    }

    async fn delete_if_matches(&self, scope: &Scope, raw: Zeroizing<Vec<u8>>) -> Result<()> {
        let store = self.store.clone();
        let scope = scope.clone();
        tokio::task::spawn_blocking(move || {
            store
                .delete_if_matches(scope.service, &scope.account, &raw)
                .map_err(storage_message)
        })
        .await
        .map_err(|_| "Enterprise secure storage could not be accessed".to_owned())?
    }
}

#[tauri::command]
pub(crate) async fn get_enterprise_auth(
    host: State<'_, EnterpriseAuthHost>,
    identity: State<'_, IdentityHost>,
) -> Result<Option<EnterpriseAuthInfo>> {
    host.get(identity.inner()).await
}

#[tauri::command]
pub(crate) async fn start_enterprise_auth_login<R: Runtime>(
    app: AppHandle<R>,
    host: State<'_, EnterpriseAuthHost>,
    identity: State<'_, IdentityHost>,
    attempt_id: Option<String>,
) -> Result<EnterpriseAuthInfo> {
    host.start(app, identity.inner(), attempt_id).await
}

#[tauri::command]
pub(crate) async fn cancel_enterprise_auth_login(
    host: State<'_, EnterpriseAuthHost>,
    attempt_id: String,
) -> Result<()> {
    host.cancel(&attempt_id).await
}

#[tauri::command]
pub(crate) async fn clear_enterprise_auth(
    host: State<'_, EnterpriseAuthHost>,
    identity: State<'_, IdentityHost>,
) -> Result<()> {
    host.clear(identity.inner()).await
}

/// Waits for removal of a refused session in progress, then reports what
/// did not succeed, if anything.
#[tauri::command]
pub(crate) async fn enterprise_auth_cleanup(
    host: State<'_, EnterpriseAuthHost>,
) -> Result<Option<EnterpriseCleanup>> {
    Ok(host.cleanup().await)
}

struct CallbackState {
    nonce: Zeroizing<String>,
    sender: Mutex<Option<oneshot::Sender<Result<String>>>>,
}

async fn wait_for_callback(
    callback: oneshot::Receiver<Result<String>>,
    canceled: &mut oneshot::Receiver<()>,
) -> Result<String> {
    tokio::select! {
        result = callback => match result {
            Ok(result) => result,
            Err(_) => Err("Enterprise login callback was interrupted".to_owned()),
        },
        _ = &mut *canceled => Err("Enterprise authentication was canceled".to_owned()),
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => Err("Enterprise authentication timed out".to_owned()),
    }
}

async fn login_callback(
    Path(nonce): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    AxumState(state): AxumState<Arc<CallbackState>>,
) -> Response {
    if nonce != state.nonce.as_str() {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    let result = match query.get("code").filter(|code| {
        !code.is_empty()
            && code.len() <= MAX_CALLBACK_CODE
            && !code.chars().any(char::is_whitespace)
    }) {
        Some(code) => Ok(code.clone()),
        None => Err(query
            .get("error_description")
            .or_else(|| query.get("error"))
            .and_then(|error| sanitize_callback_error(error))
            .unwrap_or_else(|| "Enterprise authentication was denied".to_owned())),
    };
    if let Ok(mut sender) = state.sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
    Html(COMPLETE_HTML).into_response()
}

fn sanitize_callback_error(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= MAX_CALLBACK_ERROR && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn service_name() -> &'static str {
    if cfg!(debug_assertions) {
        DEBUG_SERVICE
    } else {
        RELEASE_SERVICE
    }
}

async fn scope_for_identity(identity: &IdentityHost) -> Result<Scope> {
    scope_for_identity_viewer(&identity.viewer().await?)
}

fn scope_for_identity_viewer(viewer: &str) -> Result<Scope> {
    scope_for_adapter(&adapter_base_url()?, viewer)
}

fn scope_for_adapter(adapter: &str, viewer: &str) -> Result<Scope> {
    if viewer.len() != 64 || !viewer.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Enterprise authentication requires a restored human identity".into());
    }
    let mut digest = Sha256::new();
    digest.update(adapter.as_bytes());
    digest.update([0]);
    digest.update(viewer.as_bytes());
    Ok(Scope {
        service: service_name(),
        account: format!("{ACCOUNT_PREFIX}{:x}", digest.finalize()),
        adapter: adapter.to_owned(),
    })
}

fn adapter_base_url() -> Result<String> {
    let raw = option_env!("BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL")
        .ok_or("This Buzz build has no enterprise authentication adapter")?;
    crate::enterprise_adapter_url::validate_enterprise_adapter_url(raw)
        .map_err(|_| "Enterprise authentication adapter is invalid".into())
}

fn api_url(base: &str, path: &str) -> Result<Url> {
    Url::parse(&format!("{}{}", base.trim_end_matches('/'), path))
        .map_err(|_| "Enterprise authentication adapter is invalid".into())
}

fn login_url(base: &str, callback: &str, handoff_secret: &str) -> Result<Url> {
    let mut url = api_url(base, "/v1/login/start")?;
    url.query_pairs_mut()
        .append_pair("return_to", callback)
        .append_pair("handoff_challenge", &handoff_challenge(handoff_secret))
        .append_pair("handoff_challenge_method", "S256");
    Ok(url)
}

fn random_secret() -> Result<Zeroizing<String>> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create enterprise login verifier")?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes)))
}

fn handoff_challenge(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

fn validate_attempt_id(id: &str) -> Result<()> {
    if (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err("Enterprise authentication attempt is invalid".into())
    }
}

fn remember_canceled(canceled: &mut VecDeque<String>, id: &str) {
    if canceled.iter().any(|current| current == id) {
        return;
    }
    if canceled.len() >= CANCELED_ATTEMPT_LIMIT {
        canceled.pop_front();
    }
    canceled.push_back(id.to_owned());
}

fn encode_session(session: &StoredSession) -> Result<Zeroizing<Vec<u8>>> {
    let value = serde_json::to_vec(&StoredRecordRef {
        version: 1,
        session_token: session.token.as_str(),
        expires_at: &session.expires_at,
    })
    .map_err(|_| "Enterprise authentication session could not be saved".to_owned())?;
    Ok(Zeroizing::new(value))
}

fn decode_session(raw: Zeroizing<Vec<u8>>) -> Result<StoredSession> {
    let record: StoredRecord = serde_json::from_slice(&raw)
        .map_err(|_| "Saved enterprise authentication is corrupt".to_owned())?;
    if record.version != 1
        || record.session_token.is_empty()
        || record.session_token.len() > MAX_SESSION_TOKEN
        || record.session_token.chars().any(char::is_whitespace)
        || record.expires_at.is_empty()
        || record.expires_at.len() > MAX_SESSION_EXPIRY
        || !expiry_is_well_formed(&record.expires_at)
    {
        return Err("Saved enterprise authentication is corrupt".into());
    }
    Ok(StoredSession {
        token: record.session_token,
        expires_at: record.expires_at,
    })
}

fn read_sync(store: &dyn CredentialStore, scope: &Scope) -> Result<Option<PersistedSession>> {
    match store.read(scope.service, &scope.account) {
        Ok(raw) => {
            let session = decode_session(raw.clone())?;
            Ok(Some(PersistedSession { raw, session }))
        }
        Err(StoreError::Absent) => Ok(None),
        Err(error) => Err(storage_message(error)),
    }
}

fn storage_message(error: StoreError) -> String {
    match error {
        StoreError::Absent => "Enterprise authentication is not saved".into(),
        StoreError::Denied => {
            "Enterprise secure storage access was denied; unlock it and retry".into()
        }
        StoreError::Corrupt => "Saved enterprise authentication is corrupt".into(),
        StoreError::Busy => {
            "Another Buzz process is using enterprise secure storage; retry shortly".into()
        }
        StoreError::Unavailable => {
            "Enterprise secure storage is unavailable; retry without changing credentials".into()
        }
    }
}

enum SessionCheck {
    Valid(EnterpriseAuthInfo),
    /// The session was refused before the check could send it.
    Refused,
    Invalid,
    Inconsistent,
    Transient(String),
}

enum ReadJsonError {
    Transport,
    TooLarge,
    Invalid,
}

impl From<ReadJsonError> for String {
    fn from(error: ReadJsonError) -> Self {
        match error {
            ReadJsonError::Transport => "Enterprise authentication response failed".into(),
            ReadJsonError::TooLarge => "Enterprise authentication response was too large".into(),
            ReadJsonError::Invalid => "Enterprise authentication response was invalid".into(),
        }
    }
}

async fn exchange(
    base: &str,
    code: &str,
    handoff_secret: &str,
) -> Result<(StoredSession, EnterpriseAuthInfo)> {
    let http_client = client()?;
    let response = http_client
        .post(api_url(base, "/v1/login/exchange")?)
        .json(&ExchangeRequest {
            code,
            handoff_secret,
        })
        .send()
        .await
        .map_err(|_| "Enterprise authentication exchange failed".to_owned())?;
    if !response.status().is_success() {
        return Err("Enterprise authentication exchange failed".into());
    }
    let response: ExchangeResponse = read_json(response).await?;
    let session = session_from_exchange(response)?;
    // A session the adapter just issued has not been refused.
    let info = match check_session(
        http_client,
        base,
        &session,
        Some(&session.expires_at),
        &|| true,
    )
    .await
    {
        SessionCheck::Valid(info) => info,
        SessionCheck::Refused | SessionCheck::Invalid | SessionCheck::Inconsistent => {
            return Err("Enterprise authentication session was rejected".into())
        }
        SessionCheck::Transient(error) => return Err(error),
    };
    Ok((session, info))
}

fn session_from_exchange(response: ExchangeResponse) -> Result<StoredSession> {
    if response.session_token.is_empty()
        || response.session_token.len() > MAX_SESSION_TOKEN
        || response.session_token.chars().any(char::is_whitespace)
        || response.expires_at.is_empty()
        || response.expires_at.len() > MAX_SESSION_EXPIRY
        || !expiry_is_current(&response.expires_at)
    {
        return Err("Enterprise authentication exchange was invalid".into());
    }
    Ok(StoredSession {
        token: response.session_token,
        expires_at: response.expires_at,
    })
}

async fn check_session(
    http_client: &reqwest::Client,
    base: &str,
    session: &StoredSession,
    expected_expiry: Option<&str>,
    admit: &(dyn Fn() -> bool + Sync),
) -> SessionCheck {
    if !expiry_is_well_formed(&session.expires_at) {
        return SessionCheck::Inconsistent;
    }
    if !expiry_is_current(&session.expires_at) {
        return SessionCheck::Invalid;
    }
    let url = match api_url(base, "/v1/session") {
        Ok(url) => url,
        Err(error) => return SessionCheck::Transient(error),
    };
    let authorization = Zeroizing::new(format!("Bearer {}", session.token.as_str()));
    if !admit() {
        return SessionCheck::Refused;
    }
    let response = http_client
        .get(url)
        .header(AUTHORIZATION, authorization.as_str())
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(_) => return SessionCheck::Transient("Enterprise session check failed".into()),
    };
    if response.status().is_server_error()
        || matches!(
            response.status(),
            StatusCode::REQUEST_TIMEOUT | StatusCode::TOO_MANY_REQUESTS
        )
    {
        return SessionCheck::Transient("Enterprise session check failed".into());
    }
    if !response.status().is_success() {
        return SessionCheck::Invalid;
    }
    let response: SessionResponse = match read_json(response).await {
        Ok(response) => response,
        Err(ReadJsonError::Transport) => {
            return SessionCheck::Transient("Enterprise session check failed".into())
        }
        Err(ReadJsonError::TooLarge | ReadJsonError::Invalid) => return SessionCheck::Inconsistent,
    };
    if response.expires_at.is_empty()
        || response.expires_at.len() > MAX_SESSION_EXPIRY
        || !expiry_is_well_formed(&response.expires_at)
        || expected_expiry.is_some_and(|expected| expected != response.expires_at)
    {
        return SessionCheck::Inconsistent;
    }
    if !expiry_is_current(&response.expires_at) {
        return SessionCheck::Invalid;
    }
    SessionCheck::Valid(EnterpriseAuthInfo {
        expires_at: response.expires_at,
    })
}

fn expiry_is_well_formed(value: &str) -> bool {
    OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

fn expiry_is_current(value: &str) -> bool {
    OffsetDateTime::parse(value, &Rfc3339)
        .is_ok_and(|expires_at| expires_at > OffsetDateTime::now_utc())
}

fn client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Enterprise network client is unavailable".into())
}

async fn read_json<T: DeserializeOwned>(
    mut response: reqwest::Response,
) -> std::result::Result<T, ReadJsonError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SESSION_BODY as u64)
    {
        return Err(ReadJsonError::TooLarge);
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ReadJsonError::Transport)?
    {
        if chunk.len() > MAX_SESSION_BODY - body.len() {
            return Err(ReadJsonError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ReadJsonError::Invalid)
}

#[cfg(test)]
#[derive(Default)]
struct FixtureStore {
    values: Mutex<HashMap<(String, String), Vec<u8>>>,
    error: Mutex<Option<StoreError>>,
    replace_error: Mutex<Option<StoreError>>,
    delete_error: Mutex<Option<StoreError>>,
    delete_started: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    release_delete: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

#[cfg(test)]
impl CredentialStore for FixtureStore {
    fn read(
        &self,
        service: &str,
        account: &str,
    ) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError> {
        if let Some(error) = *self.error.lock().unwrap() {
            return Err(error);
        }
        self.values
            .lock()
            .unwrap()
            .get(&(service.to_owned(), account.to_owned()))
            .cloned()
            .map(Zeroizing::new)
            .ok_or(StoreError::Absent)
    }

    fn replace(
        &self,
        service: &str,
        account: &str,
        value: &[u8],
    ) -> std::result::Result<(), StoreError> {
        if let Some(error) = *self.replace_error.lock().unwrap() {
            return Err(error);
        }
        self.values
            .lock()
            .unwrap()
            .insert((service.to_owned(), account.to_owned()), value.to_vec());
        Ok(())
    }

    fn delete_if_matches(
        &self,
        service: &str,
        account: &str,
        expected: &[u8],
    ) -> std::result::Result<(), StoreError> {
        if let Some(error) = *self.delete_error.lock().unwrap() {
            return Err(error);
        }
        if let Some(started) = self.delete_started.lock().unwrap().take() {
            started.send(()).unwrap();
            self.release_delete
                .lock()
                .unwrap()
                .take()
                .unwrap()
                .recv()
                .unwrap();
        }
        let mut values = self.values.lock().unwrap();
        let key = (service.to_owned(), account.to_owned());
        if values
            .get(&key)
            .is_some_and(|value| value.as_slice() == expected)
        {
            values.remove(&key);
        }
        Ok(())
    }
}

/// Lets relay badge tests drive this owner without reaching its internals.
#[cfg(test)]
impl EnterpriseAuthHost {
    /// A host holding `token` as `viewer`'s saved session at `adapter`.
    pub(crate) fn with_saved(adapter: &str, viewer: &str, token: &str) -> Self {
        let scope = scope_for_adapter(adapter, viewer).unwrap();
        let store = FixtureStore::default();
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new(token.into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        Self::with_store(Arc::new(store))
    }

    /// Like `with_saved`, but secure storage fails every removal.
    pub(crate) fn with_saved_undeletable(adapter: &str, viewer: &str, token: &str) -> Self {
        let scope = scope_for_adapter(adapter, viewer).unwrap();
        let store = FixtureStore::default();
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new(token.into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        Self::with_store(Arc::new(store))
    }

    pub(crate) async fn saved_at(&self, adapter: &str, viewer: &str) -> Option<SavedSession> {
        self.saved_scope(scope_for_adapter(adapter, viewer).unwrap())
            .await
            .unwrap()
    }

    /// Holds the commit owner, as a slow secure-storage commit would.
    pub(crate) async fn hold_commit(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.commit.clone().lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::{Shutdown, SocketAddr, TcpListener as StdTcpListener, TcpStream as StdTcpStream},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
        thread::{self, JoinHandle},
    };

    struct BlockingStore {
        values: Mutex<HashMap<(String, String), Vec<u8>>>,
        replace_started: Mutex<Option<mpsc::Sender<()>>>,
        release_replace: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl BlockingStore {
        fn new(replace_started: mpsc::Sender<()>, release_replace: mpsc::Receiver<()>) -> Self {
            Self {
                values: Mutex::new(HashMap::new()),
                replace_started: Mutex::new(Some(replace_started)),
                release_replace: Mutex::new(Some(release_replace)),
            }
        }

        fn stored(&self, service: &str, account: &str) -> Zeroizing<Vec<u8>> {
            Zeroizing::new(
                self.values
                    .lock()
                    .unwrap()
                    .get(&(service.to_owned(), account.to_owned()))
                    .cloned()
                    .unwrap(),
            )
        }
    }

    impl CredentialStore for BlockingStore {
        fn read(
            &self,
            service: &str,
            account: &str,
        ) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError> {
            self.values
                .lock()
                .unwrap()
                .get(&(service.to_owned(), account.to_owned()))
                .cloned()
                .map(Zeroizing::new)
                .ok_or(StoreError::Absent)
        }

        fn replace(
            &self,
            service: &str,
            account: &str,
            value: &[u8],
        ) -> std::result::Result<(), StoreError> {
            if let Some(started) = self.replace_started.lock().unwrap().take() {
                started.send(()).unwrap();
                self.release_replace
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .recv()
                    .unwrap();
            }
            self.values
                .lock()
                .unwrap()
                .insert((service.to_owned(), account.to_owned()), value.to_vec());
            Ok(())
        }

        fn delete_if_matches(
            &self,
            service: &str,
            account: &str,
            expected: &[u8],
        ) -> std::result::Result<(), StoreError> {
            let mut values = self.values.lock().unwrap();
            let key = (service.to_owned(), account.to_owned());
            if values
                .get(&key)
                .is_some_and(|value| value.as_slice() == expected)
            {
                values.remove(&key);
            }
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    enum BodyFailure {
        Interrupted,
        Stalled,
        Malformed,
        Oversized,
    }

    struct BodyFixture {
        address: SocketAddr,
        base: String,
        first_started: Arc<tokio::sync::Notify>,
        release_first: Mutex<Option<mpsc::Sender<()>>>,
        requests: Arc<AtomicUsize>,
        join: Option<JoinHandle<()>>,
    }

    impl BodyFixture {
        fn spawn(failure: BodyFailure) -> Self {
            let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let first_started = Arc::new(tokio::sync::Notify::new());
            let requests = Arc::new(AtomicUsize::new(0));
            let (release_sender, release_receiver) = mpsc::channel();
            let started = first_started.clone();
            let served = requests.clone();
            let join = thread::spawn(move || {
                let valid = br#"{"expires_at":"2030-01-01T00:00:00Z"}"#;
                for index in 0..2 {
                    let (mut stream, _) = listener.accept().unwrap();
                    let Some(_request) = read_fixture_request(&mut stream).unwrap() else {
                        break;
                    };
                    served.fetch_add(1, Ordering::SeqCst);
                    if index == 0 {
                        started.notify_one();
                        match failure {
                            BodyFailure::Interrupted => {
                                let _ = stream.write_all(&raw_response(
                                    "200 OK",
                                    valid,
                                    valid.len() + 1,
                                ));
                                let _ = stream.shutdown(Shutdown::Write);
                            }
                            BodyFailure::Stalled => {
                                let headers = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                                    valid.len()
                                );
                                let _ = stream.write_all(headers.as_bytes());
                                let _ = release_receiver.recv();
                                let _ = stream.write_all(valid);
                                let _ = stream.shutdown(Shutdown::Write);
                            }
                            BodyFailure::Malformed => {
                                let _ = stream.write_all(&raw_response(
                                    "200 OK",
                                    b"not json",
                                    b"not json".len(),
                                ));
                            }
                            BodyFailure::Oversized => {
                                let _ = stream.write_all(&raw_response(
                                    "200 OK",
                                    &[],
                                    MAX_SESSION_BODY + 1,
                                ));
                            }
                        }
                    } else {
                        let _ = stream.write_all(&raw_response("200 OK", valid, valid.len()));
                    }
                }
            });
            Self {
                address,
                base: format!("http://{address}"),
                first_started,
                release_first: Mutex::new(Some(release_sender)),
                requests,
                join: Some(join),
            }
        }

        fn release_first(&self) {
            if let Some(sender) = self.release_first.lock().unwrap().take() {
                let _ = sender.send(());
            }
        }

        fn requests(&self) -> usize {
            self.requests.load(Ordering::SeqCst)
        }

        fn finish(mut self) {
            self.release_first();
            self.wake();
            if let Some(join) = self.join.take() {
                join.join().unwrap();
            }
        }

        fn wake(&self) {
            if let Ok(mut stream) = StdTcpStream::connect(self.address) {
                let _ = stream.write_all(b"BUZZ_FIXTURE_SHUTDOWN\n");
                let _ = stream.shutdown(Shutdown::Write);
            }
        }
    }

    impl Drop for BodyFixture {
        fn drop(&mut self) {
            self.release_first();
            self.wake();
            if let Some(join) = self.join.take() {
                let _ = join.join();
            }
        }
    }

    fn read_fixture_request(stream: &mut StdTcpStream) -> std::io::Result<Option<Vec<u8>>> {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        loop {
            let read = stream.read(&mut buffer)?;
            if read == 0 {
                return Ok(None);
            }
            request.extend_from_slice(&buffer[..read]);
            if request.starts_with(b"BUZZ_FIXTURE_SHUTDOWN\n") {
                return Ok(None);
            }
            if request.windows(4).any(|window| window == b"\r\n\r\n") {
                return Ok(Some(request));
            }
        }
    }

    fn raw_response(status: &str, body: &[u8], content_length: usize) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {content_length}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    fn test_http_client(timeout: Duration) -> reqwest::Client {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(timeout)
            .timeout(timeout)
            .build()
            .unwrap()
    }

    struct ReadGatedStore {
        values: Mutex<HashMap<(String, String), Vec<u8>>>,
        read_started: Mutex<Option<mpsc::Sender<()>>>,
        release_read: Mutex<Option<mpsc::Receiver<()>>>,
    }

    impl ReadGatedStore {
        fn new(read_started: mpsc::Sender<()>, release_read: mpsc::Receiver<()>) -> Self {
            Self {
                values: Mutex::new(HashMap::new()),
                read_started: Mutex::new(Some(read_started)),
                release_read: Mutex::new(Some(release_read)),
            }
        }

        fn stored(&self, service: &str, account: &str) -> Zeroizing<Vec<u8>> {
            Zeroizing::new(
                self.values
                    .lock()
                    .unwrap()
                    .get(&(service.to_owned(), account.to_owned()))
                    .cloned()
                    .unwrap(),
            )
        }
    }

    impl CredentialStore for ReadGatedStore {
        fn read(
            &self,
            service: &str,
            account: &str,
        ) -> std::result::Result<Zeroizing<Vec<u8>>, StoreError> {
            let value = self
                .values
                .lock()
                .unwrap()
                .get(&(service.to_owned(), account.to_owned()))
                .cloned()
                .ok_or(StoreError::Absent)?;
            // Taken first, so a concurrent read does not wait on this one.
            let started = self.read_started.lock().unwrap().take();
            if let Some(started) = started {
                started.send(()).unwrap();
                self.release_read
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .recv()
                    .unwrap();
            }
            Ok(Zeroizing::new(value))
        }

        fn replace(
            &self,
            service: &str,
            account: &str,
            value: &[u8],
        ) -> std::result::Result<(), StoreError> {
            self.values
                .lock()
                .unwrap()
                .insert((service.to_owned(), account.to_owned()), value.to_vec());
            Ok(())
        }

        fn delete_if_matches(
            &self,
            service: &str,
            account: &str,
            expected: &[u8],
        ) -> std::result::Result<(), StoreError> {
            let mut values = self.values.lock().unwrap();
            let key = (service.to_owned(), account.to_owned());
            if values
                .get(&key)
                .is_some_and(|value| value.as_slice() == expected)
            {
                values.remove(&key);
            }
            Ok(())
        }
    }

    struct HeldSessionServer {
        base: String,
        first_started: Arc<tokio::sync::Notify>,
        release_first: Arc<tokio::sync::Notify>,
        second_started: Arc<tokio::sync::Notify>,
        release_second: Arc<tokio::sync::Notify>,
        server: tokio::task::JoinHandle<()>,
    }

    impl HeldSessionServer {
        async fn spawn() -> Self {
            Self::spawn_with_holds(StatusCode::OK, StatusCode::UNAUTHORIZED, true, false).await
        }

        async fn spawn_with_statuses(first_status: StatusCode, second_status: StatusCode) -> Self {
            Self::spawn_with_holds(first_status, second_status, true, false).await
        }

        async fn spawn_with_both_responses_held() -> Self {
            Self::spawn_with_holds(StatusCode::OK, StatusCode::UNAUTHORIZED, true, true).await
        }

        async fn spawn_with_holds(
            first_status: StatusCode,
            second_status: StatusCode,
            hold_first: bool,
            hold_second: bool,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let first_started = Arc::new(tokio::sync::Notify::new());
            let release_first = Arc::new(tokio::sync::Notify::new());
            let second_started = Arc::new(tokio::sync::Notify::new());
            let release_second = Arc::new(tokio::sync::Notify::new());
            let calls = Arc::new(AtomicUsize::new(0));
            let first_started_for_route = first_started.clone();
            let release_first_for_route = release_first.clone();
            let second_started_for_route = second_started.clone();
            let release_second_for_route = release_second.clone();
            let first_status_for_route = first_status;
            let second_status_for_route = second_status;
            let app = Router::new().route(
                "/v1/session",
                get(move || {
                    let call = calls.fetch_add(1, Ordering::SeqCst);
                    let first_started = first_started_for_route.clone();
                    let release_first = release_first_for_route.clone();
                    let second_started = second_started_for_route.clone();
                    let release_second = release_second_for_route.clone();
                    let first_status = first_status_for_route;
                    let second_status = second_status_for_route;
                    async move {
                        if call == 0 {
                            first_started.notify_one();
                            if hold_first {
                                release_first.notified().await;
                            }
                            (
                                first_status,
                                Json(if first_status.is_success() {
                                    serde_json::json!({
                                        "expires_at": "2030-01-01T00:00:00Z"
                                    })
                                } else {
                                    serde_json::json!({})
                                }),
                            )
                        } else {
                            second_started.notify_one();
                            if hold_second {
                                release_second.notified().await;
                            }
                            (
                                second_status,
                                Json(if second_status.is_success() {
                                    serde_json::json!({
                                        "expires_at": "2030-01-01T00:00:00Z"
                                    })
                                } else {
                                    serde_json::json!({})
                                }),
                            )
                        }
                    }
                }),
            );
            let server = tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Self {
                base,
                first_started,
                release_first,
                second_started,
                release_second,
                server,
            }
        }
    }

    impl Drop for HeldSessionServer {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    #[test]
    fn scope_isolated_by_adapter_and_identity() {
        let first = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let second = scope_for_adapter(
            "https://adapter.example",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
        assert_ne!(first.account, second.account);
    }

    #[test]
    fn scope_isolated_by_adapter() {
        let first = scope_for_adapter(
            "https://one.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let second = scope_for_adapter(
            "https://two.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        assert_ne!(first.account, second.account);
    }

    #[test]
    fn adapter_url_requires_https_except_for_loopback_development() {
        assert!(
            crate::enterprise_adapter_url::validate_enterprise_adapter_url(
                "https://adapter.example",
            )
            .is_ok()
        );
        for value in [
            "http://adapter.example",
            "ws://127.0.0.1",
            "https://user:password@adapter.example",
            "https://adapter.example?tenant=one",
        ] {
            assert!(
                crate::enterprise_adapter_url::validate_enterprise_adapter_url(value).is_err(),
                "{value}"
            );
        }
        for value in ["http://localhost:4318/", "http://127.0.0.1:4318"] {
            assert!(
                crate::enterprise_adapter_url::validate_enterprise_adapter_url(value).is_ok(),
                "{value}"
            );
        }
    }

    #[test]
    fn handoff_challenge_is_sha256_base64url() {
        assert_eq!(
            handoff_challenge("secret"),
            "K7gNU3sdo-OL0wNhqoVWhr3g6s1xYv72ol_pe_Unols"
        );
    }

    #[test]
    fn stored_session_round_trips_without_plaintext_ipc_shape() {
        let session = StoredSession {
            token: Zeroizing::new("secret-token".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let raw = encode_session(&session).unwrap();
        let decoded = decode_session(raw).unwrap();
        assert_eq!(decoded.token.as_str(), "secret-token");
        assert_eq!(decoded.expires_at, session.expires_at);
        let info = serde_json::to_value(EnterpriseAuthInfo {
            expires_at: decoded.expires_at,
        })
        .unwrap();
        assert!(info.get("sessionToken").is_none());
    }

    #[test]
    fn exchange_rejects_malformed_or_expired_session_expiry() {
        for expires_at in ["not-a-timestamp", "2020-01-01T00:00:00Z"] {
            assert!(session_from_exchange(ExchangeResponse {
                session_token: Zeroizing::new("fixture-session".into()),
                expires_at: expires_at.into(),
            })
            .is_err());
        }
        assert!(expiry_is_current("2030-01-01T00:00:00Z"));
        assert!(!expiry_is_well_formed("2030-01-01 00:00:00 UTC"));
    }

    #[test]
    fn callback_rejects_wrong_nonce_without_consuming_code() {
        let (sender, _receiver) = oneshot::channel();
        let state = Arc::new(CallbackState {
            nonce: Zeroizing::new("right".into()),
            sender: Mutex::new(Some(sender)),
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime.block_on(login_callback(
            Path("wrong".into()),
            Query(HashMap::from([(
                String::from("code"),
                String::from("secret"),
            )])),
            AxumState(state.clone()),
        ));
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(state.sender.lock().unwrap().is_some());
    }

    #[test]
    fn callback_reports_a_bounded_adapter_error_without_exposing_secrets() {
        let (sender, receiver) = oneshot::channel();
        let state = Arc::new(CallbackState {
            nonce: Zeroizing::new("right".into()),
            sender: Mutex::new(Some(sender)),
        });
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let response = runtime.block_on(login_callback(
            Path("right".into()),
            Query(HashMap::from([(
                String::from("error_description"),
                String::from("The account was canceled"),
            )])),
            AxumState(state),
        ));
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            runtime.block_on(receiver).unwrap().unwrap_err(),
            "The account was canceled"
        );
    }

    #[tokio::test]
    async fn callback_receiver_failure_is_returned_for_listener_cleanup() {
        let (sender, callback) = oneshot::channel();
        drop(sender);
        let (_cancel_sender, mut canceled) = oneshot::channel();
        assert_eq!(
            wait_for_callback(callback, &mut canceled)
                .await
                .unwrap_err(),
            "Enterprise login callback was interrupted"
        );
    }

    #[tokio::test]
    async fn callback_error_is_returned_for_listener_cleanup() {
        let (sender, callback) = oneshot::channel();
        sender
            .send(Err("Enterprise authentication was denied".into()))
            .unwrap();
        let (_cancel_sender, mut canceled) = oneshot::channel();
        assert_eq!(
            wait_for_callback(callback, &mut canceled)
                .await
                .unwrap_err(),
            "Enterprise authentication was denied"
        );
    }

    #[tokio::test]
    async fn a_late_refusal_of_an_old_session_keeps_the_newer_login() {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let session = |token: &str| StoredSession {
            token: Zeroizing::new(token.into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let raw = encode_session(&session("old")).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        // A badge request reads the old session; its refusal is held.
        let held = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        // A new login is adopted the way `commit_session` adopts one.
        let newer = encode_session(&session("new")).unwrap();
        store
            .replace(scope.service, &scope.account, &newer)
            .unwrap();
        EnterpriseAuthHost::bump_generation(&mut host.login.lock().unwrap());
        host.remember(scope.clone(), session("new"));

        assert!(host.superseded(&held));
        assert_eq!(host.reject(held).await.unwrap(), Rejection::Superseded);
        assert_eq!(
            store
                .read(scope.service, &scope.account)
                .unwrap()
                .as_slice(),
            newer.as_slice()
        );
        let current = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        assert_eq!(current.token(), "new");
        // A refusal of the current session does clear it.
        assert_eq!(host.reject(current).await.unwrap(), Rejection::Removed);
        assert!(host.saved_scope(scope).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_refusal_is_judged_by_token_not_by_login_generation() {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("old".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let first = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        let second = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        // Starting a login advances the generation but keeps the old token,
        // so its refusal still removes it.
        let (cancel, _canceled) = oneshot::channel();
        assert!(host.begin("login".into(), cancel).unwrap());
        assert_eq!(host.reject(first).await.unwrap(), Rejection::Removed);
        assert!(host.saved_scope(scope.clone()).await.unwrap().is_none());
        // A second refusal of the same token, while that login is still
        // open, changes nothing and does not ask for sign-in again.
        assert!(!host.superseded(&second));
        assert_eq!(host.reject(second).await.unwrap(), Rejection::Superseded);
        assert!(host.is_active("login").unwrap());
    }

    #[test]
    fn conditional_cleanup_does_not_remove_a_newer_session() {
        let store = Arc::new(FixtureStore::default());
        store.replace("service", "account", b"newer").unwrap();
        store
            .delete_if_matches("service", "account", b"older")
            .unwrap();
        assert_eq!(
            store.read("service", "account").unwrap().as_slice(),
            b"newer"
        );
    }

    #[tokio::test]
    async fn storage_errors_preserve_saved_session_without_adopting_it() {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let session = StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());

        for (error, message) in [
            (
                StoreError::Denied,
                "Enterprise secure storage access was denied; unlock it and retry",
            ),
            (
                StoreError::Corrupt,
                "Saved enterprise authentication is corrupt",
            ),
            (
                StoreError::Unavailable,
                "Enterprise secure storage is unavailable; retry without changing credentials",
            ),
            (
                StoreError::Busy,
                "Another Buzz process is using enterprise secure storage; retry shortly",
            ),
        ] {
            *store.error.lock().unwrap() = Some(error);
            assert!(matches!(
                host.get_scope(scope.clone()).await,
                Err(error) if error == message
            ));
            assert!(host.cached(&scope).is_none());

            *store.error.lock().unwrap() = None;
            assert_eq!(
                store
                    .read(scope.service, &scope.account)
                    .unwrap()
                    .as_slice(),
                raw.as_slice()
            );
        }
    }

    #[tokio::test]
    async fn a_refused_session_that_storage_keeps_stays_refused_after_restart() {
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("refused-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.keep_refusals_at(refusals.clone());
        let saved = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        assert!(matches!(
            host.reject(saved).await.unwrap(),
            Rejection::Retained
        ));
        assert!(host.saved_scope(scope.clone()).await.unwrap().is_none());

        // After a restart the stored session stays refused, and the session
        // check answers without contacting the adapter.
        let restarted = EnterpriseAuthHost::with_store(store.clone());
        restarted.keep_refusals_at(refusals.clone());
        assert!(restarted
            .saved_scope(scope.clone())
            .await
            .unwrap()
            .is_none());
        let offline = test_http_client(Duration::from_millis(1));
        assert!(restarted
            .get_scope_with_client(scope.clone(), &offline)
            .await
            .unwrap()
            .is_none());

        // Once secure storage works, the next check removes the session.
        *store.delete_error.lock().unwrap() = None;
        assert!(restarted
            .get_scope_with_client(scope.clone(), &offline)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.read(scope.service, &scope.account).unwrap_err(),
            StoreError::Absent
        );
        assert!(!recorded(&refusals, &scope, "refused-session"));
    }

    /// Whether `token`'s refusal is recorded on disk under `root`.
    fn recorded(root: &std::path::Path, scope: &Scope, token: &str) -> bool {
        RefusalRecords::At(root.to_owned())
            .path(scope.service, token_digest(token))
            .unwrap()
            .unwrap()
            .exists()
    }

    fn refusal_fixture(token: &str) -> (Scope, Arc<FixtureStore>, Zeroizing<Vec<u8>>) {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new(token.into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        (scope, store, raw)
    }

    #[tokio::test]
    async fn a_refused_session_stays_refused_after_a_restart_while_removal_waits() {
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        let (scope, store, _) = refusal_fixture("refused-session");
        let (started, delete_started) = mpsc::channel();
        let (release, release_delete) = mpsc::channel();
        *store.delete_started.lock().unwrap() = Some(started);
        *store.release_delete.lock().unwrap() = Some(release_delete);
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.keep_refusals_at(refusals.clone());
        let saved = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        let rejection = tokio::spawn({
            let host = host.clone();
            async move { host.reject(saved).await }
        });
        tokio::task::spawn_blocking(move || delete_started.recv().unwrap())
            .await
            .unwrap();

        // Buzz restarts while secure storage is still removing the session.
        let restarted = EnterpriseAuthHost::with_store(store.clone());
        restarted.keep_refusals_at(refusals.clone());
        assert!(restarted
            .saved_scope(scope.clone())
            .await
            .unwrap()
            .is_none());

        release.send(()).unwrap();
        assert_eq!(rejection.await.unwrap().unwrap(), Rejection::Removed);
        assert!(!recorded(&refusals, &scope, "refused-session"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unreadable_refusal_records_keep_the_stored_session_unused() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        std::fs::create_dir(&refusals).unwrap();
        std::fs::set_permissions(&refusals, std::fs::Permissions::from_mode(0o000)).unwrap();
        let (scope, store, _) = refusal_fixture("stored-session");
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.keep_refusals_at(refusals.clone());
        std::fs::set_permissions(&refusals, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(host.saved_scope(scope.clone()).await.unwrap().is_none());
        let offline = test_http_client(Duration::from_millis(1));
        assert!(host
            .get_scope_with_client(scope.clone(), &offline)
            .await
            .unwrap()
            .is_none());
        // Secure storage keeps the session; only its use is withheld.
        assert!(store.read(scope.service, &scope.account).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refusal_record_that_cannot_be_pruned_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        let (scope, store, _) = refusal_fixture("refused-session");
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.keep_refusals_at(refusals.clone());
        let saved = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        assert_eq!(host.reject(saved).await.unwrap(), Rejection::Retained);
        let service = refusals.join(scope.service);
        std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o500)).unwrap();
        // A new login replaces the refused session, but its record stays.
        host.adopted(&scope, Some(token_digest("refused-session")));
        std::fs::set_permissions(&service, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            host.cleanup().await,
            Some(EnterpriseCleanup {
                retained: false,
                unrecorded: false,
                unpruned: true,
            })
        );
        assert!(recorded(&refusals, &scope, "refused-session"));
    }

    #[tokio::test]
    async fn a_login_in_another_scope_does_not_lift_a_refusal() {
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        // Debug and release builds keep sessions under different keychain
        // services but share the refusal records.
        let (debug, store, _) = refusal_fixture("refused-debug-session");
        let release = Scope {
            service: "release-service",
            ..debug.clone()
        };
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.keep_refusals_at(refusals.clone());
        let saved = host.saved_scope(debug.clone()).await.unwrap().unwrap();
        assert_eq!(host.reject(saved).await.unwrap(), Rejection::Retained);
        *store.delete_error.lock().unwrap() = None;

        // The release build signs in, replacing its own stored session.
        let other = EnterpriseAuthHost::with_store(store.clone());
        other.keep_refusals_at(refusals.clone());
        let (cancel, _canceled) = oneshot::channel();
        assert!(other.begin("release-login".into(), cancel).unwrap());
        other
            .commit_session(
                &release,
                "release-login",
                StoredSession {
                    token: Zeroizing::new("release-session".into()),
                    expires_at: "2030-01-01T00:00:00Z".into(),
                },
                EnterpriseAuthInfo {
                    expires_at: "2030-01-01T00:00:00Z".into(),
                },
            )
            .await
            .unwrap();

        let restarted = EnterpriseAuthHost::with_store(store.clone());
        restarted.keep_refusals_at(refusals.clone());
        assert!(restarted.saved_scope(debug).await.unwrap().is_none());
        assert!(restarted.saved_scope(release).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn refusals_from_two_processes_both_survive_a_restart() {
        let directory = tempfile::tempdir().unwrap();
        let refusals = directory.path().join("enterprise-refused-sessions");
        let (first, store, _) = refusal_fixture("first-session");
        let second = scope_for_adapter(
            "https://adapter.example",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("second-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store
            .replace(second.service, &second.account, &raw)
            .unwrap();
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        // Two Buzz processes started before either refused anything.
        let one = EnterpriseAuthHost::with_store(store.clone());
        let two = EnterpriseAuthHost::with_store(store.clone());
        one.keep_refusals_at(refusals.clone());
        two.keep_refusals_at(refusals.clone());
        let saved = one.saved_scope(first.clone()).await.unwrap().unwrap();
        assert_eq!(one.reject(saved).await.unwrap(), Rejection::Retained);
        let saved = two.saved_scope(second.clone()).await.unwrap().unwrap();
        assert_eq!(two.reject(saved).await.unwrap(), Rejection::Retained);

        let restarted = EnterpriseAuthHost::with_store(store.clone());
        restarted.keep_refusals_at(refusals.clone());
        assert!(restarted.saved_scope(first).await.unwrap().is_none());
        assert!(restarted.saved_scope(second).await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_session_refused_before_a_session_check_sends_is_not_sent() {
        let calls = Arc::new(AtomicUsize::new(0));
        let app = Router::new().route(
            "/v1/session",
            get({
                let calls = calls.clone();
                move || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { axum::Json(serde_json::json!({"expires_at": "2030-01-01T00:00:00Z"})) }
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let session = StoredSession {
            token: Zeroizing::new("refused-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let raw = encode_session(&session).unwrap();
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let store = Arc::new(ReadGatedStore::new(started_sender, release_receiver));
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        // The session check has read the token when the refusal lands.
        let check = tokio::spawn({
            let (host, scope) = (host.clone(), scope.clone());
            async move { host.get_scope(scope).await }
        });
        tokio::task::spawn_blocking(move || started_receiver.recv().unwrap())
            .await
            .unwrap();
        let saved = SavedSession {
            scope: scope.clone(),
            persisted: PersistedSession { raw, session },
        };
        assert_eq!(host.reject(saved).await.unwrap(), Rejection::Removed);
        release_sender.send(()).unwrap();
        assert!(check.await.unwrap().unwrap().is_none());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_session_check_cannot_restore_a_refused_session() {
        let (scope, store, _) = refusal_fixture("refused-session");
        let host = EnterpriseAuthHost::with_store(store.clone());
        // A validating session check adopts the token in the same instant
        // the refusal is recorded, before secure storage is touched.
        host.refusals()
            .tokens
            .insert(token_digest("refused-session"));
        host.remember(
            scope.clone(),
            StoredSession {
                token: Zeroizing::new("refused-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            },
        );
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        // A session check neither sends the refused token nor restores it.
        let offline = test_http_client(Duration::from_millis(1));
        assert!(host
            .get_scope_with_client(scope.clone(), &offline)
            .await
            .unwrap()
            .is_none());
        assert!(host.saved_scope(scope).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_session_check_held_across_a_refusal_does_not_adopt_it() {
        let server = HeldSessionServer::spawn().await;
        let scope = scope_for_adapter(
            &server.base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("refused-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        let host = EnterpriseAuthHost::with_store(store.clone());
        let saved = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        let check = tokio::spawn({
            let (host, scope) = (host.clone(), scope.clone());
            async move { host.get_scope(scope).await }
        });
        server.first_started.notified().await;
        assert_eq!(host.reject(saved).await.unwrap(), Rejection::Retained);
        server.release_first.notify_one();
        assert!(check.await.unwrap().unwrap().is_none());
        assert!(host.cached_raw(&scope).is_none());
        assert!(host.saved_scope(scope).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_failed_cleanup_is_reported_until_a_new_login() {
        let (scope, store, _) = refusal_fixture("refused-session");
        *store.delete_error.lock().unwrap() = Some(StoreError::Unavailable);
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.refusals_unavailable();
        assert_eq!(host.cleanup().await, None);
        // Before a login the stored session is not used at all, so read it
        // the way a request that started earlier would have.
        host.refusals().distrust_stored = false;
        let saved = host.saved_scope(scope.clone()).await.unwrap().unwrap();
        assert_eq!(host.reject(saved).await.unwrap(), Rejection::Retained);
        assert_eq!(
            host.cleanup().await,
            Some(EnterpriseCleanup {
                retained: true,
                unrecorded: true,
                unpruned: false,
            })
        );
        host.adopted(&scope, Some(token_digest("refused-session")));
        assert_eq!(host.cleanup().await, None);
    }

    #[tokio::test]
    async fn storage_write_and_cleanup_failures_are_recoverable() {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let old = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let newer = StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let old_raw = encode_session(&old).unwrap();
        store
            .replace(scope.service, &scope.account, &old_raw)
            .unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let (cancel, _receiver) = oneshot::channel();
        assert!(host.begin("write-retry".into(), cancel).unwrap());
        *store.replace_error.lock().unwrap() = Some(StoreError::Denied);
        assert_eq!(
            host.commit_session(
                &scope,
                "write-retry",
                newer.clone(),
                EnterpriseAuthInfo {
                    expires_at: "2031-01-01T00:00:00Z".into(),
                },
            )
            .await
            .unwrap_err(),
            "Enterprise secure storage access was denied; unlock it and retry"
        );
        assert!(host.cached(&scope).is_none());
        assert_eq!(store.read(scope.service, &scope.account).unwrap(), old_raw);

        *store.replace_error.lock().unwrap() = None;
        assert!(host
            .commit_session(
                &scope,
                "write-retry",
                newer,
                EnterpriseAuthInfo {
                    expires_at: "2031-01-01T00:00:00Z".into(),
                },
            )
            .await
            .is_ok());
        assert_eq!(host.cached(&scope).unwrap().token.as_str(), "new-session");

        let expired = StoredSession {
            token: Zeroizing::new("expired-session".into()),
            expires_at: "2020-01-01T00:00:00Z".into(),
        };
        let expired_raw = encode_session(&expired).unwrap();
        let cleanup_store = Arc::new(FixtureStore::default());
        cleanup_store
            .replace(scope.service, &scope.account, &expired_raw)
            .unwrap();
        let cleanup_host = EnterpriseAuthHost::with_store(cleanup_store.clone());
        *cleanup_store.delete_error.lock().unwrap() = Some(StoreError::Denied);
        assert_eq!(
            cleanup_host.get_scope(scope.clone()).await.unwrap_err(),
            "Enterprise secure storage access was denied; unlock it and retry"
        );
        assert!(cleanup_host.cached(&scope).is_none());
        assert_eq!(
            cleanup_store.read(scope.service, &scope.account).unwrap(),
            expired_raw
        );

        *cleanup_store.delete_error.lock().unwrap() = None;
        assert!(cleanup_host
            .get_scope(scope.clone())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            cleanup_store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
    }

    #[tokio::test]
    async fn local_adapter_restores_a_session_on_a_fresh_host() {
        let expiry = "2030-01-01T00:00:00Z";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/v1/session",
            get(move || async move {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({"expires_at": expiry})),
                )
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let session = StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: expiry.into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();

        let first = EnterpriseAuthHost::with_store(store.clone())
            .get_scope(scope.clone())
            .await
            .unwrap();
        let second = EnterpriseAuthHost::with_store(store)
            .get_scope(scope)
            .await
            .unwrap();
        assert_eq!(first.map(|info| info.expires_at), Some(expiry.into()));
        assert_eq!(second.map(|info| info.expires_at), Some(expiry.into()));
        server.abort();
    }

    #[tokio::test]
    async fn expired_saved_session_is_cleared_without_network_access() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let hits = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let route_hits = hits.clone();
        let app = Router::new().route(
            "/v1/session",
            get(move || {
                route_hits.fetch_add(1, Ordering::SeqCst);
                async { (StatusCode::OK, Json(serde_json::json!({}))) }
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("expired-session".into()),
            expires_at: "2020-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();

        assert!(EnterpriseAuthHost::with_store(store.clone())
            .get_scope(scope.clone())
            .await
            .unwrap()
            .is_none());
        assert_eq!(hits.load(Ordering::SeqCst), 0);
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
        server.abort();
    }

    #[tokio::test]
    async fn restore_does_not_adopt_a_checked_session_over_a_newer_cached_login() {
        let request_started = Arc::new(tokio::sync::Notify::new());
        let release_request = Arc::new(tokio::sync::Notify::new());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let started = request_started.clone();
        let release = release_request.clone();
        let app = Router::new().route(
            "/v1/session",
            get(move || {
                started.notify_one();
                let release = release.clone();
                async move {
                    release.notified().await;
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({
                            "expires_at": "2030-01-01T00:00:00Z"
                        })),
                    )
                }
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let old = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let newer = StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        };
        let old_raw = encode_session(&old).unwrap();
        store
            .replace(scope.service, &scope.account, &old_raw)
            .unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let restore = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move { host.get_scope(scope).await }
        });
        request_started.notified().await;

        let newer_raw = encode_session(&newer).unwrap();
        store
            .replace(scope.service, &scope.account, &newer_raw)
            .unwrap();
        host.remember(scope.clone(), newer);
        release_request.notify_one();

        assert_eq!(
            restore.await.unwrap().unwrap().unwrap().expires_at,
            "2031-01-01T00:00:00Z"
        );
        assert_eq!(host.cached(&scope).unwrap().token.as_str(), "new-session");
        server.abort();
    }

    #[tokio::test]
    async fn overlapping_validation_is_fenced_by_invalidation_for_both_paths() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for cached in [false, true] {
            let server = HeldSessionServer::spawn().await;
            let scope = scope_for_adapter(&server.base, viewer).unwrap();
            let session = StoredSession {
                token: Zeroizing::new("fixture-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            };
            let store = Arc::new(FixtureStore::default());
            let raw = encode_session(&session).unwrap();
            store.replace(scope.service, &scope.account, &raw).unwrap();
            let host = EnterpriseAuthHost::with_store(store.clone());
            if cached {
                host.remember(scope.clone(), session);
            }
            let client = test_http_client(Duration::from_secs(1));

            let first = tokio::spawn({
                let host = host.clone();
                let scope = scope.clone();
                let client = client.clone();
                async move { host.get_scope_with_client(scope, &client).await }
            });
            server.first_started.notified().await;
            let second = tokio::spawn({
                let host = host.clone();
                let scope = scope.clone();
                let client = client.clone();
                async move { host.get_scope_with_client(scope, &client).await }
            });
            server.second_started.notified().await;
            assert!(second.await.unwrap().unwrap().is_none());
            server.release_first.notify_one();
            assert!(first.await.unwrap().unwrap().is_none());
            assert!(host.cached(&scope).is_none());
            assert_eq!(
                store.read(scope.service, &scope.account),
                Err(StoreError::Absent)
            );
        }
    }

    #[tokio::test]
    async fn saved_session_rejection_wins_after_prior_success_for_both_paths() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for cached in [false, true] {
            let server = HeldSessionServer::spawn_with_both_responses_held().await;
            let scope = scope_for_adapter(&server.base, viewer).unwrap();
            let session = StoredSession {
                token: Zeroizing::new("fixture-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            };
            let store = Arc::new(FixtureStore::default());
            let raw = encode_session(&session).unwrap();
            store.replace(scope.service, &scope.account, &raw).unwrap();
            let host = EnterpriseAuthHost::with_store(store.clone());
            if cached {
                host.remember(scope.clone(), session);
            }
            let client = test_http_client(Duration::from_secs(1));

            let first = tokio::spawn({
                let host = host.clone();
                let scope = scope.clone();
                let client = client.clone();
                async move { host.get_scope_with_client(scope, &client).await }
            });
            server.first_started.notified().await;
            let second = tokio::spawn({
                let host = host.clone();
                let scope = scope.clone();
                let client = client.clone();
                async move { host.get_scope_with_client(scope, &client).await }
            });
            server.second_started.notified().await;

            server.release_first.notify_one();
            assert!(first.await.unwrap().unwrap().is_some());
            server.release_second.notify_one();
            assert!(second.await.unwrap().unwrap().is_none());
            assert!(host.cached(&scope).is_none());
            assert_eq!(
                store.read(scope.service, &scope.account),
                Err(StoreError::Absent)
            );
        }
    }

    #[tokio::test]
    async fn validation_is_fenced_by_a_new_login_and_clear() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        let server = HeldSessionServer::spawn().await;
        let scope = scope_for_adapter(&server.base, viewer).unwrap();
        let session = StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let client = test_http_client(Duration::from_secs(1));
        let validation = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            let client = client.clone();
            async move { host.get_scope_with_client(scope, &client).await }
        });
        server.first_started.notified().await;
        let (cancel, _canceled) = oneshot::channel();
        assert!(host.begin("new-login".into(), cancel).unwrap());
        server.release_first.notify_one();
        assert!(validation.await.unwrap().unwrap().is_none());
        assert_eq!(
            store
                .read(scope.service, &scope.account)
                .unwrap()
                .as_slice(),
            raw.as_slice()
        );
        host.cancel("new-login").await.unwrap();

        let server = HeldSessionServer::spawn().await;
        let scope = scope_for_adapter(&server.base, viewer).unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let validation = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            let client = client.clone();
            async move { host.get_scope_with_client(scope, &client).await }
        });
        server.first_started.notified().await;
        host.clear_scope(scope.clone()).await.unwrap();
        server.release_first.notify_one();
        assert!(validation.await.unwrap().unwrap().is_none());
        assert!(host.cached(&scope).is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
    }

    #[tokio::test]
    async fn clear_fences_a_restore_before_a_blocked_commit() {
        let server = HeldSessionServer::spawn().await;
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scope = scope_for_adapter(&server.base, viewer).unwrap();
        let session = StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let client = test_http_client(Duration::from_secs(1));
        let commit_guard = host.commit.lock().await;
        let restore = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            let client = client.clone();
            async move { host.get_scope_with_client(scope, &client).await }
        });
        server.first_started.notified().await;

        let clear = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move { host.clear_scope(scope).await }
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while host.current_generation().unwrap() == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();

        server.release_first.notify_one();
        drop(commit_guard);
        clear.await.unwrap().unwrap();
        assert!(restore.await.unwrap().unwrap().is_none());
        assert!(host.cached(&scope).is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
    }

    #[tokio::test]
    async fn clear_fences_a_restore_started_during_delete() {
        let server = HeldSessionServer::spawn().await;
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scope = scope_for_adapter(&server.base, viewer).unwrap();
        let session = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let (delete_started, delete_started_receiver) = mpsc::channel();
        let (release_delete, release_delete_receiver) = mpsc::channel();
        *store.delete_started.lock().unwrap() = Some(delete_started);
        *store.release_delete.lock().unwrap() = Some(release_delete_receiver);
        let host = EnterpriseAuthHost::with_store(store.clone());
        let clear = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move { host.clear_scope(scope).await }
        });
        tokio::task::spawn_blocking(move || delete_started_receiver.recv().unwrap())
            .await
            .unwrap();
        let (cancel, _cancel_receiver) = oneshot::channel();
        assert!(host.begin("new-login".into(), cancel).unwrap());

        let restore = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move { host.get_scope(scope).await }
        });
        server.first_started.notified().await;
        server.release_first.notify_one();
        release_delete.send(()).unwrap();

        assert!(clear.await.unwrap().is_ok());
        assert!(restore.await.unwrap().unwrap().is_none());
        assert!(host.cached(&scope).is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
        let newer = StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        };
        let newer_raw = encode_session(&newer).unwrap();
        assert!(host
            .commit_session(
                &scope,
                "new-login",
                newer,
                EnterpriseAuthInfo {
                    expires_at: "2031-01-01T00:00:00Z".into(),
                },
            )
            .await
            .is_ok());
        assert_eq!(host.cached(&scope).unwrap().token.as_str(), "new-session");
        assert_eq!(
            store.read(scope.service, &scope.account).unwrap(),
            newer_raw
        );
    }

    #[tokio::test]
    async fn invalidation_fences_a_restore_started_during_delete() {
        let server =
            HeldSessionServer::spawn_with_statuses(StatusCode::UNAUTHORIZED, StatusCode::OK).await;
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let scope = scope_for_adapter(&server.base, viewer).unwrap();
        let session = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&session).unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let (delete_started, delete_started_receiver) = mpsc::channel();
        let (release_delete, release_delete_receiver) = mpsc::channel();
        *store.delete_started.lock().unwrap() = Some(delete_started);
        *store.release_delete.lock().unwrap() = Some(release_delete_receiver);
        let host = EnterpriseAuthHost::with_store(store.clone());
        let client = test_http_client(Duration::from_secs(1));
        let invalidation = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            let client = client.clone();
            async move { host.get_scope_with_client(scope, &client).await }
        });
        server.first_started.notified().await;
        server.release_first.notify_one();
        tokio::task::spawn_blocking(move || delete_started_receiver.recv().unwrap())
            .await
            .unwrap();
        let (cancel, _cancel_receiver) = oneshot::channel();
        assert!(host.begin("new-login".into(), cancel).unwrap());

        let restore = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            let client = client.clone();
            async move { host.get_scope_with_client(scope, &client).await }
        });
        server.second_started.notified().await;
        release_delete.send(()).unwrap();

        assert!(invalidation.await.unwrap().unwrap().is_none());
        assert!(restore.await.unwrap().unwrap().is_none());
        assert!(host.cached(&scope).is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
        let newer = StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        };
        let newer_raw = encode_session(&newer).unwrap();
        assert!(host
            .commit_session(
                &scope,
                "new-login",
                newer,
                EnterpriseAuthInfo {
                    expires_at: "2031-01-01T00:00:00Z".into(),
                },
            )
            .await
            .is_ok());
        assert_eq!(host.cached(&scope).unwrap().token.as_str(), "new-session");
        assert_eq!(
            store.read(scope.service, &scope.account).unwrap(),
            newer_raw
        );
    }

    #[tokio::test]
    async fn validation_started_before_new_adoption_cannot_replace_or_clear_it() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for first_status in [StatusCode::OK, StatusCode::UNAUTHORIZED] {
            let server =
                HeldSessionServer::spawn_with_statuses(first_status, StatusCode::UNAUTHORIZED)
                    .await;
            let scope = scope_for_adapter(&server.base, viewer).unwrap();
            let old = StoredSession {
                token: Zeroizing::new("old-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            };
            let newer = StoredSession {
                token: Zeroizing::new("new-session".into()),
                expires_at: "2031-01-01T00:00:00Z".into(),
            };
            let store = Arc::new(FixtureStore::default());
            let old_raw = encode_session(&old).unwrap();
            store
                .replace(scope.service, &scope.account, &old_raw)
                .unwrap();
            let host = EnterpriseAuthHost::with_store(store.clone());
            let (cancel, _receiver) = oneshot::channel();
            assert!(host.begin("new-login".into(), cancel).unwrap());
            let client = test_http_client(Duration::from_secs(1));
            let validation = tokio::spawn({
                let host = host.clone();
                let scope = scope.clone();
                let client = client.clone();
                async move { host.get_scope_with_client(scope, &client).await }
            });
            server.first_started.notified().await;

            let newer_raw = encode_session(&newer).unwrap();
            assert_eq!(
                host.commit_session(
                    &scope,
                    "new-login",
                    newer,
                    EnterpriseAuthInfo {
                        expires_at: "2031-01-01T00:00:00Z".into(),
                    },
                )
                .await
                .unwrap()
                .expires_at,
                "2031-01-01T00:00:00Z"
            );

            server.release_first.notify_one();
            assert_eq!(
                validation.await.unwrap().unwrap().unwrap().expires_at,
                "2031-01-01T00:00:00Z"
            );
            assert_eq!(host.cached(&scope).unwrap().token.as_str(), "new-session");
            assert_eq!(
                store
                    .read(scope.service, &scope.account)
                    .unwrap()
                    .as_slice(),
                newer_raw.as_slice()
            );
        }
    }

    #[tokio::test]
    async fn local_adapter_expiry_mismatch_clears_only_the_checked_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/v1/session",
            get(|| async {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({"expires_at": "2031-01-01T00:00:00Z"})),
                )
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        assert!(EnterpriseAuthHost::with_store(store.clone())
            .get_scope(scope.clone())
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
        server.abort();
    }

    #[tokio::test]
    async fn local_adapter_server_failure_preserves_the_saved_session() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let route_requests = requests.clone();
        let app = Router::new().route(
            "/v1/session",
            get(move || {
                let status = if route_requests.fetch_add(1, Ordering::SeqCst) == 0 {
                    StatusCode::BAD_GATEWAY
                } else {
                    StatusCode::TOO_MANY_REQUESTS
                };
                async move { (status, "retry") }
            }),
        );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let scope = scope_for_adapter(
            &base,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let store = Arc::new(FixtureStore::default());
        let raw = encode_session(&StoredSession {
            token: Zeroizing::new("fixture-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        assert!(host.get_scope(scope.clone()).await.is_err());
        assert_eq!(
            store
                .read(scope.service, &scope.account)
                .unwrap()
                .as_slice(),
            raw.as_slice()
        );
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert!(host.get_scope(scope.clone()).await.is_err());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert_eq!(
            store
                .read(scope.service, &scope.account)
                .unwrap()
                .as_slice(),
            raw.as_slice()
        );
        server.abort();
    }

    #[tokio::test]
    async fn body_transport_failures_are_transient_for_cached_and_restored_sessions() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for cached in [false, true] {
            for failure in [BodyFailure::Interrupted, BodyFailure::Stalled] {
                let fixture = BodyFixture::spawn(failure);
                let client = test_http_client(Duration::from_millis(100));
                let scope = scope_for_adapter(&fixture.base, viewer).unwrap();
                let session = StoredSession {
                    token: Zeroizing::new("fixture-session".into()),
                    expires_at: "2030-01-01T00:00:00Z".into(),
                };
                let store = Arc::new(FixtureStore::default());
                let raw = encode_session(&session).unwrap();
                store.replace(scope.service, &scope.account, &raw).unwrap();
                let host = EnterpriseAuthHost::with_store(store.clone());
                if cached {
                    host.remember(scope.clone(), session.clone());
                }

                let first = tokio::spawn({
                    let host = host.clone();
                    let scope = scope.clone();
                    let client = client.clone();
                    async move { host.get_scope_with_client(scope, &client).await }
                });
                fixture.first_started.notified().await;
                assert!(first.await.unwrap().is_err());
                if matches!(failure, BodyFailure::Stalled) {
                    fixture.release_first();
                }

                assert!(host
                    .get_scope_with_client(scope.clone(), &client)
                    .await
                    .unwrap()
                    .is_some());
                assert_eq!(fixture.requests(), 2);
                assert_eq!(
                    store
                        .read(scope.service, &scope.account)
                        .unwrap()
                        .as_slice(),
                    raw.as_slice()
                );
                fixture.finish();
            }
        }
    }

    #[tokio::test]
    async fn malformed_or_oversized_session_bodies_are_inconsistent() {
        let viewer = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for cached in [false, true] {
            for failure in [BodyFailure::Malformed, BodyFailure::Oversized] {
                let fixture = BodyFixture::spawn(failure);
                let client = test_http_client(Duration::from_secs(1));
                let scope = scope_for_adapter(&fixture.base, viewer).unwrap();
                let session = StoredSession {
                    token: Zeroizing::new("fixture-session".into()),
                    expires_at: "2030-01-01T00:00:00Z".into(),
                };
                let store = Arc::new(FixtureStore::default());
                let raw = encode_session(&session).unwrap();
                store.replace(scope.service, &scope.account, &raw).unwrap();
                let host = EnterpriseAuthHost::with_store(store.clone());
                if cached {
                    host.remember(scope.clone(), session);
                }

                assert!(host
                    .get_scope_with_client(scope.clone(), &client)
                    .await
                    .unwrap()
                    .is_none());
                assert_eq!(fixture.requests(), 1);
                assert_eq!(
                    store.read(scope.service, &scope.account),
                    Err(StoreError::Absent)
                );
                fixture.finish();
            }
        }
    }

    #[tokio::test]
    async fn exchange_uses_the_local_adapter_and_checks_the_returned_session() {
        let expiry = "2030-01-01T00:00:00Z";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/v1/login/exchange",
                post(move || async move {
                    Json(serde_json::json!({
                        "session_token": "fixture-session",
                        "expires_at": expiry,
                    }))
                }),
            )
            .route(
                "/v1/session",
                get(move || async move {
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({"expires_at": expiry})),
                    )
                }),
            );
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let (session, info) = exchange(&base, "fixture-code", "fixture-secret")
            .await
            .unwrap();
        assert_eq!(session.token.as_str(), "fixture-session");
        assert_eq!(info.expires_at, expiry);
        server.abort();
    }

    #[tokio::test]
    async fn adapter_redirects_do_not_replay_a_bearer_credential() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let target_hits = Arc::new(AtomicUsize::new(0));
        let target_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_url = format!("http://{}", target_listener.local_addr().unwrap());
        let target_hits_for_route = target_hits.clone();
        let target = Router::new().route(
            "/v1/session",
            get(move || {
                let target_hits = target_hits_for_route.clone();
                async move {
                    target_hits.fetch_add(1, Ordering::SeqCst);
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({"expires_at": "2030-01-01T00:00:00Z"})),
                    )
                }
            }),
        );
        let target_server = tokio::spawn(async move {
            let _ = axum::serve(target_listener, target).await;
        });

        let redirect_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redirect_url = format!("http://{}", redirect_listener.local_addr().unwrap());
        let redirect = Router::new().route(
            "/v1/session",
            get(move || {
                let target_url = format!("{target_url}/v1/session");
                async move {
                    (
                        StatusCode::TEMPORARY_REDIRECT,
                        [(axum::http::header::LOCATION, target_url)],
                    )
                }
            }),
        );
        let redirect_server = tokio::spawn(async move {
            let _ = axum::serve(redirect_listener, redirect).await;
        });
        let result = check_session(
            client().unwrap(),
            &redirect_url,
            &StoredSession {
                token: Zeroizing::new("fixture-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            },
            None,
            &|| true,
        )
        .await;
        assert!(matches!(result, SessionCheck::Invalid));
        assert_eq!(target_hits.load(Ordering::SeqCst), 0);
        target_server.abort();
        redirect_server.abort();
    }

    #[tokio::test]
    async fn canceled_writer_cannot_overwrite_a_newer_login() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let store = Arc::new(BlockingStore::new(started_sender, release_receiver));
        let host = EnterpriseAuthHost::with_store(store.clone());
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let old = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let newer = StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        };
        let (old_cancel, _old_receiver) = oneshot::channel();
        assert!(host.begin("old".into(), old_cancel).unwrap());
        let old_task = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move {
                host.commit_session(
                    &scope,
                    "old",
                    old,
                    EnterpriseAuthInfo {
                        expires_at: "2030-01-01T00:00:00Z".into(),
                    },
                )
                .await
            }
        });
        tokio::task::spawn_blocking(move || started_receiver.recv().unwrap())
            .await
            .unwrap();

        let (new_cancel, _new_receiver) = oneshot::channel();
        assert!(host.begin("new".into(), new_cancel).unwrap());
        let new_task = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move {
                host.commit_session(
                    &scope,
                    "new",
                    newer,
                    EnterpriseAuthInfo {
                        expires_at: "2031-01-01T00:00:00Z".into(),
                    },
                )
                .await
            }
        });
        release_sender.send(()).unwrap();

        assert!(matches!(
            old_task.await.unwrap(),
            Err(error) if error == "Enterprise authentication was canceled"
        ));
        assert!(new_task.await.unwrap().is_ok());
        assert_eq!(
            decode_session(store.stored(scope.service, &scope.account))
                .unwrap()
                .token
                .as_str(),
            "new-session"
        );
    }

    #[tokio::test]
    async fn cancel_marks_a_blocked_writer_inactive_before_waiting_for_commit() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let store = Arc::new(BlockingStore::new(started_sender, release_receiver));
        let host = EnterpriseAuthHost::with_store(store.clone());
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let (cancel, _receiver) = oneshot::channel();
        assert!(host.begin("cancel-me".into(), cancel).unwrap());
        let commit = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move {
                host.commit_session(
                    &scope,
                    "cancel-me",
                    StoredSession {
                        token: Zeroizing::new("fixture-session".into()),
                        expires_at: "2030-01-01T00:00:00Z".into(),
                    },
                    EnterpriseAuthInfo {
                        expires_at: "2030-01-01T00:00:00Z".into(),
                    },
                )
                .await
            }
        });
        tokio::task::spawn_blocking(move || started_receiver.recv().unwrap())
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(1), host.cancel("cancel-me"))
            .await
            .unwrap()
            .unwrap();
        assert!(!host.is_active("cancel-me").unwrap());
        release_sender.send(()).unwrap();
        assert!(matches!(
            commit.await.unwrap(),
            Err(error) if error == "Enterprise authentication was canceled"
        ));
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
    }

    #[tokio::test]
    async fn clear_is_idempotent_and_preserves_a_concurrent_newer_session() {
        let scope = scope_for_adapter(
            "https://adapter.example",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let session = StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        };
        let raw = encode_session(&session).unwrap();
        let store = Arc::new(FixtureStore::default());
        store.replace(scope.service, &scope.account, &raw).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        host.remember(scope.clone(), session);
        let (cancel, _receiver) = oneshot::channel();
        assert!(host.begin("clear-me".into(), cancel).unwrap());
        host.clear_scope(scope.clone()).await.unwrap();
        assert!(!host.is_active("clear-me").unwrap());
        assert!(host.cached(&scope).is_none());
        assert_eq!(
            store.read(scope.service, &scope.account),
            Err(StoreError::Absent)
        );
        host.clear_scope(scope.clone()).await.unwrap();
        assert!(host.get_scope(scope.clone()).await.unwrap().is_none());

        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let store = Arc::new(ReadGatedStore::new(started_sender, release_receiver));
        let old = encode_session(&StoredSession {
            token: Zeroizing::new("old-session".into()),
            expires_at: "2030-01-01T00:00:00Z".into(),
        })
        .unwrap();
        let newer = encode_session(&StoredSession {
            token: Zeroizing::new("new-session".into()),
            expires_at: "2031-01-01T00:00:00Z".into(),
        })
        .unwrap();
        store.replace(scope.service, &scope.account, &old).unwrap();
        let host = EnterpriseAuthHost::with_store(store.clone());
        let clear = tokio::spawn({
            let host = host.clone();
            let scope = scope.clone();
            async move { host.clear_scope(scope).await }
        });
        tokio::task::spawn_blocking(move || started_receiver.recv().unwrap())
            .await
            .unwrap();
        store
            .replace(scope.service, &scope.account, &newer)
            .unwrap();
        release_sender.send(()).unwrap();
        clear.await.unwrap().unwrap();
        assert_eq!(
            store.stored(scope.service, &scope.account).as_slice(),
            newer.as_slice()
        );
    }

    #[tokio::test]
    async fn canceled_attempts_cannot_be_reused_or_cancel_a_newer_attempt() {
        let host = EnterpriseAuthHost::default();
        let (cancel, _receiver) = oneshot::channel();
        assert!(host.begin("first".into(), cancel).unwrap());
        let (next_cancel, _next_receiver) = oneshot::channel();
        assert!(host.begin("second".into(), next_cancel).unwrap());
        host.cancel("first").await.unwrap();
        assert!(!host.is_active("first").unwrap());
        assert!(host.is_active("second").unwrap());
        host.cancel("second").await.unwrap();
        let (cancel, _receiver) = oneshot::channel();
        assert!(!host.begin("first".into(), cancel).unwrap());
    }
}
