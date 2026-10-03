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
        MutexGuard,
    },
};
use tempfile::TempDir;
use tokio::{net::TcpListener, sync::Notify, task::JoinHandle};

const RELAY: &str = "wss://relay.example";

#[derive(Clone)]
enum FixtureReply {
    IssueForRequest,
    IssueJson(serde_json::Value),
    SessionReplacedDuringDenial(Arc<SessionReplacementGate>),
    Status {
        status: StatusCode,
        code: &'static str,
    },
    Discovery(serde_json::Value),
}

#[derive(Default)]
struct SessionReplacementGate {
    requests: AtomicUsize,
    first_request_started: Notify,
    release_first_request: Notify,
}

#[derive(Clone)]
struct FixtureState {
    reply: FixtureReply,
    requests: Arc<Mutex<Vec<FixtureRequest>>>,
}

struct FixtureRequest {
    method: Method,
    path: String,
    authorization: Option<String>,
    proof: Option<String>,
    body: Vec<u8>,
}

struct FixtureServer {
    base: Url,
    requests: Arc<Mutex<Vec<FixtureRequest>>>,
    task: JoinHandle<()>,
}

impl FixtureServer {
    async fn spawn(reply: FixtureReply) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = FixtureState {
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

    fn info_url(&self) -> Url {
        self.base.join("info").unwrap()
    }

    fn records(&self) -> std::sync::MutexGuard<'_, Vec<FixtureRequest>> {
        self.requests.lock().unwrap()
    }
}

impl Drop for FixtureServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle_request(
    AxumState(state): AxumState<FixtureState>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = to_bytes(body, 1024 * 1024)
        .await
        .map(|body| body.to_vec())
        .unwrap_or_default();
    let path = parts.uri.path().to_owned();
    state.requests.lock().unwrap().push(FixtureRequest {
        method: parts.method,
        path: path.clone(),
        authorization: parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        proof: parts
            .headers
            .get("Nostr-Authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
        body: bytes.clone(),
    });

    match state.reply {
        FixtureReply::Discovery(ref document) if path == "/info" => {
            Json(document.clone()).into_response()
        }
        FixtureReply::IssueForRequest if path.ends_with(ASSERTION_PATH) => {
            let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            Json(serde_json::json!({
                "assertion": "fixture.assertion",
                "nostr_pubkey": request["nostr_pubkey"],
                "expires_at": now().unwrap() + 240,
            }))
            .into_response()
        }
        FixtureReply::SessionReplacedDuringDenial(ref gate) if path.ends_with(ASSERTION_PATH) => {
            if gate.requests.fetch_add(1, Ordering::SeqCst) == 0 {
                gate.first_request_started.notify_one();
                gate.release_first_request.notified().await;
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "session_expired"})),
                )
                    .into_response()
            } else {
                let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                Json(serde_json::json!({
                    "assertion": "fixture.assertion",
                    "nostr_pubkey": request["nostr_pubkey"],
                    "expires_at": now().unwrap() + 240,
                }))
                .into_response()
            }
        }
        FixtureReply::IssueJson(ref document) if path.ends_with(ASSERTION_PATH) => {
            Json(document.clone()).into_response()
        }
        FixtureReply::Status { status, code } if path.ends_with(ASSERTION_PATH) => {
            (status, Json(serde_json::json!({ "error": code }))).into_response()
        }
        _ => (StatusCode::NOT_FOUND, Body::empty()).into_response(),
    }
}

static TEST_ENVIRONMENT_KEYS: [&str; 7] = [
    "BL_HOME",
    "BL_SKILLS_PROFILE",
    "BL_SKILLS_CONFIG",
    "KGOOSE_BASE_URL",
    "KGOOSE_SERVICE_PATH",
    "BL_AUTH_STORAGE",
    "BL_AUTH_STORAGE_FILE",
];

