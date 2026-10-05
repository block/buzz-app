//! Native Builderlab sign-in over the session store the `bl` CLI uses.
//!
//! Storage is the source of truth: every operation re-reads the item under the
//! key `bl` derives, so a `bl auth login` shows up here without a second sign-in
//! and a sign-out here ends the session for `bl` too. The credential exists in
//! process memory only as `Zeroizing<String>` for the duration of one HTTP call,
//! and no error string ever carries a response body, header, path or credential.
use axum::{
    extract::{Path as RoutePath, Query, State as RouteState},
    response::{Html, IntoResponse, Response},
    routing::get,
    Router,
};
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
    SESSION_CREDENTIAL_HEADER,
};
use buzz_agent::auth::BrowserOpener;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    future::IntoFuture,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::oneshot;
use url::Url;
use zeroize::Zeroizing;

use crate::agent_models::Opener;

const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_BODY: usize = 64 * 1024;
const MAX_ERROR_BODY: usize = 16 * 1024;
const USER_AGENT: &str = "buzz-app";
const COMPLETE_HTML: &str = "<!doctype html><meta charset=utf-8><title>Buzz authentication complete</title><p>You're signed in. You can close this window and return to Buzz.";
const FAILED_HTML: &str = "<!doctype html><meta charset=utf-8><title>Buzz authentication failed</title><p>Sign-in did not complete. You can close this window and try again from Buzz.";

/// `bl` has no non-interactive org default; Block is the only tenant Buzz targets.
const DEFAULT_ORG: &str = "block";
/// `bl`'s repository default (`kgoose.sqprod.co`) does not serve `/v1/auth/*`.
const DEFAULT_BASE_URL: &str = "https://builderlab.xyz";
const KGOOSE_BASE_URL_ENV_VAR: &str = "KGOOSE_BASE_URL";

const INVALID_SETTINGS: &str =
    "Builderlab settings in the environment are invalid; check KGOOSE_BASE_URL and KGOOSE_SERVICE_PATH.";
const MEMORY_STORAGE: &str =
    "BL_AUTH_STORAGE=memory cannot be shared with Buzz; use keyring or file.";
const STATE_UNAVAILABLE: &str = "Builderlab sign-in is unavailable; restart the app";
const STORE_UNAVAILABLE: &str = "The Builderlab session store is unavailable.";
const STORE_READ: &str = "The Builderlab session store could not be read.";
const STORE_UPDATE: &str = "The Builderlab session store could not be updated.";
const KEYCHAIN_DENIED: &str =
    "Keychain access was denied. Allow Buzz to use the Builderlab session in Keychain and retry.";
const KEYCHAIN_FAILED: &str = "The Builderlab session could not be accessed in Keychain.";
const CANCELED: &str = "Builderlab authentication canceled";
const CHANGED: &str = "Builderlab session changed";
const TIMED_OUT: &str = "Builderlab authentication timed out";
const LISTENER: &str = "Could not start the local sign-in callback";
const TOO_LARGE: &str = "Builderlab response was too large";
const INVALID_RESPONSE: &str = "Builderlab returned an invalid response";
const SIGN_IN_FIRST: &str = "Sign in to Builderlab first";

