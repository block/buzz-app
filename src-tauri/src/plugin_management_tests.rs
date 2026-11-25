//! Actual command handlers and generated ACL with an injected store; never OS credentials.
use super::*;
use buzzodz_plugins::{secrets::SecretStore, Manager};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY};

const PLUGIN: &str = "example.management";
const LIMIT: Duration = Duration::from_secs(5);
#[derive(Default)]
struct Store {
    items: Mutex<HashMap<String, Vec<u8>>>,
    deleted: Mutex<Vec<String>>,
    calls: AtomicUsize,
    allowed: AtomicUsize,
    completed: AtomicUsize,
    stall: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}
impl SecretStore for Store {
    fn read(
        &self,
        account: &str,
    ) -> Result<zeroize::Zeroizing<Vec<u8>>, buzz_credential_store::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.items
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(zeroize::Zeroizing::new)
            .ok_or(buzz_credential_store::Error::Absent)
    }
    fn add(&self, account: &str, value: &[u8]) -> Result<(), buzz_credential_store::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.items
            .lock()
            .unwrap()
            .insert(account.into(), value.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), buzz_credential_store::Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.deleted.lock().unwrap().push(account.into());
        if let Some((started, release)) = self.stall.lock().unwrap().take() {
            started.send(()).unwrap();
            release.recv_timeout(LIMIT).unwrap();
        }
        if self
            .allowed
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_err()
        {
            self.completed.fetch_add(1, Ordering::SeqCst);
            return Err(buzz_credential_store::Error::Denied);
        }
        self.items.lock().unwrap().remove(account);
        self.completed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct Fixture {
    root: tempfile::TempDir,
    manager: Manager,
    store: Arc<Store>,
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::default());
        let manager = Manager::open(Some(root.path().join("home")), "test", false)
            .unwrap()
            .with_secret_storage(root.path().join("inventory"), store.clone());
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":PLUGIN,"name":"Management fixture","apiVersion":1,
            "host":{"networkOrigins":["https://example.test"],"secrets":[{
                "id":"key","label":"Key","origins":["https://example.test"],"header":"Authorization","scheme":"Bearer"
            }]}
        })).unwrap()).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == PLUGIN)
            .unwrap()
            .revision;
        manager.change("enable", PLUGIN).unwrap();
        for identity in ["1".repeat(64), "2".repeat(64)] {
            manager
                .secret_set(PLUGIN, &revision, "key", &identity, "test-value", &|| true)
                .unwrap();
        }
        let app = mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(federated_identity::access::Registrations::default())
            .invoke_handler(commands())
            .build(app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            root,
            manager,
            store,
            app,
            view,
        }
    }
    fn invoke(
        &self,
        view: &tauri::WebviewWindow<MockRuntime>,
        origin: &str,
        command: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        get_ipc_response(
            view,
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
        )
        .map_err(|e| e.to_string())
        .map(|r| r.deserialize().unwrap())
    }
    fn call(&self, command: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        self.invoke(&self.view, self.view.url().unwrap().as_str(), command, body)
    }
    fn remove(&self) -> serde_json::Value {
        self.call(
            "plugin_change",
            serde_json::json!({"action":"remove","id":PLUGIN}),
        )
        .unwrap()
    }
    fn retired(&self) {
        // Set up retained debt through the shared manager, not a production-store switch.
        self.manager.change("remove", PLUGIN).unwrap();
    }
    fn settled(&self, pending: usize) {
        let deadline = Instant::now() + LIMIT;
        loop {
            let status = self.manager.credential_cleanup_status().unwrap();
            if status.running == 0 && status.pending == pending {
                break;
            }
            assert!(Instant::now() < deadline, "worker did not complete");
            std::thread::yield_now();
        }
    }
}
#[test]
fn registered_retry_obeys_real_acl_before_any_store_work() {
    let f = Fixture::new();
    f.retired();
    let guest = tauri::WebviewWindowBuilder::new(&f.app, "browser-content", Default::default())
        .build()
        .unwrap();
    let huddle = tauri::WebviewWindowBuilder::new(&f.app, "huddle", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&f.app, "unrelated", Default::default())
        .build()
        .unwrap();
    let before = f.store.calls.load(Ordering::SeqCst);
    for (view, origin) in [
        (&f.view, "https://remote.example"),
        (&guest, "tauri://localhost"),
        (&huddle, "tauri://localhost"),
        (&other, "tauri://localhost"),
    ] {
        let denial = f
            .invoke(
                view,
                origin,
                "plugin_credential_cleanup_retry",
                serde_json::json!({}),
            )
            .unwrap_err();
        assert!(
            denial.contains("not allowed") && !denial.contains("Command not found"),
            "{denial}"
        );
    }
    assert_eq!(f.store.calls.load(Ordering::SeqCst), before);
    let status = f.manager.credential_cleanup_status().unwrap();
    assert_eq!((status.pending, status.running), (2, 0));
    assert!(
        f.store.deleted.lock().unwrap().is_empty(),
        "denial must precede handler work"
    );
    f.store.allowed.store(2, Ordering::SeqCst);
    let result = f.call("plugin_credential_cleanup_retry", serde_json::json!({}));
    assert!(
        result.is_ok(),
        "registered local-main retry must be reachable: {result:?}"
    );
    f.settled(0);
    assert_eq!(f.manager.credential_cleanup_status().unwrap().pending, 0);
}
#[test]
fn committed_remove_returns_before_stalled_cleanup_and_retry_cannot_duplicate_it() {
    let f = Fixture::new();
    let (started, at_delete) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *f.store.stall.lock().unwrap() = Some((started, released));
    f.store.allowed.store(2, Ordering::SeqCst);
    let reply = f.remove();
    assert_eq!(
        reply["committed"], true,
        "management result must distinguish commit from cleanup"
    );
    assert!(!reply["catalog"]["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["manifest"]["id"] == PLUGIN));
    at_delete
        .recv_timeout(LIMIT)
        .expect("one deliberate initial batch starts after commit");
    assert_eq!(f.manager.credential_cleanup_status().unwrap().running, 1);
    assert!(f
        .call("plugin_credential_cleanup_retry", serde_json::json!({}))
        .unwrap_err()
        .contains("already running"));
    assert_eq!(
        f.store.deleted.lock().unwrap().len(),
        1,
        "stalled worker owns its completion"
    );
    let catalog = f.call("plugin_catalog", serde_json::json!({})).unwrap();
    assert!(!catalog["catalog"]["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["manifest"]["id"] == PLUGIN));
    release.send(()).unwrap();
    f.settled(0);
    assert_eq!(f.manager.credential_cleanup_status().unwrap().pending, 0);
}
#[test]
fn catalog_restart_and_partial_retry_keep_only_remaining_debt_without_prompts() {
    let f = Fixture::new();
    f.retired();
    let before = f.store.calls.load(Ordering::SeqCst);
    f.call("plugin_catalog", serde_json::json!({})).unwrap();
    let reopened = Manager::open(Some(f.root.path().join("home")), "test", false)
        .unwrap()
        .with_secret_storage(f.root.path().join("inventory"), f.store.clone());
    assert_eq!(reopened.credential_cleanup_status().unwrap().pending, 2);
    assert_eq!(
        f.store.calls.load(Ordering::SeqCst),
        before,
        "startup/status must not touch secure storage"
    );
    f.store.allowed.store(1, Ordering::SeqCst);
    f.call("plugin_credential_cleanup_retry", serde_json::json!({}))
        .unwrap();
    let deadline = Instant::now() + LIMIT;
    while f.store.completed.load(Ordering::SeqCst) != 2 {
        assert!(
            Instant::now() < deadline,
            "partial batch did not finish its attempts"
        );
        std::thread::yield_now();
    }
    f.settled(1);
    assert_eq!(reopened.credential_cleanup_status().unwrap().pending, 1);
    let deleted = f.store.deleted.lock().unwrap().clone();
    let remaining = f.store.items.lock().unwrap().keys().next().unwrap().clone();
    f.store.allowed.store(1, Ordering::SeqCst);
    loop {
        match f.call("plugin_credential_cleanup_retry", serde_json::json!({})) {
            Ok(_) => break,
            Err(error) => {
                assert!(error.contains("already running"), "{error}");
                assert!(Instant::now() < deadline, "batch did not release ownership");
                std::thread::yield_now();
            }
        }
    }
    f.settled(0);
    assert_eq!(reopened.credential_cleanup_status().unwrap().pending, 0);
    assert_eq!(
        &f.store.deleted.lock().unwrap()[deleted.len()..],
        &[remaining]
    );
}
#[test]
fn artifact_problem_is_post_commit_and_safe_not_a_removal_error() {
    let f = Fixture::new();
    f.store.allowed.store(2, Ordering::SeqCst);
    let location = f.manager.catalog().unwrap().location;
    let artifacts = f.manager.storage_root().join("artifacts").join(PLUGIN);
    std::fs::remove_dir_all(&artifacts).unwrap();
    std::fs::write(&artifacts, b"not a directory").unwrap();
    let result = f.call(
        "plugin_change",
        serde_json::json!({"action":"remove","id":PLUGIN}),
    );
    assert!(
        result.is_ok(),
        "post-commit file problem must not masquerade as uncommitted removal: {result:?}"
    );
    let reply = result.unwrap();
    assert_eq!(reply["committed"], true);
    assert_eq!(
        reply["problem"],
        "Plugin removed, but its files could not be deleted"
    );
    assert!(!reply["problem"]
        .as_str()
        .unwrap()
        .contains(f.root.path().to_str().unwrap()));
    assert_eq!(reply["catalog"]["location"], location);
    f.settled(0);
    assert!(!f
        .manager
        .catalog()
        .unwrap()
        .plugins
        .iter()
        .any(|p| p.manifest.id == PLUGIN));
}

#[test]
fn interim_reply_exposes_uncertainty_and_never_offers_reset_after_commit() {
    let f = Fixture::new();
    let mut outcome = f.manager.change_managed("disable", PLUGIN).unwrap();
    outcome.committed = false;
    outcome.problem = Some("Plugin change outcome is unknown; refresh before trying again");
    assert!(management_reply(&f.manager, outcome)
        .err()
        .unwrap()
        .contains("unknown"));
    let mut outcome = f.manager.change_managed("disable", PLUGIN).unwrap();
    outcome.catalog = None;
    let reply = serde_json::to_value(management_reply(&f.manager, outcome).unwrap()).unwrap();
    assert_eq!(reply["committed"], true);
    assert_eq!(reply["status"], "recovery");
    assert_eq!(reply["canReset"], false);
    assert!(reply["reason"].as_str().unwrap().contains("saved"));
}

fn retry_with_held_namespace_owner(synchronous: bool) {
    let f = Fixture::new();
    f.retired();
    let independent = Manager::open(Some(f.root.path().join("home")), "test", false)
        .unwrap()
        .with_secret_storage(f.root.path().join("inventory"), f.store.clone());
    let (started, at_delete) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *f.store.stall.lock().unwrap() = Some((started, released));
    f.store.allowed.store(2, Ordering::SeqCst);
    let owner = if synchronous {
        let manager = f.manager.clone();
        Some(std::thread::spawn(move || {
            manager.credential_cleanup(LIMIT)
        }))
    } else {
        independent.start_credential_cleanup().unwrap();
        None
    };
    at_delete
        .recv_timeout(LIMIT)
        .expect("owner reached fake delete");
    let status = f.manager.credential_cleanup_status().unwrap();
    assert_eq!((status.pending, status.running), (2, 1));
    // Actual registered command uses a different clone family in the first
    // schedule, and the synchronous owner's clone family in the second.
    let reply = f.call("plugin_credential_cleanup_retry", serde_json::json!({}));
    assert_eq!(f.store.deleted.lock().unwrap().len(), 1);
    release.send(()).unwrap();
    if let Some(owner) = owner {
        owner.join().unwrap().unwrap();
    }
    f.settled(0);
    assert_eq!(
        f.store.deleted.lock().unwrap().len(),
        2,
        "one delete per account, no duplicate attempt"
    );
    assert!(
        reply
            .as_ref()
            .is_err_and(|error| error.contains("already running")),
        "active namespace owner must refuse retry, never false Ok: {reply:?}"
    );
}

#[test]
fn retry_refuses_independently_opened_manager_owning_namespace() {
    retry_with_held_namespace_owner(false);
}

#[test]
fn retry_refuses_same_manager_synchronous_cleanup_owning_namespace() {
    retry_with_held_namespace_owner(true);
}