struct BuilderLabEnv {
    _guard: MutexGuard<'static, ()>,
    previous: Vec<(&'static str, Option<OsString>)>,
}

impl BuilderLabEnv {
    fn new(base_url: &Url) -> Self {
        let guard = crate::enterprise_auth::BUILDERLAB_TEST_ENV_LOCK
            .get_or_init(Default::default)
            .lock()
            .unwrap();
        let previous = TEST_ENVIRONMENT_KEYS
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

fn owner(home: &TempDir) -> SessionOwner {
    SessionOwner::from_home(
        home.path(),
        Some(home.path().join("app-data")),
        crate::enterprise_auth::refusal_service_name(),
    )
}

async fn save(owner: &SessionOwner, id: &str, token: &str) {
    let attempt = owner.begin_attempt(id).unwrap();
    owner
        .commit_attempt(
            &attempt,
            buzz_builderlab_session::SessionCredential::new(Zeroizing::new(token.to_owned()), None),
        )
        .await
        .unwrap();
    owner.retire_attempt(&attempt);
}

fn required_document(issuer: &str) -> serde_json::Value {
    serde_json::json!({
        "limitation": { "federated_identity": true },
        "federated_identity": {
            "core": "client-attached",
            "issuer": issuer,
            "assertion_freshness": {
                "class": "offline-jwt",
                "maximum_residual_upstream_revocation_seconds": null
            }
        }
    })
}

fn fixture_assertions(owner: SessionOwner, discovery: &FixtureServer) -> RelayAssertions {
    RelayAssertions::new(owner).with_discovery_url(discovery.info_url())
}

async fn issue_raw(response: Vec<u8>, signed_at: u64) -> Result<Assertion> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}{ASSERTION_PATH}",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let server = tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let mut request = [0; 16 * 1024];
        let _ = tcp.read(&mut request).await;
        tcp.write_all(&response).await.unwrap();
    });

    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "raw-response", "fixture-cli-session").await;
    let snapshot = owner.session_snapshot().await.unwrap().unwrap();
    let identity = IdentityHost::fixture();
    let result = issue(
        &owner,
        &snapshot,
        client()?,
        &endpoint,
        &identity,
        RELAY,
        signed_at,
    )
    .await
    .map_err(|failure| match failure {
        IssueFailure::SessionDenied => SIGN_IN_REQUIRED.to_owned(),
        IssueFailure::Failed(error) => error,
    });
    server.await.unwrap();
    result
}

fn raw_http(status: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn issues_badge_for_the_signer_and_sends_session_only_to_configured_service() {
    let service = FixtureServer::spawn(FixtureReply::IssueForRequest).await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "file:///issuer-from-nip11",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "badge-session", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let identity = IdentityHost::fixture();
    let pubkey = identity.viewer().await.unwrap();
    let url = Url::parse("wss://relay.example/query").unwrap();

    let assertion = assertions
        .get(&identity, &url, false)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(assertion.header.as_str(), "Bearer fixture.assertion");
    let requests = service.records();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, Method::POST);
    assert!(requests[0].path.ends_with(ASSERTION_PATH));
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("Bearer fixture-cli-session")
    );
    let body: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "relay_url": "wss://relay.example", "nostr_pubkey": pubkey })
    );
    let proof = requests[0].proof.as_deref().unwrap();
    let proof: serde_json::Value = serde_json::from_slice(
        &STANDARD
            .decode(proof.strip_prefix("Nostr ").unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(proof["kind"], 27235);
    assert_eq!(proof["pubkey"], pubkey.as_str());
    let tags = proof["tags"].as_array().unwrap();
    let tag = |name: &str| {
        tags.iter()
            .find(|tag| tag[0] == name)
            .map(|tag| tag[1].as_str().unwrap().to_owned())
            .unwrap()
    };
    assert_eq!(tag("u"), owner.endpoint(ASSERTION_PATH).unwrap().as_str());
    assert_eq!(tag("method"), "POST");
    assert_eq!(
        tag("payload"),
        format!("{:x}", Sha256::digest(&requests[0].body))
    );
    assert!(discovery.records()[0].path == "/info");
}

#[tokio::test]
async fn session_denial_refuses_the_exact_shared_session() {
    let service = FixtureServer::spawn(FixtureReply::Status {
        status: StatusCode::UNAUTHORIZED,
        code: "session_expired",
    })
    .await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "rejected-session", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();

    let error = assertions.get(&identity, &url, true).await.unwrap_err();

    assert_eq!(error, SIGN_IN_REQUIRED);
    assert!(owner.session_snapshot().await.unwrap().is_none());
    assert!(service.records()[0]
        .authorization
        .as_deref()
        .is_some_and(|header| header == "Bearer fixture-cli-session"));
}

#[tokio::test]
async fn a_late_session_denial_retries_with_the_replacement_without_signing_out() {
    let gate = Arc::new(SessionReplacementGate::default());
    let service =
        FixtureServer::spawn(FixtureReply::SessionReplacedDuringDenial(gate.clone())).await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "old-login", "old-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();
    let first_request_started = gate.first_request_started.notified();
    tokio::pin!(first_request_started);
    let request = tokio::spawn(async move { assertions.get(&identity, &url, true).await });

    first_request_started.await;
    save(&owner, "new-login", "new-cli-session").await;
    gate.release_first_request.notify_one();

    let assertion = request.await.unwrap().unwrap().unwrap();
    assert_eq!(assertion.header.as_str(), "Bearer fixture.assertion");
    let requests = service.records();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some("Bearer old-cli-session")
    );
    assert_eq!(
        requests[1].authorization.as_deref(),
        Some("Bearer new-cli-session")
    );
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "new-cli-session"
    );
}

