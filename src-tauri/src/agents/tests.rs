use super::*;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, MockRuntime};

const RUNTIME_GATE: &str = "Synthetic runtime unavailable.";
const IMPORT_GATE: &str = "Synthetic credential refusal.";

// Test-only custody. Synthetic fixtures cannot reach PlatformCredentials.
struct RejectingCredentials;
impl Credentials for RejectingCredentials {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        Err(IMPORT_GATE.into())
    }
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
        Err(IMPORT_GATE.into())
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        Err(IMPORT_GATE.into())
    }
}

impl AgentHost {
    fn open(paths: Result<(PathBuf, PathBuf, PathBuf), String>) -> Self {
        Self(
            Arc::new(Mutex::new(paths.and_then(|(root, legacy, workspace)| {
                Host::open(
                    root,
                    legacy,
                    workspace,
                    Err(RUNTIME_GATE.into()),
                    Arc::new(RejectingCredentials),
                )
            }))),
            Arc::new(AtomicBool::new(false)),
        )
    }
}

pub(crate) fn fixture() -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    fixture_with_models(|dir| crate::agent_models::ModelHost::new(Ok(dir.join("store"))))
}
pub(crate) fn fixture_with_models(
    models: impl FnOnce(&std::path::Path) -> crate::agent_models::ModelHost,
) -> (
    tempfile::TempDir,
    AgentHost,
    tauri::App<MockRuntime>,
    tauri::WebviewWindow<MockRuntime>,
) {
    let dir = tempfile::tempdir().unwrap();
    let model_host = models(dir.path());
    let host = AgentHost::open(Ok((
        dir.path().join("store"),
        dir.path().join("legacy"),
        dir.path().join("workspace"),
    )));
    let app = mock_builder()
        .manage(host.clone())
        .manage(model_host)
        .invoke_handler(crate::commands())
        .build(mock_context(noop_assets()))
        .unwrap();
    let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    (dir, host, app, view)
}
pub(crate) fn invoke(
    view: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        view,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize().unwrap())
}
pub(crate) fn seed(dir: &std::path::Path) -> String {
    let id = format!(
        "{}-{}",
        "ab".repeat(32),
        "733db93c5a38b650794422a480fab67f1dd8f6f40112c360f9814dfaec3bfcbb"
    );
    // Public artificial identity and write-only sample environment; no key custody.
    std::fs::write(dir.join("store/agents.json"), serde_json::to_vec(&json!({"version":1,"agents":[{
        "id":id, "pubkey":"ab".repeat(32), "relayUrl":"wss://relay.example", "name":"Sample", "systemPrompt":"Original",
        "workspace":dir.to_str().unwrap(), "harness":{"command":"buzz-agent","args":[],"model":"sample","provider":"sample"},
        "environment":{"SAMPLE_TOKEN":"DO_NOT_PROJECT"},"revision":1,"enabled":true,"credentialId":"missing-fixture-key", "authTag":null, "imported":{}
    }]})).unwrap()).unwrap();
    id
}
#[test]
fn real_ipc_snapshot_save_cas_stop_and_launch_gate() {
    let (dir, _host, _app, view) = fixture();
    let id = seed(dir.path());
    let before = invoke(&view, "agent_control_snapshot", json!({})).unwrap();
    assert_eq!(before["runtimeAvailable"], false);
    assert_eq!(before["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(
        before["harnessOptions"],
        json!([{
            "command":"buzz-agent", "label":"Buzz Agent",
            "providers":[{"value":"databricks_v2", "label":"Databricks v2"}]
        }])
    );
    assert_eq!(before["agents"][0]["name"], "Sample");
    assert_eq!(before["agents"][0]["enabled"], true);
    assert_eq!(before["agents"][0]["status"], "stopped");
    assert!(!before.to_string().contains("DO_NOT_PROJECT"));
    for action in ["start", "restart"] {
        let err = invoke(
            &view,
            "agent_control_action",
            json!({"id":id,"action":action}),
        )
        .unwrap_err();
        assert_eq!(err, RUNTIME_GATE);
    }
    let edit = json!({"name":"Edited","systemPrompt":"Saved via IPC","workspace":dir.path().to_str().unwrap(),
        "harness":{"command":"buzz-agent","args":["--literal space"],"model":"chosen","provider":"databricks_v2"},"environment":{}});
    let saved = invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit}),
    )
    .unwrap();
    assert_eq!(saved["harnessOptions"], before["harnessOptions"]);
    assert_eq!(saved["runtimeAvailable"], false);
    assert_eq!(saved["importAvailable"], cfg!(target_os = "macos"));
    assert_eq!(saved["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        saved["agents"][0]["harness"]["args"],
        json!(["--literal space"])
    );
    assert_eq!(saved["agents"][0]["revision"], 2);
    assert_eq!(saved["agents"][0]["systemPrompt"], "Saved via IPC");
    assert!(invoke(
        &view,
        "agent_control_save",
        json!({"id":id,"expectedRevision":1,"edit":edit})
    )
    .is_err());
    let stopped = invoke(
        &view,
        "agent_control_action",
        json!({"id":id,"action":"stop"}),
    )
    .unwrap();
    assert_eq!(stopped["harnessOptions"], before["harnessOptions"]);
    assert_eq!(stopped["agents"][0]["enabled"], false);
    assert_eq!(stopped["agents"][0]["revision"], 2);
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["systemPrompt"], "Saved via IPC");
    assert_eq!(disk["agents"][0]["harness"]["provider"], "databricks_v2");
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap()["agents"][0]["harness"],
        saved["agents"][0]["harness"]
    );
    assert_eq!(disk["agents"][0]["enabled"], false);
    assert_eq!(
        disk["agents"][0]["environment"]["SAMPLE_TOKEN"],
        "DO_NOT_PROJECT"
    );
}
#[test]
fn real_ipc_preview_source_no_import_and_shutdown_fence() {
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(
        source.join("managed-agents.json"),
        serde_json::to_vec(&json!([{
            "pubkey":"79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            "name":"Synthetic", "agent_command":"buzz-agent", "agent_args":[]
        }]))
        .unwrap(),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert!(preview["sourcePath"]
        .as_str()
        .unwrap()
        .ends_with("xyz.block.buzz.app.dev/agents/managed-agents.json"));
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"installed","destination":"wss://chosen.example"})
    )
    .is_err());
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        "Import preview expired; choose the source again"
    );
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://chosen.example"}),
    )
    .unwrap();
    assert_eq!(
        invoke(
            &view,
            "agent_control_import_commit",
            json!({"token":preview["token"],"ids":[preview["candidates"][0]["id"]]})
        )
        .unwrap_err(),
        IMPORT_GATE
    );
    host.shutdown().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Agent host is shutting down"
    );
}
#[test]
fn malformed_store_does_not_prevent_native_host_construction() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("agents.json"), "RAW_SECRET_INVALID").unwrap();
    let host = AgentHost::open(Ok((
        dir.path().into(),
        dir.path().into(),
        dir.path().into(),
    )));
    let error = host.with(|h| h.snapshot()).err().unwrap();
    assert!(!error.contains("RAW_SECRET"));
    assert!(error.contains("malformed"));
    host.shutdown().unwrap();
}

