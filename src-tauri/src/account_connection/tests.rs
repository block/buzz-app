use super::*;
#[test]
fn activity_leases_are_main_view_only_and_never_replace_other_communities() {
    let host = AccountConnection::default();
    let identity = IdentityHost::fixture();
    let viewer = identity.ready_viewer().unwrap();
    let a = Arc::new(session::Session::with_identity(
        "a".into(),
        "https://a.example".into(),
        viewer.clone(),
        identity.clone(),
        "c".repeat(64),
        None,
    ));
    let b = Arc::new(session::Session::with_identity(
        "b".into(),
        "https://b.example".into(),
        viewer,
        identity,
        "d".repeat(64),
        None,
    ));
    host.state
        .lock()
        .unwrap()
        .sessions
        .insert("a".into(), Some(a.clone()));
    host.state
        .lock()
        .unwrap()
        .sessions
        .insert("b".into(), Some(b.clone()));
    assert!(host.session("guest", "a").is_err());
    assert!(host.session("main", "a").is_ok());
    let captured = host.matching("https://a.example");
    host.close_session("main", "a").unwrap();
    assert!(captured[0].current().is_err());
    assert!(host.session("main", "b").is_ok());
    host.close_session("main", "a").unwrap();
    assert!(b.current().is_ok());
    host.revoke();
    assert!(b.current().is_err());
}
#[test]
fn origins_are_scoped_secure_communities() {
    for url in [
        "http://relay.example",
        "https://u:p@relay.example",
        "https://relay.example/query",
        "https://relay.example/?key=x",
    ] {
        assert!(relay_origin(url).is_err());
    }
    assert_eq!(
        relay_origin("https://relay.example").unwrap(),
        "https://relay.example"
    );
}

#[tokio::test]
async fn pending_origin_exclusion_cancellation_and_replacement_keep_one_epoch_owner() {
    let host = AccountConnection::default();
    let identity = IdentityHost::fixture();
    let viewer = identity.ready_viewer().unwrap();
    let (started, began) = tokio::sync::oneshot::channel();
    let (release, wait) = tokio::sync::oneshot::channel::<()>();
    let worker = host.clone();
    let key = identity.clone();
    let who = viewer.clone();
    let first = tokio::spawn(async move {
        worker
            .open_with("main", key, "https://a.example".into(), who, |_| async {
                let _ = started.send(());
                let _ = wait.await;
                Ok("a".repeat(64))
            })
            .await
    });
    began.await.unwrap();
    assert!(host
        .open_with(
            "main",
            identity.clone(),
            "https://a.example".into(),
            viewer.clone(),
            |_| async { panic!("duplicate discovery") }
        )
        .await
        .is_err());
    first.abort();
    let _ = first.await;
    drop(release);
    assert!(host.state.lock().unwrap().origins.is_empty());
    let lease = host
        .open_with(
            "main",
            identity.clone(),
            "https://a.example".into(),
            viewer.clone(),
            |_| async { Ok("a".repeat(64)) },
        )
        .await
        .unwrap();
    let old = host.session("main", &lease.lease).unwrap();
    host.close_session("main", &lease.lease).unwrap();
    let next = host
        .open_with(
            "main",
            identity.clone(),
            "https://a.example".into(),
            viewer,
            |_| async { Ok("a".repeat(64)) },
        )
        .await
        .unwrap();
    host.close_session("main", &lease.lease).unwrap();
    assert!(host.session("main", &next.lease).is_ok());
    assert!(old.current().is_err());
    host.revoke();
    assert!(host.state.lock().unwrap().origins.is_empty());
}

#[test]
fn delayed_roster_delivery_cannot_authorize_a_replacement_lease() {
    use nostr::{EventBuilder, Keys, Kind, Tag};
    let relay = Keys::generate();
    let identity = IdentityHost::fixture();
    let viewer = identity.ready_viewer().unwrap();
    let host = AccountConnection::default();
    let make = |id: &str| {
        Arc::new(session::Session::with_identity(
            id.into(),
            "https://a.example".into(),
            viewer.clone(),
            identity.clone(),
            relay.public_key().to_hex(),
            None,
        ))
    };
    let old = make("old");
    host.state
        .lock()
        .unwrap()
        .sessions
        .insert("old".into(), Some(old));
    let captured = host.matching("https://a.example");
    host.close_session("main", "old").unwrap();
    let next = make("next");
    host.state
        .lock()
        .unwrap()
        .sessions
        .insert("next".into(), Some(next.clone()));
    let event = EventBuilder::new(Kind::from(39002), "")
        .tags([Tag::parse(["d", "channel"]).unwrap()])
        .sign_with_keys(&relay)
        .unwrap();
    let rows = [serde_json::to_value(event).unwrap()];
    for lease in captured {
        lease.accept_rosters(&rows);
    }
    // Old history's epoch cannot contaminate the replacement's authority.
    assert_eq!(next.history.epoch(), 0);
    next.accept_rosters(&rows);
    assert_eq!(
        next.history.epoch(),
        1,
        "the same response applies only when dispatched under this lease"
    );
    assert!(next.current().is_ok());
}
