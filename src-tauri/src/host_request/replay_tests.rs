//! Real command IPC admission plus internal loopback transport. No WebView fallback claim.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};
use tauri::{
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    Manager as _,
};

fn envelope(calls: &HostCalls) -> Once {
    let context = calls.context("main").unwrap();
    Once {
        boot: context.boot,
        page: context.page,
        activation: uuid::Uuid::new_v4().to_string(),
        call_id: uuid::Uuid::new_v4().to_string(),
    }
}
fn input() -> HostRequest {
    HostRequest {
        url: "https://example.test/submit".into(),
        method: "POST".into(),
        headers: BTreeMap::new(),
        body: Some("{}".into()),
        timeout_ms: Some(1000),
    }
}
fn ipc(
    view: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: command.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map_err(|e| e.to_string())
    .map(|r| r.deserialize().unwrap())
}
struct App {
    _root: tempfile::TempDir,
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
    revision: String,
}
impl App {
    fn new(origin: &str) -> Self {
        let root = tempfile::tempdir().unwrap();
        let manager =
            buzzodz_plugins::Manager::open(Some(root.path().join("data")), "test", false).unwrap();
        let source = root.path().join("plugin");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "id":"example.replay", "name":"Replay fixture", "apiVersion":1,
                "host":{"networkOrigins":[origin]}
            }))
            .unwrap(),
        )
        .unwrap();
        let installed = manager.install(&source).unwrap();
        let revision = installed
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.replay")
            .unwrap()
            .revision
            .clone();
        manager.change("enable", "example.replay").unwrap();
        let app = mock_builder()
            .manage(PluginManager(Ok(manager)))
            .manage(HostCalls::default())
            .invoke_handler(crate::commands())
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            _root: root,
            app,
            view,
            revision,
        }
    }
    fn body(&self, url: &str, once: Option<&Once>) -> serde_json::Value {
        let mut body = serde_json::json!({"id":"example.replay","revision":self.revision,
            "request":{"url":url,"method":"POST","body":"{}","timeoutMs":1000}});
        if let Some(once) = once {
            body["once"] = serde_json::to_value(once).unwrap();
        }
        body
    }
}

#[test]
fn actual_ipc_decodes_explicit_envelope_and_preserves_omitted_once_callers() {
    // Loopback TLS is deliberately untrusted: command admission/one connection is real;
    // positive HTTP POST bytes are tested separately below, without a TLS test bypass.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/submit", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let server = std::thread::spawn(move || {
        // An ordinary call and the protected call each attempt TLS, then fail.
        for _ in 0..2 {
            drop(listener.accept().unwrap());
        }
    });
    let context = ipc(
        &fixture.view,
        "plugin_host_call_context",
        serde_json::json!({}),
    )
    .unwrap();
    assert_eq!(
        context,
        serde_json::json!({"boot":once.boot,"page":once.page})
    );
    assert_eq!(
        ipc(
            &fixture.view,
            "plugin_host_call_context",
            serde_json::json!({})
        )
        .unwrap(),
        context
    );
    let ordinary = fixture.body(&url, None);
    assert!(ipc(&fixture.view, "plugin_host_request", ordinary)
        .unwrap_err()
        .contains("Host request failed"));
    assert_eq!(calls.claims.lock().unwrap().consumed.len(), 0);
    let body = fixture.body(&url, Some(&once));
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("Host request failed"));
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    server.join().unwrap();
    let mut changed = body.clone();
    changed["request"]["body"] = "different".into();
    assert!(ipc(&fixture.view, "plugin_host_request", changed)
        .unwrap_err()
        .contains("payload conflict"));
    for key in ["boot", "activation", "callId"] {
        for alias in [
            body["once"][key].as_str().unwrap().to_uppercase(),
            body["once"][key].as_str().unwrap().replace('-', ""),
        ] {
            let mut bad = body.clone();
            bad["once"][key] = alias.into();
            assert!(ipc(&fixture.view, "plugin_host_request", bad)
                .unwrap_err()
                .contains("Invalid protected"));
        }
    }
    let mut bad = body.clone();
    bad["once"]["unexpected"] = true.into();
    assert!(ipc(&fixture.view, "plugin_host_request", bad)
        .unwrap_err()
        .contains("unknown field"));
    let mut bad = body.clone();
    bad["once"]["page"] = (-1).into();
    assert!(ipc(&fixture.view, "plugin_host_request", bad).is_err());
    let mut stale = body.clone();
    stale["once"]["boot"] = uuid::Uuid::new_v4().to_string().into();
    assert!(ipc(&fixture.view, "plugin_host_request", stale)
        .unwrap_err()
        .contains("Stale"));
    // Revoking and restoring a current grant must not rearm its old claim.
    let manager = fixture.app.state::<PluginManager>();
    manager
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone()).is_err());
    manager
        .0
        .as_ref()
        .unwrap()
        .change("enable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    calls.page_load();
    assert!(ipc(&fixture.view, "plugin_host_request", body)
        .unwrap_err()
        .contains("Stale"));
    assert_eq!(calls.claims.lock().unwrap().consumed.len(), 0);
    let other = tauri::WebviewWindowBuilder::new(&fixture.app, "other", Default::default())
        .build()
        .unwrap();
    // Existing capability permits only main; it denies before command extraction.
    for command in ["plugin_host_call_context", "plugin_host_request"] {
        let error = ipc(&other, command, fixture.body(&url, Some(&envelope(&calls)))).unwrap_err();
        assert!(error.contains("not allowed"), "{error}");
    }
    // Defense in depth still refuses a non-main caller if an ACL later broadens.
    assert!(calls.context("other").err().unwrap().contains("main view"));
    assert!(calls
        .consume(
            "other",
            "post",
            "p",
            "r",
            &envelope(&calls),
            input().fingerprint()
        )
        .unwrap_err()
        .contains("Invalid protected"));
}