#[test]
fn native_contention_fails_fast_and_quit_preserves_enabled_intent() {
    let (dir, host, _app, view) = fixture();
    seed(dir.path());
    let lock = host.0.lock().unwrap();
    assert_eq!(
        invoke(&view, "agent_control_snapshot", json!({})).unwrap_err(),
        "Another native agent operation is in progress"
    );
    drop(lock);
    assert!(invoke(&view, "agent_control_snapshot", json!({})).is_ok());
    host.shutdown().unwrap();
    let disk: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(disk["agents"][0]["enabled"], true);
    for (command, body) in [
        (
            "agent_control_action",
            json!({"id":"sample","action":"stop"}),
        ),
        (
            "agent_control_import_preview",
            json!({"source":"installed","destination":"wss://chosen.example"}),
        ),
    ] {
        assert_eq!(
            invoke(&view, command, body).unwrap_err(),
            "Agent host is shutting down"
        );
    }
}

#[test]
fn legacy_guard_is_process_path_evidence_not_name_substring_or_coexistence_claim() {
    for listing in [
        " 100 /Applications/Buzz.app/Contents/MacOS/buzz-desktop",
        " 200 /checkout/target/debug/buzz-desktop",
    ] {
        assert!(refuse_legacy_listing(listing).is_err());
    }
    assert!(refuse_legacy_listing(
        "123 /tmp/buzz-agent\n456 /tmp/buzz-foundation\n789 /tmp/buzz-desktop-notes"
    )
    .is_ok());
}

