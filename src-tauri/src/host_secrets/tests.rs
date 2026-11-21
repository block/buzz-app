//! Real registered commands/ACL with temporary native ownership and fake storage only.
use super::*;
use buzzodz_plugins::{Manager, SecretStore};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};
use tauri::test::{mock_builder, MockRuntime, INVOKE_KEY};
const ID: &str = "example.slots";
const LIMIT: Duration = Duration::from_secs(5);
#[derive(Default)]
struct Store {
    items: Mutex<HashMap<String, Vec<u8>>>,
    calls: AtomicUsize,
    adds: AtomicUsize,
    denied: AtomicBool,
    stall: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
}
impl Store {
    fn enter(&self) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some((started, release)) = self.stall.lock().unwrap().take() {
            started.send(()).unwrap();
            release.recv_timeout(LIMIT).unwrap();
        }
    }
}
impl SecretStore for Store {
    fn read(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, buzz_credential_store::Error> {
        self.enter();
        if self.denied.load(Ordering::SeqCst) {
            return Err(buzz_credential_store::Error::Denied);
        }
        self.items
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(buzz_credential_store::Error::Absent)
    }
    fn add(&self, account: &str, value: &[u8]) -> Result<(), buzz_credential_store::Error> {
        self.adds.fetch_add(1, Ordering::SeqCst);
        self.enter();
        if self.denied.load(Ordering::SeqCst) {
            return Err(buzz_credential_store::Error::Denied);
        }
        self.items
            .lock()
            .unwrap()
            .insert(account.into(), value.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), buzz_credential_store::Error> {
        self.enter();
        if self.denied.load(Ordering::SeqCst) {
            return Err(buzz_credential_store::Error::Denied);
        }
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}
struct Fixture {
    root: tempfile::TempDir,
    manager: Manager,
    store: Arc<Store>,
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
    revision: String,
}
impl Fixture {
    fn new(configured: bool, safe: bool, identity: IdentityHost, instance: bool) -> Self {
        Self::at_origin(configured, safe, identity, instance, "https://example.test")
    }
    fn at_origin(
        configured: bool,
        safe: bool,
        identity: IdentityHost,
        instance: bool,
        origin: &str,
    ) -> Self {
        Self::build(configured, safe, identity, instance, origin, false)
    }
    fn build(
        configured: bool,
        safe: bool,
        identity: IdentityHost,
        instance: bool,
        origin: &str,
        custody: bool,
    ) -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::default());
        // Qualify before any enrollment; never override unknown or resolve machine paths.
        let clean = if custody {
            crate::sign_out::fixture_instance_with_custody(
                root.path(),
                &root.path().join("home"),
                store.clone(),
            )
        } else {
            crate::sign_out::fixture_instance(root.path())
        };
        let mut manager = Manager::open(Some(root.path().join("home")), "test", safe).unwrap();
        if custody {
            manager = clean.configure_plugin_secrets(manager, store.clone());
        } else if configured {
            manager = manager.with_secret_storage(root.path().join("inventory"), store.clone());
        }
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&json!({"id":ID,"name":"Slots","apiVersion":1,
            "host":{"networkOrigins":[origin],"secrets":[{"id":"key","label":"Key","origins":[origin],"header":"Authorization","scheme":"Bearer"}]}})).unwrap()).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == ID)
            .unwrap()
            .revision;
        manager.change("enable", ID).unwrap();
        let builder = mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(identity)
            .manage(crate::host_request::HostCalls::default())
            .manage(crate::reviewed_invocation::Invocations::default())
            .invoke_handler(crate::commands());
        let builder = if instance {
            builder.manage(clean)
        } else {
            drop(clean);
            builder
        };
        let app = builder.build(crate::app_context()).unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            root,
            manager,
            store,
            app,
            view,
            revision,
        }
    }
    fn body(&self) -> Value {
        json!({"id":ID,"revision":self.revision,"slot":"key","value":"test-value"})
    }
    fn send(
        &self,
        view: &tauri::WebviewWindow<MockRuntime>,
        origin: &str,
        command: &str,
        body: Value,
    ) -> mpsc::Receiver<Result<Value, String>> {
        let (tx, rx) = mpsc::channel();
        view.as_ref().clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: command.into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: origin.parse().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_, _, response, _, _| {
                let _ = tx.send(match response {
                    tauri::ipc::InvokeResponse::Ok(body) => Ok(body.deserialize().unwrap()),
                    tauri::ipc::InvokeResponse::Err(error) => Err(error.0.to_string()),
                });
            }),
        );
        rx
    }
    fn call(&self, op: &str, body: Value) -> Result<Value, String> {
        self.send(
            &self.view,
            self.view.url().unwrap().as_str(),
            &format!("plugin_host_secret_{op}"),
            body,
        )
        .recv_timeout(LIMIT)
        .unwrap()
    }
    fn ready() -> Self {
        Self::new(true, false, IdentityHost::fixture(), true)
    }
}
#[test]
fn registered_slots_obey_actual_acl_and_return_only_status_or_void() {
    let f = Fixture::ready();
    let guest = tauri::WebviewWindowBuilder::new(&f.app, "browser-content", Default::default())
        .build()
        .unwrap();
    let huddle = tauri::WebviewWindowBuilder::new(&f.app, "huddle", Default::default())
        .build()
        .unwrap();
    let other = tauri::WebviewWindowBuilder::new(&f.app, "unrelated", Default::default())
        .build()
        .unwrap();
    for op in ["status", "set", "clear"] {
        for (view, origin) in [
            (&f.view, "https://remote.example"),
            (&guest, "tauri://localhost"),
            (&huddle, "tauri://localhost"),
            (&other, "tauri://localhost"),
        ] {
            let e = f
                .send(view, origin, &format!("plugin_host_secret_{op}"), f.body())
                .recv_timeout(LIMIT)
                .unwrap()
                .unwrap_err();
            assert!(
                e.contains("not allowed") && !e.contains("Command not found"),
                "{e}"
            );
        }
    }
    assert_eq!(f.store.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.call("status", f.body()).unwrap(), "missing");
    assert_eq!(f.call("set", f.body()).unwrap(), Value::Null);
    assert_eq!(f.call("status", f.body()).unwrap(), "saved");
    f.store.denied.store(true, Ordering::SeqCst);
    assert_eq!(f.call("status", f.body()).unwrap(), "unreadable");
    assert!(f.call("clear", f.body()).is_err());
    assert_eq!(f.call("status", f.body()).unwrap(), "missing");
    f.store.denied.store(false, Ordering::SeqCst);
    assert_eq!(f.call("clear", f.body()).unwrap(), Value::Null);
    assert_eq!(f.call("status", f.body()).unwrap(), "missing");
    assert!(f.store.items.lock().unwrap().is_empty());
}
#[test]
fn slots_refuse_bad_scope_identity_and_unconfigured_state_without_store_work() {
    let f = Fixture::ready();
    for (field, value) in [
        ("id", "../bad"),
        ("id", "channels"),
        ("id", "example.absent"),
        ("revision", "stale"),
        ("revision", &"0".repeat(64)),
        ("slot", "../bad"),
        ("slot", "absent"),
    ] {
        let mut body = f.body();
        body[field] = json!(value);
        for op in ["status", "set", "clear"] {
            assert!(f.call(op, body.clone()).is_err());
        }
    }
    f.manager.change("disable", ID).unwrap();
    for op in ["status", "set", "clear"] {
        assert!(f.call(op, f.body()).is_err());
    }
    assert_eq!(f.store.calls.load(Ordering::SeqCst), 0);
    for f in [
        Fixture::new(false, false, IdentityHost::fixture(), true),
        Fixture::new(true, true, IdentityHost::fixture(), true),
        Fixture::new(true, false, IdentityHost::fixture_without_key(true), true),
        Fixture::new(true, false, IdentityHost::fixture_without_key(false), true),
    ] {
        for op in ["status", "set", "clear"] {
            let e = f.call(op, f.body()).unwrap_err();
            assert!(
                !e.contains("test-value") && !e.contains(f.root.path().to_str().unwrap()),
                "{e}"
            );
        }
        assert_eq!(f.store.calls.load(Ordering::SeqCst), 0);
    }
    let f = Fixture::new(true, false, IdentityHost::fixture(), false);
    assert!(f.call("set", f.body()).is_err());
    let viewer = f
        .app
        .state::<IdentityHost>()
        .current_viewer()
        .unwrap()
        .unwrap();
    f.manager
        .secret_set(ID, &f.revision, "key", &viewer, "fake-existing", &|| true)
        .unwrap();
    assert!(f.call("enroll", f.enrollment()).is_err());
    assert_eq!(f.call("status", f.body()).unwrap(), "saved");
    let f = Fixture::ready();
    crate::identity::tests::while_fixture_busy(f.app.state::<IdentityHost>().inner(), || {
        for op in ["status", "set", "clear"] {
            assert!(f.call(op, f.body()).is_err());
        }
    });
    assert_eq!(f.store.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.call("set", f.body()).unwrap(), Value::Null);
    std::fs::write(f.root.path().join("inventory/state.json"), b"broken").unwrap();
    assert_eq!(f.call("status", f.body()).unwrap(), "unreadable");
}
#[test]
fn slot_set_timeout_and_dropped_waiter_keep_native_ownership_until_completion() {
    for dropped in [false, true] {
        let f = Fixture::ready();
        f.app.manage(Duration::from_millis(100));
        let (started, at_store) = mpsc::channel();
        let (release, released) = mpsc::channel();
        *f.store.stall.lock().unwrap() = Some((started, released));
        let reply = f.send(
            &f.view,
            f.view.url().unwrap().as_str(),
            "plugin_host_secret_set",
            f.body(),
        );
        at_store.recv_timeout(LIMIT).unwrap();
        // Same async executor still handles metadata-only status while add is blocked.
        assert_eq!(f.call("status", f.body()).unwrap(), "missing");
        if dropped {
            drop(reply);
        } else {
            assert!(reply.recv_timeout(LIMIT).unwrap().is_err());
        }
        let key = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(f.root.path().join(".identity.debug.instance.lock"))
            .unwrap();
        assert!(key.try_lock().is_err());
        release.send(()).unwrap();
        let end = std::time::Instant::now() + LIMIT;
        while f.store.items.lock().unwrap().is_empty() {
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
        while f.call("status", f.body()).unwrap() != "saved" {
            assert!(std::time::Instant::now() < end);
            std::thread::yield_now();
        }
        assert_eq!(
            f.store.adds.load(Ordering::SeqCst),
            1,
            "exactly one add; no automatic retry"
        );
    }
}

impl Fixture {
    fn enrollment(&self) -> Value {
        let context = serde_json::to_value(
            crate::host_request::plugin_host_call_context(
                self.view.as_ref().clone(),
                self.app.state(),
            )
            .unwrap(),
        )
        .unwrap();
        json!({"id":ID,"revision":self.revision,"slot":"key", "once":{
            "boot":context["boot"], "page":context["page"],
            "activation":uuid::Uuid::new_v4().to_string(), "callId":uuid::Uuid::new_v4().to_string()
        }})
    }
    fn input(
        &self,
    ) -> (
        mpsc::Receiver<()>,
        tokio::sync::oneshot::Sender<Option<String>>,
    ) {
        let (started, entered) = mpsc::channel();
        let (user, input) = tokio::sync::oneshot::channel();
        if let Some(fixture) = self.app.try_state::<super::private_input::FixtureInput>() {
            *fixture.0.lock().unwrap() = Some((started, input));
        } else {
            self.app
                .manage(super::private_input::FixtureInput(Mutex::new(Some((
                    started, input,
                )))));
        }
        (entered, user)
    }
}

#[cfg(target_os = "macos")]
#[test]
fn slot_only_enrollment_saves_fake_native_input_and_replace_cancel_stays_missing() {
    let f = Fixture::ready();
    for replace in [false, true] {
        let (entered, user) = f.input();
        let body = f.enrollment();
        assert!(body.get("value").is_none());
        let reply = f.send(
            &f.view,
            f.view.url().unwrap().as_str(),
            "plugin_host_secret_enroll",
            body,
        );
        entered.recv_timeout(LIMIT).unwrap();
        // This barrier is the native input boundary, after old retirement/cleanup.
        assert_eq!(f.call("status", f.body()).unwrap(), "missing");
        assert!(f.store.items.lock().unwrap().is_empty());
        user.send((!replace).then(|| "FAKE-NATIVE-CANARY".into()))
            .unwrap();
        let result = reply.recv_timeout(LIMIT).unwrap().unwrap();
        assert_eq!(result, if replace { "missing" } else { "saved" });
        assert!(!result.to_string().contains("CANARY"));
        assert_eq!(
            f.call("status", f.body()).unwrap(),
            if replace { "missing" } else { "saved" }
        );
    }
    assert_eq!(f.store.adds.load(Ordering::SeqCst), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn replace_cleanup_denial_retires_the_old_key_without_showing_input() {
    let f = Fixture::ready();
    f.call("set", f.body()).unwrap();
    let (_entered, _user) = f.input();
    f.store.denied.store(true, Ordering::SeqCst);
    assert!(f.call("enroll", f.enrollment()).is_err());
    assert!(f
        .app
        .state::<super::private_input::FixtureInput>()
        .0
        .lock()
        .unwrap()
        .is_some());
    assert_eq!(f.call("status", f.body()).unwrap(), "missing");
    assert_eq!(
        f.store.items.lock().unwrap().len(),
        1,
        "physical cleanup was denied"
    );
    assert_eq!(f.store.adds.load(Ordering::SeqCst), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn private_enrollment_timeout_retains_native_owner_until_cancelled_add_returns() {
    let f = Fixture::ready();
    f.app.manage(Duration::from_millis(100));
    let (entered, user) = f.input();
    let (started, at_store) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *f.store.stall.lock().unwrap() = Some((started, released));
    let body = f.enrollment();
    let reply = f.send(
        &f.view,
        f.view.url().unwrap().as_str(),
        "plugin_host_secret_enroll",
        body,
    );
    entered.recv_timeout(LIMIT).unwrap();
    user.send(Some("FAKE-HELD-CANARY".into())).unwrap();
    at_store.recv_timeout(LIMIT).unwrap();
    assert!(reply.recv_timeout(LIMIT).unwrap().is_err());
    let state = f.app.state::<crate::reviewed_invocation::Invocations>();
    assert!(state.own("successor", ID).is_err());
    state.retire(ID);
    release.send(()).unwrap();
    tauri::async_runtime::block_on(state.retire_plugin_and_wait(ID)).unwrap();
    assert_eq!(f.call("status", f.body()).unwrap(), "missing");
    assert!(f.store.items.lock().unwrap().is_empty());
    let _successor = state.own("successor", ID).unwrap();
}

#[test]
fn cancelled_or_stale_enrollment_cannot_reach_input_or_clear_an_existing_key() {
    let f = Fixture::ready();
    f.call("set", f.body()).unwrap();
    let (_entered, _user) = f.input();
    let body = f.enrollment();
    f.app
        .state::<crate::reviewed_invocation::Invocations>()
        .cancel(body["once"]["callId"].as_str().unwrap());
    assert!(f.call("enroll", body).is_err());
    let stale = f.enrollment();
    f.app.state::<crate::host_request::HostCalls>().page_load();
    assert!(f.call("enroll", stale).is_err());
    assert!(f
        .app
        .state::<super::private_input::FixtureInput>()
        .0
        .lock()
        .unwrap()
        .is_some());
    assert_eq!(f.call("status", f.body()).unwrap(), "saved");
    assert_eq!(f.store.adds.load(Ordering::SeqCst), 1);
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn private_enrollment_is_unavailable_without_touching_saved_credentials_or_input() {
    let f = Fixture::ready();
    f.call("set", f.body()).unwrap();
    let (_entered, _user) = f.input();
    let calls = f.store.calls.load(Ordering::SeqCst);
    assert_eq!(
        f.call("enroll", f.enrollment()).unwrap_err(),
        json!(UNAVAILABLE).to_string()
    );
    assert_eq!(f.store.calls.load(Ordering::SeqCst), calls);
    assert!(f
        .app
        .state::<super::private_input::FixtureInput>()
        .0
        .lock()
        .unwrap()
        .is_some());
    assert_eq!(f.call("status", f.body()).unwrap(), "saved");
}

#[cfg(not(unix))]
#[test]
fn non_unix_private_enrollment_refuses_without_store_or_input_work() {
    let f = Fixture::ready();
    let (_entered, _user) = f.input();
    assert_eq!(
        f.call("enroll", f.enrollment()).unwrap_err(),
        json!(UNAVAILABLE).to_string()
    );
    assert!(f.call("set", f.body()).is_err());
    assert_eq!(f.store.calls.load(Ordering::SeqCst), 0);
    assert!(f.store.items.lock().unwrap().is_empty());
    assert!(f
        .app
        .state::<super::private_input::FixtureInput>()
        .0
        .lock()
        .unwrap()
        .is_some());
}

#[cfg(target_os = "macos")]
#[test]
fn registered_private_enrollment_uses_qualified_production_caller_construction() {
    let f = Fixture::build(
        true,
        false,
        IdentityHost::fixture(),
        true,
        "https://example.test",
        true,
    );
    let instance = f.app.state::<crate::sign_out::Instance>();
    let root = instance.plugin_inventory().unwrap();
    let state: Value =
        serde_json::from_slice(&std::fs::read(root.join("state.json")).unwrap()).unwrap();
    assert_eq!(state["installation"]["committed"], true);
    assert_eq!(state["signedOutSeen"], 0);
    let witness = f.store.items.lock().unwrap().clone();
    assert_eq!(witness.len(), 1);
    let (entered, user) = f.input();
    let reply = f.send(
        &f.view,
        f.view.url().unwrap().as_str(),
        "plugin_host_secret_enroll",
        f.enrollment(),
    );
    entered.recv_timeout(LIMIT).unwrap();
    assert_eq!(*f.store.items.lock().unwrap(), witness);
    user.send(Some("FAKE-QUALIFIED-INPUT".into())).unwrap();
    assert_eq!(reply.recv_timeout(LIMIT).unwrap().unwrap(), "saved");
    assert_eq!(f.call("status", f.body()).unwrap(), "saved");
    assert_eq!(
        f.store.adds.load(Ordering::SeqCst),
        2,
        "one installation witness, one credential"
    );
    assert_eq!(f.call("clear", f.body()).unwrap(), Value::Null);
    assert_eq!(*f.store.items.lock().unwrap(), witness);

    let (_entered, _user) = f.input();
    let late = f.root.path().join("home/profiles/late");
    std::fs::create_dir_all(&late).unwrap();
    std::fs::write(late.join("registry.json"), b"foreign evidence").unwrap();
    let calls = f.store.calls.load(Ordering::SeqCst);
    assert!(f.call("enroll", f.enrollment()).is_err());
    assert_eq!(f.store.calls.load(Ordering::SeqCst), calls);
    assert!(f
        .app
        .state::<super::private_input::FixtureInput>()
        .0
        .lock()
        .unwrap()
        .is_some());
    assert_eq!(*f.store.items.lock().unwrap(), witness);
}