#[test]
fn denied_ipc_requests_never_consume_dispatch_authority() {
    let fixture = App::new("https://example.test");
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let body = fixture.body("https://example.test/submit", Some(&once));
    let mut cases = Vec::new();
    let mut value = body.clone();
    value["revision"] = "stale".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["url"] = "https://other.test/submit".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["url"] = "http://example.test/submit".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["method"] = "GET".into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["headers"] = serde_json::json!({"cookie":"secret"});
    cases.push(value);
    let mut value = body.clone();
    value["request"]["body"] = "x".repeat(MAX_REQUEST_BYTES + 1).into();
    cases.push(value);
    let mut value = body.clone();
    value["request"]["timeoutMs"] = 0.into();
    cases.push(value);
    for value in cases {
        assert!(ipc(&fixture.view, "plugin_host_request", value).is_err());
    }
    fixture
        .app
        .state::<PluginManager>()
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body).is_err());
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
}

#[test]
fn full_claims_reset_only_on_page_advance_and_stale_boot_poison_overflow_fail_closed() {
    let calls = HostCalls::default();
    let first = envelope(&calls);
    let payload = input().fingerprint();
    calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap();
    for _ in 1..1024 {
        calls
            .consume("main", "post", "p", "r", &envelope(&calls), payload)
            .unwrap();
    }
    assert!(calls
        .consume("main", "post", "p", "r", &envelope(&calls), payload)
        .unwrap_err()
        .contains("capacity"));
    assert!(calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("already consumed"));
    calls.page_load();
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
    // Freed capacity never admits the original envelope, even with identical tags/payload.
    assert!(calls
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("Stale"));
    let mut current = envelope(&calls);
    current.activation = first.activation.clone();
    current.call_id = first.call_id.clone();
    current.page = calls.context("main").unwrap().page;
    calls
        .consume("main", "post", "p", "r", &current, payload)
        .unwrap();
    assert!(calls
        .consume("main", "post", "p", "r", &current, payload)
        .unwrap_err()
        .contains("already consumed"));
    assert!(HostCalls::default()
        .consume("main", "post", "p", "r", &first, payload)
        .unwrap_err()
        .contains("Stale"));
    let exhausted = HostCalls::default();
    exhausted.claims.lock().unwrap().page = Some(9_007_199_254_740_991);
    exhausted.page_load();
    assert!(exhausted.context("main").is_err());
    let poisoned = Arc::new(HostCalls::default());
    let other = poisoned.clone();
    assert!(std::thread::spawn(move || {
        let _lock = other.claims.lock().unwrap();
        panic!("fixture poison");
    })
    .join()
    .is_err());
    poisoned.page_load();
    assert!(poisoned.context("main").is_err());
}

