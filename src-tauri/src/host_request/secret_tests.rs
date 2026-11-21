//! Fake-only private preparation and real selector-off IPC; no dispatch permit.
use super::*;
use crate::identity::IdentityHost;
use buzzodz_plugins::{Manager, SecretStore};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use tauri::{
    test::{mock_builder, MockRuntime, INVOKE_KEY},
    Manager as _,
};
use zeroize::Zeroizing;

fn watches() -> &'static Mutex<BTreeMap<String, Arc<AtomicUsize>>> {
    static WATCHES: OnceLock<Mutex<BTreeMap<String, Arc<AtomicUsize>>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}
pub(super) fn observe(url: &reqwest::Url) {
    if let Some(counter) = watches().lock().unwrap().get(url.as_str()) {
        counter.fetch_add(1, Ordering::SeqCst);
    }
}
pub(super) struct Watch {
    key: String,
    count: Arc<AtomicUsize>,
}
impl Watch {
    pub(super) fn new(url: &reqwest::Url) -> Result<Arc<Self>, &'static str> {
        let mut registry = watches().lock().unwrap();
        if registry.contains_key(url.as_str()) {
            return Err("Duplicate send watch");
        }
        let count = Arc::new(AtomicUsize::new(0));
        registry.insert(url.as_str().into(), count.clone());
        Ok(Arc::new(Self {
            key: url.as_str().into(),
            count,
        }))
    }
    pub(super) fn count(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }
}
impl Drop for Watch {
    fn drop(&mut self) {
        let mut registry = watches().lock().unwrap();
        assert!(Arc::ptr_eq(registry.get(&self.key).unwrap(), &self.count));
        registry.remove(&self.key);
    }
}
#[derive(Default)]
struct Fake {
    items: Mutex<BTreeMap<String, Vec<u8>>>,
    enrolled: Mutex<Option<String>>,
    reads: Mutex<Vec<String>>,
    denied: AtomicBool,
}
impl SecretStore for Fake {
    fn read(&self, account: &str) -> Result<Zeroizing<Vec<u8>>, buzz_credential_store::Error> {
        self.reads.lock().unwrap().push(account.into());
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
        *self.enrolled.lock().unwrap() = Some(account.into());
        self.items
            .lock()
            .unwrap()
            .insert(account.into(), value.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), buzz_credential_store::Error> {
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}
struct Fixture {
    _root: tempfile::TempDir,
    manager: Manager,
    identity: IdentityHost,
    store: Arc<Fake>,
    revision: String,
    app: tauri::App<MockRuntime>,
    view: tauri::WebviewWindow<MockRuntime>,
    listener: std::net::TcpListener,
    url: reqwest::Url,
    watch: Arc<Watch>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let identity = IdentityHost::fixture();
        let store = Arc::new(Fake::default());
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = reqwest::Url::parse(&format!(
            "https://{}/{}",
            listener.local_addr().unwrap(),
            uuid::Uuid::new_v4()
        ))
        .unwrap();
        let watch = Watch::new(&url).unwrap();
        let manager = Manager::open(Some(root.path().join("home")), "test", false)
            .unwrap()
            .with_secret_storage(root.path().join("inventory"), store.clone());
        let source = root.path().join("source");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        let origin = url.origin().ascii_serialization();
        std::fs::write(source.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "id":"example.slots","name":"Slots","apiVersion":1,
            "host":{"networkOrigins":[origin],"secrets":[{"id":"key","label":"Key","origins":[origin],"header":"Authorization","scheme":"Bearer"}]}
        })).unwrap()).unwrap();
        let revision = manager
            .install(&source)
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == "example.slots")
            .unwrap()
            .revision;
        manager.change("enable", "example.slots").unwrap();
        manager
            .secret_set(
                "example.slots",
                &revision,
                "key",
                &identity.current_viewer().unwrap().unwrap(),
                "fixture-value",
                &|| true,
            )
            .unwrap();
        store.reads.lock().unwrap().clear();
        let app = mock_builder()
            .manage(PluginManager(Ok(manager.clone())))
            .manage(HostCalls::default())
            .invoke_handler(crate::commands())
            .build(crate::app_context())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        Self {
            _root: root,
            manager,
            identity,
            store,
            revision,
            app,
            view,
            listener,
            url,
            watch,
        }
    }
    fn request(&self) -> HostRequest {
        serde_json::from_value(serde_json::json!({"url":self.url,"secret":"key","timeoutMs":100}))
            .unwrap()
    }
    fn prepare(
        &self,
        request: &HostRequest,
    ) -> Result<(buzzodz_plugins::secrets::PreparedSecret, HeaderMap), String> {
        request.prepare_secret(
            &self.manager,
            "example.slots",
            &self.revision,
            &self.identity,
            std::time::Instant::now() + Duration::from_secs(5),
        )
    }
    fn ipc(&self, protected: bool) -> Result<(), String> {
        let calls = self.app.state::<HostCalls>();
        let context = calls.context("main").unwrap();
        let mut body = serde_json::json!({"id":"example.slots","revision":self.revision,"request":{"url":self.url,"method":"POST","secret":"key","timeoutMs":100}});
        if protected {
            body["once"] = serde_json::json!({"boot":context.boot,"page":context.page,"activation":uuid::Uuid::new_v4(),"callId":uuid::Uuid::new_v4()});
        }
        let (tx, rx) = mpsc::channel();
        // Callback owns app/watch through completion, including a failed outer wait.
        let lifetime = (self.app.handle().clone(), self.watch.clone());
        self.view.as_ref().clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: "plugin_host_request".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: self.view.url().unwrap(),
                body: tauri::ipc::InvokeBody::Json(body),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.into(),
            },
            Box::new(move |_, _, response, _, _| {
                let _lifetime = lifetime;
                let _ = tx.send(match response {
                    tauri::ipc::InvokeResponse::Ok(_) => Ok(()),
                    tauri::ipc::InvokeResponse::Err(error) => Err(error.0.to_string()),
                });
            }),
        );
        rx.recv_timeout(Duration::from_secs(5))
            .expect("IPC completion deadline, not cancellation")
    }
    fn refused(&self, protected: bool) {
        let sends = self.watch.count();
        let reads = self.store.reads.lock().unwrap().len();
        let result = self.ipc(protected);
        assert!(result
            .unwrap_err()
            .contains("Saved credential requests are unavailable"));
        assert_eq!(self.watch.count(), sends);
        assert_eq!(self.store.reads.lock().unwrap().len(), reads);
        assert!(self
            .app
            .state::<HostCalls>()
            .claims
            .lock()
            .unwrap()
            .consumed
            .is_empty());
    }
}
#[test]
fn configured_ipc_zeros_and_private_preparation_share_connected_observers() {
    let f = Fixture::new();
    f.refused(false);
    f.refused(true);
    let positive = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(2), async {
            tokio::join!(
                send_request(
                    f.url.clone(),
                    reqwest::Method::GET,
                    HeaderMap::new(),
                    None,
                    Duration::from_millis(200)
                ),
                async {
                    loop {
                        match f.listener.accept() {
                            Ok((socket, _)) => {
                                drop(socket);
                                break;
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                                tokio::time::sleep(Duration::from_millis(5)).await
                            }
                            Err(e) => panic!("Local accept failed: {e}"),
                        }
                    }
                }
            )
        })
        .await
    });
    // Both owned futures have completed or been dropped; no spawned server to strand.
    assert!(positive.unwrap().0.is_err());
    assert_eq!(f.watch.count(), 1);
    f.refused(false);
    f.refused(true);
    let (prepared, headers) = f.prepare(&f.request()).unwrap();
    assert!(headers["authorization"].is_sensitive());
    prepared.with_header(|name, value| assert!(headers[name].as_bytes() == value.as_bytes()));
    let account = f.store.enrolled.lock().unwrap().clone().unwrap();
    assert!(*f.store.reads.lock().unwrap() == vec![account.clone()]);
    f.store.denied.store(true, Ordering::SeqCst);
    assert!(f.prepare(&f.request()).is_err());
    assert!(*f.store.reads.lock().unwrap() == vec![account.clone(), account]);
    assert_eq!(f.watch.count(), 1);
}
#[test]
fn watch_registration_is_unique_isolated_and_owned_until_last_drop() {
    let f = Fixture::new();
    assert!(Watch::new(&f.url).is_err());
    let other = f.url.join("independent").unwrap();
    let watch = Watch::new(&other).unwrap();
    let lease = watch.clone();
    drop(watch);
    observe(&other);
    assert_eq!(lease.count(), 1);
    assert_eq!(f.watch.count(), 0);
    drop(lease);
    assert!(!watches().lock().unwrap().contains_key(other.as_str()));
    assert!(watches().lock().unwrap().contains_key(f.url.as_str()));
}
#[test]
fn native_prevalidation_refuses_without_reading_and_header_failures_do_not_send() {
    let f = Fixture::new();
    for damage in [
        "url", "method", "body", "slot", "missing", "header", "syntax", "count", "bytes",
    ] {
        let mut request = f.request();
        match damage {
            "url" => request.url = "http://example.test".into(),
            "method" => request.method = "CONNECT".into(),
            "body" => request.body = Some("x".repeat(MAX_REQUEST_BYTES + 1)),
            "slot" => request.secret = Some("../bad".into()),
            "missing" => request.secret = None,
            "header" => {
                request.headers.insert("cookie".into(), "x".into());
            }
            "syntax" => {
                request.headers.insert("x-bad".into(), "bad\nvalue".into());
            }
            "count" => request.headers = (0..33).map(|n| (format!("x-{n}"), "v".into())).collect(),
            _ => {
                request
                    .headers
                    .insert("x".into(), "v".repeat(MAX_HEADER_BYTES));
            }
        }
        assert!(f.prepare(&request).is_err(), "{damage}");
        assert!(f.store.reads.lock().unwrap().is_empty());
    }
    for identity in [
        IdentityHost::fixture_without_key(true),
        IdentityHost::fixture_without_key(false),
    ] {
        assert!(f
            .request()
            .prepare_secret(
                &f.manager,
                "example.slots",
                &f.revision,
                &identity,
                std::time::Instant::now() + Duration::from_secs(5)
            )
            .is_err());
    }
    assert!(f
        .request()
        .prepare_secret(
            &f.manager,
            "example.slots",
            &f.revision,
            &f.identity,
            std::time::Instant::now()
        )
        .is_err());
    assert!(f.store.reads.lock().unwrap().is_empty());
    for header in ["authorization", "Authorization", "AUTHORIZATION"] {
        let mut request = f.request();
        request.headers.insert(header.into(), "caller".into());
        request
            .headers
            .insert("aUtHoRiZaTiOn".into(), "other".into());
        assert!(f.prepare(&request).is_err());
    }
    for count in [31, 32] {
        let mut request = f.request();
        request.headers = (0..count).map(|n| (format!("x-{n}"), "v".into())).collect();
        if count == 32 {
            request.headers.remove("x-31");
            request.headers.insert("X-0".into(), "v".into());
        }
        assert_eq!(f.prepare(&request).is_ok(), count == 31);
    }
    let injected = "authorization".len() + "Bearer fixture-value".len();
    for extra in [0, 1] {
        let mut request = f.request();
        request.headers.insert(
            "xx".into(),
            "v".repeat(MAX_HEADER_BYTES - injected - 2 + extra),
        );
        assert_eq!(f.prepare(&request).is_ok(), extra == 0);
    }
    assert_eq!(f.watch.count(), 0);
    assert!(f
        .app
        .state::<HostCalls>()
        .claims
        .lock()
        .unwrap()
        .consumed
        .is_empty());
}
