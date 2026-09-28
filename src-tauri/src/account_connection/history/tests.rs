use super::*;
use nostr::{nips::nip44, EventBuilder, Keys, Kind, Tag};
fn keys(seed: u8) -> Keys {
    Keys::parse(&format!("{seed:064x}")).unwrap()
}
fn roster(channel: &str, allowed: bool, time: u64) -> Value {
    let mut tags = vec![Tag::parse(["d", channel]).unwrap()];
    if allowed {
        tags.push(Tag::parse(["p", &keys(1).public_key().to_hex()]).unwrap());
    }
    serde_json::to_value(
        EventBuilder::new(Kind::from(39002), "")
            .tags(tags)
            .custom_created_at(Timestamp::from(time))
            .sign_with_keys(&keys(3))
            .unwrap(),
    )
    .unwrap()
}
fn envelope(payload: Value) -> Value {
    let author = keys(2);
    let encrypted = nip44::encrypt(
        author.secret_key(),
        &keys(1).public_key(),
        payload.to_string(),
        nip44::Version::V2,
    )
    .unwrap();
    serde_json::to_value(
        EventBuilder::new(Kind::from(24200), encrypted)
            .tags([
                Tag::parse(["p", &keys(1).public_key().to_hex()]).unwrap(),
                Tag::parse(["agent", &author.public_key().to_hex()]).unwrap(),
                Tag::parse(["frame", "telemetry"]).unwrap(),
            ])
            .sign_with_keys(&author)
            .unwrap(),
    )
    .unwrap()
}
#[test]
fn native_scope_index_is_rederived_and_mixed_denial_purges_whole_envelope() {
    let dir = tempfile::tempdir().unwrap();
    let archive = Arc::new(Archive::new(dir.path().join("history")));
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive.clone()),
    );
    let event = envelope(
        json!({"kind":"batch","payload":{"events":[{"kind":"acp_read","channelId":"one"},{"kind":"acp_read","channelId":"two"}]}}),
    );
    let dto = decode_history(&event, &session).unwrap();
    let epoch = session.history.capture_epoch();
    assert!(session
        .history
        .capture(&session, &event, &dto, epoch)
        .is_err());
    let now = Timestamp::now().as_secs();
    session.history.accept_rosters(
        &[roster("one", true, now), roster("two", true, now)],
        &keys(1).public_key().to_hex(),
        &session.origin,
    );
    session
        .history
        .capture(&session, &event, &dto, epoch)
        .unwrap();
    let before = archive
        .page(
            &keys(1).public_key().to_hex(),
            &session.origin,
            &keys(2).public_key().to_hex(),
            Some("one"),
            None,
            now_ms(),
        )
        .unwrap();
    assert_eq!(before.rows.len(), 1);
    assert_eq!(before.rows[0].channels.len(), 2);
    assert!(!before.rows[0].raw.contains("acp_read"));
    session.history.accept_rosters(
        &[roster("two", false, now + 1)],
        &keys(1).public_key().to_hex(),
        &session.origin,
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !session.history.purge_ready() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(archive
        .page(
            &keys(1).public_key().to_hex(),
            &session.origin,
            &keys(2).public_key().to_hex(),
            Some("one"),
            None,
            now_ms()
        )
        .unwrap()
        .rows
        .is_empty());
    session.history.accept_rosters(
        &[roster("two", true, now)],
        &keys(1).public_key().to_hex(),
        &session.origin,
    );
    assert!(session
        .history
        .capture(&session, &event, &dto, epoch)
        .is_err());
    session.history.disconnect();
    assert!(session
        .history
        .capture(&session, &event, &dto, epoch)
        .is_err());
}
#[tokio::test]
async fn real_fresh_roster_read_gates_historical_plaintext_after_reopen() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let archive = Arc::new(Archive::new(dir.path().join("history")));
    let now = Timestamp::now().as_secs();
    let evidence = roster("one", true, now);
    let event = envelope(json!({"kind":"turn_completed","channelId":"one","turnId":"T","seq":2}));
    {
        let session = Session::with_history(
            origin.clone(),
            keys(1),
            keys(3).public_key().to_hex(),
            Some(archive.clone()),
        );
        session.history.accept_rosters(
            std::slice::from_ref(&evidence),
            &keys(1).public_key().to_hex(),
            &origin,
        );
        let dto = decode_history(&event, &session).unwrap();
        session.history.capture(&session, &event, &dto, 0).unwrap();
    }
    let server = std::thread::spawn(move || {
        for answer in [json!([evidence]), json!([])] {
            let (mut socket, _) = listener.accept().unwrap();
            let mut input = [0; 4096];
            assert!(socket.read(&mut input).unwrap() > 0);
            let body = answer.to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        }
    });
    let session = Arc::new(Session::with_history(
        origin,
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive),
    ));
    let read = || super::Read {
        agent: keys(2).public_key().to_hex(),
        channel: "one".into(),
        before: None,
    };
    let page = session.history.read(&session, read()).await.unwrap();
    assert_eq!(page.records.len(), 1);
    assert!(page.records[0].plaintext.contains("turn_completed"));
    assert!(session.history.read(&session, read()).await.is_err());
    server.join().unwrap();
}
#[test]
fn delete_fences_existing_capture_and_does_not_touch_other_partition() {
    let dir = tempfile::tempdir().unwrap();
    let archive = Arc::new(Archive::new(dir.path().join("history")));
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive.clone()),
    );
    let now = Timestamp::now().as_secs();
    session.history.accept_rosters(
        &[roster("one", true, now)],
        &keys(1).public_key().to_hex(),
        &session.origin,
    );
    let event = envelope(json!({"kind":"acp_read","channelId":"one"}));
    let dto = decode_history(&event, &session).unwrap();
    session.history.capture(&session, &event, &dto, 0).unwrap();
    session.history.delete(&session).unwrap();
    assert!(session.history.capture(&session, &event, &dto, 0).is_err());
    session
        .history
        .capture(&session, &event, &dto, session.history.capture_epoch())
        .unwrap_err();
    assert!(archive
        .page(
            &keys(1).public_key().to_hex(),
            &session.origin,
            &keys(2).public_key().to_hex(),
            None,
            None,
            now_ms()
        )
        .unwrap()
        .rows
        .is_empty());
}

