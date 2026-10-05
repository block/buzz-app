//! Operation-gated CLI store: exercise real file layout without Keychain access.
use super::*;

#[derive(Clone, Copy, PartialEq)]
enum Call {
    Get,
    Set,
    Delete,
}
struct StorageGate {
    call: Call,
    started: oneshot::Sender<()>,
    release: std::sync::mpsc::Receiver<()>,
}
struct TestStore {
    path: PathBuf,
    gate: Mutex<Option<StorageGate>>,
    failure: Mutex<Option<(Call, &'static str)>>,
}
impl TestStore {
    fn hold(&self, call: Call) -> (oneshot::Receiver<()>, std::sync::mpsc::Sender<()>) {
        let (started, arrived) = oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        *self.gate.lock().unwrap() = Some(StorageGate {
            call,
            started,
            release: released,
        });
        (arrived, release)
    }
    fn checkpoint(&self, call: Call) -> anyhow::Result<()> {
        let mut gate = self.gate.lock().unwrap();
        let held = if gate.as_ref().is_some_and(|g| g.call == call) {
            gate.take()
        } else {
            None
        };
        drop(gate);
        if let Some(gate) = held {
            let _ = gate.started.send(());
            // Dropping release during an assertion failure also unblocks the worker.
            let _ = gate.release.recv();
        }
        let mut failure = self.failure.lock().unwrap();
        if failure.as_ref().is_some_and(|(c, _)| *c == call) {
            anyhow::bail!(failure.take().unwrap().1);
        }
        Ok(())
    }
}
struct Handle(Arc<TestStore>);
impl StoreFactory for Handle {
    fn open(&self, _: &Config, _: Op) -> Result<Box<dyn SessionCredentialStorage>, String> {
        Ok(Box::new(Handle(self.0.clone())))
    }
}
impl SessionCredentialStorage for Handle {
    fn kind(&self) -> &'static str {
        "fixture"
    }
    fn get(&self, key: &SessionStorageKey) -> anyhow::Result<Option<StoredSessionCredential>> {
        let result = FileSessionCredentialStorage::new(self.0.path.clone()).get(key)?;
        self.0.checkpoint(Call::Get)?;
        Ok(result)
    }
    fn set(
        &self,
        key: &SessionStorageKey,
        credential: &StoredSessionCredential,
    ) -> anyhow::Result<()> {
        // Pause inside the write, after persistence and before the host's fence.
        FileSessionCredentialStorage::new(self.0.path.clone()).set(key, credential)?;
        self.0.checkpoint(Call::Set)
    }
    fn delete(&self, key: &SessionStorageKey) -> anyhow::Result<bool> {
        self.0.checkpoint(Call::Delete)?;
        FileSessionCredentialStorage::new(self.0.path.clone()).delete(key)
    }
}
async fn gated_fixture() -> (Fixture, Arc<TestStore>) {
    let mut f = fixture().await;
    let store = Arc::new(TestStore {
        path: f.dir.path().join("auth-sessions.json"),
        gate: Mutex::new(None),
        failure: Mutex::new(None),
    });
    let mut config = test_config(&f.config.service_url, f.dir.path());
    config.factory = Arc::new(Handle(store.clone()));
    f.host = BuilderlabHost::new(Ok(config));
    f.config = f.host.config().unwrap();
    (f, store)
}

#[tokio::test]
async fn cancel_during_write_deletes_minted_and_revokes_displaced_session() {
    let (f, store) = gated_fixture().await;
    let (_browser, callback, login) = f.login(Mode::Silent);
    let url = callback.await.unwrap();
    // bl rotates while the browser is open.
    f.seed("displaced");
    let (written, release) = store.hold(Call::Set);
    raw(url.port().unwrap(), &format!("{}?code=c", url.path())).await;
    written.await.unwrap();
    f.host.cancel().unwrap();
    assert_eq!(login.await.unwrap().unwrap_err(), CANCELED);
    release.send(()).unwrap();
    eventually(|| ready(f.kgoose.credentials(LOGOUT).len() == 2)).await;
    assert_eq!(f.kgoose.credentials(LOGOUT), ["displaced", "minted-1"]);
    assert!(f.stored().is_none());
}

