use super::*;
fn keys() -> Keys {
    Keys::parse("0000000000000000000000000000000000000000000000000000000000000001").unwrap()
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
    let Output::Response(result) = result;
    assert_eq!(result.status, 200);
    assert_eq!(result.body, "[]");
    server.join().unwrap();
}
#[test]
fn revocation_wrong_session_and_capacity_fail_closed() {
    let host = super::super::AccountConnection::default();
    let session = Arc::new(Session::new("https://relay.example".into(), keys()));
    host.state
        .lock()
        .unwrap()
        .sessions
        .insert(session.id.clone(), Some(session.clone()));
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
        server.join().unwrap();match result {Ok(Output::Response(r))=>assert_eq!(r.status,302),Err(e)=>assert!(e.sent)};
        assert!(session.operations.lock().unwrap().is_empty());
    }
}
