use super::*;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct MemoryCredentials {
    keys: Mutex<BTreeMap<String, Secret>>,
    denied: AtomicBool,
    adds: AtomicUsize,
    fail_record: Mutex<Option<PathBuf>>,
}
impl Credentials for MemoryCredentials {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        unreachable!()
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        if self.denied.load(Ordering::SeqCst) {
            return Err(IMPORT_GATE.into());
        }
        self.keys
            .lock()
            .unwrap()
            .get(id)
            .map(|key| Secret::parse(&key.hex(), pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
        self.adds.fetch_add(1, Ordering::SeqCst);
        self.keys
            .lock()
            .unwrap()
            .insert(id.into(), Secret::parse(&key.hex(), key.pubkey())?);
        if let Some(path) = self.fail_record.lock().unwrap().take() {
            std::fs::create_dir(path).unwrap();
        }
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<(), String> {
        self.keys.lock().unwrap().remove(id);
        Ok(())
    }
}

fn app_at(
    root: &std::path::Path,
    credentials: Arc<MemoryCredentials>,
) -> (
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let host = AgentHost::open_with_credentials(
        Ok((
            root.join("store"),
            root.join("legacy"),
            root.join("workspace"),
        )),
        Err(RUNTIME_GATE.into()),
        credentials,
    );
    let app = mock_builder()
        .manage(host.clone())
        .manage(crate::harness_setup::HarnessSetup::default())
        .manage(crate::agent_models::ModelHost::new(Ok(root.join("store"))))
        .manage(crate::identity::IdentityHost::fixture())
        .invoke_handler(crate::commands())
        .build(crate::app_context())
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (host, app, view)
}
fn edit(root: &std::path::Path, command: &str) -> Value {
    json!({"name":"Created", "systemPrompt":"", "workspace":root,
        "harness":{"command":command,"args":[],"model":"sample","provider":"sample"},"environment":{}})
}
fn request(view: &tauri::WebviewWindow<MockRuntime>, edit: &Value) -> Value {
    let owner = invoke(view, "identity_restore", json!({})).unwrap();
    json!({"requestId":uuid::Uuid::new_v4().to_string(),"destination":"wss://relay.example","owner":owner,"edit":edit})
}
fn authorize(view: &tauri::WebviewWindow<MockRuntime>, request: &Value, prepared: &Value) -> Value {
    invoke(view, "agent_control_create_authorize", json!({"destination":request["destination"],"owner":request["owner"],"pubkey":prepared["pubkey"]})).unwrap()
}
fn commit(
    view: &tauri::WebviewWindow<MockRuntime>,
    request: &Value,
    auth: &Value,
) -> Result<Value, Value> {
    invoke(
        view,
        "agent_control_create_commit",
        json!({"requestId":request["requestId"],"edit":request["edit"],"auth":auth.to_string()}),
    )
}

#[test]
fn credential_denial_keeps_existing_harness_create_retry_usable() {
    for command in ["buzz-agent", "goose", "/fixture/buzz-pi-acp"] {
        let root = tempfile::tempdir().unwrap();
        let credentials = Arc::new(MemoryCredentials::default());
        let (_host, _app, view) = app_at(root.path(), credentials.clone());
        let request = request(&view, &edit(root.path(), command));
        let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        let auth = authorize(&view, &request, &prepared);
        credentials.denied.store(true, Ordering::SeqCst);
        assert_eq!(
            commit(&view, &request, &auth).unwrap_err(),
            json!(IMPORT_GATE)
        );
        assert!(invoke(&view, "agent_control_create_recovery", json!({}))
            .unwrap()
            .is_null());
        credentials.denied.store(false, Ordering::SeqCst);
        let retried = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        assert_eq!(retried, prepared);
        let result = commit(&view, &request, &auth).unwrap();
        assert_eq!(result["agents"].as_array().unwrap().len(), 1);
        assert_eq!(result["agents"][0]["id"], prepared["id"]);
        assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn committed_create_survives_response_failure_and_fresh_host_retry() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let (host, app, view) = app_at(root.path(), credentials.clone());
    let request = request(&view, &edit(root.path(), "buzz-agent"));
    let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    let auth = authorize(&view, &request, &prepared);
    // Agent persistence succeeds; the following snapshot cannot read defaults.
    std::fs::write(root.path().join("store/defaults.json"), "invalid").unwrap();
    assert!(commit(&view, &request, &auth).is_err());
    std::fs::remove_file(root.path().join("store/defaults.json")).unwrap();
    // The mock app retains State clones; explicitly drop the entire native host.
    *host.0.lock().unwrap() = Err("Simulated app termination".into());
    drop(view);
    drop(app);
    drop(host);
    let (_host, _app, view) = app_at(root.path(), credentials.clone());
    let replay = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    assert_eq!(replay["id"], prepared["id"]);
    assert_eq!(replay["completed"], true);
    let snapshot = commit(&view, &request, &auth).unwrap();
    assert_eq!(snapshot["agents"].as_array().unwrap().len(), 1);
    assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    let mut changed = request.clone();
    changed["edit"]["name"] = json!("Different");
    assert!(invoke(&view, "agent_control_create_prepare", changed).is_err());
    let mut other_owner = request.clone();
    other_owner["owner"] = json!("ab".repeat(32));
    assert!(invoke(&view, "agent_control_create_prepare", other_owner).is_err());
}

#[cfg(unix)]
fn codex_edit(root: &std::path::Path) -> Value {
    let mut edit = edit(root, root.join("tools/codex-acp").to_str().unwrap());
    edit["harness"]["integration"] = json!("codex");
    edit["harness"]["configuration"] = json!({"mode":"default"});
    edit["harness"]["model"] = json!("");
    edit["harness"]["provider"] = json!("");
    edit
}

#[test]
#[cfg(unix)]
fn codex_create_and_edit_without_tools_preserve_identity_recovery_and_revision_checks() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().to_path_buf();
    let credentials = Arc::new(MemoryCredentials::default());
    let expected_id = {
        let (host, _app, view) = app_at(&root, credentials.clone());
        let request = request(&view, &codex_edit(&root));
        // No adapter or CLI exists at the selected path. Create must not run
        // inference or require readiness; runtime failures belong to Start.
        assert!(!root.join("tools/codex-acp").exists());
        let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
        let auth = authorize(&view, &request, &prepared);
        // Fail the record write after the key is durable, leaving only the
        // on-disk journal and synthetic secure storage for the next host.
        *credentials.fail_record.lock().unwrap() = Some(root.join("store/agents.previous.json"));
        assert!(commit(&view, &request, &auth).is_err());
        assert!(invoke(&view, "agent_control_create_recovery", json!({}))
            .unwrap()
            .is_object());
        assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
        *host.0.lock().unwrap() = Err("Simulated app termination".into());
        prepared["id"].clone()
    };
    std::fs::remove_dir(root.join("store/agents.previous.json")).unwrap();
    let (_host, _app, view) = app_at(&root, credentials.clone());
    let recovery = invoke(&view, "agent_control_create_recovery", json!({})).unwrap();
    let auth = authorize(&view, &recovery, &recovery);
    // Signing again demonstrably changes bytes; both authorize the same key.
    assert_ne!(auth, authorize(&view, &recovery, &recovery));
    let mut edit = codex_edit(&root);
    edit["name"] = json!("Changed");
    let resume = |edit: Value, auth: &Value| {
        invoke(
            &view,
            "agent_control_create_resume",
            json!({"requestId":recovery["requestId"],"edit":edit,"auth":auth.to_string()}),
        )
    };
    assert!(resume(edit, &auth).is_err());
    let mut forged = auth.clone();
    forged[3] = json!("00".repeat(64));
    assert!(resume(codex_edit(&root), &forged).is_err());
    let result = resume(codex_edit(&root), &auth).unwrap();
    assert_eq!(result["agents"].as_array().unwrap().len(), 1);
    assert_eq!(result["agents"][0]["id"], expected_id);
    assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    assert!(invoke(&view, "agent_control_create_recovery", json!({}))
        .unwrap()
        .is_null());
    // Advanced execution changes save without tools or account access, but
    // stale revisions and attempts to strip the native integration still fail.
    let before = result["agents"][0].clone();
    let mut edit = codex_edit(&root);
    edit["systemPrompt"] = json!("Updated instructions");
    edit["harness"]["model"] = json!("model-a");
    edit["harness"]["configuration"] =
        json!({"mode":"advanced","effort":{"kind":"value","value":"high"}});
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":before["revision"],"edit":edit}),
    )
    .unwrap();
    assert_eq!(saved["agents"][0]["systemPrompt"], "Updated instructions");
    assert_eq!(saved["agents"][0]["harness"]["model"], "model-a");
    assert_eq!(
        saved["agents"][0]["revision"],
        before["revision"].as_u64().unwrap() + 1
    );
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":before["revision"],"edit":edit})
    )
    .is_err());
    edit["harness"]
        .as_object_mut()
        .unwrap()
        .remove("integration");
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":expected_id,"expectedRevision":saved["agents"][0]["revision"],"edit":edit})
    )
    .is_err());
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"],
        saved["agents"]
    );
}