/// The `bl` environment Buzz mirrors, captured once so resolution is a pure
/// function of its inputs and tests never read the process environment.
#[derive(Default)]
pub(crate) struct Env {
    bl_home: Option<String>,
    profile: Option<String>,
    base_url: Option<String>,
    service_path: Option<String>,
    storage: Option<String>,
    storage_file: Option<String>,
}
impl Env {
    pub(crate) fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self {
            bl_home: var(BL_HOME_ENV_VAR),
            profile: var(BL_SKILLS_PROFILE_ENV_VAR),
            base_url: var(KGOOSE_BASE_URL_ENV_VAR),
            service_path: var(KGOOSE_SERVICE_PATH_ENV_VAR),
            storage: var(BL_AUTH_STORAGE_ENV_VAR),
            storage_file: var(BL_AUTH_STORAGE_FILE_ENV_VAR),
        }
    }
}
/// The two fields of `bl`'s `skills.yaml` that name the active profile.
#[derive(Deserialize)]
struct SkillsFile {
    current_profile: Option<String>,
}
enum StorageSelection {
    /// The crate's own selection: Keychain, or `BL_AUTH_STORAGE`/`BL_AUTH_STORAGE_FILE`.
    CrateDefault,
    File(PathBuf),
}
/// Resolved once at startup without touching storage. Every request goes to
/// `service_url` and the item is keyed by that same URL, so the credential and
/// the endpoint cannot disagree.
pub(crate) struct Config {
    service_url: Url,
    origin: String,
    key: SessionStorageKey,
    bl_home: PathBuf,
    storage: StorageSelection,
}
impl Config {
    pub(crate) fn resolve(env: &Env, home: &Path) -> Result<Config, String> {
        // GUI processes on Windows have no HOME, so the Tauri home directory
        // stands in for `bl`'s `$HOME/.bl`.
        let bl_home = env
            .bl_home
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".bl"));
        let profile = env
            .profile
            .clone()
            .or_else(|| {
                let bytes = std::fs::read(bl_home.join("skills.yaml")).ok()?;
                serde_yaml::from_slice::<SkillsFile>(&bytes)
                    .ok()?
                    .current_profile
            })
            .unwrap_or_else(|| DEFAULT_PROFILE_NAME.to_owned());
        let org = read_preferences_file(&default_preferences_path(&bl_home))
            .ok()
            .and_then(|preferences| preferences.org)
            .unwrap_or_else(|| DEFAULT_ORG.to_owned());
        let configured = env
            .base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let service_path = match &env.service_path {
            Some(path) => normalize_kgoose_service_path(path).map_err(|_| INVALID_SETTINGS)?,
            None => default_kgoose_service_path(false, &configured).to_owned(),
        };
        let base = resolve_org_kgoose_base_url(&configured, Some(&org), false, &service_path)
            .map_err(|_| INVALID_SETTINGS)?;
        let service_url =
            Url::parse(&kgoose_service_url(&base, &service_path)).map_err(|_| INVALID_SETTINGS)?;
        if !matches!(service_url.scheme(), "http" | "https") || service_url.host().is_none() {
            return Err(INVALID_SETTINGS.into());
        }
        let storage = if env.storage.is_some() || env.storage_file.is_some() {
            // A fresh in-memory store per blocking closure would always be empty.
            if env.storage.as_deref() == Some("memory") {
                return Err(MEMORY_STORAGE.into());
            }
            StorageSelection::CrateDefault
        } else if cfg!(target_os = "macos") {
            StorageSelection::CrateDefault
        } else {
            // What `bl` uses under BL_AUTH_STORAGE=file; its keyring is macOS-only.
            StorageSelection::File(bl_home.join("auth-sessions.json"))
        };
        Ok(Config {
            origin: service_url.origin().ascii_serialization(),
            key: SessionStorageKey::from_profile_and_kgoose_base_url(profile, &base, &service_path),
            service_url,
            bl_home,
            storage,
        })
    }
}

