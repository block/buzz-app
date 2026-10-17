use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Notify, Semaphore},
};

fn pubkey(secret: [u8; 32]) -> String {
    PublicKey::from_secret_key(
        &Secp256k1::signing_only(),
        &SecretKey::from_byte_array(secret).unwrap(),
    )
    .x_only_public_key()
    .0
    .to_string()
}
struct FixtureState {
    mapping: Option<String>,
    mapping_status: u16,
    mapping_body: Option<serde_json::Value>,
    owner: String,
    recipient_id: String,
    recipient_key: Option<String>,
    subject: String,
    receipt_stored: bool,
    receipt_matches: bool,
    upload_status: u16,
    requests: HashMap<String, usize>,
    uploads: Vec<Vec<u8>>,
    rows: HashMap<String, Vec<u8>>,
}
struct Service {
    root: String,
    state: Arc<Mutex<FixtureState>>,
    pause_upload: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    upload_started: Arc<Notify>,
    release_upload: Arc<Semaphore>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Service {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(Mutex::new(FixtureState {
            mapping: Some(pubkey([1; 32])),
            mapping_status: 200,
            mapping_body: None,
            owner: "subject:synthetic-account".into(),
            recipient_id: "backup-key-2026-09".into(),
            recipient_key: None,
            subject: "synthetic-account".into(),
            receipt_stored: true,
            receipt_matches: true,
            upload_status: 200,
            requests: HashMap::new(),
            uploads: Vec::new(),
            rows: HashMap::new(),
        }));
        let pause_upload = Arc::new(AtomicBool::new(false));
        let pause_current = Arc::new(AtomicBool::new(false));
        let upload_started = Arc::new(Notify::new());
        let release_upload = Arc::new(Semaphore::new(0));
        let current = pause_current.clone();
        let (shared, pause, started, release) = (
            state.clone(),
            pause_upload.clone(),
            upload_started.clone(),
            release_upload.clone(),
        );
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let current = current.clone();
                let (shared, pause, started, release) = (
                    shared.clone(),
                    pause.clone(),
                    started.clone(),
                    release.clone(),
                );
                tokio::spawn(async move {
                    serve(stream, shared, pause, current, started, release).await;
                });
            }
        });
        Self {
            root,
            state,
            pause_upload,
            pause_current,
            upload_started,
            release_upload,
            task,
        }
    }
    fn host(&self, root: &std::path::Path) -> NsecBackupHost {
        NsecBackupHost {
            state: Default::default(),
            config: Arc::new(Some(Config {
                service_url: self.root.clone(),
                namespace: "backup/staging".into(),
            })),
            root: Some(root.to_owned()),
        }
    }
    fn session(&self) -> Session {
        Session {
            source: Source::Hosted,
            credential: Zeroizing::new("synthetic-cli-credential".into()),
        }
    }
    async fn enable(&self, host: &NsecBackupHost) {
        host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true)
            .await
            .unwrap();
    }
}
async fn serve(
    mut stream: TcpStream,
    shared: Arc<Mutex<FixtureState>>,
    pause: Arc<AtomicBool>,
    pause_current: Arc<AtomicBool>,
    started: Arc<Notify>,
    release: Arc<Semaphore>,
) {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if let Some(index) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&bytes[..header_end])
        .unwrap()
        .to_owned();
    let path = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .to_owned();
    let length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    while bytes.len() < header_end + length {
        let count = stream.read(&mut chunk).await.unwrap();
        if count == 0 {
            return;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let body = bytes[header_end..].to_vec();
    assert!(
        path.ends_with("/exchange")
            || header
                .to_ascii_lowercase()
                .contains("x-bb-session-credential: synthetic-cli-credential")
    );
    let (status, response) = {
        let mut state = shared.lock().unwrap();
        *state.requests.entry(path.clone()).or_default() += 1;
        match path.as_str() {
            "/v1/auth/me" => (200, serde_json::json!({"subject":state.subject,"expires_at":"2999-01-01T00:00:00Z"})),
            "/v1/buzz/nostr-identities/current" => (state.mapping_status,state.mapping_body.clone().unwrap_or_else(||serde_json::json!({"correlation_id":"synthetic-correlation","identity":state.mapping.as_ref().map(|key|serde_json::json!({"pubkey_hex":key}))}))),
            "/v1/buzz/nsec-backups/enrollment" => {
                let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/hpke_nsec_backup_v1.json")).unwrap();
                (200, serde_json::json!({"version":1,"suite":{"kem_id":16,"kdf_id":1,"aead_id":2},
                    "recipient_key_id":state.recipient_id,"service_namespace":"backup/staging","owner_id":state.owner,
                    "backup_id":uuid::Uuid::new_v4().to_string(),"nostr_pubkey":state.mapping,
                    "recipient_public_key":state.recipient_key.clone().unwrap_or_else(||URL_SAFE_NO_PAD.encode(hex::decode(fixture["recipient_public_key_sec1_hex"].as_str().unwrap()).unwrap()))}))
            },
            "/v1/buzz/nsec-backups" => {
                let envelope: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let id = envelope["backup_id"].as_str().unwrap().to_owned();
                if let Some(previous) = state.rows.get(&id) { assert_eq!(previous, &body); }
                state.rows.insert(id.clone(),body.clone());
                state.uploads.push(body);
                (state.upload_status,serde_json::json!({"backup_id":if state.receipt_matches { id } else { uuid::Uuid::new_v4().to_string() },"stored":state.receipt_stored}))
            },
            _ => panic!("unexpected synthetic route {path}"),
        }
    };
    if path == "/v1/buzz/nsec-backups" && pause.load(Ordering::SeqCst)
        || path == "/v1/buzz/nostr-identities/current" && pause_current.load(Ordering::SeqCst)
    {
        started.notify_one();
        release.acquire().await.unwrap().forget();
    }
    let response = serde_json::to_vec(&response).unwrap();
    let header = format!("HTTP/1.1 {status} Synthetic\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
    stream.write_all(header.as_bytes()).await.unwrap();
    let _ = stream.write_all(&response).await;
}

#[tokio::test]
async fn overlapping_binding_triggers_back_up_after_a_stale_missing_mapping_response() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    let identity = IdentityHost::fixture();
    service.state.lock().unwrap().mapping = None;
    service.pause_current.store(true, Ordering::SeqCst);
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(identity.clone());
    service.upload_started.notified().await;
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    for _ in 0..3 {
        host.trigger(identity.clone());
    }
    service.pause_current.store(false, Ordering::SeqCst);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    let state = service.state.lock().unwrap();
    assert_eq!(state.requests["/v1/buzz/nostr-identities/current"], 2);
    assert_eq!(state.uploads.len(), 1);
    assert_eq!(state.rows.len(), 1);
    drop(state);
    let record = persistence::LockedRecord::open(
        directory.path(),
        host.config.as_ref().as_ref().unwrap(),
        "synthetic-account",
        &pubkey([1; 32]),
    )
    .unwrap()
    .read()
    .unwrap()
    .unwrap();
    assert!(record.envelope.is_none());
}

#[tokio::test]
async fn retirement_cancels_a_queued_binding_pass_without_recreating_erased_records() {
    for signout in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("records");
        std::fs::create_dir(&root).unwrap();
        let host = service.host(&root);
        service.enable(&host).await;
        service.enable(&host).await;
        let identity = IdentityHost::fixture();
        service.pause_current.store(true, Ordering::SeqCst);
        host.state.lock().unwrap().sessions.push(service.session());
        host.trigger(identity.clone());
        service.upload_started.notified().await;
        host.trigger(identity.clone());
        let worker = host
            .state
            .lock()
            .unwrap()
            .worker
            .as_ref()
            .unwrap()
            .inner()
            .abort_handle();
        if signout {
            host.close();
        } else {
            host.document_load();
        }
        tokio::time::timeout(Duration::from_secs(5), async {
            while !worker.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        std::fs::remove_dir_all(&root).unwrap();
        service.release_upload.add_permits(1);
        host.trigger(identity);
        finish_background(&host).await;
        assert!(!root.exists());
        let state = service.state.lock().unwrap();
        assert_eq!(state.requests["/v1/buzz/nostr-identities/current"], 1);
        assert!(state.uploads.is_empty());
    }
}

#[tokio::test]
async fn restart_retry_reuses_persisted_ciphertext_and_completion_prevents_more_slots() {
    // A lost acknowledgment retains ciphertext while the authenticated recipient is unchanged.
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().upload_status = 503;
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    let first = service.state.lock().unwrap().uploads[0].clone();
    service.state.lock().unwrap().upload_status = 200;
    let restarted = service.host(directory.path());
    restarted
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false)
        .await
        .unwrap();
    let baseline = service.state.lock().unwrap().requests.clone();
    restarted
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    assert_eq!(service.state.lock().unwrap().requests, baseline);
    service.enable(&restarted).await;
    restarted
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    restarted
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads, vec![first.clone(), first]);
    assert_eq!(state.rows.len(), 1);
    assert_eq!(state.requests["/v1/buzz/nsec-backups/enrollment"], 2);
}

