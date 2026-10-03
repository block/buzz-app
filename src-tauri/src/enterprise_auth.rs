use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

use axum::{
    extract::{Path, Query, State as AxumState},
    http::StatusCode,
    response::{Html, IntoResponse, Response},
    routing::get as axum_get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use buzz_builderlab_session::{SessionAttempt, SessionCredential, SessionOwner, SessionSnapshot};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_opener::OpenerExt;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::{net::TcpListener, sync::oneshot};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_CALLBACK_CODE: usize = 4096;
const MAX_CALLBACK_ERROR: usize = 1024;
const MAX_SESSION_TOKEN: usize = 4096;
const MAX_SESSION_EXPIRY: usize = 128;
const MAX_SESSION_BODY: usize = 64 * 1024;
const RELEASE_SERVICE: &str = "dev.local.buzz.foundation.enterprise-session";
const DEBUG_SERVICE: &str = "dev.local.buzz.foundation.enterprise-session.debug";
const AUTHORIZATION: &str = "Authorization";
const CANCELED: &str = "Enterprise authentication was canceled";
const SESSION_CHANGED: &str = "BuilderLab session changed while it was being checked; retry";
const COMPLETE_HTML: &str =
    "<!doctype html><title>Buzz authentication complete</title><p>You can close this window and return to Buzz.</p>";

type Result<T> = std::result::Result<T, String>;

#[cfg(test)]
pub(crate) static BUILDERLAB_TEST_ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EnterpriseAuthInfo {
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

#[derive(Deserialize)]
struct SessionResponse {
    expires_at: String,
}

struct CallbackState {
    nonce: Zeroizing<String>,
    sender: Mutex<Option<oneshot::Sender<Result<String>>>>,
}

enum SessionCheck {
    Valid(EnterpriseAuthInfo),
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

pub(crate) fn refusal_service_name() -> &'static str {
    if cfg!(debug_assertions) {
        DEBUG_SERVICE
    } else {
        RELEASE_SERVICE
    }
}

pub(crate) async fn get(owner: &SessionOwner) -> Result<Option<EnterpriseAuthInfo>> {
    let http = client()?;
    get_with_client(owner, http).await
}

async fn get_with_client(
    owner: &SessionOwner,
    http: &reqwest::Client,
) -> Result<Option<EnterpriseAuthInfo>> {
    for _ in 0..2 {
        let Some(snapshot) = owner.session_snapshot().await? else {
            return Ok(None);
        };
        match check_saved_session(owner, &snapshot, http).await {
            SessionCheck::Valid(info) => {
                if let Some(info) = owner.admit(&snapshot, || info) {
                    return Ok(Some(info));
                }
            }
            SessionCheck::Refused => {}
            SessionCheck::Invalid | SessionCheck::Inconsistent => {
                if owner.invalidate_shared_session(&snapshot).await? {
                    return Ok(None);
                }
            }
            SessionCheck::Transient(error) => {
                if let Some(error) = owner.admit(&snapshot, || error) {
                    return Err(error);
                }
            }
        }
    }
    Err(SESSION_CHANGED.into())
}

pub(crate) async fn start<R: Runtime>(
    owner: &SessionOwner,
    app: &AppHandle<R>,
    attempt_id: Option<String>,
) -> Result<EnterpriseAuthInfo> {
    let id = attempt_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let mut attempt = owner.begin_attempt(id)?;
    let result = run_login(owner, app, &mut attempt).await;
    owner.retire_attempt(&attempt);
    result
}

async fn run_login<R: Runtime>(
    owner: &SessionOwner,
    app: &AppHandle<R>,
    attempt: &mut SessionAttempt,
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
        .route("/callback/{nonce}", axum_get(login_callback))
        .with_state(state);
    let url = login_url(
        attempt.endpoint("/v1/login/start"),
        &callback_url,
        &handoff_secret,
    );
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });

    if app.opener().open_url(url.as_str(), None::<&str>).is_err() {
        server.abort();
        let _ = server.await;
        return Err("Could not open the enterprise sign-in browser".into());
    }

    let callback_result = wait_for_callback(callback, attempt.canceled()).await;
    server.abort();
    let _ = server.await;
    let code = callback_result?;

    let http = client()?;
    let protocol = exchange_and_check(
        http,
        attempt.endpoint("/v1/login/exchange"),
        attempt.endpoint("/v1/session"),
        &code,
        &handoff_secret,
    );
    let (session, info) = tokio::select! {
        biased;
        _ = attempt.canceled() => return Err(CANCELED.into()),
        result = protocol => result?,
    };
    owner.commit_attempt(attempt, session).await?;
    Ok(info)
}

async fn check_saved_session(
    owner: &SessionOwner,
    snapshot: &SessionSnapshot,
    http: &reqwest::Client,
) -> SessionCheck {
    if let Some(expiry) = snapshot.expires_at() {
        if !expiry_is_well_formed(expiry) {
            return SessionCheck::Inconsistent;
        }
        if !expiry_is_current(expiry) {
            return SessionCheck::Invalid;
        }
    }

    let endpoint = match owner.endpoint("/v1/session") {
        Ok(endpoint) => endpoint,
        Err(error) => return SessionCheck::Transient(error),
    };
    let request = owner.admit(snapshot, || {
        let authorization = Zeroizing::new(format!("Bearer {}", snapshot.credential()));
        http.get(endpoint)
            .header(AUTHORIZATION, authorization.as_str())
            .send()
    });
    let Some(request) = request else {
        return SessionCheck::Refused;
    };
    let response = match request.await {
        Ok(response) => response,
        Err(_) => return SessionCheck::Transient("Enterprise session check failed".into()),
    };
    validate_session_response(response, snapshot.expires_at()).await
}

