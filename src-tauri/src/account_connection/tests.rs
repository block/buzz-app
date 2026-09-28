use super::*;
use nostr::ToBech32;
use std::sync::atomic::AtomicUsize;
fn keys() -> Keys {
    Keys::parse("0000000000000000000000000000000000000000000000000000000000000001").unwrap()
}
fn request() -> Request {
    Request {
        expected_public_key: keys().public_key().to_hex(),
        relay_url: "wss://relay.example".into(),
    }
}
#[test]
fn origin_and_public_pin_match_frontend_contract() {
    for (raw, expected) in [
        (" wss://EXAMPLE.com:443/ ", "https://example.com"),
        ("https://example.com.", "https://example.com"),
        ("wss://example.com:8443", "https://example.com:8443"),
        ("https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"),
        ("WSS://bücher.example/", "https://xn--bcher-kva.example"),
    ] {
        assert_eq!(relay_origin(raw).unwrap(), expected);
    }
    for raw in [
        "",
        "relay.example",
        "primary",
        "ws://relay.example",
        "http://relay.example",
        "javascript:alert(1)",
        "file:///tmp/relay",
        "https://user:password@relay.example",
        "https://@relay.example",
        "https://relay.example/path",
        "https://relay.example/?",
        "https://relay.example/#",
        "https://relay.example?x=1",
        "https://relay.example/#x",
        "https://relay.example/../",
        "https://relay.example/%2e/",
        "https://relay.example//",
        "https://relay.example\\@evil.example",
        "https://relay.example\n.evil.example",
        "https:///relay.example",
        "https://relay.example:99999",
        "https://",
    ] {
        assert!(relay_origin(raw).is_err(), "{raw}");
    }
    assert!(relay_origin(&format!("https://{}", "a".repeat(2048))).is_err());
    let mut input = request();
    input.expected_public_key = keys().public_key().to_bech32().unwrap();
    assert_eq!(
        validate(input).unwrap().viewer,
        keys().public_key().to_hex()
    );
}
#[test]
fn fixed_identity_field_no_agent_fallback_or_duplicates() {
    let key = keys();
    let expected = key.public_key().to_hex();
    let nsec = key.secret_key().to_bech32().unwrap();
    let valid = serde_json::json!({"identity":nsec, "agent:other":"unused"}).to_string();
    assert!(verify_identity(valid.as_bytes(), &expected).is_ok());
    for raw in [
        "bad".into(),
        "{}".into(),
        serde_json::json!({"agent:other":nsec}).to_string(),
        format!("{{\"identity\":\"{nsec}\",\"identity\":\"{nsec}\"}}"),
        serde_json::json!({"identity":key.secret_key().to_secret_hex()}).to_string(),
    ] {
        assert_eq!(
            verify_identity(raw.as_bytes(), &expected).unwrap_err(),
            CREDENTIAL
        );
    }
    assert_eq!(
        verify_identity(valid.as_bytes(), &"a".repeat(64)).unwrap_err(),
        CREDENTIAL
    );
    assert!(verify_identity(&vec![b' '; MAX_BYTES + 1], &expected).is_err());
}
#[test]
fn tickets_bound_to_main_single_use_cancelled_and_shutdown() {
    let host = AccountConnection::default();
    assert!(host.begin("guest", request()).is_err());
    let mut invalid = request();
    invalid.expected_public_key = keys().secret_key().to_bech32().unwrap();
    assert!(host.begin("main", invalid).is_err());
    let id = host.begin("main", request()).unwrap();
    assert!(host.begin("main", request()).is_err());
    assert!(host.start("guest", &id).is_err());
    assert!(host.start("main", "wrong").is_err());
    host.cancel("main", "stale").unwrap();
    assert!(host.start("main", &id).is_ok());
    assert!(host.start("main", &id).is_err());
    host.cancel("main", &id).unwrap();
    assert!(host.active(&id).is_err());
    let next = host.begin("main", request()).unwrap();
    host.shutdown();
    assert!(host.start("main", &next).is_err());
    assert!(host.begin("main", request()).is_err());
}
#[test]
fn discovery_keeps_explicit_self_separate_and_refuses_invalid_or_oversize() {
    let k = keys().public_key().to_hex();
    assert_eq!(
        discovery(serde_json::json!({"pubkey":k}).to_string().as_bytes()).unwrap(),
        (k.clone(), None)
    );
    assert_eq!(
        discovery(serde_json::json!({"self":k}).to_string().as_bytes()).unwrap(),
        (k.clone(), Some(k.clone()))
    );
    for raw in [
        "[]".into(),
        "bad".into(),
        "{}".into(),
        format!("{{\"self\":\"bad\",\"pubkey\":\"{k}\"}}"),
        format!("{{\"self\":\"{k}\",\"self\":\"{k}\"}}"),
    ] {
        assert!(discovery(raw.as_bytes()).is_err());
    }
    assert!(discovery(&vec![b' '; MAX_BYTES + 1]).is_err());
}
struct Held {
    calls: AtomicUsize,
    entered: Arc<tokio::sync::Notify>,
    gate: Arc<(Mutex<bool>, std::sync::Condvar)>,
}
impl Credentials for Held {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        let (lock, cv) = &*self.gate;
        let mut release = lock.lock().unwrap();
        while !*release {
            release = cv.wait(release).unwrap();
        }
        Ok(Zeroizing::new(
            serde_json::json!({"identity":keys().secret_key().to_bech32().unwrap()})
                .to_string()
                .into_bytes(),
        ))
    }
}
#[tokio::test]
async fn delayed_keychain_read_cannot_return_after_cancel_or_allow_parallel_prompt() {
    let entered = Arc::new(tokio::sync::Notify::new());
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let source = Arc::new(Held {
        calls: AtomicUsize::new(0),
        entered: entered.clone(),
        gate: gate.clone(),
    });
    let host = AccountConnection {
        credentials: source.clone(),
        ..Default::default()
    };
    let id = host.begin("main", request()).unwrap();
    let destination = host.start("main", &id).unwrap();
    let worker = host.clone();
    let workid = id.clone();
    let task = tokio::spawn(async move { worker.verify(&workid, &destination).await });
    let observed = tokio::time::timeout(Duration::from_secs(3), entered.notified()).await;
    host.cancel("main", &id).unwrap();
    let parallel = host.begin("main", request());
    {
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }
    assert!(observed.is_ok());
    assert!(parallel.is_err());
    assert!(task.await.unwrap().is_err());
    assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    assert!(host.begin("main", request()).is_ok());
}

