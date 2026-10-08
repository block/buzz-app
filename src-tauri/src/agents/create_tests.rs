use super::*;
use std::sync::atomic::AtomicUsize;

#[derive(Default)]
struct MemoryCredentials {
    keys: Mutex<BTreeMap<String, Secret>>,
    denied: AtomicBool,
    adds: AtomicUsize,
    gate: Mutex<Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>>,
}
impl Credentials for MemoryCredentials {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        unreachable!()
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        if self.denied.load(Ordering::SeqCst) {
            return Err(IMPORT_GATE.into());
        }
        if let Some((entered, release)) = self.gate.lock().unwrap().take() {
            entered.send(()).unwrap();
            release.recv().unwrap();
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
fn create_commit_releases_admission_during_credential_io() {
    let root = tempfile::tempdir().unwrap();
    let credentials = Arc::new(MemoryCredentials::default());
    let (host, _app, view) = app_at(root.path(), credentials.clone());
    let request = request(&view, &edit(root.path(), "buzz-agent"));
    let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    let auth = authorize(&view, &request, &prepared);
    let (entered, acquired) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    *credentials.gate.lock().unwrap() = Some((entered, wait));
    let committing = {
        let view = view.clone();
        std::thread::spawn(move || commit(&view, &request, &auth))
    };
    acquired.recv().unwrap();
    // A Keychain prompt can wait on the user; Stop and refresh must not queue
    // behind it.
    assert!(host.2.try_lock().is_ok());
    assert!(tauri::async_runtime::block_on(run(host.clone(), |host| host.snapshot())).is_ok());
    release.send(()).unwrap();
    let result = committing.join().unwrap().unwrap();
    assert_eq!(result["agents"][0]["id"], prepared["id"]);
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
fn codex_create_and_edit_without_tools_preserve_revision_checks() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let credentials = Arc::new(MemoryCredentials::default());
    let (_host, _app, view) = app_at(root, credentials.clone());
    let request = request(&view, &codex_edit(root));
    // No adapter or CLI exists at the selected path. Create must not run
    // inference or check tools; runtime failures belong to Start.
    assert!(!root.join("tools/codex-acp").exists());
    let prepared = invoke(&view, "agent_control_create_prepare", request.clone()).unwrap();
    let auth = authorize(&view, &request, &prepared);
    let result = commit(&view, &request, &auth).unwrap();
    let expected_id = prepared["id"].clone();
    assert_eq!(result["agents"].as_array().unwrap().len(), 1);
    assert_eq!(result["agents"][0]["id"], expected_id);
    assert_eq!(result["agents"][0]["harness"]["integration"], "codex");
    assert_eq!(credentials.adds.load(Ordering::SeqCst), 1);
    // Advanced execution changes save without tools or account access, but
    // stale revisions and attempts to strip the native integration still fail.
    let before = result["agents"][0].clone();
    let mut edit = codex_edit(root);
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
