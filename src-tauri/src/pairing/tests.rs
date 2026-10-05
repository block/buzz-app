use super::*;
use buzz_pairing::{crypto, PairingMessage};
use nostr_pairing::{EventBuilder, Keys, Kind, Tag};

fn message(keys: &Keys, source: &PairingSession, value: PairingMessage) -> Event {
    let content = nostr_pairing::nips::nip44::encrypt(
        keys.secret_key(),
        &source.pubkey(),
        serde_json::to_string(&value).unwrap(),
        nostr_pairing::nips::nip44::Version::V2,
    )
    .unwrap();
    EventBuilder::new(Kind::Custom(buzz_pairing::session::KIND_PAIRING), content)
        .tags([Tag::public_key(source.pubkey())])
        .sign_with_keys(keys)
        .unwrap()
}
fn entry() -> (Exchange, Keys, buzz_pairing::QrPayload) {
    let (session, qr) = PairingSession::new_source("wss://relay.test".into());
    let target = Keys::generate();
    let mut exchange = Exchange {
        session,
        payload: Some(Zeroizing::new("identity-fixture".into())),
        code_entry: false,
    };
    let offer = message(
        &target,
        &exchange.session,
        PairingMessage::Offer {
            session_id: hex::encode(crypto::derive_session_id(&qr.session_secret)),
            version: 1,
            confirmation: Some("code-entry".into()),
        },
    );
    let output = exchange.receive(&offer).unwrap();
    assert!(matches!(
        output.status,
        Some(Status::Code {
            code_entry: true,
            ..
        })
    ));
    assert!(output.events.is_empty());
    (exchange, target, qr)
}
fn proof(exchange: &Exchange, target: &Keys, qr: &buzz_pairing::QrPayload) -> Event {
    let shared =
        nostr_pairing::util::generate_shared_key(target.secret_key(), &qr.source_pubkey).unwrap();
    let (_, sas) = crypto::derive_sas(&shared, &qr.session_secret);
    let hash = crypto::derive_transcript_hash(
        &crypto::derive_session_id(&qr.session_secret),
        &qr.source_pubkey.to_bytes(),
        &target.public_key().to_bytes(),
        &sas,
        &qr.session_secret,
    );
    message(
        target,
        &exchange.session,
        PairingMessage::SasConfirm {
            transcript_hash: hex::encode(hash),
        },
    )
}
#[test]
fn entry_requires_phone_proof_and_real_completion() {
    let (mut exchange, target, qr) = entry();
    assert!(
        exchange.confirm().is_err(),
        "desktop cannot bypass code entry"
    );
    let output = exchange.receive(&proof(&exchange, &target, &qr)).unwrap();
    assert_eq!(output.status, Some(Status::Transferring));
    assert_eq!(output.events.len(), 2);
    let plain = Zeroizing::new(
        nostr_pairing::nips::nip44::decrypt(
            target.secret_key(),
            &qr.source_pubkey,
            &output.events[1].content,
        )
        .unwrap(),
    );
    assert!(plain.contains("identity-fixture"));
    assert!(!serde_json::to_string(&output.status)
        .unwrap()
        .contains("identity-fixture"));
    let done = message(
        &target,
        &exchange.session,
        PairingMessage::Complete { success: true },
    );
    assert_eq!(
        exchange.receive(&done).unwrap().status,
        Some(Status::Complete)
    );
}
#[test]
fn mismatch_and_phone_import_failure_never_claim_success() {
    let (mut exchange, target, _) = entry();
    let wrong = message(
        &target,
        &exchange.session,
        PairingMessage::SasConfirm {
            transcript_hash: "00".repeat(32),
        },
    );
    assert!(exchange.receive(&wrong).is_err());
    assert!(exchange.payload.is_some());
    let (mut exchange, target, qr) = entry();
    exchange.receive(&proof(&exchange, &target, &qr)).unwrap();
    let rejected = message(
        &target,
        &exchange.session,
        PairingMessage::Complete { success: false },
    );
    assert!(exchange.receive(&rejected).is_err());
}
#[test]
fn legacy_phone_still_needs_explicit_desktop_confirmation() {
    let (session, qr) = PairingSession::new_source("wss://relay.test".into());
    let (mut phone, offer) = PairingSession::new_target(&qr).unwrap();
    let mut exchange = Exchange {
        session,
        payload: Some(Zeroizing::new("fixture".into())),
        code_entry: false,
    };
    assert!(matches!(
        exchange.receive(&offer).unwrap().status,
        Some(Status::Code {
            code_entry: false,
            ..
        })
    ));
    let output = exchange.confirm().unwrap();
    phone.handle_sas_confirm(&output.events[0]).unwrap();
    phone.confirm_target_sas().unwrap();
    assert_eq!(
        &*phone.handle_payload(&output.events[1]).unwrap().1,
        "fixture"
    );
    assert_eq!(
        exchange
            .receive(&phone.send_complete().unwrap())
            .unwrap()
            .status,
        Some(Status::Complete)
    );
}
#[test]
fn old_session_cleanup_cannot_cancel_or_overwrite_replacement() {
    let manager = Pairing::default();
    let (tx, _) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    *manager.0.lock().unwrap() = Some(Active {
        id: "new".into(),
        cancel: cancel.clone(),
        confirm: tx,
        status: Status::Connecting,
    });
    manager.cancel("old").unwrap();
    manager.update("old", Status::Complete);
    assert!(!cancel.is_cancelled());
    assert_eq!(
        manager.0.lock().unwrap().as_ref().unwrap().status,
        Status::Connecting
    );
    manager.cancel("new").unwrap();
    assert!(cancel.is_cancelled());
    manager.update("new", Status::Complete);
    assert!(manager.0.lock().unwrap().is_none());
}

#[test]
fn window_reload_or_destruction_cancels_the_live_attempt() {
    let manager = Pairing::default();
    let (tx, _) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    *manager.0.lock().unwrap() = Some(Active {
        id: "live".into(),
        cancel: cancel.clone(),
        confirm: tx,
        status: Status::Connecting,
    });
    manager.cancel_all();
    assert!(cancel.is_cancelled());
    assert!(manager.0.lock().unwrap().is_none());
}

#[tokio::test]
async fn unexpected_connection_failure_becomes_a_visible_error() {
    let result = guard(async { panic!("simulated connection setup failure") }).await;
    assert_eq!(
        result.unwrap_err(),
        "Pairing stopped unexpectedly. Create a new code and try again."
    );
}