#[test]
fn fingerprints_bind_exact_fields_and_absence_not_ambiguous_concatenation() {
    let original = input();
    let expected = original.fingerprint();
    for field in [
        "url",
        "method",
        "body",
        "timeout",
        "header-name",
        "header-value",
    ] {
        let mut changed = input();
        match field {
            "url" => changed.url.push('/'),
            "method" => changed.method = "PUT".into(),
            "body" => changed.body = Some("{ }".into()),
            "timeout" => changed.timeout_ms = None,
            "header-name" => {
                changed.headers.insert("a".into(), "bc".into());
            }
            _ => {
                changed.headers.insert("ab".into(), "c".into());
            }
        }
        assert_ne!(changed.fingerprint(), expected, "{field}");
    }
    let mut absent = input();
    absent.body = None;
    let mut empty = input();
    empty.body = Some("".into());
    assert_ne!(absent.fingerprint(), empty.fingerprint());
    absent.headers = BTreeMap::from([("a".into(), "bc".into())]);
    empty = input();
    empty.body = None;
    empty.headers = BTreeMap::from([("ab".into(), "c".into())]);
    assert_ne!(absent.fingerprint(), empty.fingerprint());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_consumption_lost_reply_and_transport_failure_send_one_post() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for success in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/submit", listener.local_addr().unwrap()))
            .unwrap();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let (started_tx, started) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut buf = [0; 1024];
            loop {
                let n = socket.read(&mut buf).await.unwrap();
                assert_ne!(n, 0);
                bytes.extend_from_slice(&buf[..n]);
                if bytes.ends_with(b"\r\n\r\n{}") {
                    break;
                }
            }
            assert!(bytes.starts_with(b"POST /submit HTTP/1.1"));
            seen.fetch_add(1, Ordering::SeqCst);
            started_tx.send(()).unwrap();
            held.await.unwrap();
            if success {
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .unwrap();
            }
            listener.into_std().unwrap()
        });
        let calls = Arc::new(HostCalls::default());
        let once = Arc::new(envelope(&calls));
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let calls = calls.clone();
                let once = once.clone();
                let barrier = barrier.clone();
                let url = url.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    calls
                        .consume("main", "post", "p", "r", &once, input().fingerprint())
                        .map(|()| {
                            tauri::async_runtime::block_on(send_request_with_policy(
                                url,
                                reqwest::Method::POST,
                                HeaderMap::new(),
                                Some("{}".into()),
                                DEADLINE,
                                true,
                            ))
                        })
                })
            })
            .collect();
        started.await.unwrap();
        // The first result is held/possibly lost; replay must already refuse.
        assert!(calls
            .consume("main", "post", "p", "r", &once, input().fingerprint())
            .unwrap_err()
            .contains("already consumed"));
        release.send(()).unwrap();
        let server_listener = server.await.unwrap();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
        assert_eq!(
            results.into_iter().find_map(Result::ok).unwrap().is_ok(),
            success
        );
        // With the admitted sender completed, no hidden retry connection may be queued.
        let listener = server_listener;
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
        assert!(calls
            .consume("main", "post", "p", "r", &once, input().fingerprint())
            .is_err());
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn concurrent_actual_command_replay_attempts_one_connection_before_ambiguous_completion() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/submit", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let once = envelope(&fixture.app.state::<HostCalls>());
    let body = fixture.body(&url, Some(&once));
    let (seen_tx, seen) = std::sync::mpsc::channel();
    let (release, held) = std::sync::mpsc::channel();
    let count = Arc::new(AtomicUsize::new(0));
    let accepted = count.clone();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        accepted.fetch_add(1, Ordering::SeqCst);
        seen_tx.send(()).unwrap();
        let _ = held.recv();
        drop(socket);
        listener
    });
    let view = fixture.view.clone();
    let first_body = body.clone();
    let first = std::thread::spawn(move || ipc(&view, "plugin_host_request", first_body));
    seen.recv().unwrap();
    assert!(ipc(&fixture.view, "plugin_host_request", body.clone())
        .unwrap_err()
        .contains("already consumed"));
    release.send(()).unwrap();
    let listener = server.join().unwrap();
    assert!(first
        .join()
        .unwrap()
        .unwrap_err()
        .contains("Host request failed"));
    assert!(ipc(&fixture.view, "plugin_host_request", body)
        .unwrap_err()
        .contains("already consumed"));
    listener.set_nonblocking(true).unwrap();
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn deadline_and_cancellation_do_not_rearm_a_consumed_transport_call() {
    use tokio::io::AsyncReadExt;
    for cancel in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/submit", listener.local_addr().unwrap()))
            .unwrap();
        let calls = HostCalls::default();
        let once = envelope(&calls);
        let payload = input().fingerprint();
        calls
            .consume("main", "post", "p", "r", &once, payload)
            .unwrap();
        let (seen_tx, seen) = tokio::sync::oneshot::channel();
        let (release, held) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            assert!(socket.read(&mut bytes).await.unwrap() > 0);
            seen_tx.send(()).unwrap();
            held.await.unwrap();
            listener
        });
        let sending = tokio::spawn(send_request_with_policy(
            url,
            reqwest::Method::POST,
            HeaderMap::new(),
            Some("{}".into()),
            Duration::from_secs(1),
            true,
        ));
        seen.await.unwrap();
        if cancel {
            sending.abort();
            assert!(sending.await.err().unwrap().is_cancelled());
        } else {
            assert!(sending.await.unwrap().is_err());
        }
        assert!(calls
            .consume("main", "post", "p", "r", &once, payload)
            .unwrap_err()
            .contains("already consumed"));
        release.send(()).unwrap();
        let listener = server.await.unwrap().into_std().unwrap();
        assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}