async fn exchange_and_check(
    http: &reqwest::Client,
    exchange_endpoint: Url,
    session_endpoint: Url,
    code: &str,
    handoff_secret: &str,
) -> Result<(SessionCredential, EnterpriseAuthInfo)> {
    let session = exchange(http, exchange_endpoint, code, handoff_secret).await?;
    match check_new_session(http, session_endpoint, &session).await {
        SessionCheck::Valid(info) => Ok((session, info)),
        SessionCheck::Refused | SessionCheck::Invalid | SessionCheck::Inconsistent => {
            Err("Enterprise authentication session was rejected".into())
        }
        SessionCheck::Transient(error) => Err(error),
    }
}

async fn exchange(
    http: &reqwest::Client,
    endpoint: Url,
    code: &str,
    handoff_secret: &str,
) -> Result<SessionCredential> {
    let response = http
        .post(endpoint)
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
    session_from_exchange(response)
}

fn session_from_exchange(response: ExchangeResponse) -> Result<SessionCredential> {
    if response.session_token.is_empty()
        || response.session_token.len() > MAX_SESSION_TOKEN
        || response.session_token.chars().any(char::is_whitespace)
        || response.expires_at.is_empty()
        || response.expires_at.len() > MAX_SESSION_EXPIRY
        || !expiry_is_current(&response.expires_at)
    {
        return Err("Enterprise authentication exchange was invalid".into());
    }
    Ok(SessionCredential::new(
        response.session_token,
        Some(response.expires_at),
    ))
}

async fn check_new_session(
    http: &reqwest::Client,
    endpoint: Url,
    session: &SessionCredential,
) -> SessionCheck {
    let Some(expiry) = session.expires_at() else {
        return SessionCheck::Inconsistent;
    };
    if !expiry_is_well_formed(expiry) {
        return SessionCheck::Inconsistent;
    }
    if !expiry_is_current(expiry) {
        return SessionCheck::Invalid;
    }
    let authorization = Zeroizing::new(format!("Bearer {}", session.credential()));
    let response = match http
        .get(endpoint)
        .header(AUTHORIZATION, authorization.as_str())
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return SessionCheck::Transient("Enterprise session check failed".into()),
    };
    validate_session_response(response, Some(expiry)).await
}

async fn validate_session_response(
    response: reqwest::Response,
    expected_expiry: Option<&str>,
) -> SessionCheck {
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
        || expected_expiry.is_some_and(|expected| {
            !expiry_matches_at_second_precision(expected, &response.expires_at)
        })
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

fn login_url(mut endpoint: Url, callback: &str, handoff_secret: &str) -> Url {
    endpoint
        .query_pairs_mut()
        .append_pair("return_to", callback)
        .append_pair("handoff_challenge", &handoff_challenge(handoff_secret))
        .append_pair("handoff_challenge_method", "S256");
    endpoint
}

fn random_secret() -> Result<Zeroizing<String>> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create enterprise login verifier")?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes)))
}

fn handoff_challenge(secret: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()))
}

async fn wait_for_callback(
    callback: oneshot::Receiver<Result<String>>,
    canceled: &mut oneshot::Receiver<()>,
) -> Result<String> {
    tokio::select! {
        biased;
        _ = &mut *canceled => Err(CANCELED.into()),
        result = callback => match result {
            Ok(result) => result,
            Err(_) => Err("Enterprise login callback was interrupted".into()),
        },
        _ = tokio::time::sleep(LOGIN_TIMEOUT) => Err("Enterprise authentication timed out".into()),
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

fn expiry_is_well_formed(value: &str) -> bool {
    OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

fn expiry_is_current(value: &str) -> bool {
    OffsetDateTime::parse(value, &Rfc3339)
        .is_ok_and(|expires_at| expires_at > OffsetDateTime::now_utc())
}

fn expiry_matches_at_second_precision(expected: &str, actual: &str) -> bool {
    match (
        OffsetDateTime::parse(expected, &Rfc3339),
        OffsetDateTime::parse(actual, &Rfc3339),
    ) {
        (Ok(expected), Ok(actual)) => expected.unix_timestamp() == actual.unix_timestamp(),
        _ => false,
    }
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

#[tauri::command]
pub(crate) async fn get_enterprise_auth(
    owner: State<'_, SessionOwner>,
) -> Result<Option<EnterpriseAuthInfo>> {
    get(owner.inner()).await
}

#[tauri::command]
pub(crate) async fn start_enterprise_auth_login<R: Runtime>(
    app: AppHandle<R>,
    owner: State<'_, SessionOwner>,
    attempt_id: Option<String>,
) -> Result<EnterpriseAuthInfo> {
    start(owner.inner(), &app, attempt_id).await
}

#[tauri::command]
pub(crate) async fn cancel_enterprise_auth_login(
    owner: State<'_, SessionOwner>,
    attempt_id: String,
) -> Result<()> {
    owner.cancel_attempt(&attempt_id)
}

#[tauri::command]
pub(crate) async fn clear_enterprise_auth(owner: State<'_, SessionOwner>) -> Result<()> {
    owner.clear_shared_session().await
}

#[cfg(test)]
#[path = "enterprise_auth/tests.rs"]
mod tests;
