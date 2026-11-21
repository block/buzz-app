//! Lifecycle proof with a fake secure store and real temporary metadata files.
//! Never touches the OS credential store.
use super::*;
use crate::Manager;
use buzz_credential_store::Error;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier, Mutex};

const ALICE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const BOB: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const SENTINEL: &str = "sk-sentinel-value-0001";
const PLUGIN: &str = "example.slots";

#[cfg(unix)]
mod continuity;
mod management;
pub(crate) mod native_creators;
mod transport;
mod validators;

type Hook = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Default)]
pub(crate) struct Fake {
    items: Mutex<HashMap<String, Vec<u8>>>,
    adds: AtomicUsize,
    reads: AtomicUsize,
    deletes: AtomicUsize,
    fail_add: Mutex<Option<Error>>,
    fail_delete: Mutex<Option<Error>>,
    fail_read: Mutex<Option<Error>>,
    on_add: Mutex<Option<Hook>>,
    /// Runs after a read captured its bytes, before they are returned.
    on_read: Mutex<Option<Hook>>,
}

type DirSync = Box<dyn Fn(&Path) -> std::io::Result<()>>;
thread_local! {
    static DIR_SYNC: std::cell::RefCell<Option<DirSync>> = const { std::cell::RefCell::new(None) };
}
/// Failure seam for directory-link durability; observes the calling thread only.
pub(super) fn dir_synced(path: &Path) -> std::io::Result<()> {
    DIR_SYNC.with(|hook| hook.borrow().as_ref().map_or(Ok(()), |hook| hook(path)))
}
fn on_dir_sync(hook: impl Fn(&Path) -> std::io::Result<()> + 'static) {
    DIR_SYNC.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}
impl Fake {
    fn count(&self) -> usize {
        self.items.lock().unwrap().len()
    }
    fn deny_delete(&self, error: Option<Error>) {
        *self.fail_delete.lock().unwrap() = error;
    }
}
impl SecretStore for Fake {
    fn read(&self, account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.fail_read.lock().unwrap() {
            return Err(error);
        }
        let value = self
            .items
            .lock()
            .unwrap()
            .get(account)
            .map(|value| Zeroizing::new(value.clone()))
            .ok_or(Error::Absent);
        let hook = self.on_read.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(account);
        }
        value
    }
    fn add(&self, account: &str, value: &[u8]) -> std::result::Result<(), Error> {
        self.adds.fetch_add(1, Ordering::SeqCst);
        let hook = self.on_add.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(account);
        }
        if let Some(error) = *self.fail_add.lock().unwrap() {
            return Err(error);
        }
        let mut items = self.items.lock().unwrap();
        if items.contains_key(account) {
            return Err(Error::Occupied);
        }
        items.insert(account.into(), value.to_vec());
        Ok(())
    }
    fn delete(&self, account: &str) -> std::result::Result<(), Error> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        if let Some(error) = *self.fail_delete.lock().unwrap() {
            return Err(error);
        }
        self.items.lock().unwrap().remove(account);
        Ok(())
    }
}

struct Env {
    temp: tempfile::TempDir,
    store: Arc<Fake>,
    manager: Manager,
}
const SLOT: &str = r#"{"id":"api-key","label":"API key","origins":["https://api.example.test"],"header":"Authorization","scheme":"Bearer"}"#;
fn manifest(slots: &str) -> String {
    format!(
        r#"{{"id":"{PLUGIN}","name":"Slots","apiVersion":1,"host":{{"networkOrigins":["https://api.example.test","https://other.example.test"],"secrets":[{slots}]}}}}"#
    )
}
impl Env {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let store = Arc::new(Fake::default());
        let manager = Self::open(&temp, "test", store.clone());
        fs::create_dir(temp.path().join("build")).unwrap();
        fs::write(
            temp.path().join("build/plugin.js"),
            "export function apply() {}",
        )
        .unwrap();
        Self {
            temp,
            store,
            manager,
        }
    }
    fn open(temp: &tempfile::TempDir, profile: &str, store: Arc<Fake>) -> Manager {
        Manager::open(Some(temp.path().join("home")), profile, false)
            .unwrap()
            .with_secret_storage(temp.path().join("secrets"), store)
    }
    fn root(&self) -> PathBuf {
        self.temp.path().join("secrets")
    }
    fn install(&self, slots: &str) -> String {
        fs::write(
            self.temp.path().join("build/manifest.json"),
            manifest(slots),
        )
        .unwrap();
        self.revision(
            &self
                .manager
                .install(&self.temp.path().join("build"))
                .unwrap(),
        )
    }
    fn revision(&self, catalog: &crate::Catalog) -> String {
        catalog
            .plugins
            .iter()
            .find(|plugin| plugin.manifest.id == PLUGIN)
            .unwrap()
            .revision
            .clone()
    }
    fn current(&self) -> String {
        self.revision(&self.manager.catalog().unwrap())
    }
    fn ready(&self, slots: &str) -> String {
        let revision = self.install(slots);
        self.manager.change("enable", PLUGIN).unwrap();
        revision
    }
    fn set(&self, identity: &str, value: &str) -> Result<()> {
        self.manager
            .secret_set(PLUGIN, &self.current(), "api-key", identity, value, &|| {
                true
            })
    }
    fn status(&self, identity: &str) -> SecretStatus {
        self.manager
            .secret_status(PLUGIN, &self.current(), "api-key", identity)
            .unwrap()
    }
    fn pending(&self) -> usize {
        self.manager.credential_cleanup_status().unwrap().pending
    }
    fn retry(&self) -> CleanupStatus {
        self.manager
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
    }
    fn registry(&self) -> serde_json::Value {
        serde_json::from_slice(
            &fs::read(self.temp.path().join("home/profiles/test/registry.json")).unwrap(),
        )
        .unwrap()
    }
    fn write_registry(&self, value: &serde_json::Value) {
        fs::write(
            self.temp.path().join("home/profiles/test/registry.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    fn ns_path(&self) -> PathBuf {
        fs::read_dir(self.root())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                let name = path.file_name().unwrap().to_string_lossy();
                name.starts_with("ns-") && name.ends_with(".json")
            })
            .unwrap()
    }
    fn seed_retired(&self, count: usize) {
        let path = self.ns_path();
        let mut namespace: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let template = namespace["entries"][0].clone();
        let entries = namespace["entries"].as_array_mut().unwrap();
        for index in 0..count {
            let mut entry = template.clone();
            entry["account"] = format!("v1.seed{index:027}").into();
            entry["phase"] = "retired".into();
            entry["cause"] = "failed".into();
            entries.push(entry);
        }
        fs::write(&path, serde_json::to_vec(&namespace).unwrap()).unwrap();
    }
    fn write_state(&self, state: serde_json::Value) {
        fs::create_dir_all(self.root()).unwrap();
        fs::write(self.root().join(STATE), serde_json::to_vec(&state).unwrap()).unwrap();
    }
    #[cfg(unix)]
    fn locks(&self) -> Vec<(String, u64)> {
        use std::os::unix::fs::MetadataExt;
        let mut locks: Vec<_> = fs::read_dir(self.root())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("w-")
            })
            .map(|path| {
                let inode = fs::metadata(&path).unwrap().ino();
                (
                    path.file_name().unwrap().to_string_lossy().into_owned(),
                    inode,
                )
            })
            .collect();
        locks.sort();
        locks
    }
    fn metadata_text(&self) -> String {
        let mut text = String::new();
        for entry in fs::read_dir(self.root()).unwrap() {
            let path = entry.unwrap().path();
            if path.extension() == Some("json".as_ref()) {
                text.push_str(&fs::read_to_string(path).unwrap());
            }
        }
        text
    }
}

/// The top-level strictness of the registry reader on main before this change.
/// Its nested `Installed`/`HostGrants` strictness is not reproduced: an old
/// host already rejects any manifest declaring `host.secrets`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(dead_code)]
struct OldRegistry {
    version: u32,
    bundled_enabled: bool,
    #[serde(default)]
    bundled_overrides: std::collections::BTreeMap<String, bool>,
    installed: std::collections::BTreeMap<String, serde_json::Value>,
}
fn old_reader_accepts(text: &[u8]) -> bool {
    serde_json::from_slice::<OldRegistry>(text).is_ok_and(|r| r.version == 1 || r.version == 2)
}

#[test]
fn first_enrollment_makes_the_registry_v3_which_old_readers_reject() {
    let env = Env::new();
    env.ready(SLOT);
    let before = fs::read(env.temp.path().join("home/profiles/test/registry.json")).unwrap();
    assert_eq!(
        env.registry()["version"],
        2,
        "no H1 state before enrollment"
    );
    assert!(String::from_utf8_lossy(&before).contains("\"secrets\""));
    env.set(ALICE, SENTINEL).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    let saved = fs::read(env.temp.path().join("home/profiles/test/registry.json")).unwrap();
    assert_eq!(env.registry()["version"], 3);
    assert!(
        !old_reader_accepts(&saved),
        "old strict readers must reject v3"
    );
    // Plain v1/v2 profiles that never used slots remain readable by old readers.
    let plain = Env::new();
    fs::write(
        plain.temp.path().join("build/manifest.json"),
        format!(r#"{{"id":"{PLUGIN}","name":"Plain","apiVersion":1}}"#),
    )
    .unwrap();
    plain
        .manager
        .install(&plain.temp.path().join("build"))
        .unwrap();
    let text = fs::read(plain.temp.path().join("home/profiles/test/registry.json")).unwrap();
    assert!(old_reader_accepts(&text));
}

#[test]
fn old_recover_overwrite_and_same_policy_reinstall_never_reactivate() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let v3 = env.registry();
    // An older executable's `recover` writes defaults without reading the registry.
    env.write_registry(&serde_json::json!({"version":2,"bundledEnabled":true,"installed":{}}));
    assert_eq!(
        env.manager
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .pending,
        1
    );
    // ... then the same plugin, revision and policy are written back without
    // H1 fields: an adversarial stand-in, since an old host rejects the manifest.
    let mut old = v3.clone();
    old["version"] = 2.into();
    old.as_object_mut().unwrap().remove("secrets");
    old["installed"][PLUGIN]
        .as_object_mut()
        .unwrap()
        .remove("generation");
    env.write_registry(&old);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(
        env.store.count(),
        0,
        "the old enrollment is physically deleted"
    );
    // Re-entry creates a fresh lineage, generation and account.
    env.set(ALICE, "sk-second").unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    assert_eq!(env.registry()["version"], 3);
    assert_ne!(
        env.registry()["secrets"]["lineage"],
        v3["secrets"]["lineage"]
    );
}