fn upload_metadata(fixture: &App, once: &Once, url: &str) -> serde_json::Value {
    serde_json::json!({"id":"example.replay","revision":fixture.revision,
        "once":once,"upload":{"url":url,"field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"test"}}})
}
fn upload_ipc(
    fixture: &App,
    metadata: &serde_json::Value,
    body: tauri::ipc::InvokeBody,
) -> Result<serde_json::Value, String> {
    get_ipc_response(
        &fixture.view,
        tauri::webview::InvokeRequest {
            cmd: "plugin_host_upload_bytes_once".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: fixture.view.url().unwrap(),
            body,
            headers: HeaderMap::from_iter([(
                HeaderName::from_static("x-buzz-upload"),
                HeaderValue::from_str(&metadata.to_string()).unwrap(),
            )]),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map_err(|e| e.to_string())
    .map(|r| r.deserialize().unwrap())
}
#[test]
fn upload_raw_ipc_consumes_once_without_files_and_binds_bytes_and_metadata() {
    let _serial = crate::host_files::managed_tests::commands();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/upload", listener.local_addr().unwrap());
    let origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    let fixture = App::new(&origin);
    let calls = fixture.app.state::<HostCalls>();
    let once = envelope(&calls);
    let metadata = upload_metadata(&fixture, &once, &url);
    let server = std::thread::spawn(move || {
        drop(listener.accept().unwrap());
        listener
    });
    let raw = || tauri::ipc::InvokeBody::Raw(vec![0, 159, 255]);
    assert!(upload_ipc(&fixture, &metadata, raw())
        .unwrap_err()
        .contains("Host request failed"));
    let listener = server.join().unwrap();
    assert!(upload_ipc(&fixture, &metadata, raw())
        .unwrap_err()
        .contains("already consumed"));
    assert!(
        upload_ipc(&fixture, &metadata, tauri::ipc::InvokeBody::Raw(vec![1]))
            .unwrap_err()
            .contains("payload conflict")
    );
    for key in ["url", "field", "name", "contentType", "fields"] {
        let mut changed = metadata.clone();
        if key == "fields" {
            changed["upload"][key]["label"] = "changed".into();
        } else {
            changed["upload"][key] =
                format!("{}x", changed["upload"][key].as_str().unwrap()).into();
        }
        assert!(
            upload_ipc(&fixture, &changed, raw())
                .unwrap_err()
                .contains("payload conflict"),
            "{key}"
        );
    }
    // Tauri's JSON fallback cannot dispatch, even when the original result was lost.
    assert!(upload_ipc(
        &fixture,
        &metadata,
        tauri::ipc::InvokeBody::Json(serde_json::json!([0, 159, 255]))
    )
    .unwrap_err()
    .contains("raw bytes"));
    calls.page_load();
    assert!(upload_ipc(&fixture, &metadata, raw())
        .unwrap_err()
        .contains("Stale"));
    listener.set_nonblocking(true).unwrap();
    assert!(matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
}

#[test]
fn upload_ipc_rejects_invalid_data_and_authority_before_consuming() {
    let _serial = crate::host_files::managed_tests::commands();
    let fixture = App::new("https://example.test");
    let calls = fixture.app.state::<HostCalls>();
    let metadata = upload_metadata(&fixture, &envelope(&calls), "https://example.test/upload");
    for bytes in [vec![], vec![0; MAX_RESPONSE_BYTES + 1]] {
        assert!(upload_ipc(&fixture, &metadata, tauri::ipc::InvokeBody::Raw(bytes)).is_err());
    }
    for (path, value) in [
        (
            vec!["upload", "url"],
            serde_json::json!("http://example.test/"),
        ),
        (
            vec!["upload", "url"],
            serde_json::json!("https://other.test/"),
        ),
        (vec!["upload", "field"], serde_json::json!("bad\r\nfield")),
        (vec!["upload", "name"], serde_json::json!("bad\"name")),
        (vec!["upload", "contentType"], serde_json::json!("a\r\nb")),
        (
            vec!["upload", "fields"],
            serde_json::json!({"huge":"x".repeat(16384)}),
        ),
        (vec!["upload", "path"], serde_json::json!("/not/a/file")),
        (
            vec!["upload", "headers"],
            serde_json::json!({"Cookie":"secret"}),
        ),
        (vec!["revision"], serde_json::json!("stale")),
        (vec!["once", "activation"], serde_json::json!("invalid")),
        (
            vec!["once", "boot"],
            serde_json::json!(uuid::Uuid::new_v4().to_string()),
        ),
        (vec!["once", "page"], serde_json::json!(999)),
    ] {
        let mut bad = metadata.clone();
        let mut at = &mut bad;
        for part in path {
            at = &mut at[part];
        }
        *at = value;
        assert!(upload_ipc(&fixture, &bad, tauri::ipc::InvokeBody::Raw(vec![1])).is_err());
    }
    fixture
        .app
        .state::<PluginManager>()
        .0
        .as_ref()
        .unwrap()
        .change("disable", "example.replay")
        .unwrap();
    assert!(upload_ipc(&fixture, &metadata, tauri::ipc::InvokeBody::Raw(vec![1])).is_err());
    assert!(calls.claims.lock().unwrap().consumed.is_empty());
}

#[test]
fn upload_validation_and_fingerprint_bind_full_binary_and_plain_metadata() {
    let mut upload: ByteUpload = serde_json::from_value(serde_json::json!({
        "url":"https://example.test/upload","field":"image","name":"image.png",
        "contentType":"image/png","fields":{"label":"hello"}
    }))
    .unwrap();
    assert!(validate_byte_upload(&upload, &[0, 159, 255]).is_ok());
    assert!(validate_byte_upload(&upload, &vec![0; MAX_RESPONSE_BYTES]).is_ok());
    let original = upload.fingerprint(&[0, 159, 255]);
    assert_ne!(original, upload.fingerprint(&[0, 159, 254]));
    upload.fields.insert("label".into(), "different".into());
    assert_ne!(original, upload.fingerprint(&[0, 159, 255]));
    for field in ["url", "field", "name", "contentType", "fields"] {
        let mut value = serde_json::to_value(&upload).unwrap();
        if field == "fields" {
            value[field] = serde_json::json!({"ab":"c"});
        } else {
            value[field] = format!("{}x", value[field].as_str().unwrap()).into();
        }
        let changed: ByteUpload = serde_json::from_value(value).unwrap();
        assert_ne!(upload.fingerprint(&[1]), changed.fingerprint(&[1]));
    }
    upload.fields = BTreeMap::from([("x".into(), "x".repeat(8193))]);
    assert!(validate_byte_upload(&upload, &[1]).is_err());
}

#[tokio::test]
async fn upload_transport_preserves_binary_multipart_and_never_follows_redirects_or_retries() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for reply in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap()))
            .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            loop {
                let n = socket.read(&mut buffer).await.unwrap();
                assert_ne!(n, 0);
                request.extend_from_slice(&buffer[..n]);
                if let Some(split) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&request[..split]);
                    let length: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .unwrap()
                        .parse()
                        .unwrap();
                    if request.len() == split + 4 + length {
                        break;
                    }
                }
            }
            assert!(request.starts_with(b"POST /upload HTTP/1.1"));
            let split = request.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
            let headers = String::from_utf8_lossy(&request[..split]);
            let boundary = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-type: multipart/form-data; boundary="))
                .unwrap();
            assert!(!headers.to_ascii_lowercase().contains("cookie:"));
            let expected = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"label\"\r\n\r\ncafé\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"image.png\"\r\nContent-Type: image/png\r\n\r\n");
            let mut body = expected.into_bytes();
            body.extend([0, 159, 255]);
            body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
            assert_eq!(&request[split + 4..], body);
            if reply {
                socket.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: https://other.test/\r\nSet-Cookie: secret=1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await.unwrap();
            }
            listener
        });
        let upload: ByteUpload = serde_json::from_value(serde_json::json!({"url":url.as_str(),"field":"image","name":"image.png","contentType":"image/png","fields":{"label":"café"}})).unwrap();
        let result = send_byte_upload(url, &upload, &[0, 159, 255]).await;
        if reply {
            let response = result.unwrap();
            assert_eq!(response.status, 307);
            assert_eq!(response.body, "{}");
            assert!(!response.headers.contains_key("set-cookie"));
        } else {
            assert!(result.unwrap_err().contains("Host request failed"));
        }
        let listener = server.await.unwrap().into_std().unwrap();
        assert!(matches!(listener.accept(),Err(e) if e.kind() == std::io::ErrorKind::WouldBlock));
    }
}
