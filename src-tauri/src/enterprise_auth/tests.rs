use super::*;
use axum::{
    body::{to_bytes, Body},
    extract::State as AxumState,
    http::{header, Method, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use std::{
    ffi::OsString,
    sync::{
        atomic::{AtomicUsize, Ordering},
        MutexGuard, OnceLock,
    },
};
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    task::JoinHandle,
};

const FUTURE_EXPIRY: &str = "2030-01-01T00:00:00Z";

#[derive(Clone)]
enum Reply {
    Valid {
        expiry: String,
    },
    Status(StatusCode),
    Gated {
        expiry: String,
        started: Arc<Notify>,
        release: Arc<Notify>,
    },
    GatedUnauthorizedThenValid {
        expiry: String,
        started: Arc<Notify>,
        release: Arc<Notify>,
        calls: Arc<AtomicUsize>,
    },
    MalformedSession,
    OversizedSession,
    TruncatedSession,
    Login {
        expiry: String,
    },
    Redirect(Url),
    LargeExchange,
}

struct RequestRecord {
    method: Method,
    path: String,
    authorization: Option<String>,
    body: Vec<u8>,
}

#[derive(Clone)]
struct ServiceState {
    reply: Reply,
    requests: Arc<Mutex<Vec<RequestRecord>>>,
}

struct FixtureServer {
    base: Url,
    requests: Arc<Mutex<Vec<RequestRecord>>>,
    task: JoinHandle<()>,
}

impl FixtureServer {
    async fn spawn(reply: Reply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = ServiceState {
            reply,
            requests: requests.clone(),
        };
        let app = Router::new().fallback(any(handle_request).with_state(state));
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: Url::parse(&format!("http://{address}")).unwrap(),
            requests,
            task,
        }
    }

    fn records(&self) -> std::sync::MutexGuard<'_, Vec<RequestRecord>> {
        self.requests.lock().unwrap()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle_request(
    AxumState(state): AxumState<ServiceState>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1024 * 1024)
        .await
        .map(|bytes| bytes.to_vec())
        .unwrap_or_default();
    let path = parts.uri.path().to_owned();
    state.requests.lock().unwrap().push(RequestRecord {
        method: parts.method,
        path: path.clone(),
        authorization: parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body: bytes,
    });

    match state.reply {
        Reply::Valid { ref expiry } if path.ends_with("/v1/session") => {
            Json(serde_json::json!({ "expires_at": expiry })).into_response()
        }
        Reply::Status(status) if path.ends_with("/v1/session") => {
            (status, Body::empty()).into_response()
        }
        Reply::Gated {
            ref expiry,
            ref started,
            ref release,
        } if path.ends_with("/v1/session") => {
            started.notify_one();
            release.notified().await;
            Json(serde_json::json!({ "expires_at": expiry })).into_response()
        }
        Reply::GatedUnauthorizedThenValid {
            ref expiry,
            ref started,
            ref release,
            ref calls,
        } if path.ends_with("/v1/session") => {
            if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                started.notify_one();
                release.notified().await;
                (StatusCode::UNAUTHORIZED, Body::empty()).into_response()
            } else {
                Json(serde_json::json!({ "expires_at": expiry })).into_response()
            }
        }
        Reply::MalformedSession if path.ends_with("/v1/session") => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("not json"))
            .unwrap(),
        Reply::OversizedSession if path.ends_with("/v1/session") => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONTENT_LENGTH, MAX_SESSION_BODY + 1)
            .body(Body::empty())
            .unwrap(),
        Reply::TruncatedSession if path.ends_with("/v1/session") => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONTENT_LENGTH, 128)
            .body(Body::from(r#"{"expires_at":""#))
            .unwrap(),
        Reply::Login { ref expiry } if path.ends_with("/v1/login/exchange") => {
            Json(serde_json::json!({
                "session_token": "fixture-session-token",
                "expires_at": expiry
            }))
            .into_response()
        }
        Reply::Login { ref expiry } if path.ends_with("/v1/session") => {
            Json(serde_json::json!({ "expires_at": expiry })).into_response()
        }
        Reply::Redirect(ref target) if path.ends_with("/v1/session") => (
            StatusCode::FOUND,
            [(header::LOCATION, target.as_str())],
            Body::empty(),
        )
            .into_response(),
        Reply::LargeExchange if path.ends_with("/v1/login/exchange") => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::CONTENT_LENGTH, MAX_SESSION_BODY + 1)
            .body(Body::from(vec![b'x'; MAX_SESSION_BODY + 1]))
            .unwrap(),
        _ => (StatusCode::NOT_FOUND, Body::empty()).into_response(),
    }
}