#[test]
fn wrong_variant_missing_or_corrupt_metadata_fail_closed() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let mut registry = env.registry();
    let saved = registry.clone();
    registry["secrets"]["variant"] = if cfg!(debug_assertions) {
        "release"
    } else {
        "debug"
    }
    .into();
    env.write_registry(&registry);
    assert!(
        env.manager.catalog().is_err(),
        "another build's lineage is refused"
    );
    env.write_registry(&saved);
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    // Corrupt inventory is unreadable, never absence, and permits no OS write.
    for entry in fs::read_dir(env.root()).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if name.starts_with("ns-") && name.ends_with(".json") {
            fs::write(&path, b"{not json").unwrap();
        }
    }
    let adds = env.store.adds.load(Ordering::SeqCst);
    assert_eq!(env.status(ALICE), SecretStatus::Unreadable);
    assert!(env.set(ALICE, "sk-other").is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
    // A v3 registry whose lineage the inventory cannot vouch for is not continuity.
    let lost = Env::new();
    lost.ready(SLOT);
    lost.set(ALICE, SENTINEL).unwrap();
    fs::remove_dir_all(lost.root()).unwrap();
    assert_eq!(lost.status(ALICE), SecretStatus::Unreadable);
}

#[test]
fn inventory_outside_app_data_survives_a_home_wipe() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    // Erase/old wipe removes the plugin home, not the external inventory root.
    fs::remove_dir_all(env.temp.path().join("home")).unwrap();
    assert!(env.root().exists());
    let fresh = Env::open(&env.temp, "test", env.store.clone());
    assert_eq!(
        fresh.catalog().unwrap().credential_cleanup.unwrap().pending,
        1
    );
    assert_eq!(
        fresh
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
            .pending,
        0
    );
    assert_eq!(env.store.count(), 0);
}

#[test]
fn write_ahead_failure_makes_zero_os_writes() {
    let env = Env::new();
    env.ready(SLOT);
    // The inventory root cannot be created: durability fails before any OS add.
    fs::write(env.root(), b"not a directory").unwrap();
    assert!(env.set(ALICE, SENTINEL).is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    assert_eq!(env.status(ALICE), SecretStatus::Unreadable);
}

#[test]
fn intent_is_durable_before_add_and_interrupted_writes_are_never_promoted() {
    let env = Env::new();
    env.ready(SLOT);
    let root = env.root();
    let seen = Arc::new(Mutex::new(None));
    let observed = seen.clone();
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |account| {
        // Durable, enumerable intent exists before the OS write starts.
        let text = read_dir_json(&root);
        *observed.lock().unwrap() = Some(text.contains(account) && text.contains("writing"));
    }));
    env.set(ALICE, SENTINEL).unwrap();
    assert_eq!(*seen.lock().unwrap(), Some(true));
    assert!(!env.metadata_text().contains(SENTINEL));

    // Crash after the OS add but before the eligibility commit: simulate the
    // process dying inside add after the item exists.
    let crashed = Env::new();
    crashed.ready(SLOT);
    let store = crashed.store.clone();
    *crashed.store.on_add.lock().unwrap() = Some(Arc::new(move |account| {
        store
            .items
            .lock()
            .unwrap()
            .insert(account.into(), b"sk-crash".to_vec());
        panic!("simulated crash after add");
    }));
    let manager = crashed.manager.clone();
    let revision = crashed.current();
    let result = std::thread::spawn(move || {
        manager.secret_set(PLUGIN, &revision, "api-key", ALICE, "sk-crash", &|| true)
    })
    .join();
    assert!(result.is_err());
    *crashed.store.on_add.lock().unwrap() = None;
    let restarted = Env::open(&crashed.temp, "test", crashed.store.clone());
    let revision = crashed.current();
    assert_eq!(
        restarted
            .secret_status(PLUGIN, &revision, "api-key", ALICE)
            .unwrap(),
        SecretStatus::Missing,
        "an OS item without a committed enrollment is never promoted"
    );
    assert_eq!(restarted.credential_cleanup_status().unwrap().pending, 1);
    assert_eq!(
        restarted
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
            .pending,
        0
    );
    assert_eq!(crashed.store.count(), 0);

    // A failed add stays indexed until deletion confirms absence.
    let failed = Env::new();
    failed.ready(SLOT);
    *failed.store.fail_add.lock().unwrap() = Some(Error::Denied);
    assert!(failed.set(ALICE, SENTINEL).is_err());
    assert_eq!(failed.status(ALICE), SecretStatus::Missing);
}

fn read_dir_json(root: &Path) -> String {
    fs::read_dir(root)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.path().extension() == Some("json".as_ref()))
                .map(|entry| fs::read_to_string(entry.path()).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn a_slow_add_holds_completion_ownership_so_cleanup_cannot_orphan_it() {
    let env = Env::new();
    env.ready(SLOT);
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (hook_started, hook_release) = (started.clone(), release.clone());
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
        hook_started.wait();
        hook_release.wait();
    }));
    let manager = env.manager.clone();
    let revision = env.current();
    let writer = std::thread::spawn(move || {
        manager.secret_set(PLUGIN, &revision, "api-key", ALICE, SENTINEL, &|| true)
    });
    started.wait();
    // Removal commits while the writer is inside the OS add.
    env.manager.change("remove", PLUGIN).unwrap();
    let status = env.retry();
    assert_eq!((status.pending, status.running), (1, 1));
    assert_eq!(
        env.store.deletes.load(Ordering::SeqCst),
        0,
        "W held: no delete"
    );
    release.wait();
    assert!(
        writer.join().unwrap().is_err(),
        "ineligible after revalidation"
    );
    *env.store.on_add.lock().unwrap() = None;
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0);
}

#[test]
fn authority_changes_permanently_retire_and_equivalence_retains() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    // Label, origin order and header case are equivalent authority.
    let equivalent = r#"{"id":"api-key","label":"Renamed key","origins":["https://api.example.test"],"header":"authorization","scheme":"Bearer"}"#;
    env.install(equivalent);
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    env.manager.change("disable", PLUGIN).unwrap();
    env.manager.change("enable", PLUGIN).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    // A -> B -> A: changing the origin retires the enrollment forever.
    let widened = r#"{"id":"api-key","label":"API key","origins":["https://api.example.test","https://other.example.test"],"header":"Authorization","scheme":"Bearer"}"#;
    env.install(widened);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    env.install(SLOT);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    // Rollback without an intervening set stays retired.
    env.set(ALICE, "sk-two").unwrap();
    env.install(r#"{"id":"api-key","label":"API key","origins":["https://api.example.test"],"header":"Authorization","scheme":"Token"}"#);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    env.manager.change("rollback", PLUGIN).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    // Slot removal then re-adding stays retired.
    env.set(ALICE, "sk-three").unwrap();
    env.install(r#"{"id":"other","label":"Other","origins":["https://api.example.test"],"header":"x-api-key","scheme":""}"#);
    env.install(SLOT);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    // Remove -> re-add is a fresh installation.
    env.set(ALICE, "sk-four").unwrap();
    env.manager.change("remove", PLUGIN).unwrap();
    env.ready(SLOT);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0, "every retired account was deleted");
}

#[test]
fn replacement_retires_the_prior_account_and_clear_is_idempotent() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.set(ALICE, "sk-replacement").unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    assert_eq!(env.store.count(), 1, "the superseded account is deleted");
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 2);
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.store.count(), 0);
    // A failed deletion is pending, never absence, and never reusable.
    env.set(ALICE, SENTINEL).unwrap();
    env.store.deny_delete(Some(Error::Denied));
    assert!(env
        .manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .is_err());
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.pending(), 1);
    env.store.deny_delete(None);
    assert_eq!(env.retry().pending, 0);
    // A read failure is unreadable and clear does not run on it.
    env.set(ALICE, SENTINEL).unwrap();
    *env.store.fail_read.lock().unwrap() = Some(Error::Denied);
    assert_eq!(env.status(ALICE), SecretStatus::Unreadable);
}

#[test]
fn removal_commits_before_cleanup_and_reports_pending_until_retry() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.set(BOB, "sk-bob").unwrap();
    // Dropped historical slot accounts are still tracked after an update.
    env.install(r#"{"id":"other","label":"Other","origins":["https://api.example.test"],"header":"x-api-key","scheme":""}"#);
    env.store.deny_delete(Some(Error::Busy));
    let catalog = env.manager.change("remove", PLUGIN).unwrap();
    assert!(catalog.plugins.iter().all(|p| p.manifest.id != PLUGIN));
    assert_eq!(catalog.credential_cleanup.as_ref().unwrap().pending, 2);
    // Restart: pending is rebuilt from inventory without any OS call.
    let deletes = env.store.deletes.load(Ordering::SeqCst);
    let restarted = Env::open(&env.temp, "test", env.store.clone());
    assert_eq!(restarted.credential_cleanup_status().unwrap().pending, 2);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), deletes);
    assert_eq!(env.retry().pending, 2);
    env.store.deny_delete(None);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0);
    assert!(env.manager.catalog().unwrap().credential_cleanup.is_none());
}

#[test]
fn identity_profile_and_home_scopes_are_isolated() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    assert_eq!(env.status(BOB), SecretStatus::Missing);
    let other = Env::open(&env.temp, "other", env.store.clone());
    assert!(other
        .secret_set(PLUGIN, &env.current(), "api-key", ALICE, SENTINEL, &|| true)
        .is_err());
    // An identity that changed during the OS write is never promoted.
    assert!(env
        .manager
        .secret_set(PLUGIN, &env.current(), "api-key", BOB, "sk-bob", &|| false)
        .is_err());
    assert_eq!(env.status(BOB), SecretStatus::Missing);
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
}

