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
        assert!(run(200, body).await.is_err());
    }
}

#[test]
fn non_enterprise_relays_get_no_badge() {
    // Test builds configure no trusted enterprise relays.
    let url = Url::parse("https://relay.example/query").unwrap();
    assert_eq!(trusted_relay(&url).unwrap(), None);
}