static ENV_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();

struct BuilderLabEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl BuilderLabEnv {
    fn new(base_url: &Url) -> Self {
        const KEYS: [&str; 7] = [
            "BL_HOME",
            "BL_SKILLS_PROFILE",
            "BL_SKILLS_CONFIG",
            "KGOOSE_BASE_URL",
            "KGOOSE_SERVICE_PATH",
            "BL_AUTH_STORAGE",
            "BL_AUTH_STORAGE_FILE",
        ];
        let guard = ENV_LOCK.get_or_init(Default::default).lock().unwrap();
        let previous = KEYS
            .into_iter()
            .map(|key| (key, std::env::var_os(key)))
            .collect::<Vec<_>>();
        for (key, _) in &previous {
            std::env::remove_var(key);
        }
        std::env::set_var("KGOOSE_BASE_URL", base_url.as_str());
        std::env::set_var("BL_AUTH_STORAGE", "file");
        Self {
            _guard: guard,
            previous,
        }
    }
}

impl Drop for BuilderLabEnv {
    fn drop(&mut self) {
        for (key, value) in &self.previous {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
    }
}

fn make_owner(home: &TempDir) -> SessionOwner {
    SessionOwner::from_home(
        home.path(),
        Some(home.path().join("app-data")),
        refusal_service_name(),
    )
}

async fn save(owner: &SessionOwner, attempt_id: &str, token: &str, expires_at: Option<&str>) {
    let attempt = owner.begin_attempt(attempt_id).unwrap();
    owner
        .commit_attempt(
            &attempt,
            SessionCredential::new(
                Zeroizing::new(token.to_owned()),
                expires_at.map(str::to_owned),
            ),
        )
        .await
        .unwrap();
    owner.retire_attempt(&attempt);
}

fn session_records(server: &FixtureServer) -> Vec<RequestRecord> {
    server
        .records()
        .drain(..)
        .filter(|record| record.path.ends_with("/v1/session"))
        .collect()
}

#[test]
fn handoff_challenge_is_s256_base64url_and_never_contains_the_verifier() {
    const VERIFIER: &str = "secret";
    let endpoint = Url::parse("https://identity.example/service/v1/login/start").unwrap();
    let url = login_url(endpoint, "http://127.0.0.1:1234/callback/nonce", VERIFIER);
    let query = url.query_pairs().collect::<HashMap<_, _>>();

    assert_eq!(
        query
            .get("handoff_challenge_method")
            .map(|value| value.as_ref()),
        Some("S256")
    );
    assert_eq!(
        query.get("handoff_challenge").map(|value| value.as_ref()),
        Some("K7gNU3sdo-OL0wNhqoVWhr3g6s1xYv72ol_pe_Unols")
    );
    assert_eq!(
        query.get("return_to").map(|value| value.as_ref()),
        Some("http://127.0.0.1:1234/callback/nonce")
    );
    assert!(!url.as_str().contains(VERIFIER));
}

#[test]
fn expiry_comparison_uses_whole_seconds_and_rejects_other_seconds() {
    assert!(expiry_matches_at_second_precision(
        "2030-01-01T00:00:00.987654321Z",
        "2030-01-01T00:00:00Z"
    ));
    assert!(!expiry_matches_at_second_precision(
        "2030-01-01T00:00:00.987654321Z",
        "2030-01-01T00:00:01Z"
    ));
    assert!(!expiry_matches_at_second_precision(
        "invalid",
        FUTURE_EXPIRY
    ));
}

#[test]
fn callback_rejects_wrong_nonce_without_consuming_the_code() {
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
            String::from("fixture-code"),
        )])),
        AxumState(state.clone()),
    ));

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert!(state.sender.lock().unwrap().is_some());
}