#[tokio::test]
#[ignore = "requires staged immutable runtime resources; run explicitly after build-agent-runtime"]
async fn native_start_restore_disconnect_stop_and_quit_fence_late_credentials() {
    struct Delayed {
        entered: std::sync::mpsc::Sender<()>,
        release: Mutex<std::sync::mpsc::Receiver<()>>,
    }
    impl Credentials for Delayed {
        fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
            panic!("not an import")
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            panic!("not a write")
        }
        fn read(&self, _: &str, _: &str) -> Result<Option<Secret>, String> {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Err("Synthetic credential refusal".into())
        }
    }
    let (dir, host, _app, view) = fixture();
    let id = seed(dir.path());
    // Use the actual resource manifest when staged; no child is spawned and no
    // PlatformCredentials method is ever called by this fixture.
    let tools = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/agent-runtime");
    assert!(
        tools.join("manifest.json").is_file(),
        "Build immutable runtime resources first"
    );
    let (entered, receive) = std::sync::mpsc::channel();
    let receive = Arc::new(Mutex::new(receive));
    let (release, wait) = std::sync::mpsc::channel();
    let credentials: Arc<dyn Credentials> = Arc::new(Delayed {
        entered,
        release: Mutex::new(wait),
    });
    host.with(|h| {
        let replacement = Store::open(dir.path().join("replacement"))?;
        // Reopen the same durable fixture only after replacing/dropping its owner.
        h.controller = Controller::new(
            replacement,
            credentials.clone(),
            Err("placeholder".into()),
            dir.path().join("ownership"),
        );
        h.controller = Controller::new(
            Store::open(dir.path().join("store"))?,
            credentials.clone(),
            RuntimeBundle::new(tools),
            dir.path().join("ownership"),
        );
        h.credentials = credentials;
        h.legacy_check = || Ok(());
        Ok(())
    })
    .unwrap();
    let path = dir.path().join("store/agents.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    saved["agents"][0]["harness"]["provider"] = json!("databricks_v2");
    saved["agents"][0]["harness"]["databricks"] =
        json!({"host":"https://workspace.example", "filter":""});
    std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
    for action in ["disconnect", "stop", "quit"] {
        if action == "quit" {
            let path = dir.path().join("store/agents.json");
            let mut saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            saved["agents"][0]["enabled"] = json!(true);
            std::fs::write(path, serde_json::to_vec(&saved).unwrap()).unwrap();
        }
        let owner = host.clone();
        let agent_id = id.clone();
        let running = tokio::spawn(async move {
            if action == "quit" {
                owner.restore().await;
                Err("restore completed".into())
            } else {
                start(owner, agent_id, Action::Start, false, None).await
            }
        });
        tokio::task::spawn_blocking({
            let receive = receive.clone();
            move || {
                receive
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
            }
        })
        .await
        .unwrap()
        .unwrap();
        if action == "quit" {
            host.shutdown().unwrap();
        } else if action == "disconnect" {
            host.disconnect("https://workspace.example").unwrap();
        } else {
            invoke(
                &view,
                "agent_control_action",
                json!({"id":id,"action":"stop"}),
            )
            .unwrap();
        }
        release.send(()).unwrap();
        assert!(running.await.unwrap().is_err());
        if action == "quit" {
            let mut state = host.0.lock().unwrap();
            let h = state.as_mut().unwrap_or_else(|_| panic!("fixture host"));
            let snapshot = h.controller.snapshot().unwrap();
            assert!(snapshot.agents[0].error.is_none());
            assert!(snapshot.agents[0].enabled);
        }
    }
}