#[tokio::test]
async fn invalid_receipts_and_changed_recipient_owner_cannot_settle_or_reseal_a_pending_backup() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().receipt_matches = false;
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().receipt_matches = true;
    service.state.lock().unwrap().receipt_stored = false;
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().receipt_stored = true;
    // A new authenticated owner gets a separate record, never the old owner's ciphertext.
    service.state.lock().unwrap().owner = "subject:other-synthetic-account".into();
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().subject = "other-synthetic-account".into();
    host.backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_ne!(state.uploads[1], state.uploads[2]);
    assert_eq!(state.rows.len(), 2);
}

#[tokio::test]
async fn mismatched_mapping_and_unwritable_pending_state_never_upload() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.state.lock().unwrap().mapping = Some(pubkey([2; 32]));
    assert!(host
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    service.state.lock().unwrap().mapping = Some(pubkey([1; 32]));
    service.pause_current.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let session = service.session();
    let backup = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    let retained = directory.path().with_extension("retained");
    std::fs::rename(directory.path(), &retained).unwrap();
    std::fs::write(directory.path(), b"synthetic persistence failure").unwrap();
    service.release_upload.add_permits(1);
    let result = backup.await;
    std::fs::remove_file(directory.path()).unwrap();
    std::fs::rename(&retained, directory.path()).unwrap();
    assert!(result.unwrap().is_err());
    assert!(service.state.lock().unwrap().uploads.is_empty());
}