#[test]
fn capacity_is_enforced_before_any_os_write() {
    let env = Env::new();
    env.ready(SLOT);
    env.store.deny_delete(Some(Error::Denied));
    env.set(ALICE, SENTINEL).unwrap();
    // Seed retired records directly: 255 entries, one below the cap.
    env.seed_retired(MAX_ENTRIES - 2);
    env.set(ALICE, "sk-at-cap").unwrap();
    let adds = env.store.adds.load(Ordering::SeqCst);
    assert!(env.set(ALICE, "sk-overflow").is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
    assert_eq!(
        env.pending(),
        MAX_ENTRIES - 1,
        "failed cleanup is never evicted"
    );
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
}

#[test]
fn sign_out_journal_scopes_identity_and_erase_and_retains_on_failure() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.set(BOB, "sk-bob").unwrap();
    let (_elsewhere, other_home, revision) = second_home(&env);
    other_home
        .secret_set(PLUGIN, &revision, "api-key", BOB, "sk-elsewhere", &|| true)
        .unwrap();

    // Normal sign-out of ALICE: only ALICE's enrollments, in every namespace.
    begin_sign_out(&env.root(), Some(ALICE), None).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.status(BOB), SecretStatus::Saved);
    assert!(
        env.set(ALICE, "sk-again").is_err(),
        "journal fences new writes"
    );
    env.store.deny_delete(Some(Error::Denied));
    assert!(finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).is_err());
    assert!(env.root().join(STATE).exists());
    assert!(read_dir_json(&env.root()).contains("journal"));
    env.store.deny_delete(None);
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
    assert!(!read_dir_json(&env.root()).contains("\"journal\":{"));
    assert_eq!(env.store.count(), 2);

    // Erase of this home: every identity there, not the other home.
    let home = env.temp.path().join("home");
    begin_sign_out(&env.root(), None, Some(&home)).unwrap();
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
    assert_eq!(env.status(BOB), SecretStatus::Missing);
    assert_eq!(
        other_home
            .secret_status(PLUGIN, &revision, "api-key", BOB)
            .unwrap(),
        SecretStatus::Saved
    );
    assert_eq!(env.store.count(), 1);
    // Finishing with no journal is idempotent success.
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
}

#[test]
fn an_observed_old_sign_out_conservatively_retires() {
    let env = Env::new();
    env.ready(SLOT);
    observe_sign_outs(&env.root(), 4).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    observe_sign_outs(&env.root(), 4).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    observe_sign_outs(&env.root(), 5).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.pending(), 1);
}

#[test]
fn metadata_and_errors_never_contain_the_value() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    *env.store.fail_add.lock().unwrap() = Some(Error::Denied);
    let error = env.set(ALICE, "sk-sentinel-value-0002").unwrap_err();
    assert!(!error.contains("sk-sentinel"));
    assert!(!env.metadata_text().contains("sk-sentinel"));
    let registry = serde_json::to_string(&env.registry()).unwrap();
    assert!(!registry.contains("sk-sentinel"));
}

#[test]
fn values_and_authority_are_validated_before_mutation() {
    let env = Env::new();
    let revision = env.install(SLOT);
    // Disabled: no plugin-facing operation, and status is not "missing".
    assert!(env.set(ALICE, SENTINEL).is_err());
    assert!(env
        .manager
        .secret_status(PLUGIN, &revision, "api-key", ALICE)
        .is_err());
    env.manager.change("enable", PLUGIN).unwrap();
    for bad in ["", "   ", "has space", "line\nbreak", "tab\tvalue", "é"] {
        assert!(env.set(ALICE, bad).is_err(), "{bad:?}");
    }
    assert!(env.set(ALICE, &"x".repeat(513)).is_err());
    env.set(ALICE, &format!("  {}  ", "x".repeat(512))).unwrap();
    assert!(env
        .manager
        .secret_set(PLUGIN, &revision, "undeclared", ALICE, SENTINEL, &|| true)
        .is_err());
    assert!(env
        .manager
        .secret_status(PLUGIN, &revision, "undeclared", ALICE)
        .is_err());
    let paused = Manager::open(Some(env.temp.path().join("home")), "test", true)
        .unwrap()
        .with_secret_storage(env.root(), env.store.clone());
    assert!(paused
        .secret_status(PLUGIN, &revision, "api-key", ALICE)
        .is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
}

// ------------------------------------------------ first-slice audit (red first)

fn manifest_value(secrets: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "id": PLUGIN, "name": "Slots", "apiVersion": 1,
        "host": {
            "networkOrigins": ["https://api.example.test", "https://other.example.test"],
            "secrets": secrets
        }
    })
}
fn validates(manifest: serde_json::Value) -> bool {
    serde_json::from_value::<Manifest>(manifest).is_ok_and(|m| m.validate().is_ok())
}

#[test]
fn manifest_declarations_are_validated() {
    let slot: serde_json::Value = serde_json::from_str(SLOT).unwrap();
    assert!(validates(manifest_value(serde_json::json!([slot]))));
    assert!(validates(manifest_value(serde_json::json!([]))));
    let raw = serde_json::json!({"id":"raw","label":"Raw key","origins":["https://other.example.test","https://api.example.test"],"header":"X-API-Key","scheme":""});
    assert!(validates(manifest_value(serde_json::json!([raw]))));
    let with = |field: &str, value: serde_json::Value| {
        let mut slot = slot.clone();
        slot[field] = value;
        manifest_value(serde_json::json!([slot]))
    };
    let invalid = [
        with("value", "sk-inline".into()),
        with("id", "Bad".into()),
        with("label", "".into()),
        with("label", " API key".into()),
        with("label", "x".repeat(81).into()),
        with("label", "API\u{7}key".into()),
        with("origins", serde_json::json!([])),
        with(
            "origins",
            serde_json::json!(["https://undeclared.example.test"]),
        ),
        with("origins", serde_json::json!(["https://api.example.test/"])),
        with(
            "origins",
            serde_json::json!(["https://api.example.test", "https://api.example.test"]),
        ),
        with("header", "cookie".into()),
        with("header", "authorization ".into()),
        with("scheme", "Bear er".into()),
        with("scheme", "Bearer\n".into()),
        with("scheme", "x".repeat(33).into()),
        manifest_value(serde_json::json!([slot, slot])),
        manifest_value(serde_json::Value::Array(
            (0..17)
                .map(|index| {
                    let mut slot = slot.clone();
                    slot["id"] = format!("slot-{index}").into();
                    slot
                })
                .collect(),
        )),
    ];
    for manifest in invalid {
        assert!(!validates(manifest.clone()), "{manifest}");
    }
    // Round trip is stable, and no bundled plugin declares a slot.
    let parsed: Manifest =
        serde_json::from_value(manifest_value(serde_json::json!([slot]))).unwrap();
    let again: Manifest = serde_json::from_value(serde_json::to_value(&parsed).unwrap()).unwrap();
    assert_eq!(parsed.host, again.host);
    assert!(crate::bundled_manifests()
        .iter()
        .all(|m| m.host.as_ref().is_none_or(|host| host.secrets.is_empty())));
}

#[test]
fn registry_versions_and_lineage_are_read_strictly() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let v3 = env.registry();
    let broken = |change: &dyn Fn(&mut serde_json::Value)| {
        let mut registry = v3.clone();
        change(&mut registry);
        env.write_registry(&registry);
        let refused = env.manager.catalog().is_err();
        env.write_registry(&v3);
        refused
    };
    assert!(broken(&|r| r["version"] = 2.into()), "v2 with lineage");
    assert!(
        broken(&|r| {
            r.as_object_mut().unwrap().remove("secrets");
        }),
        "v3 without lineage"
    );
    assert!(broken(&|r| r["secrets"]["lineage"] = "not-a-uuid".into()));
    assert!(broken(
        &|r| r["installed"][PLUGIN]["generation"] = "nope".into()
    ));
    assert!(
        broken(&|r| {
            r["version"] = 2.into();
            r.as_object_mut().unwrap().remove("secrets");
        }),
        "a generation outside v3"
    );
    assert!(broken(&|r| r["version"] = 4.into()));
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
}

#[test]
fn every_manifest_transition_retires_changed_authority() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    // Live reload from the folder with changed authority retires, and back again stays retired.
    let widened = r#"{"id":"api-key","label":"API key","origins":["https://api.example.test","https://other.example.test"],"header":"Authorization","scheme":"Bearer"}"#;
    fs::write(
        env.temp.path().join("build/manifest.json"),
        manifest(widened),
    )
    .unwrap();
    env.manager.reload_live(PLUGIN).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    fs::write(env.temp.path().join("build/manifest.json"), manifest(SLOT)).unwrap();
    env.manager.reload_live(PLUGIN).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    // Reviewed reload of an unchanged declaration keeps authority across disable/enable.
    env.set(ALICE, "sk-two").unwrap();
    fs::write(
        env.temp.path().join("build/plugin.js"),
        "export function apply() { return 2; }",
    )
    .unwrap();
    env.manager.change("disable", PLUGIN).unwrap();
    env.manager.reload(PLUGIN).unwrap();
    env.manager.change("enable", PLUGIN).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    // Recover in new code retires everything; same-id, same-policy reinstall is fresh.
    env.manager.recover().unwrap();
    env.ready(SLOT);
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0);
}

#[cfg(unix)]
#[test]
fn stable_completion_locks_are_never_unlinked() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.set(ALICE, "sk-replacement").unwrap();
    let before = env.locks();
    assert!(!before.is_empty());
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    env.manager.change("remove", PLUGIN).unwrap();
    env.retry();
    let after = env.locks();
    for lock in &before {
        assert!(after.contains(lock), "{} was unlinked or replaced", lock.0);
    }
}