#[tokio::test]
async fn policy_and_proof_denials_preserve_the_shared_session() {
    let service = FixtureServer::spawn(FixtureReply::Status {
        status: StatusCode::FORBIDDEN,
        code: "binding_mismatch",
    })
    .await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "policy-denial", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();

    let error = assertions.get(&identity, &url, true).await.unwrap_err();

    assert!(error.contains("403 binding_mismatch"));
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "fixture-cli-session"
    );
}

#[tokio::test]
async fn relay_policy_denial_preserves_the_shared_session() {
    let service = FixtureServer::spawn(FixtureReply::Status {
        status: StatusCode::FORBIDDEN,
        code: "authorization_denied",
    })
    .await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "policy-denial", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();

    let error = assertions.get(&identity, &url, true).await.unwrap_err();

    assert_eq!(error, ACCESS_DENIED);
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "fixture-cli-session"
    );
}

#[tokio::test]
async fn only_overload_refusals_are_retryable() {
    for (status, code, retryable) in [
        (StatusCode::UNAUTHORIZED, "invalid_proof", false),
        (StatusCode::FORBIDDEN, "binding_mismatch", false),
        (StatusCode::BAD_REQUEST, "invalid_request", false),
        (StatusCode::PAYLOAD_TOO_LARGE, "request_too_large", false),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited", true),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "issuance_unavailable",
            true,
        ),
    ] {
        let service = FixtureServer::spawn(FixtureReply::Status { status, code }).await;
        let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
            "https://ignored.example/v1/identity/assertions",
        )))
        .await;
        let _environment = BuilderLabEnv::new(&service.base);
        let home = TempDir::new().unwrap();
        let owner = owner(&home);
        save(&owner, code, "fixture-cli-session").await;
        let assertions = fixture_assertions(owner.clone(), &discovery);
        let identity = IdentityHost::fixture();
        let url = Url::parse("wss://relay.example/query").unwrap();

        let error = assertions.get(&identity, &url, true).await.unwrap_err();
        if retryable {
            assert!(error.starts_with("Relay badge is unavailable"), "{error}");
        } else {
            assert!(error.starts_with(REFUSED), "{error}");
        }
        assert_eq!(
            owner
                .session_snapshot()
                .await
                .unwrap()
                .unwrap()
                .credential(),
            "fixture-cli-session"
        );
    }
}

