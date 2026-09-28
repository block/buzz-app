use super::*;
use nostr::{nips::nip44, Keys};
use std::sync::Mutex;
fn keys(seed: u8) -> Keys {
    Keys::parse(&format!("{seed:064x}")).unwrap()
}
fn session() -> Session {
    Session::new("https://relay.example".into(), keys(1))
}
fn setup() -> (Session, Protocol) {
    let session = session();
    let mut protocol = Protocol::new();
    protocol
        .inbound(&json!(["AUTH", "observed"]).to_string(), &session)
        .unwrap();
    let auth = protocol.authenticate(&session).unwrap();
    protocol
        .outbound(
            &json!(["AUTH", auth]).to_string(),
            &keys(1).public_key().to_hex(),
        )
        .unwrap();
    protocol
        .inbound(&json!(["OK", auth["id"], true, ""]).to_string(), &session)
        .unwrap();
    (session, protocol)
}
fn observer_filter() -> Value {
    json!({"kinds":[24200],"#p":[keys(1).public_key().to_hex()],"since":Timestamp::now().as_secs()})
}
fn envelope() -> Value {
    let author = keys(2);
    let payload = serde_json::json!({"kind":"turn_started","seq":1,"channelId":"c","turnId":"T","timestamp":"2026-09-25T00:00:00Z"});
    let content = nip44::encrypt(
        author.secret_key(),
        &keys(1).public_key(),
        payload.to_string(),
        nip44::Version::V2,
    )
    .unwrap();
    let event = EventBuilder::new(Kind::from(24200), content)
        .tags([
            Tag::parse(["p", &keys(1).public_key().to_hex()]).unwrap(),
            Tag::parse(["agent", &author.public_key().to_hex()]).unwrap(),
            Tag::parse(["frame", "telemetry"]).unwrap(),
        ])
        .sign_with_keys(&author)
        .unwrap();
    serde_json::to_value(event).unwrap()
}
#[test]
fn native_auth_is_observed_once_and_exact_on_same_socket() {
    let s = session();
    let mut p = Protocol::new();
    assert!(p.authenticate(&s).is_err());
    p.inbound(&json!(["AUTH", "hello"]).to_string(), &s)
        .unwrap();
    let raw = p.authenticate(&s).unwrap();
    let auth: Event = serde_json::from_value(raw.clone()).unwrap();
    auth.verify().unwrap();
    assert_eq!(auth.pubkey, keys(1).public_key());
    assert_eq!(auth.kind, Kind::from(22242));
    let tags: Vec<_> = auth.tags.iter().map(|t| t.as_slice().to_vec()).collect();
    assert!(tags.contains(&vec!["relay".into(), "wss://relay.example".into()]));
    assert!(tags.contains(&vec!["challenge".into(), "hello".into()]));
    assert!(p.authenticate(&s).is_err());
    assert!(p
        .inbound(&json!(["AUTH", "other"]).to_string(), &s)
        .is_err());
    let mut other = Protocol::new();
    assert!(other
        .outbound(
            &json!(["AUTH", raw]).to_string(),
            &keys(1).public_key().to_hex()
        )
        .is_err());
    assert!(p
        .outbound(
            &json!(["EVENT", raw]).to_string(),
            &keys(1).public_key().to_hex()
        )
        .is_err());
}
#[test]
fn exact_route_shapes_and_no_publication_or_second_observer() {
    let (s, mut p) = setup();
    let viewer = s.keys.public_key().to_hex();
    let time = Timestamp::now().as_secs();
    let filters = vec![
        vec![observer_filter()],
        vec![json!({"kinds":CHANNEL_KINDS,"#h":["c"],"limit":500,"since":time})],
        vec![
            json!({"kinds":[0,10100,30177],"since":time,"limit":500}),
            json!({"kinds":[30315],"#d":["general"],"since":time,"limit":500}),
            json!({"kinds":[30030],"#d":["buzz:custom-emoji"],"since":time,"limit":500}),
        ],
        vec![
            json!({"kinds":[44100,44101],"#p":[viewer],"since":time,"limit":500}),
            json!({"kinds":[30078],"authors":[viewer],"#t":["read-state"],"since":time,"limit":500}),
        ],
    ];
    for (i, filters) in filters.into_iter().enumerate() {
        let mut value = vec![json!("REQ"), json!(format!("r{i}"))];
        value.extend(filters);
        assert!(p
            .outbound(&Value::Array(value).to_string(), &viewer)
            .is_ok());
    }
    assert!(p
        .outbound(
            &json!(["REQ", "other", observer_filter()]).to_string(),
            &viewer
        )
        .is_err());
    for filter in [
        json!({"kinds":[24200],"#p":[viewer],"since":time,"limit":500}),
        json!({"kinds":[9],"since":time,"limit":500}),
        json!({"kinds":[24200],"#p":[keys(2).public_key().to_hex()],"since":time}),
    ] {
        assert!(validate_route(&[filter], &viewer).is_err());
    }
    assert!(p
        .outbound(&json!(["EVENT", {}]).to_string(), &viewer)
        .is_err());
    p.outbound(&json!(["CLOSE", "r0"]).to_string(), &viewer)
        .unwrap();
    assert!(!p.routes.contains_key("r0"));
}
#[test]
fn decrypt_only_current_observer_wire_no_raw_fallback() {
    let (s, mut p) = setup();
    let viewer = s.keys.public_key().to_hex();
    p.outbound(
        &json!(["REQ", "observe", observer_filter()]).to_string(),
        &viewer,
    )
    .unwrap();
    let event = envelope();
    let (kind, value) = p
        .inbound(&json!(["EVENT", "observe", event]).to_string(), &s)
        .unwrap()
        .unwrap();
    assert_eq!(kind, "observer");
    assert_eq!(value["wire"], "observe");
    assert!(value["frame"]["plaintext"]
        .as_str()
        .unwrap()
        .contains("turn_started"));
    assert!(value.get("content").is_none());
    assert!(p
        .inbound(&json!(["EVENT", "other", event]).to_string(), &s)
        .unwrap()
        .is_none());
    let mut tampered = event.clone();
    tampered["sig"] = json!("0".repeat(128));
    assert!(p
        .inbound(&json!(["EVENT", "observe", tampered]).to_string(), &s)
        .is_err());
    let mut wrong = event.clone();
    wrong["kind"] = json!(89736);
    assert!(decode_observer(&wrong, &s, 0).is_none());
    wrong = event.clone();
    wrong["created_at"] = json!(0);
    assert!(decode_observer(&wrong, &s, 0).is_none());
    p.outbound(&json!(["CLOSE", "observe"]).to_string(), &viewer)
        .unwrap();
    assert!(p
        .inbound(&json!(["EVENT", "observe", event]).to_string(), &s)
        .unwrap()
        .is_none());
}
#[test]
fn delivery_count_and_byte_caps_ack_once() {
    let messages = Arc::new(Mutex::new(Vec::new()));
    let received = messages.clone();
    let channel = tauri::ipc::Channel::new(move |body| {
        received.lock().unwrap().push(body);
        Ok(())
    });
    let mut delivery = Delivery {
        id: "socket".into(),
        sequence: 0,
        pending: BTreeMap::new(),
        bytes: 0,
        channel,
    };
    for _ in 0..32 {
        delivery.send("message", json!([])).unwrap();
    }
    assert!(delivery.send("message", Value::Null).is_err());
    delivery.ack(1);
    let bytes = delivery.bytes;
    delivery.ack(1);
    delivery.ack(1000);
    assert_eq!(delivery.bytes, bytes);
    delivery.send("message", Value::Null).unwrap();
    delivery.pending.clear();
    delivery.bytes = 0;
    assert!(delivery
        .send("message", json!("a".repeat(2 * MAX_FRAME)))
        .is_err());
}