#[tokio::test]
async fn competing_workers_and_signout_keep_an_admitted_upload_pending() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let task_host = host.clone();
    let session = service.session();
    let upload = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    assert!(service
        .host(directory.path())
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .is_err());
    host.close();
    service.release_upload.add_permits(1);
    assert!(upload.await.unwrap().is_err());
    service.pause_upload.store(false, Ordering::SeqCst);
    service
        .host(directory.path())
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads.len(), 2);
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_eq!(state.rows.len(), 1);
}

#[tokio::test]
async fn known_missing_mapping_accepts_omitted_identity_but_malformed_success_is_retryable() {
    for response in [
        serde_json::json!({"correlation_id":"synthetic-correlation"}),
        serde_json::json!({}),
    ] {
        let service = Service::new().await;
        service.state.lock().unwrap().mapping_body = Some(response.clone());
        let result = Api::new(&service.root, "synthetic-cli-credential")
            .unwrap()
            .current()
            .await;
        if response.get("correlation_id").is_some() {
            assert_eq!(result.unwrap(), None);
        } else {
            assert!(result.is_err());
        }
    }
}

#[tokio::test]
async fn completion_persistence_failure_retains_the_same_pending_bytes_for_restart() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("records");
    let retained = directory.path().join("retained");
    let host = service.host(&root);
    service.enable(&host).await;
    service.pause_upload.store(true, Ordering::SeqCst);
    let session = service.session();
    let task_host = host.clone();
    let backup = tokio::spawn(async move {
        task_host
            .backup(&IdentityHost::fixture(), &session, 0)
            .await
    });
    service.upload_started.notified().await;
    std::fs::rename(&root, &retained).unwrap();
    std::fs::write(&root, b"synthetic persistence failure").unwrap();
    service.release_upload.add_permits(1);
    assert!(backup.await.unwrap().is_err());
    std::fs::remove_file(&root).unwrap();
    std::fs::rename(&retained, &root).unwrap();
    service.pause_upload.store(false, Ordering::SeqCst);
    service
        .host(&root)
        .backup(&IdentityHost::fixture(), &service.session(), 0)
        .await
        .unwrap();
    let state = service.state.lock().unwrap();
    assert_eq!(state.uploads.len(), 2);
    assert_eq!(state.uploads[0], state.uploads[1]);
    assert_eq!(state.rows.len(), 1);
}

