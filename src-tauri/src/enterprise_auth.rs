use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, OnceLock},
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

struct PersistedSession {
    raw: Zeroizing<Vec<u8>>,
    session: StoredSession,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRecord {
    version: u8,
    session_token: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct ExchangeResponse {
    session_token: String,
    expires_at: String,
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
}

struct ActiveLogin {
    id: String,
    cancel: oneshot::Sender<()>,
}

#[derive(Clone)]
pub(crate) struct EnterpriseAuthHost {
    session: Arc<Mutex<Option<(Scope, StoredSession)>>>,
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
        if let Some(session) = self.cached(&scope) {
            let raw = encode_session(&session)?;
            return match check_session(&scope.adapter, &session, Some(&session.expires_at)).await {
                SessionCheck::Valid(info) => {
                    let _commit = self.commit.lock().await;
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
                    self.delete_if_matches(&scope, raw).await?;
                    self.clear_memory(&scope, Some(&session.token));
                    Ok(None)
                }
                SessionCheck::Transient(error) => Err(error),
            };
        }
        let Some(persisted) = self.read(&scope).await? else {
            self.clear_memory(&scope, None);
            return Ok(None);
        };
        match check_session(
            &scope.adapter,
            &persisted.session,
            Some(&persisted.session.expires_at),
        )
        .await
        {
            SessionCheck::Valid(info) => {
                let _commit = self.commit.lock().await;
                if let Some(current) = self.cached(&scope) {
                    if current.token.as_str() != persisted.session.token.as_str() {
                        return Ok(Some(EnterpriseAuthInfo {
                            expires_at: current.expires_at,
                        }));
                    }
                } else {
                    self.remember(scope, persisted.session);
                }
                Ok(Some(info))
            }
            SessionCheck::Invalid | SessionCheck::Inconsistent => {
                self.delete_if_matches(&scope, persisted.raw).await?;
                self.clear_memory(&scope, Some(&persisted.session.token));
                Ok(None)
            }
            SessionCheck::Transient(error) => Err(error),
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
        let _commit = self.commit.lock().await;
        let mut state = self
            .login
            .lock()
            .map_err(|_| "Enterprise authentication state is unavailable".to_owned())?;
        if state.active.as_ref().is_some_and(|active| active.id == id) {
            let active = state.active.take().expect("active login checked above");
            remember_canceled(&mut state.canceled, id);
            let _ = active.cancel.send(());
        } else {
            remember_canceled(&mut state.canceled, id);
        }
        Ok(())
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
        let callback_url = format!("http://127.0.0.1:{port}/callback/{nonce}");
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
        state.active = Some(ActiveLogin { id, cancel });
        Ok(true)
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
        self.replace(scope, raw.clone()).await?;
        if !self.is_active(id)? {
            self.delete_if_matches(scope, raw).await?;
            return Err("Enterprise authentication was canceled".into());
        }
        self.remember(scope.clone(), session);
        Ok(info)
    }

    fn remember(&self, scope: Scope, session: StoredSession) {
        if let Ok(mut stored) = self.session.lock() {
            *stored = Some((scope, session));
        }
    }

    fn cached(&self, scope: &Scope) -> Option<StoredSession> {
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
                    && token.is_none_or(|token| session.token.as_str() == token.as_str())
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

struct CallbackState {
    nonce: String,
    sender: Mutex<Option<oneshot::Sender<Result<String>>>>,
}

async fn wait_for_callback(
    callback: oneshot::Receiver<Result<String>>,
    canceled: &mut oneshot::Receiver<()>,
) -> Result<String> {
    tokio::select! {
        result = callback => result.map_err(|_| "Enterprise login callback was interrupted".to_owned()),
        _ = &mut *canceled => Err("Enterprise authentication was canceled".to_owned()),
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => Err("Enterprise authentication timed out".to_owned()),
    }
}

async fn login_callback(
    Path(nonce): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    AxumState(state): AxumState<Arc<CallbackState>>,
) -> Response {
    if nonce != state.nonce {
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
    validate_adapter_base_url(raw)
}

fn validate_adapter_base_url(raw: &str) -> Result<String> {
    let url = Url::parse(raw).map_err(|_| "Enterprise authentication adapter is invalid")?;
    let loopback = url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("localhost"))
        || matches!(url.host(), Some(url::Host::Ipv4(address)) if address.is_loopback())
        || matches!(url.host(), Some(url::Host::Ipv6(address)) if address.is_loopback());
    let loopback_http = url.scheme() == "http" && loopback;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || loopback_http)
    {
        return Err("Enterprise authentication adapter is invalid".into());
    }
    Ok(raw.trim_end_matches('/').to_owned())
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
    let value = serde_json::to_vec(&StoredRecord {
        version: 1,
        session_token: session.token.to_string(),
        expires_at: session.expires_at.clone(),
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
        token: Zeroizing::new(record.session_token),
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
    Invalid,
    Inconsistent,
    Transient(String),
}

async fn exchange(
    base: &str,
    code: &str,
    handoff_secret: &str,
) -> Result<(StoredSession, EnterpriseAuthInfo)> {
    let response = client()?
        .post(api_url(base, "/v1/login/exchange")?)
        .json(&serde_json::json!({
            "code": code,
            "handoff_secret": handoff_secret,
        }))
        .send()
        .await
        .map_err(|_| "Enterprise authentication exchange failed".to_owned())?;
    if !response.status().is_success() {
        return Err("Enterprise authentication exchange failed".into());
    }
    let response: ExchangeResponse = read_json(response).await?;
    let session = session_from_exchange(response)?;
    let info = match check_session(base, &session, Some(&session.expires_at)).await {
        SessionCheck::Valid(info) => info,
        SessionCheck::Invalid | SessionCheck::Inconsistent => {
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
        token: Zeroizing::new(response.session_token),
        expires_at: response.expires_at,
    })
}

async fn check_session(
    base: &str,
    session: &StoredSession,
    expected_expiry: Option<&str>,
) -> SessionCheck {
    if !expiry_is_well_formed(&session.expires_at) {
        return SessionCheck::Inconsistent;
    }
    if !expiry_is_current(&session.expires_at) {
        return SessionCheck::Invalid;
    }
    let response = match client().and_then(|client| Ok((client, api_url(base, "/v1/session")?))) {
        Ok((client, url)) => {
            client
                .get(url)
                .header(AUTHORIZATION, format!("Bearer {}", session.token.as_str()))
                .send()
                .await
        }
        Err(error) => return SessionCheck::Transient(error),
    };
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
        Err(_) => return SessionCheck::Inconsistent,
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

async fn read_json<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SESSION_BODY as u64)
    {
        return Err("Enterprise authentication response was too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Enterprise authentication response failed".to_owned())?
    {
        if chunk.len() > MAX_SESSION_BODY - body.len() {
            return Err("Enterprise authentication response was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "Enterprise authentication response was invalid".into())
}

#[cfg(test)]
#[derive(Default)]
struct FixtureStore {
    values: Mutex<HashMap<(String, String), Vec<u8>>>,
    error: Mutex<Option<StoreError>>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

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
        assert!(validate_adapter_base_url("https://adapter.example").is_ok());
        for value in [
            "http://adapter.example",
            "ws://127.0.0.1",
            "https://user:password@adapter.example",
            "https://adapter.example?tenant=one",
        ] {
            assert!(validate_adapter_base_url(value).is_err(), "{value}");
        }
        for value in ["http://localhost:4318/", "http://127.0.0.1:4318"] {
            assert!(validate_adapter_base_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn handoff_challenge_is_sha256_base64url() {
        assert_eq!(
            handoff_challenge("secret"),
            "K7gNU3sdo-OL0wNhqoVWhr8B7JY9L1M8Q6YfKc8e7JQ"
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
                session_token: "fixture-session".into(),
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
            nonce: "right".into(),
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
            nonce: "right".into(),
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        server.abort();
        assert!(host.get_scope(scope.clone()).await.is_err());
        assert_eq!(
            store
                .read(scope.service, &scope.account)
                .unwrap()
                .as_slice(),
            raw.as_slice()
        );
    }

    #[tokio::test]
    async fn exchange_uses_the_local_adapter_and_checks_the_returned_session() {
        let expiry = "2030-01-01T00:00:00Z";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let app = Router::new()
            .route(
                "/v1/login/exchange",
                post(|| async {
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
        let server = tokio::spawn(axum::serve(listener, app));
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
        let target_server = tokio::spawn(axum::serve(target_listener, target));

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
        let redirect_server = tokio::spawn(axum::serve(redirect_listener, redirect));
        let result = check_session(
            &redirect_url,
            &StoredSession {
                token: Zeroizing::new("fixture-session".into()),
                expires_at: "2030-01-01T00:00:00Z".into(),
            },
            None,
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