#[test]
fn real_ipc_import_uses_selected_memory_custody_and_stays_disabled() {
    const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
    const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    #[derive(Default)]
    struct Memory(Mutex<BTreeMap<String, String>>, Mutex<Vec<LegacySource>>);
    impl Credentials for Memory {
        fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret, String> {
            assert!(matches!(source, LegacySource::Development));
            self.1.lock().unwrap().push(source);
            Secret::parse(KEY, pubkey)
        }
        fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .map(|v| Secret::parse(v, pubkey))
                .transpose()
        }
        fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
            assert!(self
                .0
                .lock()
                .unwrap()
                .insert(id.into(), key.hex().to_string())
                .is_none());
            Ok(())
        }
    }
    let (dir, host, _app, view) = fixture();
    let source = dir.path().join("legacy/xyz.block.buzz.app.dev/agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([
        {"pubkey":PUB, "auth_tag":"[\"auth\",\"c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5\",\"\",\"6fd97eb61e46846e184a567429e66cbb76e84aa4f70b51cdf41e18b423679952433e952ae1fc344c74c6beaad0055a7a276d512823fcba8c6512407bb1558dce\"]", "relay_url":"", "name":"Selected", "agent_command":"buzz-agent", "agent_args":[], "start_on_app_launch":true},
        {"pubkey":"ab".repeat(32), "relay_url":"wss://stale.example", "name":"Not selected"},
        {"pubkey":"cd".repeat(32), "relay_url":"wss://user:secret@raw.example/path", "name":"Unsupported old pin"}
    ])).unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let memory = Arc::new(Memory::default());
    host.with(|h| {
        h.credentials = memory.clone();
        Ok(())
    })
    .unwrap();
    // Required IPC destination: a missing argument must not use a legacy pin.
    assert!(invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development"})
    )
    .is_err());
    let invalid = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://user:private@raw.example/path"}),
    )
    .unwrap_err();
    assert_eq!(
        invalid,
        "Choose a secure community origin without credentials, path or query"
    );
    let prior = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"wss://prior.example"}),
    )
    .unwrap();
    let preview = invoke(
        &view,
        "agent_control_import_preview",
        json!({"source":"development","destination":"https://CHOSEN.example/"}),
    )
    .unwrap();
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":prior["token"],"ids":[prior["candidates"][0]["id"]]})
    )
    .is_err());
    assert!(memory.1.lock().unwrap().is_empty());
    assert!(memory.0.lock().unwrap().is_empty());
    assert_eq!(preview["candidates"].as_array().unwrap().len(), 3);
    for candidate in preview["candidates"].as_array().unwrap() {
        assert_eq!(candidate["relayUrl"], "wss://chosen.example");
    }
    for hidden in ["raw.example", "stale.example", "user:secret", KEY] {
        assert!(!preview.to_string().contains(hidden));
    }
    let selected = preview["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["pubkey"] == PUB)
        .unwrap();
    let imported = invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]}),
    )
    .unwrap();
    assert_eq!(imported["agents"].as_array().unwrap().len(), 1);
    assert_eq!(imported["agents"][0]["pubkey"], PUB);
    assert_eq!(imported["agents"][0]["relayUrl"], "wss://chosen.example");
    assert_eq!(imported["agents"][0]["id"], selected["id"]);
    assert!(memory
        .0
        .lock()
        .unwrap()
        .contains_key(selected["id"].as_str().unwrap()));
    assert_eq!(imported["agents"][0]["configured"], true);
    let cloned = invoke(
        &view,
        "agent_control_local_clone_settings",
        json!({"id": selected["id"]}),
    )
    .unwrap();
    assert!(cloned.get("systemPrompt").is_some());
    assert_eq!(cloned.as_object().unwrap().len(), 2);
    assert_eq!(imported["agents"][0]["enabled"], false);
    assert_eq!(imported["agents"][0]["status"], "stopped");
    assert!(!imported.to_string().contains(KEY));
    assert_eq!(memory.1.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    assert!(invoke(
        &view,
        "agent_control_import_commit",
        json!({"token":preview["token"],"ids":[selected["id"]]})
    )
    .is_err());
    host.shutdown().unwrap();
}

#[test]
fn startup_parks_metadata_without_credentials_or_runtime_and_reopens_offline() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("store");
    let legacy = dir.path().join("legacy");
    let source = legacy
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    std::fs::create_dir_all(&source).unwrap();
    let bytes = serde_json::to_vec(&json!([{
        "pubkey": "ab".repeat(32), "name": "Parked fixture",
        "start_on_app_launch": true, "auth_tag": "DO_NOT_COPY",
        "env_vars": {"TOKEN": "DO_NOT_COPY"}
    }]))
    .unwrap();
    std::fs::write(source.join("managed-agents.json"), &bytes).unwrap();
    let paths = || Ok((root.clone(), legacy.clone(), dir.path().join("workspace")));
    let host = AgentHost::open(paths());
    let snapshot = host.with(|host| host.snapshot()).unwrap();
    let value = serde_json::to_value(snapshot).unwrap();
    assert_eq!(value["parked"][0]["name"], "Parked fixture");
    assert_eq!(value["agents"], json!([]));
    assert_eq!(value["inventoryWarnings"], json!([]));
    assert!(!value.to_string().contains("DO_NOT_COPY"));
    assert_eq!(
        std::fs::read(source.join("managed-agents.json")).unwrap(),
        bytes
    );
    drop(host);
    std::fs::remove_dir_all(&legacy).unwrap();
    let host = AgentHost::open(paths());
    let reopened = serde_json::to_value(host.with(|host| host.snapshot()).unwrap()).unwrap();
    assert_eq!(reopened["parked"], value["parked"]);
    assert_eq!(reopened["agents"], json!([]));
}