#[test]
fn corrupt_or_missing_inventory_never_resets_or_abandons_cleanup() {
    // Recover never moves a corrupt record aside: its accounts stay owed.
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let path = env.ns_path();
    fs::write(&path, b"{not json").unwrap();
    env.manager.recover().unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"{not json");
    env.ready(SLOT);
    let adds = env.store.adds.load(Ordering::SeqCst);
    assert!(env.set(ALICE, "sk-new").is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
    assert_eq!(env.status(ALICE), SecretStatus::Unreadable);
    assert!(
        env.manager
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .unreadable
    );

    // A record the inventory lists but cannot find is lost, not a fresh start.
    let missing = Env::new();
    missing.ready(SLOT);
    missing.set(ALICE, SENTINEL).unwrap();
    fs::remove_file(missing.ns_path()).unwrap();
    assert_eq!(missing.status(ALICE), SecretStatus::Unreadable);
    assert!(missing.set(ALICE, "sk-new").is_err());
    assert_eq!(missing.store.adds.load(Ordering::SeqCst), 1);

    // Unreadable global state is unreadable, never absence.
    let state = Env::new();
    state.ready(SLOT);
    state.set(ALICE, SENTINEL).unwrap();
    fs::write(state.root().join(STATE), b"[").unwrap();
    assert_eq!(state.status(ALICE), SecretStatus::Unreadable);
    assert!(state.set(ALICE, "sk-new").is_err());
    assert_eq!(state.store.adds.load(Ordering::SeqCst), 1);

    // A v3 lineage without any inventory reports unknown cleanup, not clean.
    let lost = Env::new();
    lost.ready(SLOT);
    lost.set(ALICE, SENTINEL).unwrap();
    fs::remove_dir_all(lost.root()).unwrap();
    assert!(
        lost.manager
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .unreadable
    );
}

#[test]
fn namespace_and_scan_bounds_are_exact() {
    let fake = |index: usize| format!("{index:064x}");
    let below = Env::new();
    below.ready(SLOT);
    below.write_state(serde_json::json!({"version":1,"namespaces":(0..MAX_NAMESPACES - 1).map(fake).collect::<Vec<_>>()}));
    below.set(ALICE, SENTINEL).unwrap();

    let full = Env::new();
    full.ready(SLOT);
    full.write_state(serde_json::json!({"version":1,"namespaces":(0..MAX_NAMESPACES).map(fake).collect::<Vec<_>>()}));
    assert!(full.set(ALICE, SENTINEL).is_err());
    assert_eq!(full.store.adds.load(Ordering::SeqCst), 0);
    // An oversized scan list is unreadable rather than walked.
    full.write_state(serde_json::json!({"version":1,"namespaces":(0..=MAX_NAMESPACES).map(fake).collect::<Vec<_>>()}));
    assert_eq!(full.status(ALICE), SecretStatus::Unreadable);
    assert!(finish_sign_out(&full.root(), full.store.as_ref(), Duration::from_secs(1)).is_err());

    // Unlisted records a sign-out must visit are bounded like the list, and a
    // record name that is not a namespace id is unknown, never skipped.
    let unlisted = Env::new();
    unlisted.write_state(serde_json::json!({"version":1,"namespaces":[]}));
    let record = |name: &str| {
        let record = serde_json::json!({"version":1,"home":fake(0),"profile":"test","lineage":null,"entries":[]});
        let path = unlisted.root().join(format!("ns-{name}.json"));
        fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
    };
    let finish = || {
        finish_sign_out(
            &unlisted.root(),
            unlisted.store.as_ref(),
            Duration::from_secs(1),
        )
    };
    (0..MAX_NAMESPACES).for_each(|index| record(&fake(index)));
    begin_sign_out(&unlisted.root(), Some(ALICE), None).unwrap();
    finish().unwrap();
    record(&fake(MAX_NAMESPACES));
    assert!(begin_sign_out(&unlisted.root(), Some(ALICE), None).is_err());
    assert_eq!(finish(), Err(SIGN_OUT_UNREADABLE.into()));
    fs::remove_file(
        unlisted
            .root()
            .join(format!("ns-{}.json", fake(MAX_NAMESPACES))),
    )
    .unwrap();
    finish().unwrap();
    record("unknown");
    assert!(begin_sign_out(&unlisted.root(), Some(ALICE), None).is_err());
    assert_eq!(finish(), Err(SIGN_OUT_UNREADABLE.into()));
}

// C1: listed records and those a crash left unlisted share one namespace bound.
#[test]
fn listed_and_unlisted_records_share_one_namespace_bound() {
    let fake = |index: usize| format!("{index:064x}");
    // `listed` listed records, then `unlisted` ones a crash between writing a
    // record and listing it left behind.
    let inventory = |listed: usize, unlisted: usize| {
        let env = Env::new();
        env.ready(SLOT);
        env.write_state(
            serde_json::json!({"version":1,"namespaces":(0..listed).map(fake).collect::<Vec<_>>()}),
        );
        let record = serde_json::json!({"version":1,"home":fake(0),"profile":"test","lineage":null,"entries":[]});
        for index in 0..listed + unlisted {
            let path = env.root().join(format!("ns-{}.json", fake(index)));
            fs::write(path, serde_json::to_vec(&record).unwrap()).unwrap();
        }
        env
    };
    let records = |env: &Env| {
        fs::read_dir(env.root())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("ns-") && name.ends_with(".json"))
            .count()
    };
    let journal = |env: &Env| read_dir_json(&env.root()).contains("\"journal\":{");
    let finish =
        |env: &Env| finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(1));
    let mut wrong = Vec::new();

    let below = inventory(MAX_NAMESPACES - 2, 1);
    if below.set(ALICE, SENTINEL).is_err() {
        wrong.push("the 32nd namespace record was refused");
    }
    // A different new namespace is refused before its record or any OS write.
    let full = inventory(MAX_NAMESPACES - 1, 1);
    if full.set(ALICE, SENTINEL).is_ok()
        || full.store.adds.load(Ordering::SeqCst) != 0
        || records(&full) != MAX_NAMESPACES
    {
        wrong.push("a 33rd namespace record or its OS write was admitted");
    }
    // This namespace's own unlisted leftover is reused, not counted twice.
    let reused = Env::new();
    reused.ready(SLOT);
    reused.set(ALICE, SENTINEL).unwrap();
    let own = reused.ns_path();
    let state = serde_json::json!({"version":1,"namespaces":(0..MAX_NAMESPACES - 1).map(fake).collect::<Vec<_>>()});
    reused.write_state(state);
    for index in 0..MAX_NAMESPACES - 1 {
        fs::copy(&own, reused.root().join(format!("ns-{}.json", fake(index)))).unwrap();
    }
    if reused.set(BOB, "sk-bob").is_err() {
        wrong.push("a namespace's own unlisted record was counted twice");
    }

    // A sign-out visits 32 mixed records ...
    let mixed = inventory(MAX_NAMESPACES - 1, 1);
    if begin_sign_out(&mixed.root(), Some(ALICE), None).is_err()
        || finish(&mixed).is_err()
        || journal(&mixed)
    {
        wrong.push("32 mixed records were not all visited");
    }
    // ... and 33 are unknown: the journal and every record stay.
    let over = inventory(MAX_NAMESPACES - 1, 2);
    if begin_sign_out(&over.root(), Some(ALICE), None).is_ok() || !journal(&over) {
        wrong.push("begin over 33 mixed records was not unknown with its journal kept");
    }
    if finish(&over) != Err(SIGN_OUT_UNREADABLE.into()) || !journal(&over) {
        wrong.push("finish over 33 mixed records was not unknown with its journal kept");
    }
    if records(&over) != MAX_NAMESPACES + 1 {
        wrong.push("over-limit evidence was not preserved");
    }
    fs::remove_file(
        over.root()
            .join(format!("ns-{}.json", fake(MAX_NAMESPACES))),
    )
    .unwrap();
    if finish(&over).is_err() || journal(&over) {
        wrong.push("finish within the bound did not complete");
    }
    assert_eq!(wrong, Vec::<&str>::new());
}

// C1: the scan stops at the first record past the bound instead of collecting
// the whole directory first.
#[test]
fn the_member_scan_stops_at_the_first_record_past_the_bound() {
    let fake = |index: usize| format!("{index:064x}");
    let listed: Vec<String> = (0..MAX_NAMESPACES - 1).map(fake).collect();
    let pulled = std::cell::Cell::new(0);
    // Every listed record, an unlisted 32nd, then far more.
    let records = listed
        .iter()
        .cloned()
        .chain((MAX_NAMESPACES..4 * MAX_NAMESPACES).map(fake))
        .map(|id| {
            pulled.set(pulled.get() + 1);
            Ok(id)
        });
    assert_eq!(members_of(&listed, records), Err(UNREADABLE.into()));
    assert_eq!(pulled.get(), MAX_NAMESPACES + 1, "stopped at the 33rd");
    // A malformed name or an unreadable entry is unknown, never skipped.
    assert!(members_of(&[], [Ok(fake(0)), Ok("unknown".into())]).is_err());
    assert!(members_of(&[], [Ok(fake(0)), Err(UNREADABLE.into())]).is_err());
}

#[test]
fn identities_are_bounded_before_any_mutation() {
    let env = Env::new();
    env.ready(SLOT);
    for identity in [
        "",
        "alice",
        &"g".repeat(64),
        &"A".repeat(64),
        &"1".repeat(65),
        &"1".repeat(10_000),
    ] {
        assert!(env.set(identity, SENTINEL).is_err(), "{}", identity.len());
        assert!(env
            .manager
            .secret_status(PLUGIN, &env.current(), "api-key", identity)
            .is_err());
    }
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    assert!(!env.root().exists(), "no inventory was created");
}

#[test]
fn an_unwired_manager_cannot_skip_retirement_on_a_v3_registry() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let bare = Manager::open(Some(env.temp.path().join("home")), "test", false).unwrap();
    assert!(bare.catalog().is_ok(), "reading stays available");
    // Authority-neutral changes need no inventory.
    bare.change("disable", PLUGIN).unwrap();
    bare.change("enable", PLUGIN).unwrap();
    assert!(bare.change("remove", PLUGIN).is_err());
    let widened = r#"{"id":"api-key","label":"API key","origins":["https://api.example.test","https://other.example.test"],"header":"Authorization","scheme":"Bearer"}"#;
    fs::write(
        env.temp.path().join("build/manifest.json"),
        manifest(widened),
    )
    .unwrap();
    assert!(bare.install(&env.temp.path().join("build")).is_err());
    assert!(bare.reload_live(PLUGIN).is_err());
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    // Recover needs no inventory: new code later sees the broken lineage.
    bare.recover().unwrap();
    assert_eq!(env.pending(), 1);
    assert_eq!(
        env.manager
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .pending,
        1
    );
}

