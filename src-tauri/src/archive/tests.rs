use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::{
    key::{PublicKey, SecretKey},
    nips::nip44,
};
use secp256k1::{Keypair, Secp256k1};
use sha2::{Digest, Sha256};

pub(crate) fn envelope(viewer: &str, kind: u16, serial: u64) -> AgentEvent {
    let created = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    envelope_at(viewer, kind, serial, created)
}
pub(crate) fn envelope_at(viewer: &str, kind: u16, serial: u64, created: u64) -> AgentEvent {
    let secret = [2; 32];
    let pair = Keypair::from_secret_key(
        &Secp256k1::signing_only(),
        &secp256k1::SecretKey::from_byte_array(secret).unwrap(),
    );
    let agent = pair.x_only_public_key().0.to_string();
    let conversation = nip44::v2::ConversationKey::derive(
        &SecretKey::from_slice(&secret).unwrap(),
        &PublicKey::from_hex(viewer).unwrap(),
    )
    .unwrap();
    let plaintext = format!(
        r#"{{"channelId":"private-channel","kind":"turn_started","payload":"archive-secret-marker","serial":{serial}}}"#
    );
    let content = STANDARD.encode(
        nip44::v2::encrypt_to_bytes_with_nonce(&conversation, plaintext.as_bytes(), [7; 32])
            .unwrap(),
    );
    let tags = vec![
        vec!["p", viewer],
        vec!["agent", &agent],
        vec!["frame", "telemetry"],
    ];
    let hash = Sha256::digest(
        serde_json::to_vec(&json!([0, agent, created, kind, tags, content])).unwrap(),
    );
    serde_json::from_value(json!({"id":format!("{hash:x}"),"pubkey":agent,"sig":Secp256k1::signing_only().sign_schnorr_no_aux_rand(&hash,&pair).to_string(),"created_at":created,"kind":kind,"tags":tags,"content":content})).unwrap()
}
fn viewer() -> String {
    Keypair::from_secret_key(
        &Secp256k1::signing_only(),
        &secp256k1::SecretKey::from_byte_array([1; 32]).unwrap(),
    )
    .x_only_public_key()
    .0
    .to_string()
}
#[test]
fn storage_partition_dedup_policy_paging_and_shrinking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("archive.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let event = envelope(&viewer, 24200, 0);
    let now = event.created_at as i64;
    for community in ["https://a.test", "https://b.test"] {
        store.seed(&viewer, community).unwrap();
    }
    store.seed("another-viewer", "https://a.test").unwrap();
    for _ in 0..2 {
        store
            .ingest(&viewer, "https://a.test", &event, 0, now)
            .unwrap();
    }
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 24200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    assert!(store
        .read(&viewer, "https://b.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    assert!(store
        .read("another-viewer", "https://a.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    let metrics = envelope(&viewer, 44200, 1);
    store
        .ingest(&viewer, "https://a.test", &metrics, 0, now)
        .unwrap();
    for i in 1..205 {
        store
            .ingest(
                &viewer,
                "https://a.test",
                &envelope(&viewer, 24200, i),
                0,
                now,
            )
            .unwrap();
    }
    let page = store
        .read(&viewer, "https://a.test", 24200, None, None)
        .unwrap()
        .0;
    assert_eq!(page.len(), 100);
    let next = store
        .read(
            &viewer,
            "https://a.test",
            24200,
            None,
            Some(page.last().unwrap().0),
        )
        .unwrap()
        .0;
    assert_eq!(next.len(), 100);
    assert!(next[0].0 < page.last().unwrap().0);
    assert!(store
        .read(&viewer, "https://a.test", 24200, None, Some(0))
        .is_err());
    assert!(store
        .read(&viewer, "https://a.test", 24200, Some("bad"), None)
        .is_err());
    let settings = store
        .configure(&viewer, "https://a.test", false, true, 1, 0, now)
        .unwrap();
    assert_eq!(settings["revision"], 1);
    assert!(store
        .ingest(&viewer, "https://a.test", &event, 0, now)
        .is_err());
    let disabled = envelope(&viewer, 24200, 999);
    store
        .ingest(&viewer, "https://a.test", &disabled, 1, now)
        .unwrap();
    let count = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        count
            .query_row(
                "SELECT COUNT(*) FROM archive_events WHERE kind=24200",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        205
    );
    assert_eq!(
        count
            .query_row(
                "SELECT COUNT(*) FROM archive_events WHERE id=?1",
                [&disabled.id],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(count);
    assert!(store
        .configure(&viewer, "https://a.test", true, true, 30, 0, now)
        .is_err());
    store.prune(now + 86401).unwrap();
    assert!(store
        .read(&viewer, "https://a.test", 24200, None, None)
        .unwrap()
        .0
        .is_empty());
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 44200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    store.clear(&viewer, "https://a.test", Some(24200)).unwrap();
    assert_eq!(
        store
            .read(&viewer, "https://a.test", 44200, None, None)
            .unwrap()
            .0
            .len(),
        1
    );
    drop(store);
    let reopened = store::Store::open(path.clone()).unwrap();
    assert_eq!(
        reopened.settings(&viewer, "https://a.test").unwrap()["observer"],
        false
    );
    drop(reopened);
    let connection = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        2
    );
    drop(connection);
    let bytes = std::fs::read(path).unwrap();
    assert!(!bytes
        .windows(b"archive-secret-marker".len())
        .any(|s| s == b"archive-secret-marker"));
}
#[test]
fn newer_schema_is_never_modified_and_corruption_is_not_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("newer.sqlite3");
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection.execute_batch("PRAGMA user_version=2; CREATE TABLE future(data TEXT); INSERT INTO future VALUES('keep');").unwrap();
    drop(connection);
    let before = std::fs::read(&path).unwrap();
    assert!(store::Store::open(path.clone()).is_err());
    assert_eq!(before, std::fs::read(&path).unwrap());
    let corrupt = dir.path().join("corrupt.sqlite3");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(store::Store::open(corrupt.clone()).is_err());
    assert_eq!(std::fs::read(corrupt).unwrap(), b"not a database");
}

#[tokio::test]
async fn host_rejects_untrusted_ingest_isolates_bad_rows_and_preserves_live_decode_on_disk_failure()
{
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("archive.sqlite3");
    let identity = IdentityHost::fixture();
    let host = ArchiveHost::default();
    let viewer = viewer();
    let request = |input| {
        execute(
            &identity,
            host.clone(),
            path.clone(),
            "https://a.test".into(),
            viewer.clone(),
            input,
        )
    };
    request(Request::Settings).await.unwrap();
    let event = envelope(&viewer, 24200, 0);
    request(Request::Ingest {
        event: event.clone(),
        revision: 0,
    })
    .await
    .unwrap();
    for kind in [24200, 44200] {
        let stale = envelope_at(&viewer, kind, 8, event.created_at - 301);
        let wrong_viewer = envelope(&event.pubkey, kind, 9);
        for invalid in [stale, wrong_viewer] {
            assert!(request(Request::Ingest {
                event: invalid,
                revision: 0
            })
            .await
            .is_err());
        }
    }
    assert_eq!(
        rusqlite::Connection::open(&path)
            .unwrap()
            .query_row("SELECT COUNT(*) FROM archive_events", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let other = envelope(&viewer, 24200, 1);
    request(Request::Ingest {
        event: other.clone(),
        revision: 0,
    })
    .await
    .unwrap();
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE archive_events SET envelope='broken' WHERE id=?1",
            [other.id],
        )
        .unwrap();
    let page = request(Request::Read {
        kind: 24200,
        agent: None,
        before: None,
    })
    .await
    .unwrap();
    assert_eq!(page["records"].as_array().unwrap().len(), 1);
    assert_eq!(page["skipped"], 1);
    assert!(execute(
        &identity,
        host.clone(),
        path.clone(),
        "https://a.test".into(),
        "f".repeat(64),
        Request::Settings
    )
    .await
    .is_err());
    connection.execute_batch("CREATE TRIGGER refuse_clear BEFORE DELETE ON archive_events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    assert!(request(Request::Clear { kind: Some(24200) }).await.is_err());
    assert_eq!(
        request(Request::Read {
            kind: 24200,
            agent: None,
            before: None
        })
        .await
        .unwrap()["records"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let corrupt = directory.path().join("broken.sqlite3");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(execute(
        &identity,
        ArchiveHost::default(),
        corrupt,
        "https://a.test".into(),
        viewer.clone(),
        Request::Settings
    )
    .await
    .is_err());
    assert!(crate::relay::agent::decode_archive(&[1; 32], &viewer, &event, false).is_ok());
}

#[test]
fn quota_evicts_oldest_of_noisy_agent_before_other_agents_and_clear_reclaims_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("quota.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let community = "https://a.test";
    store.seed(&viewer, community).unwrap();
    let event = envelope(&viewer, 24200, 0);
    let now = event.created_at as i64;
    let raw_size = serde_json::to_string(&event).unwrap().len() as i64;
    let db = rusqlite::Connection::open(&path).unwrap();
    // Small test budget exercises the production quota algorithm, not 512 MiB of fixtures.
    db.execute(
        "UPDATE archive_subscriptions SET budget=?1 WHERE name='observer'",
        [raw_size * 8],
    )
    .unwrap();
    let mut quiet = event.clone();
    quiet.pubkey = "b".repeat(64);
    quiet.id = "b".repeat(64);
    store.ingest(&viewer, community, &quiet, 0, now).unwrap();
    store.ingest(&viewer, community, &event, 0, now).unwrap();
    for i in 1..5 {
        store
            .ingest(&viewer, community, &envelope(&viewer, 24200, i), 0, now)
            .unwrap();
    }
    let rows = store.read(&viewer, community, 24200, None, None).unwrap().0;
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| row.2.contains(&quiet.id)));
    assert!(!rows.iter().any(|row| row.2.contains(&event.id)));
    assert!(
        store.settings(&viewer, community).unwrap()["bytes"]
            .as_i64()
            .unwrap()
            <= raw_size * 8
    );
    db.execute(
        "UPDATE archive_subscriptions SET budget=536870912 WHERE name='observer'",
        [],
    )
    .unwrap();
    // Store-only fixtures intentionally bypass signature admission, proven in host/IPC tests.
    for i in 10..410 {
        let mut large = envelope(&viewer, 24200, i);
        large.content = "x".repeat(8000);
        store.ingest(&viewer, community, &large, 0, now).unwrap();
    }
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    let before = std::fs::metadata(&path).unwrap().len();
    store.clear(&viewer, community, Some(24200)).unwrap();
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    assert!(std::fs::metadata(&path).unwrap().len() < before);
    assert_eq!(store.settings(&viewer, community).unwrap()["bytes"], 0);
    let free: i64 = db
        .query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap();
    assert_eq!(free, 0);
}

#[test]
fn community_quota_evicts_oldest_across_agents_with_individual_usage_below_cap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pool.sqlite3");
    let mut store = store::Store::open(path.clone()).unwrap();
    let viewer = viewer();
    let community = "https://a.test";
    store.seed(&viewer, community).unwrap();
    let first = envelope(&viewer, 24200, 0);
    let now = first.created_at as i64;
    let size = serde_json::to_string(&first).unwrap().len() as i64;
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE archive_subscriptions SET budget=?1 WHERE name='observer'",
        [size * 4],
    )
    .unwrap();
    // Store-only fixtures: host/IPC tests separately prove signature admission.
    for index in 0..5 {
        let mut row = first.clone();
        row.pubkey = format!("{index:064x}");
        row.id = row.pubkey.clone();
        store.ingest(&viewer, community, &row, 0, now).unwrap();
    }
    let rows = store.read(&viewer, community, 24200, None, None).unwrap().0;
    assert_eq!(rows.len(), 4);
    let ids: Vec<String> = rows
        .iter()
        .map(|r| serde_json::from_str::<AgentEvent>(&r.2).unwrap().id)
        .collect();
    assert_eq!(
        ids,
        (1..5)
            .rev()
            .map(|i| format!("{i:064x}"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        store.settings(&viewer, community).unwrap()["bytes"],
        size * 4
    );
}
