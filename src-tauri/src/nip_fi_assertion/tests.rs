use super::*;
use axum::{http::HeaderMap, response::IntoResponse, routing::post, Router};

const RELAY: &str = "wss://relay.example";

/// Serves one adapter response and returns the endpoint plus what it saw.
async fn adapter(
    status: u16,
    body: serde_json::Value,
) -> (Url, tokio::sync::oneshot::Receiver<(HeaderMap, Vec<u8>)>) {
    let (seen, received) = tokio::sync::oneshot::channel();
    let seen = Arc::new(Mutex::new(Some(seen)));
    let router = Router::new().route(
        ASSERTION_PATH,
        post(move |headers: HeaderMap, bytes: axum::body::Bytes| {
            let seen = seen.clone();
            let body = body.clone();
            async move {
                if let Some(seen) = seen.lock().unwrap().take() {
                    let _ = seen.send((headers, bytes.to_vec()));
                }
                (
                    axum::http::StatusCode::from_u16(status).unwrap(),
                    axum::Json(body),
                )
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await });
    let endpoint = Url::parse(&format!("http://{address}{ASSERTION_PATH}")).unwrap();
    (endpoint, received)
}

async fn run(status: u16, body: serde_json::Value) -> Result<Assertion> {
    let (endpoint, _) = adapter(status, body).await;
    let identity = IdentityHost::fixture();
    issue(
        client().unwrap(),
        &endpoint,
        &EnterpriseAuthHost::default(),
        "session",
        &identity,
        RELAY,
        now().unwrap(),
    )
    .await
}

#[tokio::test]
async fn issues_badge_for_signer_pubkey_with_contract_headers() {
    let identity = IdentityHost::fixture();
    let pubkey = identity.viewer().await.unwrap();
    let now = now().unwrap();
    let (endpoint, seen) = adapter(
        200,
        serde_json::json!({"assertion": "abc.def", "nostr_pubkey": pubkey, "expires_at": now + 300}),
    )
    .await;

    let assertion = issue(
        client().unwrap(),
        &endpoint,
        &EnterpriseAuthHost::default(),
        "session",
        &identity,
        RELAY,
        now,
    )
    .await
    .unwrap();

    assert_eq!(assertion.header.as_str(), "Bearer abc.def");
    assert_eq!(assertion.expires_at, now + 300);
    let (headers, body) = seen.await.unwrap();
    assert_eq!(headers["authorization"], "Bearer session");
    let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        request,
        serde_json::json!({"relay_url": RELAY, "nostr_pubkey": pubkey})
    );
    let proof = headers["nostr-authorization"].to_str().unwrap();
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
    assert_eq!(tag("u"), endpoint.as_str());
    assert_eq!(tag("method"), "POST");
    assert_eq!(tag("payload"), format!("{:x}", Sha256::digest(&body)));
}

#[tokio::test]
async fn session_denials_require_sign_in() {
    for (status, code) in [(401, "session_expired"), (401, "session_required")] {
        let error = run(status, serde_json::json!({"error": code}))
            .await
            .unwrap_err();
        assert_eq!(error, SIGN_IN_REQUIRED, "{status} {code}");
    }
}

#[tokio::test]
async fn relay_policy_denial_keeps_the_session() {
    let error = run(403, serde_json::json!({"error": "authorization_denied"}))
        .await
        .unwrap_err();
    assert_eq!(error, ACCESS_DENIED);
}

#[tokio::test]
async fn proof_and_service_failures_keep_the_session() {
    for (status, code) in [
        (401, "invalid_proof"),
        (401, ""),
        (403, "binding_mismatch"),
        (401, "authorization_denied"),
        (413, "request_too_large"),
        (429, "rate_limited"),
        (503, "issuance_unavailable"),
    ] {
        let error = run(status, serde_json::json!({"error": code}))
            .await
            .unwrap_err();
        assert_ne!(error, SIGN_IN_REQUIRED, "{status} {code}");
        assert_ne!(error, ACCESS_DENIED, "{status} {code}");
    }
}

#[tokio::test]
async fn only_overload_refusals_are_retryable() {
    for (status, code, retryable) in [
        (401, "invalid_proof", false),
        (403, "binding_mismatch", false),
        (400, "invalid_request", false),
        (413, "request_too_large", false),
        (429, "rate_limited", true),
        (503, "issuance_unavailable", true),
    ] {
        let error = run(status, serde_json::json!({"error": code}))
            .await
            .unwrap_err();
        assert_eq!(error.starts_with(REFUSED), !retryable, "{status} {code}");
    }
}

#[tokio::test]
async fn rejects_badge_for_another_key_or_overlong_lifetime() {
    let now = now().unwrap();
    let pubkey = IdentityHost::fixture().viewer().await.unwrap();
    for body in [
        serde_json::json!({"assertion": "a", "nostr_pubkey": "0".repeat(64), "expires_at": now + 60}),
        serde_json::json!({"assertion": "a", "nostr_pubkey": pubkey, "expires_at": now + MAX_LIFETIME + 60}),
        serde_json::json!({"assertion": "a", "nostr_pubkey": pubkey, "expires_at": now}),
    ] {
        let error = run(200, body).await.unwrap_err();
        assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
    }
}

/// Answers one request with raw HTTP bytes, then closes the connection.
async fn issue_raw(response: Vec<u8>) -> Result<Assertion> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = Url::parse(&format!(
        "http://{}{ASSERTION_PATH}",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    tokio::spawn(async move {
        let (mut tcp, _) = listener.accept().await.unwrap();
        let _ = tcp.read(&mut [0; 16 * 1024]).await;
        let _ = tcp.write_all(&response).await;
    });
    let identity = IdentityHost::fixture();
    issue(
        client().unwrap(),
        &endpoint,
        &EnterpriseAuthHost::default(),
        "session",
        &identity,
        RELAY,
        now().unwrap(),
    )
    .await
}

fn http(status: &str, body: &[u8]) -> Vec<u8> {
    let mut response = format!(
        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    response.extend_from_slice(body);
    response
}

#[tokio::test]
async fn malformed_successful_responses_stop_without_echoing_the_body() {
    for body in [
        b"not json".as_slice(),
        br#"{"assertion": "a b", "nostr_pubkey": "x", "expires_at": 1}"#,
        br#"{"error": "secret-token"}"#,
    ] {
        let error = issue_raw(http("200 OK", body)).await.unwrap_err();
        assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
    }
    // Invalid assertion bytes for the right key and lifetime.
    let pubkey = IdentityHost::fixture().viewer().await.unwrap();
    let body = serde_json::json!({"assertion": "a\u{7f}b", "nostr_pubkey": pubkey, "expires_at": now().unwrap() + 60});
    let error = run(200, body).await.unwrap_err();
    assert_eq!(error, format!("{REFUSED} (invalid adapter response)"));
}

#[tokio::test]
async fn an_oversized_refusal_is_classified_by_its_status() {
    let large = vec![b'x'; MAX_RESPONSE + 1];
    for (status, retryable) in [
        ("400 Bad Request", false),
        ("413 Payload Too Large", false),
        ("429 Too Many Requests", true),
        ("503 Service Unavailable", true),
    ] {
        let error = issue_raw(http(status, &large)).await.unwrap_err();
        assert_eq!(error.starts_with(REFUSED), !retryable, "{status}: {error}");
    }
}

#[tokio::test]
async fn an_interrupted_response_stays_retryable() {
    // Promises more body than it sends, then closes.
    let mut response = http("200 OK", b"{}");
    response.truncate(response.len() - 2);
    let response = String::from_utf8(response)
        .unwrap()
        .replace("Content-Length: 2", "Content-Length: 100")
        .into_bytes();
    let error = issue_raw(response).await.unwrap_err();
    assert_eq!(error, "Relay badge response was interrupted");
}

#[test]
fn non_enterprise_relays_get_no_badge() {
    // Test builds configure no trusted enterprise relays.
    let url = Url::parse("https://relay.example/query").unwrap();
    assert_eq!(trusted_relay(&url).unwrap(), None);
}

#[tokio::test]
async fn a_full_lifetime_badge_issued_after_the_request_started_is_accepted() {
    let identity = IdentityHost::fixture();
    let pubkey = identity.viewer().await.unwrap();
    let issued_at = now().unwrap();
    let (endpoint, _) = adapter(
        200,
        serde_json::json!({"assertion": "abc", "nostr_pubkey": pubkey, "expires_at": issued_at + MAX_LIFETIME}),
    )
    .await;
    // The request was signed five seconds before the adapter issued the badge.
    let assertion = issue(
        client().unwrap(),
        &endpoint,
        &EnterpriseAuthHost::default(),
        "session",
        &identity,
        RELAY,
        issued_at - 5,
    )
    .await
    .unwrap();
    assert_eq!(assertion.expires_at, issued_at + MAX_LIFETIME);
}

/// An assertion adapter that refuses every request as a lost session.
async fn refusing_adapter() -> String {
    let router = Router::new().route(
        ASSERTION_PATH,
        post(|| async {
            (
                axum::http::StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({"error": "session_expired"})),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{address}")
}

#[tokio::test]
async fn a_stalled_session_read_answers_by_the_deadline() {
    let identity = IdentityHost::fixture();
    let assertions = RelayAssertions::new(EnterpriseAuthHost::default());
    let started = Instant::now();
    let deadline = started + Duration::from_millis(300);
    // Secure storage never answers, as behind an unanswered keychain prompt.
    let error = assertions
        .badge(
            &identity,
            RELAY.into(),
            std::future::pending(),
            true,
            deadline,
        )
        .await
        .unwrap_err();
    assert_eq!(error, TIMED_OUT);
    assert!(started.elapsed() < Duration::from_millis(800));
}

#[tokio::test]
async fn a_held_refusal_cleanup_still_asks_for_sign_in_by_the_deadline() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = refusing_adapter().await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    // Two requests read the same session before either is refused.
    let first = enterprise.saved_at(&adapter, &viewer).await;
    let second = enterprise.saved_at(&adapter, &viewer).await;
    // Removing the refused session waits on secure storage past the deadline.
    let held = enterprise.hold_commit().await;
    let started = Instant::now();
    let deadline = started + Duration::from_millis(500);
    let error = assertions
        .badge(&identity, RELAY.into(), async { Ok(first) }, true, deadline)
        .await
        .unwrap_err();
    assert_eq!(error, SIGN_IN_REQUIRED);
    assert!(started.elapsed() < Duration::from_millis(1000));
    // Once storage answers, the removal still completes.
    drop(held);
    let removed = async {
        while enterprise.saved_at(&adapter, &viewer).await.is_some() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(2), removed)
        .await
        .expect("refused session was not removed");
    // The second request's refusal of the already-removed session does not
    // ask for sign-in again.
    let error = assertions
        .badge(
            &identity,
            RELAY.into(),
            async { Ok(second) },
            true,
            Instant::now() + DEADLINE,
        )
        .await
        .unwrap_err();
    assert_eq!(error, SESSION_REPLACED);
}

#[tokio::test]
async fn a_refused_session_that_storage_keeps_is_no_longer_used() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = refusing_adapter().await;
    let enterprise = EnterpriseAuthHost::with_saved_undeletable(&adapter, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    let saved = enterprise.saved_at(&adapter, &viewer).await;
    let error = assertions
        .badge(
            &identity,
            RELAY.into(),
            async { Ok(saved) },
            true,
            Instant::now() + DEADLINE,
        )
        .await
        .unwrap_err();
    assert_eq!(error, SIGN_IN_REQUIRED);
    // Badge requests, including the ones media loads make through `attach`,
    // read the saved session the same way and no longer find the refused one.
    assert!(enterprise.saved_at(&adapter, &viewer).await.is_none());
    let saved = enterprise.saved_at(&adapter, &viewer).await;
    assert!(assertions
        .badge(
            &identity,
            RELAY.into(),
            async { Ok(saved) },
            true,
            Instant::now() + DEADLINE
        )
        .await
        .unwrap()
        .is_none());
}

/// An assertion adapter that issues a valid badge for `pubkey`, counting the
/// requests it receives. With `hold`, it signals `started` and waits for
/// `release` before answering.
struct IssuingAdapter {
    base: String,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}

async fn issuing_adapter(pubkey: String, hold: bool) -> IssuingAdapter {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (counted, signal, wait) = (calls.clone(), started.clone(), release.clone());
    let router = Router::new().route(
        ASSERTION_PATH,
        post(move || {
            let (counted, signal, wait, pubkey) = (
                counted.clone(),
                signal.clone(),
                wait.clone(),
                pubkey.clone(),
            );
            async move {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if hold {
                    signal.notify_one();
                    wait.notified().await;
                }
                axum::Json(serde_json::json!({
                    "assertion": "abc.def",
                    "nostr_pubkey": pubkey,
                    "expires_at": now().unwrap() + 300,
                }))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await });
    IssuingAdapter {
        base: format!("http://{address}"),
        calls,
        started,
        release,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_refused_while_signing_is_held_is_not_sent() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = issuing_adapter(viewer.clone(), false).await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter.base, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    let preparing = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    let refused = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    // The request has read the session and waits on identity access and
    // signing when another request's refusal lands.
    let held = identity.hold();
    let request = {
        let (assertions, identity) = (assertions.clone(), identity.clone());
        tokio::spawn(async move {
            assertions
                .badge(
                    &identity,
                    RELAY.into(),
                    async { Ok(Some(preparing)) },
                    true,
                    Instant::now() + DEADLINE,
                )
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!request.is_finished());
    assert_eq!(
        enterprise.reject(refused).await.unwrap(),
        Rejection::Removed
    );
    drop(held);
    assert_eq!(request.await.unwrap().unwrap_err(), SESSION_REPLACED);
    assert_eq!(adapter.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_badge_that_arrives_after_its_session_is_refused_is_dropped() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = issuing_adapter(viewer.clone(), true).await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter.base, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    let saved = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    let refused = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    let request = {
        let (assertions, identity) = (assertions.clone(), identity.clone());
        tokio::spawn(async move {
            assertions
                .badge(
                    &identity,
                    RELAY.into(),
                    async { Ok(Some(saved)) },
                    true,
                    Instant::now() + DEADLINE,
                )
                .await
        })
    };
    // The adapter has the request; the refusal lands before its answer.
    adapter.started.notified().await;
    assert_eq!(
        enterprise.reject(refused).await.unwrap(),
        Rejection::Removed
    );
    adapter.release.notify_one();
    assert_eq!(request.await.unwrap().unwrap_err(), SESSION_REPLACED);
    assert!(assertions.lock().get(RELAY).is_none());
}

#[tokio::test]
async fn relay_http_does_not_carry_a_badge_of_a_refused_session() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = issuing_adapter(viewer.clone(), false).await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter.base, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    // A protected relay endpoint that records the badge each request carries.
    let carried = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let router = Router::new().route(
        "/upload",
        post({
            let carried = carried.clone();
            move |headers: HeaderMap| {
                let carried = carried.clone();
                async move {
                    carried.lock().unwrap().push(
                        headers
                            .get(HEADER)
                            .map(|value| value.to_str().unwrap().to_owned()),
                    );
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_http = format!("http://{}/upload", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await });
    let send = |saved| {
        let request = client().unwrap().post(&relay_http);
        let attached =
            assertions.attach_badge(&identity, RELAY.into(), async move { Ok(saved) }, request);
        async move {
            attached
                .await?
                .send()
                .await
                .map_err(|error| error.to_string())
        }
    };
    let first = enterprise.saved_at(&adapter.base, &viewer).await;
    send(first).await.unwrap();
    // A request reads the session (its badge is cached), then another
    // request's refusal lands before this one is attached.
    let reading = enterprise.saved_at(&adapter.base, &viewer).await;
    let refused = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    assert_eq!(
        enterprise.reject(refused).await.unwrap(),
        Rejection::Removed
    );
    assert_eq!(send(reading).await.unwrap_err(), SESSION_REPLACED);
    assert_eq!(
        *carried.lock().unwrap(),
        [Some("Bearer abc.def".to_owned())]
    );
    assert_eq!(adapter.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// Runs `refusal` while the badge cache is held, after `racing` has passed
/// its admission and waits on the cache. Returns whether the refusal finished
/// before the cache was released, and what `racing` answered. Waits block
/// this thread rather than use the runtime's timer, since a runtime worker
/// is blocked on the cache meanwhile.
async fn refuse_while_the_cache_is_held(
    enterprise: &EnterpriseAuthHost,
    refused: SavedSession,
    racing: tokio::task::JoinHandle<Result<Option<Assertion>>>,
    reached_cache: impl Fn() -> bool,
    cache: std::sync::MutexGuard<'_, HashMap<String, Cached>>,
) -> (bool, Result<Option<Assertion>>) {
    while !reached_cache() && !racing.is_finished() {
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::sleep(Duration::from_millis(100));
    let refusal = {
        let enterprise = enterprise.clone();
        tokio::spawn(async move { enterprise.reject(refused).await })
    };
    std::thread::sleep(Duration::from_millis(200));
    let refused_first = refusal.is_finished();
    drop(cache);
    let answer = racing.await.unwrap();
    refusal.await.unwrap().unwrap();
    (refused_first, answer)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cached_badge_is_not_returned_once_its_refusal_returns() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = issuing_adapter(viewer.clone(), false).await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter.base, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    let badge = |saved| {
        let (assertions, identity) = (assertions.clone(), identity.clone());
        tokio::spawn(async move {
            assertions
                .badge(
                    &identity,
                    RELAY.into(),
                    async move { Ok(saved) },
                    false,
                    Instant::now() + DEADLINE,
                )
                .await
        })
    };
    let first = enterprise.saved_at(&adapter.base, &viewer).await;
    assert!(badge(first).await.unwrap().unwrap().is_some());
    let reusing = enterprise.saved_at(&adapter.base, &viewer).await;
    let refused = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    // The reuse passes its refusal check and waits on the cache.
    let cache = assertions.lock();
    let reuse = badge(reusing);
    let (refused_first, answer) =
        refuse_while_the_cache_is_held(&enterprise, refused, reuse, || true, cache).await;
    // Either the reuse was admitted before the refusal (and the refusal
    // returned after it), or it returned no badge.
    assert!(!(refused_first && matches!(answer, Ok(Some(_)))));
    assert!(!refused_first);
    assert_eq!(adapter.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_badge_is_not_cached_or_returned_once_its_refusal_returns() {
    let identity = IdentityHost::fixture();
    let viewer = identity.viewer().await.unwrap();
    let adapter = issuing_adapter(viewer.clone(), false).await;
    let enterprise = EnterpriseAuthHost::with_saved(&adapter.base, &viewer, "old");
    let assertions = RelayAssertions::new(enterprise.clone());
    let issuing = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    let refused = enterprise.saved_at(&adapter.base, &viewer).await.unwrap();
    // The badge arrives and passes its refusal check, then waits on the cache
    // to store it.
    let cache = assertions.lock();
    let request = {
        let (assertions, identity) = (assertions.clone(), identity.clone());
        tokio::spawn(async move {
            assertions
                .badge(
                    &identity,
                    RELAY.into(),
                    async { Ok(Some(issuing)) },
                    true,
                    Instant::now() + DEADLINE,
                )
                .await
        })
    };
    let arrived = || adapter.calls.load(std::sync::atomic::Ordering::SeqCst) > 0;
    let (refused_first, answer) =
        refuse_while_the_cache_is_held(&enterprise, refused, request, arrived, cache).await;
    assert!(!(refused_first && matches!(answer, Ok(Some(_)))));
    assert!(!refused_first);
    // The refusal then removed what that admitted request cached.
    assert!(enterprise.saved_at(&adapter.base, &viewer).await.is_none());
}