#[test]
fn callback_returns_only_bounded_error_text() {
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
async fn callback_wait_is_cancelable_and_reports_listener_failure() {
    let (sender, callback) = oneshot::channel();
    drop(sender);
    let (_cancel_sender, mut canceled) = oneshot::channel();
    assert_eq!(
        wait_for_callback(callback, &mut canceled)
            .await
            .unwrap_err(),
        "Enterprise login callback was interrupted"
    );

    let (cancel_sender, mut canceled) = oneshot::channel();
    let (callback_sender, callback) = oneshot::channel();
    cancel_sender.send(()).unwrap();
    assert_eq!(
        wait_for_callback(callback, &mut canceled)
            .await
            .unwrap_err(),
        CANCELED
    );
    drop(callback_sender);
}

#[tokio::test]
async fn optional_cli_expiry_and_fractional_expiry_survive_session_validation() {
    let server = FixtureServer::spawn(Reply::Valid {
        expiry: FUTURE_EXPIRY.into(),
    })
    .await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);

    save(&owner, "missing-expiry", "cli-session-without-expiry", None).await;
    let missing_expiry = get(&owner).await.unwrap().unwrap();
    assert_eq!(missing_expiry.expires_at, FUTURE_EXPIRY);

    save(
        &owner,
        "fractional-expiry",
        "cli-session-with-fractional-expiry",
        Some("2030-01-01T00:00:00.987654321Z"),
    )
    .await;
    let fractional_expiry = get(&owner).await.unwrap().unwrap();
    assert_eq!(fractional_expiry.expires_at, FUTURE_EXPIRY);
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "cli-session-with-fractional-expiry"
    );

    let records = session_records(&server);
    assert_eq!(records.len(), 2);
    assert!(records.iter().all(|record| record
        .authorization
        .as_deref()
        .is_some_and(|value| { value.starts_with("Bearer cli-session-") })));
}

#[tokio::test]
async fn invalid_session_is_invalidated_but_transient_failure_preserves_it() {
    let invalid = FixtureServer::spawn(Reply::Status(StatusCode::UNAUTHORIZED)).await;
    let _environment = BuilderLabEnv::new(&invalid.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "invalid-session", "invalid-session-token", None).await;

    assert!(get(&owner).await.unwrap().is_none());
    assert!(owner.session_snapshot().await.unwrap().is_none());
    drop(_environment);

    let transient = FixtureServer::spawn(Reply::Status(StatusCode::SERVICE_UNAVAILABLE)).await;
    let _environment = BuilderLabEnv::new(&transient.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "transient-session", "transient-session-token", None).await;

    assert!(get(&owner).await.is_err());
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "transient-session-token"
    );
}

#[tokio::test]
async fn stale_unauthorized_response_cannot_invalidate_a_replacement_session() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let server = FixtureServer::spawn(Reply::GatedUnauthorizedThenValid {
        expiry: FUTURE_EXPIRY.into(),
        started: started.clone(),
        release: release.clone(),
        calls: Arc::new(AtomicUsize::new(0)),
    })
    .await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "old-session", "old-session-token", None).await;

    let request_started = started.notified();
    let validating = {
        let owner = owner.clone();
        tokio::spawn(async move { get(&owner).await })
    };
    request_started.await;
    save(
        &owner,
        "replacement-session",
        "replacement-session-token",
        None,
    )
    .await;
    release.notify_one();

    let info = validating.await.unwrap().unwrap().unwrap();
    assert_eq!(info.expires_at, FUTURE_EXPIRY);
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "replacement-session-token"
    );
    let records = session_records(&server);
    assert_eq!(records.len(), 2);
    assert_eq!(
        records[0].authorization.as_deref(),
        Some("Bearer old-session-token")
    );
    assert_eq!(
        records[1].authorization.as_deref(),
        Some("Bearer replacement-session-token")
    );
}

#[tokio::test]
async fn malformed_or_oversized_session_responses_invalidate_the_saved_item() {
    for reply in [Reply::MalformedSession, Reply::OversizedSession] {
        let server = FixtureServer::spawn(reply).await;
        let _environment = BuilderLabEnv::new(&server.base);
        let home = TempDir::new().unwrap();
        let owner = make_owner(&home);
        save(&owner, "inconsistent-session", "inconsistent-token", None).await;

        assert!(get(&owner).await.unwrap().is_none());
        assert!(owner.session_snapshot().await.unwrap().is_none());
        drop(_environment);
    }
}