#[test]
fn only_contract_session_denials_prompt_for_sign_in() {
    for (status, code, denied) in [
        (401, "session_expired", true),
        (401, "session_required", true),
        (403, "authorization_denied", false),
        (401, "invalid_proof", false),
        (403, "binding_mismatch", false),
        (403, "", false),
        (429, "rate_limited", false),
        (503, "issuance_unavailable", false),
    ] {
        assert_eq!(session_denied(status, code), denied, "{status} {code}");
    }
}

#[tokio::test]
async fn malformed_successful_responses_are_final_and_do_not_echo_the_body() {
    for body in [
        b"not json".as_slice(),
        br#"{"assertion":"a b","nostr_pubkey":"x","expires_at":1}"#,
        br#"{"error":"secret-token"}"#,
    ] {
        let error = issue_raw(raw_http("200 OK", body), now().unwrap())
            .await
            .unwrap_err();
        assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
        assert!(!error.contains("secret-token"));
    }
    let pubkey = IdentityHost::fixture().viewer().await.unwrap();
    let body = serde_json::json!({
        "assertion": "a\u{7f}b",
        "nostr_pubkey": pubkey,
        "expires_at": now().unwrap() + 60,
    });
    let error = issue_raw(
        raw_http("200 OK", &serde_json::to_vec(&body).unwrap()),
        now().unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
}

#[tokio::test]
async fn rejects_badge_for_another_key_or_invalid_lifetime() {
    let pubkey = IdentityHost::fixture().viewer().await.unwrap();
    let issued_at = now().unwrap();
    for body in [
        serde_json::json!({
            "assertion": "fixture.assertion",
            "nostr_pubkey": "0".repeat(64),
            "expires_at": issued_at + 60,
        }),
        serde_json::json!({
            "assertion": "fixture.assertion",
            "nostr_pubkey": pubkey.clone(),
            "expires_at": issued_at + MAX_LIFETIME + 60,
        }),
        serde_json::json!({
            "assertion": "fixture.assertion",
            "nostr_pubkey": pubkey,
            "expires_at": issued_at,
        }),
    ] {
        let response = raw_http("200 OK", &serde_json::to_vec(&body).unwrap());
        let error = issue_raw(response, issued_at).await.unwrap_err();
        assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
    }
}

#[tokio::test]
async fn an_oversized_body_still_uses_http_status_to_classify_refusals() {
    let body = vec![b'x'; MAX_RESPONSE + 1];
    for (status, final_refusal) in [
        ("200 OK", true),
        ("400 Bad Request", true),
        ("413 Payload Too Large", true),
        ("429 Too Many Requests", false),
        ("503 Service Unavailable", false),
    ] {
        let response = raw_http(status, &body);
        let error = issue_raw(response, now().unwrap()).await.unwrap_err();
        assert_eq!(
            error.starts_with(REFUSED),
            final_refusal,
            "{status}: {error}"
        );
    }
}

#[tokio::test]
async fn interrupted_responses_remain_retryable() {
    let response =
        b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{}".to_vec();
    let error = issue_raw(response, now().unwrap()).await.unwrap_err();
    assert_eq!(error, "Relay badge response was interrupted");
}

#[tokio::test]
async fn a_full_lifetime_badge_is_validated_from_response_arrival() {
    let received = now().unwrap();
    let signed_at = received - 5;
    let expires_at = received + MAX_LIFETIME;
    let pubkey = IdentityHost::fixture().viewer().await.unwrap();
    let body = serde_json::json!({
        "assertion": "fixture.assertion",
        "nostr_pubkey": pubkey,
        "expires_at": expires_at,
    });
    let assertion = issue_raw(
        raw_http("200 OK", &serde_json::to_vec(&body).unwrap()),
        signed_at,
    )
    .await
    .unwrap();
    assert_eq!(assertion.expires_at, expires_at);
}

#[tokio::test]
async fn ordinary_relays_bypass_badges_and_gate_uses_the_shared_requirement_cache() {
    let service = FixtureServer::spawn(FixtureReply::IssueForRequest).await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(serde_json::json!({
        "name": "ordinary relay"
    })))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    let assertions = fixture_assertions(owner, &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();

    assert_eq!(
        assertions.enterprise_login_gate(RELAY).await.unwrap(),
        EnterpriseLoginGateStatus::NotRequired
    );
    assert!(assertions
        .get(&identity, &url, false)
        .await
        .unwrap()
        .is_none());
    assert_eq!(discovery.records().len(), 1);
    assert!(service.records().is_empty());
}

#[tokio::test]
async fn required_gate_and_badge_lookup_share_one_nip11_read() {
    let service = FixtureServer::spawn(FixtureReply::IssueForRequest).await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "required-badge", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner, &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();

    assert_eq!(
        assertions.enterprise_login_gate(RELAY).await.unwrap(),
        EnterpriseLoginGateStatus::Required
    );
    assert!(assertions
        .get(&identity, &url, false)
        .await
        .unwrap()
        .is_some());
    assert_eq!(discovery.records().len(), 1);
    assert_eq!(service.records().len(), 1);
}

#[tokio::test]
async fn malformed_assertions_are_rejected_without_refusing_the_session() {
    let identity = IdentityHost::fixture();
    let service = FixtureServer::spawn(FixtureReply::IssueJson(serde_json::json!({
        "assertion": "fixture.assertion",
        "nostr_pubkey": "0".repeat(64),
        "expires_at": now().unwrap() + 120,
    })))
    .await;
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let _environment = BuilderLabEnv::new(&service.base);
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    save(&owner, "invalid-badge", "fixture-cli-session").await;
    let assertions = fixture_assertions(owner.clone(), &discovery);
    let url = Url::parse("wss://relay.example/query").unwrap();

    let error = assertions.get(&identity, &url, false).await.unwrap_err();

    assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
    assert_eq!(
        owner
            .session_snapshot()
            .await
            .unwrap()
            .unwrap()
            .credential(),
        "fixture-cli-session"
    );
}

#[test]
fn relay_requirement_cache_expires_and_is_bounded() {
    let temp = TempDir::new().unwrap();
    let service = Url::parse("http://127.0.0.1:9000").unwrap();
    let _environment = BuilderLabEnv::new(&service);
    let owner = SessionOwner::from_home(temp.path(), None, "test-enterprise-session");
    let assertions = RelayAssertions::new(owner);
    let checked_at = Instant::now();
    assertions
        .cache_requirement("wss://relay.example/".into(), true, checked_at)
        .unwrap();
    assert_eq!(
        assertions
            .cached_requirement(
                "wss://relay.example/",
                checked_at + REQUIREMENT_CACHE_TTL - Duration::from_nanos(1)
            )
            .unwrap(),
        Some(true)
    );
    assert_eq!(
        assertions
            .cached_requirement("wss://relay.example/", checked_at + REQUIREMENT_CACHE_TTL)
            .unwrap(),
        None
    );

    for index in 0..=MAX_REQUIREMENT_CACHE {
        assertions
            .cache_requirement(format!("wss://relay-{index}.example/"), false, checked_at)
            .unwrap();
    }
    assert_eq!(
        assertions.requirements.lock().unwrap().len(),
        MAX_REQUIREMENT_CACHE
    );
}

#[tokio::test]
async fn an_expired_badge_deadline_stops_before_relay_discovery() {
    let discovery = FixtureServer::spawn(FixtureReply::Discovery(required_document(
        "https://ignored.example/v1/identity/assertions",
    )))
    .await;
    let home = TempDir::new().unwrap();
    let owner = owner(&home);
    let assertions = fixture_assertions(owner, &discovery);
    let identity = IdentityHost::fixture();
    let url = Url::parse("wss://relay.example/query").unwrap();
    let deadline = tokio::time::Instant::now() - Duration::from_secs(1);

    let error = assertions
        .get_until(&identity, &url, true, deadline)
        .await
        .unwrap_err();

    assert_eq!(error, TIMED_OUT);
    assert!(discovery.records().is_empty());
}