#[tokio::test]
async fn physical_socket_auth_route_encrypted_event_and_close_are_one_actor() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let s = Arc::new(Session::new(format!("http://{address}"), keys(1)));
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        socket
            .send(Message::Text(
                json!(["AUTH", "fixture-challenge"]).to_string().into(),
            ))
            .await
            .unwrap();
        let auth = socket.next().await.unwrap().unwrap();
        let raw: Value = serde_json::from_str(auth.to_text().unwrap()).unwrap();
        assert_eq!(raw[0], "AUTH");
        let event: Event = serde_json::from_value(raw[1].clone()).unwrap();
        event.verify().unwrap();
        assert_eq!(event.pubkey, keys(1).public_key());
        socket
            .send(Message::Text(
                json!(["OK", event.id.to_hex(), true, ""])
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let req: Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(req[0], "REQ");
        socket
            .send(Message::Text(
                json!(["EVENT", req[1], envelope()]).to_string().into(),
            ))
            .await
            .unwrap();
        // Client close is ordinary transport closure; no native reconnect loop.
        let _ = socket.next().await;
    });
    let (tx, mut rx) = mpsc::unbounded_channel();
    let channel = tauri::ipc::Channel::new(move |body| {
        let packet: Value = body.deserialize().unwrap();
        tx.send(packet).unwrap();
        Ok(())
    });
    let id = s.open_socket(channel).unwrap();
    assert!(s.open_socket(tauri::ipc::Channel::new(|_| Ok(()))).is_err());
    let mut plaintext = None;
    let exchange = async {
        while let Some(packet) = rx.recv().await {
            if let Some(seq) = packet["seq"].as_u64() {
                s.socket_control(&id, Control::Ack(seq)).unwrap();
            }
            if packet["kind"] == "message" && packet["value"][0] == "AUTH" {
                let (tx, reply) = oneshot::channel();
                s.socket_control(&id, Control::Authenticate(tx)).unwrap();
                let auth = reply.await.unwrap().unwrap();
                let (tx, reply) = oneshot::channel();
                s.socket_control(&id, Control::Write(json!(["AUTH", auth]).to_string(), tx))
                    .unwrap();
                reply.await.unwrap().unwrap();
            } else if packet["kind"] == "message" && packet["value"][0] == "OK" {
                let (tx, reply) = oneshot::channel();
                s.socket_control(
                    &id,
                    Control::Write(json!(["REQ", "observe", observer_filter()]).to_string(), tx),
                )
                .unwrap();
                reply.await.unwrap().unwrap();
            } else if packet["kind"] == "observer" {
                plaintext = packet["value"]["frame"]["plaintext"]
                    .as_str()
                    .map(str::to_owned);
                break;
            }
        }
    };
    let result = tokio::time::timeout(Duration::from_secs(3), exchange).await;
    s.close_socket(Some(&id));
    assert!(result.is_ok());
    assert!(plaintext.unwrap().contains("turn_started"));
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    let closed = tokio::time::timeout(Duration::from_secs(3), async {
        while let Some(packet) = rx.recv().await {
            if packet["kind"] == "closed" {
                break;
            }
        }
    })
    .await;
    assert!(closed.is_ok());
    assert!(s.socket.lock().unwrap().is_none());
}

#[test]
fn oversize_commands_are_rejected_before_queue_retention() {
    let session = session();
    let (tx, mut rx) = mpsc::channel(64);
    let (stop, _) = watch::channel(false);
    *session.socket.lock().unwrap() = Some(SocketControl {
        id: "socket".into(),
        tx,
        stop,
    });
    let (reply, _) = oneshot::channel();
    assert!(session
        .socket_control("socket", Control::Write("x".repeat(65537), reply))
        .is_err());
    assert!(rx.try_recv().is_err());
}