#[tokio::test]
async fn interrupted_session_response_preserves_the_saved_item() {
    let server = FixtureServer::spawn(Reply::TruncatedSession).await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "interrupted-session", "interrupted-token", None).await;

    assert!(get(&owner).await.is_err());
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "interrupted-token"
    );
}

#[tokio::test]
async fn clear_during_validation_fences_the_late_success() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let server = FixtureServer::spawn(Reply::Gated {
        expiry: FUTURE_EXPIRY.into(),
        started: started.clone(),
        release: release.clone(),
    })
    .await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "clear-during-check", "old-session-token", None).await;

    let started = started.notified();
    let validating = {
        let owner = owner.clone();
        tokio::spawn(async move { get(&owner).await })
    };
    started.await;
    let old = owner.session_snapshot().await.unwrap().unwrap();
    owner.clear_shared_session().await.unwrap();
    assert!(!owner.is_current(&old));
    release.notify_one();

    assert!(validating.await.unwrap().unwrap().is_none());
    assert!(owner.session_snapshot().await.unwrap().is_none());
}

#[tokio::test]
async fn session_redirect_does_not_replay_the_cli_credential() {
    let target = FixtureServer::spawn(Reply::Valid {
        expiry: FUTURE_EXPIRY.into(),
    })
    .await;
    let redirect = FixtureServer::spawn(Reply::Redirect(target.base.clone())).await;
    let _environment = BuilderLabEnv::new(&redirect.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    save(&owner, "redirect-session", "redirect-session-token", None).await;

    assert!(get(&owner).await.unwrap().is_none());
    assert_eq!(redirect.records().len(), 1);
    assert!(target.records().is_empty());
    let requests = redirect.records();
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("Bearer redirect-session-token")
    );
}

#[tokio::test]
async fn login_exchange_and_session_check_use_the_configured_service_only() {
    let server = FixtureServer::spawn(Reply::Login {
        expiry: FUTURE_EXPIRY.into(),
    })
    .await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    let attempt = owner.begin_attempt("fixture-login").unwrap();
    let http = client().unwrap();

    let (session, info) = exchange_and_check(
        http,
        attempt.endpoint("/v1/login/exchange"),
        attempt.endpoint("/v1/session"),
        "fixture-code",
        "fixture-handoff-verifier",
    )
    .await
    .unwrap();
    owner.commit_attempt(&attempt, session).await.unwrap();
    owner.retire_attempt(&attempt);

    assert_eq!(info.expires_at, FUTURE_EXPIRY);
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "fixture-session-token"
    );
    let records = server.records();
    assert_eq!(records.len(), 2);
    assert!(records[0].path.ends_with("/v1/login/exchange"));
    assert_eq!(records[0].method, Method::POST);
    let exchange: serde_json::Value = serde_json::from_slice(&records[0].body).unwrap();
    assert_eq!(exchange["code"], "fixture-code");
    assert_eq!(exchange["handoff_secret"], "fixture-handoff-verifier");
    assert!(records[0].authorization.is_none());
    assert!(records[1].path.ends_with("/v1/session"));
    assert_eq!(
        records[1].authorization.as_deref(),
        Some("Bearer fixture-session-token")
    );
}

#[tokio::test]
async fn oversized_exchange_response_is_rejected() {
    let server = FixtureServer::spawn(Reply::LargeExchange).await;
    let _environment = BuilderLabEnv::new(&server.base);
    let home = TempDir::new().unwrap();
    let owner = make_owner(&home);
    let attempt = owner.begin_attempt("oversized-login").unwrap();

    let error = match exchange(
        client().unwrap(),
        attempt.endpoint("/v1/login/exchange"),
        "fixture-code",
        "fixture-verifier",
    )
    .await
    {
        Ok(_) => panic!("oversized exchange response was accepted"),
        Err(error) => error,
    };
    assert!(error.contains("too large"));
    owner.retire_attempt(&attempt);
}