#[test]
fn a_set_never_retries_another_scopes_cleanup() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.store.deny_delete(Some(Error::Denied));
    assert!(env
        .manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .is_err());
    env.store.deny_delete(None);
    env.set(BOB, "sk-bob").unwrap();
    // Replacing BOB's value cleans up BOB's superseded account only.
    let deletes = env.store.deletes.load(Ordering::SeqCst);
    env.set(BOB, "sk-bob-two").unwrap();
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), deletes + 1);
    assert_eq!(
        env.pending(),
        1,
        "ALICE's cleanup waits for a deliberate retry"
    );
}

#[test]
fn a_sign_out_journal_fences_from_its_first_commit() {
    // No inventory exists yet: the journal still fences the first enrollment.
    let env = Env::new();
    env.ready(SLOT);
    begin_sign_out(&env.root(), Some(ALICE), None).unwrap();
    assert!(env.set(ALICE, SENTINEL).is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    // A second sign-out cannot overwrite the pending scope.
    assert!(begin_sign_out(&env.root(), Some(BOB), None).is_err());
    env.set(BOB, "sk-bob").unwrap();
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
    env.set(ALICE, SENTINEL).unwrap();

    // A write accepted before the journal commits is never promoted.
    let raced = Env::new();
    raced.ready(SLOT);
    raced.set(BOB, "sk-bob").unwrap();
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (hook_started, hook_release) = (started.clone(), release.clone());
    *raced.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
        hook_started.wait();
        hook_release.wait();
    }));
    let manager = raced.manager.clone();
    let revision = raced.current();
    let writer = std::thread::spawn(move || {
        manager.secret_set(PLUGIN, &revision, "api-key", ALICE, SENTINEL, &|| true)
    });
    started.wait();
    begin_sign_out(&raced.root(), Some(ALICE), None).unwrap();
    release.wait();
    assert!(writer.join().unwrap().is_err());
    *raced.store.on_add.lock().unwrap() = None;
    finish_sign_out(&raced.root(), raced.store.as_ref(), Duration::from_secs(5)).unwrap();
    assert_eq!(raced.store.count(), 1, "only BOB's enrollment remains");
    assert_eq!(raced.status(BOB), SecretStatus::Saved);
}

#[test]
fn finished_sign_out_count_mismatches_retire_from_the_first_observation() {
    // The boot observation precedes any inventory.
    let env = Env::new();
    env.ready(SLOT);
    observe_sign_outs(&env.root(), 4).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    observe_sign_outs(&env.root(), 5).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    // A count that went backwards is a mismatch too.
    env.set(ALICE, "sk-two").unwrap();
    observe_sign_outs(&env.root(), 3).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
}

#[test]
fn records_keep_room_to_retire_every_entry() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let path = env.ns_path();
    let read =
        || -> serde_json::Value { serde_json::from_slice(&fs::read(&path).unwrap()).unwrap() };
    let entry = serde_json::to_vec(&read()["entries"][0]).unwrap().len();
    // Pad one seeded record so the next intent fits the raw cap with 10 bytes to spare.
    env.seed_retired(1);
    let mut namespace = read();
    namespace["entries"][1]["policy"]["scheme"] = "".into();
    let base = serde_json::to_vec(&namespace).unwrap().len();
    let pad = MAX_RECORD_BYTES - base - (entry + 1) - 10;
    namespace["entries"][1]["policy"]["scheme"] = "x".repeat(pad).into();
    fs::write(&path, serde_json::to_vec(&namespace).unwrap()).unwrap();
    let adds = env.store.adds.load(Ordering::SeqCst);
    assert!(env.set(ALICE, "sk-two").is_err());
    assert_eq!(
        env.store.adds.load(Ordering::SeqCst),
        adds,
        "refused before the OS write"
    );
    // Everything indexed can still be retired and removed.
    env.manager.change("remove", PLUGIN).unwrap();
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0);
}

// ------------------------------------------- first-slice review fixes (red first)

/// A second home sharing this inventory root and store, with the slot plugin enabled.
fn second_home(env: &Env) -> (tempfile::TempDir, Manager, String) {
    let elsewhere = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(elsewhere.path().join("home")), "test", false)
        .unwrap()
        .with_secret_storage(env.root(), env.store.clone());
    fs::create_dir(elsewhere.path().join("build")).unwrap();
    fs::write(
        elsewhere.path().join("build/plugin.js"),
        "export function apply() {}",
    )
    .unwrap();
    fs::write(elsewhere.path().join("build/manifest.json"), manifest(SLOT)).unwrap();
    let revision = manager
        .install(&elsewhere.path().join("build"))
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == PLUGIN)
        .unwrap()
        .revision;
    manager.change("enable", PLUGIN).unwrap();
    (elsewhere, manager, revision)
}
/// The record a sign-out visits first: the first namespace the state lists.
fn first_listed(env: &Env) -> PathBuf {
    let state: serde_json::Value =
        serde_json::from_slice(&fs::read(env.root().join(STATE)).unwrap()).unwrap();
    env.root().join(format!(
        "ns-{}.json",
        state["namespaces"][0].as_str().unwrap()
    ))
}
fn status_at(manager: &Manager, revision: &str, identity: &str) -> SecretStatus {
    manager
        .secret_status(PLUGIN, revision, "api-key", identity)
        .unwrap()
}
fn set_at(manager: &Manager, revision: &str, identity: &str, value: &str) -> Result<()> {
    manager.secret_set(PLUGIN, revision, "api-key", identity, value, &|| true)
}
fn hold(store: &Fake, read: bool) -> (Arc<Barrier>, Arc<Barrier>) {
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (hook_started, hook_release) = (started.clone(), release.clone());
    let hook: Hook = Arc::new(move |_| {
        hook_started.wait();
        hook_release.wait();
    });
    *if read { &store.on_read } else { &store.on_add }
        .lock()
        .unwrap() = Some(hook);
    (started, release)
}

// C1: lost global authority is never adopted, rebuilt or reported clean.
#[test]
fn lost_global_state_is_never_adopted_as_continuity() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let revision = env.current();
    let (_elsewhere, other, other_revision) = second_home(&env);
    set_at(&other, &other_revision, ALICE, "sk-other").unwrap();
    let adds = env.store.adds.load(Ordering::SeqCst);
    fs::remove_file(env.root().join(STATE)).unwrap();
    // Direct calls only: no catalog or fixture helper runs first.
    assert_eq!(
        status_at(&env.manager, &revision, ALICE),
        SecretStatus::Unreadable
    );
    assert_eq!(
        status_at(&other, &other_revision, ALICE),
        SecretStatus::Unreadable
    );
    assert!(set_at(&other, &other_revision, BOB, "sk-bob").is_err());
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(observe_sign_outs(&env.root(), 1).is_err());
    assert!(begin_sign_out(&env.root(), Some(ALICE), None).is_err());
    assert_eq!(
        finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)),
        Err(SIGN_OUT_UNREADABLE.into())
    );
    assert!(
        !env.root().join(STATE).exists(),
        "no partial index is rebuilt"
    );
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.count(), 2, "every account stays owed");
}

#[test]
fn corrupt_global_state_is_unknown_on_every_surface() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    fs::write(env.root().join(STATE), b"[").unwrap();
    let cleanup = env.manager.catalog().unwrap().credential_cleanup;
    assert!(cleanup.is_some_and(|status| status.unreadable), "catalog");
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(env
        .manager
        .credential_cleanup(Duration::from_secs(5))
        .is_ok_and(|status| status.unreadable));
    assert_eq!(fs::read(env.root().join(STATE)).unwrap(), b"[");
    assert_eq!(env.store.count(), 1);
}

#[test]
fn a_lost_inventory_with_a_v3_registry_never_launders_debt() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let revision = env.current();
    fs::remove_dir_all(env.root()).unwrap();
    assert!(env
        .manager
        .secret_clear(PLUGIN, &revision, "api-key", ALICE)
        .is_err());
    assert!(
        env.manager
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
            .unreadable
    );
    assert!(set_at(&env.manager, &revision, ALICE, "sk-new").is_err());
    assert_eq!(
        status_at(&env.manager, &revision, ALICE),
        SecretStatus::Unreadable
    );
    // Recovery keeps the only surviving witness of the unknown cleanup.
    env.manager.recover().unwrap();
    assert!(
        env.manager
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .unreadable
    );
    env.ready(SLOT);
    assert!(env.set(ALICE, "sk-new").is_err());
    let restarted = Env::open(&env.temp, "test", env.store.clone());
    assert!(restarted.credential_cleanup_status().unwrap().unreadable);
    assert!(
        restarted
            .catalog()
            .unwrap()
            .credential_cleanup
            .unwrap()
            .unreadable
    );
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
    assert_eq!(env.store.count(), 1);
}

