use super::*;
fn keys() -> Keys {
    Keys::parse("0000000000000000000000000000000000000000000000000000000000000001").unwrap()
}
fn template() -> Template {
    Template {
        kind: 9,
        created_at: Timestamp::now().as_secs(),
        content: "Fixture message".into(),
        tags: vec![vec!["h".into(), "channel".into()]],
    }
}
#[test]
fn rejects_unrelated_signing_and_unbounded_or_foreign_templates() {
    for kind in [0, 7, 22242, 27235, 40003, 65545] {
        let mut t = template();
        t.kind = kind;
        assert!(validate_message(&t).is_err());
    }
    for tags in [
        vec![],
        vec![vec!["h".into(), "a".into()], vec!["h".into(), "b".into()]],
        vec![vec!["h".into(), "bad/path".into()]],
        vec![
            vec!["h".into(), "c".into()],
            vec!["auth".into(), "secret".into()],
        ],
    ] {
        let mut t = template();
        t.tags = tags;
        assert!(validate_message(&t).is_err());
    }
    let mut t = template();
    t.content = "x".repeat(32001);
    assert!(validate_message(&t).is_err());
    let mut t = template();
    t.tags
        .extend((0..33).map(|_| vec!["p".into(), "a".repeat(64)]));
    assert!(validate_message(&t).is_err());
    let mut t = template();
    t.tags.extend([
        vec!["e".into(), "a".repeat(64), "".into(), "root".into()],
        vec!["e".into(), "b".repeat(64), "".into(), "reply".into()],
    ]);
    assert!(validate_message(&t).is_ok());
}
#[test]
fn filter_contract_is_finite_not_arbitrary_fetch_or_observer_input() {
    for value in [
        json!([]),
        json!([{"kinds":[24200],"limit":1}]),
        json!([{"kinds":[9],"limit":501}]),
        json!([{"kinds":[9],"limit":1,"url":"https://other"}]),
        json!([{"kinds":[9],"limit":1,"authors":["bad"]}]),
        json!([{"kinds":[65545],"limit":1}]),
    ] {
        assert!(validate_filters(&value).is_err());
    }
    assert!(validate_filters(
        &json!([{"kinds":[39002],"authors":["a".repeat(64)],"#d":["c"],"limit":1}])
    )
    .is_ok());
    assert!(validate_filters(&json!([{"kinds":[9],"#e":["a".repeat(64)],"#h":["c"],"depth_limit":16,"include_aux":true,"limit":50}])).is_ok());
}
#[tokio::test]
async fn leases_sign_only_exact_message_and_cancel_before_dispatch() {
    let session = Session::new("https://relay.example".into(), keys());
    let operation = session.begin().unwrap();
    session.cancel(&operation);
    assert!(
        !session
            .run(operation, Request::Sign(template()))
            .await
            .err()
            .unwrap()
            .sent
    );
    let operation = session.begin().unwrap();
    let Output::Signed(value) = session
        .run(operation.clone(), Request::Sign(template()))
        .await
        .unwrap()
    else {
        panic!("not signed")
    };
    let event: Event = serde_json::from_value(value.clone()).unwrap();
    assert!(event.verify().is_ok());
    assert_eq!(event.pubkey, keys().public_key());
    assert!(session
        .run(operation, Request::Sign(template()))
        .await
        .is_err());
    let other =
        Keys::parse("0000000000000000000000000000000000000000000000000000000000000002").unwrap();
    assert!(verify_message(value, &other).is_err());
    session.close();
    assert!(session.begin().is_err());
}
#[tokio::test]
async fn bounded_http_uses_only_captured_origin_and_native_nip98_then_verifies_receipt_shape_in_caller(
) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let expected = origin.clone();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buf = [0; 4096];
        let header_end = loop {
            let n = socket.read(&mut buf).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
            if let Some(n) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                break n + 4;
            }
        };
        let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap();
        assert!(headers.starts_with("POST /query HTTP/1.1"));
        let header = |name: &str| {
            headers
                .lines()
                .find_map(|s| {
                    s.split_once(':')
                        .filter(|(k, _)| k.eq_ignore_ascii_case(name))
                        .map(|(_, v)| v.trim().to_owned())
                })
                .unwrap()
        };
        let length: usize = header("content-length").parse().unwrap();
        while bytes.len() < header_end + length {
            let n = socket.read(&mut buf).unwrap();
            assert!(n > 0);
            bytes.extend_from_slice(&buf[..n]);
        }
        let auth = header("authorization");
        let event: Event = serde_json::from_slice(
            &STANDARD
                .decode(auth.strip_prefix("Nostr ").unwrap())
                .unwrap(),
        )
        .unwrap();
        event.verify().unwrap();
        assert_eq!(event.kind, Kind::from(27235));
        assert_eq!(event.pubkey, keys().public_key());
        let tags: Vec<Vec<String>> = event.tags.iter().map(|t| t.as_slice().to_vec()).collect();
        assert!(tags.contains(&vec!["u".into(), format!("{expected}/query")]));
        assert!(tags.contains(&vec![
            "payload".into(),
            format!(
                "{:x}",
                Sha256::digest(&bytes[header_end..header_end + length])
            )
        ]));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]")
            .unwrap();
    });
    let session = Session::new(origin, keys());
    let result = session
        .run(
            session.begin().unwrap(),
            Request::Query(json!([{"kinds":[39000],"limit":10}])),
        )
        .await
        .unwrap();
    let Output::Response(result) = result else {
        panic!("not HTTP")
    };
    assert_eq!(result.status, 200);
    assert_eq!(result.body, "[]");
    server.join().unwrap();
}
#[test]
fn revocation_wrong_session_and_capacity_fail_closed() {
    let host = AccountConnection::default();
    let session = Arc::new(Session::new("https://relay.example".into(), keys()));
    host.state.lock().unwrap().session = Some(session.clone());
    assert!(host.session("guest", &session.id).is_err());
    assert!(host.session("main", "wrong").is_err());
    for _ in 0..6 {
        session.begin().unwrap();
    }
    assert!(session.begin().is_err());
    host.close_session("main", "old").unwrap();
    assert!(host.session("main", &session.id).is_ok());
    host.revoke();
    assert!(host.session("main", &session.id).is_err());
    assert!(session.begin().is_err());
}