#[tokio::test]
async fn absent_or_invalid_consent_never_contacts_the_backup_service() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    let identity = IdentityHost::fixture();
    let path = directory.path().join("choice.json");
    host.backup(&identity, &service.session(), 0).await.unwrap();
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.enable(&host).await;
    let session = service.session();
    let queued = host.backup(&identity, &session, 0);
    host.set_choice(identity.clone(), &pubkey([1; 32]), false)
        .await
        .unwrap();
    queued.await.unwrap();
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.enable(&host).await;
    let original: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("automatic", serde_json::json!(false)),
        ("pubkey", serde_json::json!(pubkey([2; 32]))),
        ("service", serde_json::json!("https://other.example")),
        ("namespace", serde_json::json!("other")),
    ] {
        let mut changed = original.clone();
        changed[field] = value;
        std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        host.backup(&identity, &service.session(), 0).await.unwrap();
        assert!(service.state.lock().unwrap().requests.is_empty());
    }
    std::fs::write(&path, b"corrupt").unwrap();
    assert!(host.backup(&identity, &service.session(), 0).await.is_err());
    assert!(service.state.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn saving_consent_after_login_wakes_the_existing_uploader_and_disable_fences_later_passes() {
    let service = Service::new().await;
    let directory = tempfile::tempdir().unwrap();
    let host = service.host(directory.path());
    host.state.lock().unwrap().sessions.push(service.session());
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert!(service.state.lock().unwrap().requests.is_empty());
    service.pause_upload.store(true, Ordering::SeqCst);
    let started = service.upload_started.notified();
    host.set_choice(IdentityHost::fixture(), &pubkey([1; 32]), true)
        .await
        .unwrap();
    started.await;
    let other = service.host(directory.path());
    let refused = other
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false)
        .await;
    let choice = crate::nsec_backup_choice::read(
        &directory.path().join("choice.json"),
        host.config.as_ref().as_ref().unwrap(),
        &pubkey([1; 32]),
    );
    let still_enabled = choice.as_ref().ok().map(|choice| choice.automatic);
    drop(choice);
    service.release_upload.add_permits(1);
    finish_background(&host).await;
    assert!(refused.is_err());
    assert_eq!(still_enabled, Some(Some(true)));
    other
        .set_choice(IdentityHost::fixture(), &pubkey([1; 32]), false)
        .await
        .unwrap();
    let baseline = service.state.lock().unwrap().requests.clone();
    host.trigger(IdentityHost::fixture());
    finish_background(&host).await;
    assert_eq!(service.state.lock().unwrap().requests, baseline);
    assert_eq!(service.state.lock().unwrap().uploads.len(), 1);
}