#[test]
fn recovery_never_resets_away_another_builds_witness() {
    // The other build enrolled, then lost its inventory: its v3 lineage is the
    // only witness, and this build cannot discharge that debt.
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    env.set(ALICE, SENTINEL).unwrap();
    let own = env.registry();
    let mut foreign = own.clone();
    foreign["secrets"]["variant"] = if cfg!(debug_assertions) {
        "release"
    } else {
        "debug"
    }
    .into();
    env.write_registry(&foreign);
    fs::remove_dir_all(env.root()).unwrap();
    let path = env.temp.path().join("home/profiles/test/registry.json");
    let before = fs::read(&path).unwrap();
    assert!(env.manager.recover().is_err());
    assert_eq!(fs::read(&path).unwrap(), before, "the witness is preserved");
    // The matching build still sees unknown cleanup, never a clean start.
    env.write_registry(&own);
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(set_at(&env.manager, &revision, ALICE, "sk-new").is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
    assert_eq!(env.store.count(), 1);

    // A corrupt registry with an intact inventory still recovers usably.
    let corrupt = Env::new();
    corrupt.ready(SLOT);
    corrupt.set(ALICE, SENTINEL).unwrap();
    fs::write(
        corrupt.temp.path().join("home/profiles/test/registry.json"),
        b"{corrupt",
    )
    .unwrap();
    corrupt.manager.recover().unwrap();
    assert_eq!(corrupt.pending(), 1);
    assert_eq!(corrupt.retry().pending, 0);
    assert_eq!(corrupt.store.count(), 0);
    corrupt.ready(SLOT);
    corrupt.set(ALICE, "sk-fresh").unwrap();
    assert_eq!(corrupt.status(ALICE), SecretStatus::Saved);
}

/// An enrolled `env` whose inventory is lost and whose registry, still valid
/// JSON with `lineage`, grew past the read bound. Returns its bytes.
fn uninspectable_witness(env: &Env, lineage: &serde_json::Value) -> Vec<u8> {
    fs::remove_dir_all(env.root()).unwrap();
    let mut registry = env.registry();
    registry["secrets"] = lineage.clone();
    let mut bytes = serde_json::to_vec(&registry).unwrap();
    bytes.resize(crate::LIMIT as usize + 1, b' ');
    fs::write(
        env.temp.path().join("home/profiles/test/registry.json"),
        &bytes,
    )
    .unwrap();
    bytes
}
/// Recovery refused without a mutation, and the debt is still unknown once
/// the registry is readable again.
fn assert_refused_and_owed(env: &Env, bytes: &[u8], own: &serde_json::Value, revision: &str) {
    let path = env.temp.path().join("home/profiles/test/registry.json");
    assert!(env.manager.recover().is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes, "the witness is preserved");
    assert!(!env.root().exists(), "no inventory was written");
    assert!(env.manager.credential_cleanup_status().is_err());
    env.write_registry(own);
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(set_at(&env.manager, revision, ALICE, "sk-new").is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.count(), 1);
}

// C1: a witness recovery cannot inspect is never treated as absent.
#[test]
fn recovery_refuses_its_own_witness_beyond_the_read_bound() {
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    env.set(ALICE, SENTINEL).unwrap();
    let own = env.registry();
    let bytes = uninspectable_witness(&env, &own["secrets"]);
    assert_refused_and_owed(&env, &bytes, &own, &revision);
}

#[test]
fn recovery_refuses_another_builds_witness_beyond_the_read_bound() {
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    env.set(ALICE, SENTINEL).unwrap();
    let own = env.registry();
    let mut foreign = own["secrets"].clone();
    foreign["variant"] = if cfg!(debug_assertions) {
        "release"
    } else {
        "debug"
    }
    .into();
    let bytes = uninspectable_witness(&env, &foreign);
    assert_refused_and_owed(&env, &bytes, &own, &revision);
}

#[test]
fn an_unlisted_record_is_never_promoted() {
    // The shape a crash between writing a record and listing it leaves behind.
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let revision = env.current();
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(env.root().join(STATE)).unwrap()).unwrap();
    state["namespaces"] = serde_json::json!([]);
    env.write_state(state);
    assert_eq!(
        status_at(&env.manager, &revision, ALICE),
        SecretStatus::Missing
    );
    // A new set lists the record without adopting it: the old account stays owed.
    set_at(&env.manager, &revision, ALICE, "sk-new").unwrap();
    assert_eq!(
        status_at(&env.manager, &revision, ALICE),
        SecretStatus::Saved
    );
    assert_eq!(env.pending(), 1);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 1, "only the fresh enrollment remains");
}

fn unlist(env: &Env) {
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(env.root().join(STATE)).unwrap()).unwrap();
    state["namespaces"] = serde_json::json!([]);
    env.write_state(state);
}

#[test]
fn a_sign_out_never_certifies_an_unlisted_account_absent() {
    // Membership is lost after enrollment; no set or catalog repairs it first.
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    env.set(ALICE, SENTINEL).unwrap();
    env.set(BOB, "sk-bob").unwrap();
    unlist(&env);
    let journal = || read_dir_json(&env.root()).contains("\"journal\":{");
    let finish = || finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5));
    begin_sign_out(&env.root(), Some(ALICE), None).unwrap();
    env.store.deny_delete(Some(Error::Denied));
    assert_eq!(finish(), Err(SIGN_OUT_INCOMPLETE.into()));
    assert!(journal());
    assert_eq!(
        env.store.count(),
        2,
        "the unlisted ALICE account is still owed"
    );
    env.store.deny_delete(None);
    finish().unwrap();
    assert!(!journal());
    assert_eq!(env.store.count(), 1, "exactly ALICE's account was deleted");
    // BOB's unlisted enrollment is never adopted; it stays owed.
    assert_eq!(
        status_at(&env.manager, &revision, BOB),
        SecretStatus::Missing
    );
    assert_eq!(env.pending(), 1);
    assert_eq!(env.retry().pending, 0);
    assert_eq!(env.store.count(), 0);

    // A crash after a first intent's record but before listing it: never
    // added, never live, and no reason a sign-out cannot finish.
    let crashed = Env::new();
    crashed.ready(SLOT);
    let revision = crashed.current();
    crashed.set(ALICE, SENTINEL).unwrap();
    let path = crashed.ns_path();
    let mut record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    record["entries"][0]["phase"] = "writing".into();
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    crashed.store.items.lock().unwrap().clear();
    unlist(&crashed);
    assert_eq!(
        status_at(&crashed.manager, &revision, ALICE),
        SecretStatus::Missing
    );
    begin_sign_out(&crashed.root(), Some(ALICE), None).unwrap();
    finish_sign_out(
        &crashed.root(),
        crashed.store.as_ref(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(!read_dir_json(&crashed.root()).contains("\"journal\":{"));
    assert_eq!(
        status_at(&crashed.manager, &revision, ALICE),
        SecretStatus::Missing
    );
}

// C2: a committed journal fences every target until all are absent.
#[test]
fn a_committed_journal_is_retained_until_every_target_is_absent() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.set(BOB, "sk-bob").unwrap();
    let (elsewhere, other, other_revision) = second_home(&env);
    set_at(&other, &other_revision, ALICE, "sk-other").unwrap();
    // An ALICE write in the other home is inside its OS add when the journal commits.
    let (started, release) = hold(&env.store, false);
    let writer = {
        let (other, revision) = (other.clone(), other_revision.clone());
        std::thread::spawn(move || set_at(&other, &revision, ALICE, "sk-in-flight"))
    };
    started.wait();
    // The first targeted record is unreadable: begin commits, then stops
    // before it reaches the other home's healthy record.
    let path = first_listed(&env);
    let saved = fs::read(&path).unwrap();
    fs::write(&path, b"{not json").unwrap();
    assert!(begin_sign_out(&env.root(), Some(ALICE), None).is_err());
    release.wait();
    assert!(
        writer.join().unwrap().is_err(),
        "the accepted writer is fenced"
    );
    *env.store.on_add.lock().unwrap() = None;
    // No native marker was written: the journal alone fences, across restart.
    let restarted = Manager::open(Some(elsewhere.path().join("home")), "test", false)
        .unwrap()
        .with_secret_storage(env.root(), env.store.clone());
    assert_eq!(
        status_at(&restarted, &other_revision, ALICE),
        SecretStatus::Missing
    );
    assert!(set_at(&restarted, &other_revision, ALICE, "sk-again").is_err());
    let journal = || read_dir_json(&env.root()).contains("\"journal\":{");
    assert_eq!(env.store.count(), 3, "both ALICE accounts and BOB's remain");
    // The readable target is deleted; the unreadable one keeps the journal.
    assert_eq!(
        finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)),
        Err(SIGN_OUT_UNREADABLE.into())
    );
    assert!(journal());
    assert_eq!(env.store.count(), 2);
    // Readable again, but a denied delete still keeps the journal.
    fs::write(&path, &saved).unwrap();
    env.store.deny_delete(Some(Error::Denied));
    assert_eq!(
        finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)),
        Err(SIGN_OUT_INCOMPLETE.into())
    );
    assert!(journal());
    assert_eq!(env.store.count(), 2, "this home's ALICE and BOB remain");
    env.store.deny_delete(None);
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
    assert!(!journal(), "cleared only after every target is absent");
    assert_eq!(
        env.store.count(),
        1,
        "exactly ALICE's accounts were deleted"
    );
    assert_eq!(env.status(BOB), SecretStatus::Saved);
}

// C3: only an actually observed count is recorded.
#[test]
fn a_markerless_finish_never_predicts_the_next_sign_out() {
    let env = Env::new();
    env.ready(SLOT);
    observe_sign_outs(&env.root(), 4).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    env.set(BOB, "sk-bob").unwrap();
    // ALICE's journal committed, then a crash before the native marker; a
    // deliberate retry finishes the journal with no native append.
    begin_sign_out(&env.root(), Some(ALICE), None).unwrap();
    finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5)).unwrap();
    // The next real event is an older build signing BOB out: 4 -> 5.
    observe_sign_outs(&env.root(), 5).unwrap();
    assert_eq!(env.status(BOB), SecretStatus::Missing);
}