#[test]
fn nested_batch_is_not_unscoped_permission() {
    let text=json!({"kind":"batch","payload":{"events":[{"kind":"batch","payload":{"events":[{"channelId":"denied","kind":"acp_read"}]}}]}}).to_string();
    assert!(channels(&text).is_err());
}

#[test]
fn overflow_gap_is_coalesced_and_durable_after_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let archive = Arc::new(Archive::new(root.clone()));
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive.clone()),
    );
    session.history.gap_pending();
    assert!(session.history.has_gap());
    session.history.flush_gap(&session);
    assert!(session.history.has_gap());
    drop(session);
    drop(archive);
    let store = Archive::new(root);
    assert!(
        store
            .page(
                &keys(1).public_key().to_hex(),
                "https://relay.example",
                &keys(2).public_key().to_hex(),
                None,
                None,
                now_ms()
            )
            .unwrap()
            .trimmed
    );
}
#[test]
fn failed_delete_restores_live_capture_epoch_without_clearing_existing_evidence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("activity.sqlite"), b"corrupt").unwrap();
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(Arc::new(Archive::new(root))),
    );
    let epoch = session.history.capture_epoch();
    assert!(session.history.delete(&session).is_err());
    assert_eq!(session.history.capture_epoch(), epoch);
    assert!(!session.history.state.lock().unwrap().deleting);
}
#[test]
fn purge_is_not_lost_when_history_read_slots_are_busy() {
    let dir = tempfile::tempdir().unwrap();
    let archive = Arc::new(Archive::new(dir.path().join("history")));
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive.clone()),
    );
    let _one = session
        .history
        .admission
        .clone()
        .try_acquire_owned()
        .unwrap();
    let _two = session
        .history
        .admission
        .clone()
        .try_acquire_owned()
        .unwrap();
    let now = Timestamp::now().as_secs();
    session.history.accept_rosters(
        &[
            roster("one", false, now),
            roster("two", false, now),
            roster("three", false, now),
        ],
        &keys(1).public_key().to_hex(),
        &session.origin,
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !session.history.purge_ready() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(
        archive
            .page(
                &keys(1).public_key().to_hex(),
                &session.origin,
                &keys(2).public_key().to_hex(),
                None,
                None,
                now_ms()
            )
            .unwrap()
            .trimmed
    );
}

#[test]
fn gap_stays_read_visible_after_flush_and_failed_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("corrupt");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("activity.sqlite"), b"corrupt").unwrap();
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(Arc::new(Archive::new(root))),
    );
    session.history.gap_pending();
    session.history.flush_gap(&session);
    assert!(session.history.has_gap());
    assert_eq!(session.history.persisted_gap.load(Ordering::SeqCst), 0);
    session.history.gap_pending();
    session.history.deleted_gap.store(1, Ordering::SeqCst);
    assert!(session.history.has_gap());
}

#[test]
fn newer_gap_can_be_repersisted_after_delete_erases_earlier_flush() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("history");
    let archive = Arc::new(Archive::new(root.clone()));
    let session = Session::with_history(
        "https://relay.example".into(),
        keys(1),
        keys(3).public_key().to_hex(),
        Some(archive.clone()),
    );
    session.history.gap_pending();
    let cutoff = session.history.gaps.load(Ordering::SeqCst);
    session.history.gap_pending();
    session.history.flush_gap(&session);
    assert_eq!(
        session.history.persisted_gap.load(Ordering::SeqCst),
        cutoff + 1
    );
    archive
        .delete(&keys(1).public_key().to_hex(), &session.origin, now_ms())
        .unwrap();
    session.history.deleted_gap.store(cutoff, Ordering::SeqCst);
    session
        .history
        .persisted_gap
        .store(cutoff, Ordering::SeqCst);
    session.history.flush_gap(&session);
    drop(session);
    drop(archive);
    assert!(
        Archive::new(root)
            .page(
                &keys(1).public_key().to_hex(),
                "https://relay.example",
                &keys(2).public_key().to_hex(),
                None,
                None,
                now_ms()
            )
            .unwrap()
            .trimmed
    );
}