#[tokio::test]
async fn superseding_login_during_write_leaves_only_the_new_session() {
    let (f, store) = gated_fixture().await;
    let (written, release) = store.hold(Call::Set);
    let (_, _, old) = f.login(Mode::Code("old"));
    written.await.unwrap();
    let (_, _, new) = f.login(Mode::Code("new"));
    assert_eq!(old.await.unwrap().unwrap_err(), CANCELED);
    release.send(()).unwrap();
    new.await.unwrap().unwrap();
    assert_eq!(f.stored_credential().as_deref(), Some("minted-2"));
    eventually(|| ready(f.kgoose.credentials(LOGOUT).contains(&"minted-1".into()))).await;
    assert!(!f.kgoose.credentials(LOGOUT).contains(&"minted-2".into()));
}

#[tokio::test]
async fn rejected_auth_cannot_delete_a_concurrent_login_write() {
    let (f, store) = gated_fixture().await;
    f.seed("old");
    f.kgoose.script(ME, 401, "");
    let (checked, response) = f.kgoose.hold(ME);
    let host = f.host.clone();
    let auth = tokio::spawn(async move { host.auth().await });
    checked.await.unwrap();
    let (compared, release) = store.hold(Call::Get);
    response.send(()).unwrap();
    compared.await.unwrap();
    // The stale delete owns the storage transaction even across this pause.
    assert!(f.config.storage_lock.try_lock().is_err());
    let (_, _, login) = f.login(Mode::Code("new"));
    release.send(()).unwrap();
    assert!(auth.await.unwrap().unwrap().is_none());
    login.await.unwrap().unwrap();
    assert_eq!(f.stored_credential().as_deref(), Some("minted-1"));
    assert!(f.kgoose.credentials(LOGOUT).is_empty());
}

#[tokio::test]
async fn sign_out_preserves_a_bl_rotation_and_blank_cleanup_does_too() {
    let (f, store) = gated_fixture().await;
    f.seed("old");
    let (revoking, release) = f.kgoose.hold(LOGOUT);
    let host = f.host.clone();
    let logout = tokio::spawn(async move { host.sign_out().await });
    revoking.await.unwrap();
    f.seed("rotated");
    release.send(()).unwrap();
    logout.await.unwrap().unwrap();
    assert_eq!(f.stored_credential().as_deref(), Some("rotated"));
    assert_eq!(f.kgoose.credentials(LOGOUT), ["old"]);

    f.seed(" ");
    let (read, release) = store.hold(Call::Get);
    let host = f.host.clone();
    let auth = tokio::spawn(async move { host.auth().await });
    read.await.unwrap();
    f.seed("rotated-again");
    release.send(()).unwrap();
    assert!(auth.await.unwrap().unwrap().is_none());
    assert_eq!(f.stored_credential().as_deref(), Some("rotated-again"));
}

#[tokio::test]
async fn keychain_errors_at_each_operation_stay_fixed_and_minted_sessions_are_revoked() {
    let (f, store) = gated_fixture().await;
    *store.failure.lock().unwrap() = Some((Call::Get, "secret path: OSStatus -128"));
    assert_eq!(f.host.auth().await.unwrap_err(), KEYCHAIN_DENIED);
    *store.failure.lock().unwrap() = Some((Call::Set, "secret credential: OSStatus -25293"));
    let (browser, _) = Browser::new(Mode::Code("c"));
    assert_eq!(
        f.host.login(browser.as_ref()).await.unwrap_err(),
        KEYCHAIN_DENIED
    );
    assert_eq!(f.kgoose.credentials(LOGOUT), ["minted-1"]);
    f.seed("saved");
    *store.failure.lock().unwrap() = Some((Call::Delete, "secret path: OSStatus -99999"));
    assert_eq!(f.host.sign_out().await.unwrap_err(), KEYCHAIN_FAILED);
    assert_eq!(f.stored_credential().as_deref(), Some("saved"));
    f.host.sign_out().await.unwrap();
    assert!(f.stored().is_none());
}