#[test]
fn source_generations_and_teardown_fence_retired_work_without_another_sources_logout() {
    // No filesystem or worker is configured; exercise purpose-specific credential ownership.
    let host = NsecBackupHost {
        state: Default::default(),
        root: None,
        config: Arc::new(Some(Config {
            service_url: "https://app.builderlab.xyz/api/goose".into(),
            namespace: "backup/staging".into(),
        })),
    };
    host.session(
        Source::Hosted,
        3,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    let epoch = host.state.lock().unwrap().epoch;
    host.session(Source::Hosted, 2, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_ok());
    host.session(Source::Hosted, 4, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_err());
    assert!(host.state.lock().unwrap().sessions.is_empty());
    host.session(
        Source::Hosted,
        5,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    let epoch = host.state.lock().unwrap().epoch;
    host.document_load();
    assert!(host.valid(epoch).is_err());
    assert!(host.state.lock().unwrap().sessions.is_empty());
    host.close();
    host.session(
        Source::Hosted,
        7,
        Some("synthetic-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    assert!(host.state.lock().unwrap().sessions.is_empty());
}

async fn finish_background(host: &NsecBackupHost) {
    let worker = host.state.lock().unwrap().worker.take();
    if let Some(worker) = worker {
        worker.await.unwrap();
    }
}

#[tokio::test]
async fn pending_backup_reseals_when_the_authenticated_recipient_rotates() {
    for change_key in [false, true] {
        let service = Service::new().await;
        let directory = tempfile::tempdir().unwrap();
        let host = service.host(directory.path());
        service.enable(&host).await;
        service.state.lock().unwrap().upload_status = 503;
        assert!(host
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .is_err());
        {
            let mut state = service.state.lock().unwrap();
            if change_key {
                let fixture: serde_json::Value =
                    serde_json::from_str(include_str!("fixtures/hpke_nsec_backup_v1.json"))
                        .unwrap();
                state.recipient_key = Some(fixture["envelope"]["enc"].as_str().unwrap().into());
            } else {
                state.recipient_id = "backup-key-rotated".into();
            }
            state.upload_status = 200;
        }
        let restarted = service.host(directory.path());
        restarted
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .unwrap();
        restarted
            .backup(&IdentityHost::fixture(), &service.session(), 0)
            .await
            .unwrap();
        let state = service.state.lock().unwrap();
        assert_eq!(state.uploads.len(), 2);
        let old: serde_json::Value = serde_json::from_slice(&state.uploads[0]).unwrap();
        let new: serde_json::Value = serde_json::from_slice(&state.uploads[1]).unwrap();
        assert_ne!(old["backup_id"], new["backup_id"]);
        assert_ne!(old["ciphertext"], new["ciphertext"]);
        assert_eq!(new["recipient_key_id"], state.recipient_id);
        assert_eq!(new["owner_id"], old["owner_id"]);
        assert_eq!(new["nostr_pubkey"], old["nostr_pubkey"]);
        assert_eq!(state.requests["/v1/buzz/nsec-backups/enrollment"], 2);
    }
}

#[test]
fn signing_out_the_latest_source_retains_the_other_sources_session() {
    let host = NsecBackupHost {
        state: Default::default(),
        root: None,
        config: Arc::new(Some(Config {
            service_url: "https://app.builderlab.xyz/api/goose".into(),
            namespace: "backup/staging".into(),
        })),
    };
    // Start with an admitted secondary session, independent of optional build origins.
    host.state.lock().unwrap().sessions.push(Session {
        source: Source::Builderlab,
        credential: Zeroizing::new("synthetic-builderlab-session".into()),
    });
    host.session(
        Source::Hosted,
        1,
        Some("synthetic-hosted-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    host.session(Source::Hosted, 2, None, IdentityHost::fixture())
        .unwrap();
    assert!(host
        .state
        .lock()
        .unwrap()
        .sessions
        .last()
        .is_some_and(|s| s.source == Source::Builderlab));
    host.session(
        Source::Hosted,
        3,
        Some("synthetic-hosted-session".into()),
        IdentityHost::fixture(),
    )
    .unwrap();
    host.retry(Source::Builderlab, IdentityHost::fixture());
    let epoch = host.state.lock().unwrap().epoch;
    host.session(Source::Hosted, 4, None, IdentityHost::fixture())
        .unwrap();
    assert!(host.valid(epoch).is_ok());
    assert!(host
        .state
        .lock()
        .unwrap()
        .sessions
        .last()
        .is_some_and(|s| s.source == Source::Builderlab
            && s.credential.as_str() == "synthetic-builderlab-session"));
}