#[test]
fn dispatch_admission_orders_close_and_cancel_without_false_unsent_after_admission() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let session = Session::new("https://relay.example".into(), keys());
    let (cancel, rx) = watch::channel(false);
    let dispatched = AtomicBool::new(false);
    cancel.send_replace(true);
    assert!(session.admit_dispatch(&rx, &dispatched).is_err());
    assert!(!dispatched.load(Ordering::SeqCst));
    let (_, fresh) = watch::channel(false);
    session.admit_dispatch(&fresh, &dispatched).unwrap();
    session.close();
    assert!(dispatched.load(Ordering::SeqCst));
    let late = AtomicBool::new(false);
    assert!(session.admit_dispatch(&fresh, &late).is_err());
    assert!(!late.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancel_after_actual_http_entry_keeps_uncertainty_and_releases_capacity() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let entered = Arc::new(tokio::sync::Notify::new());
    let seen = entered.clone();
    let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let release = gate.clone();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut buf = [0; 4096];
        assert!(socket.read(&mut buf).unwrap() > 0);
        seen.notify_one();
        let (lock, cv) = &*release;
        let mut done = lock.lock().unwrap();
        while !*done {
            done = cv.wait(done).unwrap();
        }
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]");
    });
    let session = Arc::new(Session::new(origin, keys()));
    let id = session.begin().unwrap();
    let worker = session.clone();
    let operation = id.clone();
    let task = tokio::spawn(async move {
        worker
            .run(operation, Request::Query(json!([{"kinds":[9],"limit":1}])))
            .await
    });
    let seen = tokio::time::timeout(Duration::from_secs(3), entered.notified()).await;
    session.cancel(&id);
    let result = tokio::time::timeout(Duration::from_secs(3), task).await;
    {
        let (lock, cv) = &*gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }
    server.join().unwrap();
    assert!(seen.is_ok());
    let error = result.unwrap().unwrap().err().unwrap();
    assert!(error.sent);
    assert!(session.operations.lock().unwrap().is_empty());
    assert!(session.begin().is_ok());
}
#[tokio::test]
async fn http_refusal_redirect_and_oversize_do_not_trigger_retry_or_foreign_dispatch() {
    use std::io::{Read, Write};
    for response in [
        b"HTTP/1.1 302 Found\r\nLocation: https://must-not-contact.invalid\r\nContent-Length: 0\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 99999999\r\n\r\n".to_vec(),
    ] {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();let origin=format!("http://{}",listener.local_addr().unwrap());
        let server=std::thread::spawn(move||{let(mut socket,_)=listener.accept().unwrap();let mut buf=[0;4096];assert!(socket.read(&mut buf).unwrap()>0);let _=socket.write_all(&response);});
        let session=Session::new(origin,keys());let result=session.run(session.begin().unwrap(),Request::Query(json!([{"kinds":[9],"limit":1}]))).await;
        server.join().unwrap();match result {Ok(Output::Response(r))=>assert_eq!(r.status,302),Err(e)=>assert!(e.sent),_=>panic!("unexpected")};
        assert!(session.operations.lock().unwrap().is_empty());
    }
}

#[test]
fn registered_native_relay_ipc_signs_for_lease_and_rejects_after_close() {
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, INVOKE_KEY},
        webview::InvokeRequest,
    };
    let host = AccountConnection::default();
    let session = Arc::new(Session::new("https://relay.example".into(), keys()));
    let lease = session.id.clone();
    host.state.lock().unwrap().session = Some(session);
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
    let operation = invoke("account_relay_begin", json!({"lease":lease})).unwrap();
    let signed = invoke(
        "account_relay_run",
        json!({"lease":lease,"operation":operation,"request":{"kind":"sign","value":template()}}),
    )
    .unwrap();
    assert_eq!(signed["kind"], "signed");
    let event: Event = serde_json::from_value(signed["value"].clone()).unwrap();
    event.verify().unwrap();
    assert_eq!(event.pubkey, keys().public_key());
    invoke("account_connection_close", json!({"lease":lease})).unwrap();
    assert_eq!(
        invoke("account_relay_begin", json!({"lease":lease})).unwrap_err()["sent"],
        false
    );
}