#[derive(Clone, Copy)]
enum Op {
    Read,
    Update,
}
/// Fixed strings only. The crate's Keychain errors end in `OSStatus <code>`;
/// everything else is a file, JSON or selection failure.
fn storage_error(op: Op, error: impl std::fmt::Display) -> String {
    let chain = format!("{error:#}");
    match chain
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
fn open_storage(config: &Config, op: Op) -> Result<Box<dyn SessionCredentialStorage>, String> {
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
/// The storage handle is `!Send`, so it is constructed, used and dropped inside
/// one blocking closure. A Keychain dialog blocks the pool thread, never the
/// runtime; there is deliberately no timeout, which would abandon the thread
/// while the dialog stays up.
async fn with_storage<T: Send + 'static>(
    config: Arc<Config>,
    op: Op,
    action: impl FnOnce(&dyn SessionCredentialStorage, &SessionStorageKey) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = open_storage(&config, op)?;
        action(storage.as_ref(), &config.key)
    })
    .await
    .map_err(|_| STORE_UNAVAILABLE)?
}
enum Stored {
    Absent,
    Blank,
    Credential(Zeroizing<String>),
}
async fn read(config: Arc<Config>) -> Result<Stored, String> {
    with_storage(config, Op::Read, |storage, key| {
        // The crate value holds a plain String and derives Debug; it is never
        // formatted and drops here.
        Ok(
            match storage
                .get(key)
                .map_err(|error| storage_error(Op::Read, error))?
            {
                None => Stored::Absent,
                Some(stored) => match stored.session_credential_header_value() {
                    None => Stored::Blank,
                    Some(credential) => Stored::Credential(Zeroizing::new(credential)),
                },
            },
        )
    })
    .await
}
/// Writes `{sessionCredential, expiresAt}`, the shape `bl` writes, and returns
/// the previous credential when it differed so the caller can revoke it.
async fn write(
    config: Arc<Config>,
    credential: Zeroizing<String>,
    expires_at: Option<String>,
) -> Result<Option<Zeroizing<String>>, String> {
    with_storage(config, Op::Update, move |storage, key| {
        let previous = storage
            .get(key)
            .map_err(|error| storage_error(Op::Update, error))?
            .and_then(|stored| stored.session_credential_header_value())
            .map(Zeroizing::new)
            .filter(|previous| previous.as_str() != credential.as_str());
        let stored = StoredSessionCredential {
            session_credential: credential.as_str().to_owned(),
            expires_at,
        };
        storage
            .set(key, &stored)
            .map_err(|error| storage_error(Op::Update, error))?;
        Ok(previous)
    })
    .await
}
/// Deletes the item, or only while it still holds `expected`, so an item `bl`
/// rotated during a `/me` round-trip survives.
async fn delete(config: Arc<Config>, expected: Option<Zeroizing<String>>) -> Result<(), String> {
    with_storage(config, Op::Update, move |storage, key| {
        if let Some(expected) = &expected {
            let current = storage
                .get(key)
                .map_err(|error| storage_error(Op::Update, error))?
                .and_then(|stored| stored.session_credential_header_value())
                .map(Zeroizing::new);
            if current.as_deref().map(String::as_str) != Some(expected.as_str()) {
                return Ok(());
            }
        }
        storage
            .delete(key)
            .map(drop)
            .map_err(|error| storage_error(Op::Update, error))
    })
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Account {
    expires_at: Option<String>,
    email: Option<String>,
    name: Option<String>,
    capabilities: Capabilities,
    /// Always true natively: the session is the `bl` CLI's too.
    shared: bool,
}
/// Inner key stays snake_case, as the hosted-communities `api.ts` expects.
#[derive(Debug, Serialize)]
struct Capabilities {
    can_delete_buzz_communities: bool,
}
enum Me {
    Account(Account),
    Unauthenticated(u16),
}
/// The exchange result; nothing holding the credential derives Debug.
struct Exchanged {
    credential: Zeroizing<String>,
    expires_at: Option<String>,
}

impl Config {
    fn endpoint(&self, path: &str) -> Url {
        let mut url = self.service_url.clone();
        url.set_path(&format!(
            "{}{path}",
            self.service_url.path().trim_end_matches('/')
        ));
        url.set_query(None);
        url
    }
    fn login_url(&self, return_to: &str) -> Url {
        let mut url = self.endpoint("/v1/auth/login");
        url.query_pairs_mut()
            .append_pair("type", "cli")
            .append_pair("product", "buzz")
            .append_pair("returnTo", return_to);
        url
    }
}
/// Redirects stay off: a 3xx would forward the session header cross-origin.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .user_agent(USER_AGENT)
                .build()
        })
        .as_ref()
        .map_err(|_| "Builderlab network client is unavailable".into())
}
async fn read_bounded(
    mut response: reqwest::Response,
    limit: usize,
    failed: &str,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(TOO_LARGE.into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| failed.to_owned())? {
        if chunk.len() > limit - body.len() {
            return Err(TOO_LARGE.into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
/// Loopback callback text is attacker-influenceable; bound it before display.
fn sanitize(detail: &str) -> String {
    detail
        .chars()
        .take(200)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

struct CallbackState {
    nonce: String,
    sender: Mutex<Option<oneshot::Sender<Result<String, String>>>>,
}
/// Sends on drop so every exit path closes the accept loop while an in-flight
/// page still flushes.
struct Shutdown(Option<oneshot::Sender<()>>);
impl Drop for Shutdown {
    fn drop(&mut self) {
        if let Some(stop) = self.0.take() {
            let _ = stop.send(());
        }
    }
}
async fn callback(
    RoutePath(nonce): RoutePath<String>,
    Query(query): Query<HashMap<String, String>>,
    RouteState(state): RouteState<Arc<CallbackState>>,
) -> Response {
    let not_found = || (StatusCode::NOT_FOUND, "Not found").into_response();
    if nonce != state.nonce {
        return not_found();
    }
    // A second callback finds the sender already consumed.
    let Some(sender) = state
        .sender
        .lock()
        .ok()
        .and_then(|mut sender| sender.take())
    else {
        return not_found();
    };
    match query.get("code").filter(|code| !code.is_empty()) {
        Some(code) => {
            let _ = sender.send(Ok(code.clone()));
            Html(COMPLETE_HTML).into_response()
        }
        None => {
            let detail = query
                .get("error_description")
                .or_else(|| query.get("error"))
                .map(|detail| sanitize(detail))
                .unwrap_or_else(|| "Authentication callback did not include a code".into());
            let _ = sender.send(Err(detail));
            (StatusCode::BAD_REQUEST, Html(FAILED_HTML)).into_response()
        }
    }
}
/// Binds, arms shutdown, then opens the browser; waits on the callback, the
/// ten-minute timeout or cancel. Browser-side failures never reach the
/// loopback, so the timeout is their only exit.
async fn await_callback(
    config: &Config,
    opener: &dyn BrowserOpener,
    canceled: &mut oneshot::Receiver<()>,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| LISTENER)?;
    let port = listener.local_addr().map_err(|_| LISTENER)?.port();
    let (stop, stopped) = oneshot::channel();
    let _shutdown = Shutdown(Some(stop));
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let (sender, receiver) = oneshot::channel();
    let state = Arc::new(CallbackState {
        nonce: nonce.clone(),
        sender: Mutex::new(Some(sender)),
    });
    let router = Router::new()
        .route("/callback/{nonce}", get(callback))
        .with_state(state);
    // Detached: the command never waits on a lingering browser keep-alive.
    tokio::spawn(
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .into_future(),
    );
    let return_to = format!("http://127.0.0.1:{port}/callback/{nonce}");
    opener.open(config.login_url(&return_to).as_str())?;
    // Only an explicit cancel counts; a dropped sender disables the branch.
    tokio::select! {
        outcome = tokio::time::timeout(LOGIN_TIMEOUT, receiver) => match outcome {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err(LISTENER.into()),
            Err(_) => Err(TIMED_OUT.into()),
        },
        Ok(()) = canceled => Err(CANCELED.into()),
    }
}
async fn exchange(config: &Config, code: &str) -> Result<Exchanged, String> {
    const FAILED: &str = "Builderlab code exchange failed";
    let response = client()?
        .post(config.endpoint("/v1/auth/login/exchange"))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|_| FAILED)?;
    let status = response.status();
    if !status.is_success() {
        let mut message = format!("{FAILED} with HTTP {}", status.as_u16());
        // A structured `{error: {code}}` body names the cause; plain text does not.
        let body = read_bounded(response, MAX_ERROR_BODY, FAILED)
            .await
            .unwrap_or_default();
        if let Some(code) = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|value| value.get("error")?.get("code")?.as_str().map(sanitize))
        {
            message.push_str(&format!(" ({code})"));
        }
        return Err(message);
    }
    let body = Zeroizing::new(read_bounded(response, MAX_BODY, FAILED).await?);
    let value: Value =
        serde_json::from_slice(&body).map_err(|_| "invalid Builderlab code exchange response")?;
    let credential = Zeroizing::new(
        value
            .get("session_credential")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    );
    if credential.is_empty() {
        return Err("Builderlab code exchange returned an empty credential".into());
    }
    Ok(Exchanged {
        credential,
        expires_at: value
            .get("expires_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
/// 401 and 403 mean signed out; any other failure keeps the stored item. A 3xx
/// lands here unfollowed. Capabilities use strict boolean equality.
async fn me(config: &Config, credential: &str) -> Result<Me, String> {
    const FAILED: &str = "Builderlab session check failed";
    const INVALID: &str = "invalid Builderlab session response";
    let response = client()?
        .get(config.endpoint("/v1/auth/me"))
        .header(SESSION_CREDENTIAL_HEADER, credential)
        .send()
        .await
        .map_err(|_| FAILED)?;
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403) {
        return Ok(Me::Unauthenticated(status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("{FAILED} with HTTP {}", status.as_u16()));
    }
    let body = read_bounded(response, MAX_BODY, FAILED).await?;
    let value: Value = serde_json::from_slice(&body).map_err(|_| INVALID)?;
    let object = value.as_object().ok_or(INVALID)?;
    let text = |field: &str| object.get(field).and_then(Value::as_str).map(str::to_owned);
    Ok(Me::Account(Account {
        expires_at: text("expires_at"),
        email: text("email"),
        name: text("name"),
        capabilities: Capabilities {
            can_delete_buzz_communities: object
                .get("capabilities")
                .and_then(|capabilities| capabilities.get("can_delete_buzz_communities"))
                == Some(&Value::Bool(true)),
        },
        shared: true,
    }))
}
/// `POST /v1/auth/logout` revokes exactly one CLI session and always answers
/// 302, which an unfollowed client receives as-is; an unknown credential is a
/// no-op. The outcome needs no handling, so none is returned.
async fn revoke(config: &Config, credential: &str) {
    if let Ok(client) = client() {
        let _ = client
            .post(config.endpoint("/v1/auth/logout"))
            .header(SESSION_CREDENTIAL_HEADER, credential)
            .timeout(Duration::from_secs(5))
            .send()
            .await;
    }
}

struct Pending {
    id: u64,
    cancel: Option<oneshot::Sender<()>>,
}
/// Serialises Buzz's own operations; never holds a session, which lives only in
/// the shared store.
struct State {
    generation: u64,
    pending: Option<Pending>,
}
#[derive(Clone)]
pub(crate) struct BuilderlabHost {
    config: Result<Arc<Config>, String>,
    state: Arc<Mutex<State>>,
}
impl BuilderlabHost {
    pub(crate) fn new(config: Result<Config, String>) -> Self {
        Self {
            config: config.map(Arc::new),
            state: Arc::new(Mutex::new(State {
                generation: 0,
                pending: None,
            })),
        }
    }
    fn config(&self) -> Result<Arc<Config>, String> {
        self.config.clone()
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.state.lock().map_err(|_| STATE_UNAVAILABLE.into())
    }
    /// Bumps the generation, ends any pending login and installs the new one.
    fn begin(&self, cancel: Option<oneshot::Sender<()>>) -> Result<u64, String> {
        let mut state = self.lock()?;
        state.generation += 1;
        let generation = state.generation;
        if let Some(Pending {
            cancel: Some(previous),
            ..
        }) = state.pending.take()
        {
            let _ = previous.send(());
        }
        state.pending = cancel.map(|cancel| Pending {
            id: generation,
            cancel: Some(cancel),
        });
        Ok(generation)
    }
    fn owns(&self, id: u64) -> Result<bool, String> {
        Ok(self
            .lock()?
            .pending
            .as_ref()
            .is_some_and(|pending| pending.id == id))
    }
    /// Clears the pending slot while it is still login `id`'s.
    fn retire(&self, id: u64) {
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
    /// The follow-on's `Origin` header and challenge origin.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn origin(&self) -> Result<String, String> {
        self.config().map(|config| config.origin.clone())
    }
    /// A snapshot so a bind can refuse to sign after a sign-out or new login.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn generation(&self) -> Result<u64, String> {
        self.lock().map(|state| state.generation)
    }
    /// POST with the session header and Origin for the follow-on's `/v1/buzz/*`
    /// routes. Objects pass through on 2xx or with an `error` member, with the
    /// status for the deletion flow's 202. A 401 does not clear the item; the
    /// UI maps `unauthorized` to its reconnect state.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) async fn authenticated(
        &self,
        path: &str,
        body: Value,
        timeout: Duration,
    ) -> Result<(StatusCode, Value), String> {
        const FAILED: &str = "Builderlab request failed";
        let config = self.config()?;
        let Stored::Credential(credential) = read(config.clone()).await? else {
            return Err(SIGN_IN_FIRST.into());
        };
        let response = client()?
            .post(config.endpoint(path))
            .header(SESSION_CREDENTIAL_HEADER, credential.as_str())
            .header("Origin", &config.origin)
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| FAILED)?;
        drop(credential);
        let status = response.status();
        let body = read_bounded(response, MAX_BODY, FAILED).await?;
        let value = serde_json::from_slice::<Value>(&body)
            .ok()
            .filter(Value::is_object);
        let structured = value
            .as_ref()
            .and_then(|value| value.get("error"))
            .is_some_and(|error| !error.is_null());
        match value {
            Some(value) if status.is_success() || structured => Ok((status, value)),
            // A gateway error page is a failed request, not an invalid one.
            _ if status.is_success() => Err(INVALID_RESPONSE.into()),
            _ => Err(format!("{FAILED} (HTTP {}).", status.as_u16())),
        }
    }
    pub(crate) async fn login(&self, opener: &dyn BrowserOpener) -> Result<Account, String> {
        let config = self.config()?;
        let (cancel, mut canceled) = oneshot::channel();
        let id = self.begin(Some(cancel))?;
        let result = self.attempt(&config, id, opener, &mut canceled).await;
        self.retire(id);
        result
    }
    async fn attempt(
        &self,
        config: &Arc<Config>,
        id: u64,
        opener: &dyn BrowserOpener,
        canceled: &mut oneshot::Receiver<()>,
    ) -> Result<Account, String> {
        // Mirror bl's short-circuit: a stored credential that passes /me needs
        // no browser. A dead one falls through and the write replaces it.
        let probe = async {
            match read(config.clone()).await? {
                Stored::Credential(credential) => me(config, &credential).await.map(Some),
                Stored::Absent | Stored::Blank => Ok(None),
            }
        };
        let probed = tokio::select! {
            probed = probe => probed?,
            Ok(()) = &mut *canceled => return Err(CANCELED.into()),
        };
        if let Some(Me::Account(account)) = probed {
            return Ok(account);
        }
        let code = await_callback(config, opener, canceled).await?;
        // The finish settles on its own, so cancel returns promptly and a
        // dropped IPC future (webview reload) does not lose the session.
        let finish = tokio::spawn(finish(self.clone(), config.clone(), id, code));
        // Settling clears the pending slot and drops the cancel sender; only an
        // explicit cancel ends the wait early.
        tokio::select! {
            outcome = finish => outcome.map_err(|_| CANCELED.to_owned())?,
            Ok(()) = canceled => Err(CANCELED.into()),
        }
    }
    /// Writes the minted session only while login `id` is still current; a
    /// stale completion revokes it instead, and a sign-out or login that
    /// interleaved with the write takes the item back.
    async fn settle(
        &self,
        config: Arc<Config>,
        id: u64,
        exchanged: Exchanged,
        account: Account,
    ) -> Result<Account, String> {
        let Exchanged {
            credential,
            expires_at,
        } = exchanged;
        if !self.owns(id)? {
            revoke(&config, &credential).await;
            return Err(CANCELED.into());
        }
        let previous = match write(config.clone(), credential.clone(), expires_at).await {
            Ok(previous) => previous,
            Err(error) => {
                // Never leave a live session that no tool holds.
                revoke(&config, &credential).await;
                return Err(error);
            }
        };
        let current = {
            let mut state = self.lock()?;
            let current = state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id);
            if current {
                state.pending = None;
            }
            current
        };
        if !current {
            let _ = delete(config.clone(), Some(credential.clone())).await;
            revoke(&config, &credential).await;
            return Err(CANCELED.into());
        }
        if let Some(previous) = previous {
            // Two live sessions under one key would leave one nobody can reach.
            tokio::spawn(async move { revoke(&config, &previous).await });
        }
        Ok(account)
    }
    pub(crate) fn cancel(&self) -> Result<(), String> {
        if let Some(Pending {
            cancel: Some(cancel),
            ..
        }) = self.lock()?.pending.take()
        {
            let _ = cancel.send(());
        }
        Ok(())
    }
    /// Revokes server-side under a short cap, then deletes locally regardless:
    /// the user asked to sign out of this key, and only a failed local delete
    /// may leave the card pretending otherwise.
    pub(crate) async fn sign_out(&self) -> Result<(), String> {
        let config = self.config()?;
        self.begin(None)?;
        if let Stored::Credential(credential) = read(config.clone()).await? {
            revoke(&config, &credential).await;
        }
        delete(config, None).await
    }
    /// Re-reads the store every time; nothing in memory is authoritative.
    pub(crate) async fn auth(&self) -> Result<Option<Account>, String> {
        let config = self.config()?;
        let started = self.lock()?.generation;
        let credential = match read(config.clone()).await? {
            Stored::Absent => return Ok(None),
            Stored::Blank => return delete(config, None).await.map(|()| None),
            Stored::Credential(credential) => credential,
        };
        // Transport and 5xx failures keep the item.
        let probed = me(&config, &credential).await?;
        // Never describe or clear a session a newer operation owns.
        if self.lock()?.generation != started {
            return Err(CHANGED.into());
        }
        match probed {
            Me::Account(account) => Ok(Some(account)),
            Me::Unauthenticated(_) => delete(config, Some(credential)).await.map(|()| None),
        }
    }
}
async fn finish(
    host: BuilderlabHost,
    config: Arc<Config>,
    id: u64,
    code: String,
) -> Result<Account, String> {
    let exchanged = exchange(&config, &code).await?;
    let account = match me(&config, &exchanged.credential).await {
        Ok(Me::Account(account)) => account,
        Ok(Me::Unauthenticated(status)) => {
            revoke(&config, &exchanged.credential).await;
            return Err(format!(
                "Builderlab session check failed with HTTP {status}"
            ));
        }
        Err(error) => {
            revoke(&config, &exchanged.credential).await;
            return Err(error);
        }
    };
    host.settle(config, id, exchanged, account).await
}

#[tauri::command]
pub(crate) async fn builderlab_auth(
    host: tauri::State<'_, BuilderlabHost>,
) -> Result<Option<Account>, String> {
    host.inner().clone().auth().await
}
#[tauri::command]
pub(crate) async fn builderlab_login<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, BuilderlabHost>,
) -> Result<Account, String> {
    host.inner().clone().login(&Opener(app)).await
}
#[tauri::command]
pub(crate) fn builderlab_cancel(host: tauri::State<'_, BuilderlabHost>) -> Result<(), String> {
    host.cancel()
}
#[tauri::command]
pub(crate) async fn builderlab_sign_out(
    host: tauri::State<'_, BuilderlabHost>,
) -> Result<(), String> {
    host.inner().clone().sign_out().await
}

#[cfg(test)]
mod tests;