// C4: a new root's directory links are durable before any admitted write.
#[test]
fn the_inventory_root_link_is_durable_before_any_admitted_write() {
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    let parent = physical(env.temp.path());
    let synced = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let log = synced.clone();
    on_dir_sync(move |path| {
        log.lock().unwrap().push(path.to_path_buf());
        Ok(())
    });
    let durable = Arc::new(Mutex::new(None));
    let (seen, observed) = (synced.clone(), durable.clone());
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
        *observed.lock().unwrap() = Some(seen.lock().unwrap().contains(&parent));
    }));
    set_at(&env.manager, &revision, ALICE, SENTINEL).unwrap();
    assert_eq!(
        *durable.lock().unwrap(),
        Some(true),
        "linked before the add"
    );

    // begin/observe make every newly created ancestor link durable before acknowledging.
    let deep = env.temp.path().join("deep");
    let root = deep.join("er/secrets");
    let log = Arc::new(Mutex::new(Vec::new()));
    let (record, state) = (log.clone(), root.join(STATE));
    on_dir_sync(move |path| {
        record
            .lock()
            .unwrap()
            .push((path.to_path_buf(), state.exists()));
        Ok(())
    });
    begin_sign_out(&root, Some(ALICE), None).unwrap();
    for dir in
        [deep.join("er"), deep.clone(), env.temp.path().to_path_buf()].map(|dir| physical(&dir))
    {
        assert!(
            log.lock().unwrap().contains(&(dir.clone(), false)),
            "{dir:?}"
        );
    }

    // A failed link sync admits no add, journal or count.
    let failing = Env::new();
    failing.ready(SLOT);
    let revision = failing.current();
    let parent = physical(failing.temp.path());
    on_dir_sync(move |path| {
        if path == parent {
            Err(std::io::Error::other("sync"))
        } else {
            Ok(())
        }
    });
    assert!(set_at(&failing.manager, &revision, ALICE, SENTINEL).is_err());
    assert_eq!(failing.store.adds.load(Ordering::SeqCst), 0);
    assert!(begin_sign_out(&failing.root(), Some(ALICE), None).is_err());
    assert!(observe_sign_outs(&failing.root(), 1).is_err());
    assert!(!failing.root().join(STATE).exists());
}

// C4: existence proves nothing. Every ancestor link is durable before each
// attempt acknowledges, whether set, a failed attempt or a concurrent one made it.
#[test]
fn every_ancestor_link_is_durable_before_each_attempt_acknowledges() {
    // Each sync is logged with whether this attempt's acknowledgement exists yet.
    let log = Arc::new(Mutex::new(Vec::<(PathBuf, bool)>::new()));
    let fail = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let ack = Arc::new(Mutex::new(PathBuf::new()));
    {
        let (log, fail, ack) = (log.clone(), fail.clone(), ack.clone());
        on_dir_sync(move |path| {
            if fail.lock().unwrap().iter().any(|failing| failing == path) {
                return Err(std::io::Error::other("sync"));
            }
            let acknowledged = ack.lock().unwrap().exists();
            log.lock().unwrap().push((path.to_path_buf(), acknowledged));
            Ok(())
        });
    }
    // The links under an existing base that a deep, initially absent root needs.
    let root = |base: &Path| base.join("deep/er/secrets");
    let chain = |base: &Path| {
        let base = physical(base);
        [base.join("deep/er"), base.join("deep"), base]
    };
    let added = Arc::new(Mutex::new(None));
    // A set in `env`'s own home whose inventory root set itself creates.
    let set = |env: &Env| {
        let revision = env.current();
        let (log, needed, added) = (log.clone(), chain(env.temp.path()), added.clone());
        *env.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
            let log = log.lock().unwrap();
            *added.lock().unwrap() = Some(
                needed
                    .iter()
                    .all(|dir| log.iter().any(|(path, _)| path == dir)),
            );
        }));
        let manager = env
            .manager
            .clone()
            .with_secret_storage(root(env.temp.path()), env.store.clone());
        set_at(&manager, &revision, ALICE, SENTINEL)
    };
    let durable_before_ack = |base: &Path| {
        let log = log.lock().unwrap();
        chain(base)
            .iter()
            .all(|dir| log.contains(&(dir.clone(), false)))
    };
    let mut wrong = Vec::new();

    let first = Env::new();
    first.ready(SLOT);
    set(&first).unwrap();
    if *added.lock().unwrap() != Some(true) {
        wrong.push("first set: a new ancestor link was not durable before the add");
    }

    // An upper link cannot be synced: nothing is admitted or acknowledged.
    let retry = Env::new();
    retry.ready(SLOT);
    let bases = tempfile::tempdir().unwrap();
    let (begin, observe) = (bases.path().join("begin"), bases.path().join("observe"));
    fs::create_dir(&begin).unwrap();
    fs::create_dir(&observe).unwrap();
    *fail.lock().unwrap() = vec![
        physical(retry.temp.path()),
        physical(&begin),
        physical(&observe),
    ];
    if set(&retry).is_ok() || retry.store.adds.load(Ordering::SeqCst) != 0 {
        wrong.push("set added while an ancestor link could not be synced");
    }
    if begin_sign_out(&root(&begin), Some(ALICE), None).is_ok() {
        wrong.push("begin acknowledged while an ancestor link could not be synced");
    }
    if observe_sign_outs(&root(&observe), 1).is_ok() {
        wrong.push("observe acknowledged while an ancestor link could not be synced");
    }
    for base in [retry.temp.path(), &begin, &observe] {
        assert!(
            root(base).is_dir(),
            "the retry starts with every directory present"
        );
        if root(base).join(STATE).exists() {
            wrong.push("state was written while an ancestor link could not be synced");
        }
    }

    // Retried with every directory already present, the upper link is synced again.
    fail.lock().unwrap().clear();
    log.lock().unwrap().clear();
    *added.lock().unwrap() = None;
    set(&retry).unwrap();
    if *added.lock().unwrap() != Some(true) {
        wrong.push("set retry: an ancestor link was not durable before the add");
    }
    log.lock().unwrap().clear();
    *ack.lock().unwrap() = root(&begin).join(STATE);
    begin_sign_out(&root(&begin), Some(ALICE), None).unwrap();
    if !durable_before_ack(&begin) {
        wrong.push("begin retry: an ancestor link was not durable before the journal");
    }
    log.lock().unwrap().clear();
    *ack.lock().unwrap() = root(&observe).join(STATE);
    observe_sign_outs(&root(&observe), 1).unwrap();
    if !durable_before_ack(&observe) {
        wrong.push("observe retry: an ancestor link was not durable before the count");
    }
    assert_eq!(wrong, Vec::<&str>::new());
}

/// The spelling the directory-sync seam observes: links resolved.
fn physical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap()
}

// C4: a second stable spelling of a root another attempt just materialized
// still makes the physical chain durable, whatever that attempt completed.
#[cfg(unix)]
#[test]
fn an_alias_of_a_newly_materialized_root_syncs_its_physical_parent() {
    let env = Env::new();
    env.ready(SLOT);
    let revision = env.current();
    // `link` names `a/new` before it exists; `a` will hold the new `new` link.
    let base = physical(env.temp.path());
    let a = base.join("a");
    fs::create_dir(&a).unwrap();
    std::os::unix::fs::symlink(a.join("new"), base.join("link")).unwrap();
    let (direct, alias) = (a.join("new/secrets"), base.join("link/secrets"));
    // The first creator pauses just before syncing `a`, then fails there.
    let (paused, release) = (Arc::new(Barrier::new(2)), Arc::new(Barrier::new(2)));
    let creator = {
        let (a, paused, release) = (a.clone(), paused.clone(), release.clone());
        std::thread::spawn(move || {
            on_dir_sync(move |path| {
                if path == a {
                    paused.wait();
                    release.wait();
                    return Err(std::io::Error::other("sync"));
                }
                Ok(())
            });
            begin_sign_out(&direct, Some(ALICE), None)
        })
    };
    paused.wait();
    assert!(
        alias.is_dir(),
        "the alias resolves to the creator's new root"
    );
    let log = Arc::new(Mutex::new(Vec::<PathBuf>::new()));
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    {
        let (log, fail, a) = (log.clone(), fail.clone(), a.clone());
        on_dir_sync(move |path| {
            if fail.load(Ordering::SeqCst) && path == a {
                return Err(std::io::Error::other("sync"));
            }
            log.lock().unwrap().push(path.to_path_buf());
            Ok(())
        });
    }
    let manager = env
        .manager
        .clone()
        .with_secret_storage(alias.clone(), env.store.clone());
    let mut wrong = Vec::new();
    // While `a` cannot be synced, the alias caller acknowledges nothing.
    if set_at(&manager, &revision, ALICE, SENTINEL).is_ok()
        || env.store.adds.load(Ordering::SeqCst) != 0
    {
        wrong.push("alias set added without its physical parent link");
    }
    if begin_sign_out(&alias, Some(ALICE), None).is_ok() {
        wrong.push("alias begin journaled without its physical parent link");
    }
    if observe_sign_outs(&alias, 1).is_ok() {
        wrong.push("alias observe counted without its physical parent link");
    }
    if alias.join(STATE).exists() {
        wrong.push("state was written without its physical parent link");
    }
    release.wait();
    assert!(
        creator.join().unwrap().is_err(),
        "the creator never synced `a`"
    );
    // Retried through the alias, `a` is synced before the add.
    fail.store(false, Ordering::SeqCst);
    let added = Arc::new(Mutex::new(None));
    {
        let (log, added, a) = (log.clone(), added.clone(), a.clone());
        *env.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
            *added.lock().unwrap() = Some(log.lock().unwrap().contains(&a));
        }));
    }
    if set_at(&manager, &revision, ALICE, SENTINEL).is_err() || *added.lock().unwrap() != Some(true)
    {
        wrong.push("alias set: the physical parent link was not durable before the add");
    }
    assert_eq!(wrong, Vec::<&str>::new());
}