struct Memory {
    reads: AtomicUsize,
    valid: bool,
}
impl Credentials for Memory {
    fn read(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if !self.valid {
            return Err(CREDENTIAL.into());
        }
        Ok(Zeroizing::new(
            serde_json::json!({"identity": keys().secret_key().to_bech32().unwrap()})
                .to_string()
                .into_bytes(),
        ))
    }
}
#[tokio::test]
async fn credential_denial_never_discovers_and_success_is_single_use() {
    for valid in [false, true] {
        let credentials = Arc::new(Memory {
            reads: AtomicUsize::new(0),
            valid,
        });
        let host = AccountConnection {
            credentials: credentials.clone(),
            ..Default::default()
        };
        let discoveries = AtomicUsize::new(0);
        let id = host.begin("main", request()).unwrap();
        let result = host
            .run_with("main", id.clone(), |origin| {
                discoveries.fetch_add(1, Ordering::SeqCst);
                async move {
                    assert_eq!(origin, "https://relay.example");
                    Ok((keys().public_key().to_hex(), None))
                }
            })
            .await;
        assert_eq!(result.is_ok(), valid);
        assert_eq!(credentials.reads.load(Ordering::SeqCst), 1);
        assert_eq!(discoveries.load(Ordering::SeqCst), usize::from(valid));
        assert!(host.start("main", &id).is_err());
        if let Ok(account) = result {
            assert!(host.begin("main", request()).is_err());
            host.close_session("main", &account.lease).unwrap();
        }
        assert!(host.begin("main", request()).is_ok());
    }
}
#[tokio::test]
async fn delayed_discovery_cannot_return_after_revocation() {
    let host = AccountConnection {
        credentials: Arc::new(Memory {
            reads: AtomicUsize::new(0),
            valid: true,
        }),
        ..Default::default()
    };
    let id = host.begin("main", request()).unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let worker = host.clone();
    let started = entered.clone();
    let finish = release.clone();
    let task = tokio::spawn(async move {
        worker
            .run_with("main", id, |_| async move {
                started.notify_one();
                finish.notified().await;
                Ok((keys().public_key().to_hex(), None))
            })
            .await
    });
    let started = tokio::time::timeout(Duration::from_secs(3), entered.notified()).await;
    host.revoke();
    let replacement = host.begin("main", request());
    release.notify_one();
    assert!(started.is_ok());
    assert!(replacement.is_err());
    assert!(task.await.unwrap().is_err());
    assert!(host.begin("main", request()).is_ok());
}
#[test]
fn expired_ticket_and_invalid_inputs_have_no_privileged_access() {
    let credentials = Arc::new(Memory {
        reads: AtomicUsize::new(0),
        valid: true,
    });
    let host = AccountConnection {
        credentials: credentials.clone(),
        ..Default::default()
    };
    let id = host.begin("main", request()).unwrap();
    host.state.lock().unwrap().pending.as_mut().unwrap().created =
        Instant::now() - Duration::from_secs(16);
    assert!(host.start("main", &id).is_err());
    let mut bad = request();
    bad.relay_url = "https://secret@relay.example".into();
    assert!(host.begin("main", bad).is_err());
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn real_bounded_discovery_refuses_redirect_and_oversize_without_following() {
    use std::io::{Read, Write};
    // The production caller only accepts HTTPS; this loopback fixture exercises
    // the same HTTP client/parser without certificates, external hosts or accounts.
    async fn serve(response: Vec<u8>) -> Result<(String, Option<String>)> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut input = [0; 4096];
            let n = socket.read(&mut input).unwrap();
            let text = String::from_utf8_lossy(&input[..n]);
            assert!(text.starts_with("GET / HTTP/1.1"));
            assert!(text
                .to_lowercase()
                .contains("accept: application/nostr+json"));
            let _ = socket.write_all(&response);
        });
        let result = discover(&origin).await;
        server.join().unwrap();
        result
    }
    let data = serde_json::json!({"self":keys().public_key().to_hex()}).to_string();
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        data.len(),
        data
    )
    .into_bytes();
    assert!(serve(response).await.is_ok());
    assert!(serve(b"HTTP/1.1 302 Found\r\nLocation: https://should-not-contact.invalid\r\nContent-Length: 0\r\n\r\n".to_vec()).await.is_err());
    assert!(serve(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_BYTES + 1
        )
        .into_bytes()
    )
    .await
    .is_err());
    let mut unknown_length = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
    unknown_length.extend(vec![b' '; MAX_BYTES + 1]);
    assert!(serve(unknown_length).await.is_err());
}

#[test]
fn real_registered_ipc_validates_before_credentials_and_rejects_ticket_replay() {
    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
    };
    let credentials = Arc::new(Memory {
        reads: AtomicUsize::new(0),
        valid: false,
    });
    let host = AccountConnection {
        credentials: credentials.clone(),
        ..Default::default()
    };
    let app = mock_builder()
        .manage(host)
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let invoke = |cmd: &str, body: Value| -> std::result::Result<Value, Value> {
        get_ipc_response(
            &view,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map(|body| body.deserialize().unwrap())
    };
    assert!(invoke("account_connection_begin", json!({"request":{"expectedPublicKey":"nsec-never-pass","relayUrl":"https://relay.example"}})).is_err());
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
    let ticket=invoke("account_connection_begin",json!({"request":{"expectedPublicKey":keys().public_key().to_hex(),"relayUrl":"https://relay.example"}})).unwrap();
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
    let error = invoke("account_connection_run", json!({"ticket":ticket})).unwrap_err();
    assert_eq!(error, CREDENTIAL);
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 1);
    assert!(invoke("account_connection_run", json!({"ticket":ticket})).is_err());
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 1);
}