// C4: off Unix nothing is admitted: refused before any metadata or store
// work. Not executed by the local macOS runs or by current CI.
#[cfg(not(unix))]
#[test]
fn unsupported_platforms_refuse_before_any_mutation() {
    let env = Env::new();
    let revision = env.ready(SLOT);
    let registry = fs::read(env.temp.path().join("home/profiles/test/registry.json")).unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let counted = reads.clone();
    *env.store.on_read.lock().unwrap() = Some(Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(
        establish(&env.root()).unwrap_err().kind(),
        ErrorKind::Unsupported
    );
    assert!(!env.root().exists(), "nothing is created");
    assert_eq!(
        set_at(&env.manager, &revision, ALICE, SENTINEL),
        Err(UNSUPPORTED.into())
    );
    assert_eq!(
        env.manager
            .secret_status(PLUGIN, &revision, "api-key", ALICE),
        Err(UNSUPPORTED.into())
    );
    assert!(!env.root().exists(), "no inventory metadata is written");
    assert_eq!(
        fs::read(env.temp.path().join("home/profiles/test/registry.json")).unwrap(),
        registry
    );
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    assert_eq!(reads.load(Ordering::SeqCst), 0);
}

// C5: an invalid persisted scope is unknown, never empty cleanup.
#[test]
fn invalid_persisted_scope_is_unknown_not_empty_cleanup() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let state_path = env.root().join(STATE);
    let state: serde_json::Value = serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let finish = || finish_sign_out(&env.root(), env.store.as_ref(), Duration::from_secs(5));
    for journal in [
        serde_json::json!({}),
        serde_json::json!({"identity": null, "home": null}),
        serde_json::json!({"identity": "alice"}),
        serde_json::json!({"identity": "A".repeat(64)}),
        serde_json::json!({"home": "not-a-digest"}),
    ] {
        let mut invalid = state.clone();
        invalid["journal"] = journal.clone();
        env.write_state(invalid);
        let bytes = fs::read(&state_path).unwrap();
        assert!(finish().is_err(), "{journal}");
        assert_eq!(fs::read(&state_path).unwrap(), bytes, "{journal}");
        assert_eq!(env.store.count(), 1, "{journal}");
    }
    // Malformed scope fields in a record are never skipped as unrelated.
    let path = env.ns_path();
    let record: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let home = record["home"].clone();
    let cases: [(fn(&mut serde_json::Value), _); 2] = [
        (
            |r| r["home"] = "not-a-digest".into(),
            serde_json::json!({"home": home}),
        ),
        (
            |r| r["entries"][0]["identity"] = "alice".into(),
            serde_json::json!({"identity": ALICE}),
        ),
    ];
    for (change, journal) in cases {
        let mut invalid = record.clone();
        change(&mut invalid);
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        let mut pending = state.clone();
        pending["journal"] = journal.clone();
        env.write_state(pending);
        let bytes = fs::read(&path).unwrap();
        assert!(finish().is_err(), "{journal}");
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert!(read_dir_json(&env.root()).contains("\"journal\":{"));
        assert_eq!(env.store.count(), 1);
    }
}

// I1: direct administrative status and retry reconcile with the registry.
#[test]
fn direct_cleanup_status_and_retry_reconcile_the_registry() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    // A faithful older-build recover: defaults written without reading.
    env.write_registry(&serde_json::json!({"version":2,"bundledEnabled":true,"installed":{}}));
    let reopened = Env::open(&env.temp, "test", env.store.clone());
    assert_eq!(reopened.credential_cleanup_status().unwrap().pending, 1);
    env.store.deny_delete(Some(Error::Denied));
    let retry = || reopened.credential_cleanup(Duration::from_secs(5)).unwrap();
    assert_eq!(retry().pending, 1, "denied delete stays pending");
    assert_eq!(env.store.count(), 1);
    env.store.deny_delete(None);
    assert_eq!(retry().pending, 0);
    assert_eq!(env.store.count(), 0, "zero follows confirmed deletion");

    // A bare (unwired) manager's recover, then a wired reopen.
    let bare_env = Env::new();
    bare_env.ready(SLOT);
    bare_env.set(ALICE, SENTINEL).unwrap();
    Manager::open(Some(bare_env.temp.path().join("home")), "test", false)
        .unwrap()
        .recover()
        .unwrap();
    let reopened = Env::open(&bare_env.temp, "test", bare_env.store.clone());
    assert_eq!(
        reopened
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
            .pending,
        0
    );
    assert_eq!(bare_env.store.count(), 0);
}

// I2: a delayed store read cannot report an enrollment retired meanwhile.
#[test]
fn a_delayed_store_read_never_reports_a_retired_enrollment_saved() {
    let widened = r#"{"id":"api-key","label":"API key","origins":["https://api.example.test","https://other.example.test"],"header":"Authorization","scheme":"Bearer"}"#;
    for scenario in ["clear", "policy", "sign-out"] {
        let env = Env::new();
        env.ready(SLOT);
        env.set(ALICE, SENTINEL).unwrap();
        let revision = env.current();
        // Physical deletion is denied: the bytes stay readable throughout.
        env.store.deny_delete(Some(Error::Denied));
        let (started, release) = hold(&env.store, true);
        let reader = {
            let (manager, revision) = (env.manager.clone(), revision.clone());
            std::thread::spawn(move || manager.secret_status(PLUGIN, &revision, "api-key", ALICE))
        };
        started.wait();
        match scenario {
            "clear" => {
                let _ = env
                    .manager
                    .secret_clear(PLUGIN, &revision, "api-key", ALICE);
            }
            "policy" => {
                env.install(widened);
            }
            _ => begin_sign_out(&env.root(), Some(ALICE), None).unwrap(),
        }
        release.wait();
        let status = reader.join().unwrap();
        assert!(
            !matches!(status, Ok(SecretStatus::Saved)),
            "{scenario}: {status:?}"
        );
        assert_eq!(env.store.count(), 1, "{scenario}");
    }
}

// I3: plugin-facing calls require the artifact the host would load.
#[test]
fn plugin_facing_calls_require_the_verified_artifact() {
    for damage in ["corrupt", "delete"] {
        let env = Env::new();
        env.ready(SLOT);
        env.set(ALICE, SENTINEL).unwrap();
        let revision = env.current();
        let artifact = env.temp.path().join(format!(
            "home/profiles/test/artifacts/{PLUGIN}/{revision}.json"
        ));
        if damage == "corrupt" {
            fs::write(&artifact, b"{}").unwrap();
        } else {
            fs::remove_file(&artifact).unwrap();
        }
        let (adds, deletes) = (
            env.store.adds.load(Ordering::SeqCst),
            env.store.deletes.load(Ordering::SeqCst),
        );
        assert!(env
            .manager
            .secret_status(PLUGIN, &revision, "api-key", ALICE)
            .is_err());
        assert!(set_at(&env.manager, &revision, ALICE, "sk-new").is_err());
        assert!(env
            .manager
            .secret_clear(PLUGIN, &revision, "api-key", ALICE)
            .is_err());
        assert_eq!(env.store.adds.load(Ordering::SeqCst), adds, "{damage}");
        assert_eq!(
            env.store.deletes.load(Ordering::SeqCst),
            deletes,
            "{damage}"
        );
        // Administrative cleanup needs no valid artifact.
        if damage == "corrupt" {
            env.manager.change("remove", PLUGIN).unwrap();
        } else {
            env.manager.recover().unwrap();
        }
        assert_eq!(env.retry().pending, 0, "{damage}");
        assert_eq!(env.store.count(), 0, "{damage}");
    }
}

// I4: a wiped home keeps one canonical identity for namespaces and erase scope.
#[cfg(unix)]
#[test]
fn a_wiped_symlinked_home_keeps_its_namespace_and_erase_scope() {
    let enrolled = |temp: &tempfile::TempDir| {
        fs::create_dir(temp.path().join("real")).unwrap();
        std::os::unix::fs::symlink(temp.path().join("real"), temp.path().join("alias")).unwrap();
        let home = temp.path().join("alias/home");
        let store = Arc::new(Fake::default());
        let open = || {
            Manager::open(Some(home.clone()), "test", false)
                .unwrap()
                .with_secret_storage(temp.path().join("secrets"), store.clone())
        };
        fs::create_dir(temp.path().join("build")).unwrap();
        fs::write(
            temp.path().join("build/plugin.js"),
            "export function apply() {}",
        )
        .unwrap();
        fs::write(temp.path().join("build/manifest.json"), manifest(SLOT)).unwrap();
        let manager = open();
        let revision = manager
            .install(&temp.path().join("build"))
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == PLUGIN)
            .unwrap()
            .revision;
        manager.change("enable", PLUGIN).unwrap();
        set_at(&manager, &revision, ALICE, SENTINEL).unwrap();
        fs::remove_dir_all(temp.path().join("real/home")).unwrap();
        (home.clone(), store.clone(), open())
    };
    // Erase through the same spelling after the wipe targets the enrolled namespace.
    let temp = tempfile::tempdir().unwrap();
    let (home, store, _) = enrolled(&temp);
    let root = temp.path().join("secrets");
    begin_sign_out(&root, None, Some(&home)).unwrap();
    finish_sign_out(&root, store.as_ref(), Duration::from_secs(5)).unwrap();
    assert_eq!(store.count(), 0, "the erased home's account is deleted");
    // Spellings that cannot be resolved through an existing ancestor are unknown.
    std::os::unix::fs::symlink(temp.path().join("gone"), temp.path().join("dangling")).unwrap();
    for unresolved in [
        temp.path().join("dangling/home"),
        temp.path().join("gone/../home"),
    ] {
        assert!(home_hash(&unresolved).is_err(), "{unresolved:?}");
        assert!(begin_sign_out(&root, None, Some(&unresolved)).is_err());
    }
    // Direct status/retry after reopening find the owed account, never a clean empty namespace.
    let temp = tempfile::tempdir().unwrap();
    let (_, store, reopened) = enrolled(&temp);
    assert_eq!(reopened.credential_cleanup_status().unwrap().pending, 1);
    assert_eq!(
        reopened
            .credential_cleanup(Duration::from_secs(5))
            .unwrap()
            .pending,
        0
    );
    assert_eq!(store.count(), 0);
}

#[test]
fn the_sign_out_pending_query_only_reads_the_journal() {
    let env = Env::new();
    let root = env.root();
    assert_eq!(sign_out_pending(&root), Ok(false));
    assert!(!root.exists(), "asking creates nothing");
    begin_sign_out(&root, Some(ALICE), None).unwrap();
    assert_eq!(sign_out_pending(&root), Ok(true));
    finish_sign_out(&root, env.store.as_ref(), Duration::from_secs(5)).unwrap();
    assert_eq!(sign_out_pending(&root), Ok(false));
    fs::write(root.join(STATE), b"{not json").unwrap();
    assert_eq!(sign_out_pending(&root), Err(SIGN_OUT_UNREADABLE.into()));
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
}
