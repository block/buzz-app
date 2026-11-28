//! No OS access: executable legacy closure and historical writer continuity.
use super::*;

#[test]
fn shipped_legacy_management_never_creates_first_h1_evidence() {
    let cli = include_str!("../../main.rs");
    for forbidden in [
        "secret_set",
        "begin_sign_out",
        "observe_sign_outs",
        "with_secret_storage",
    ] {
        assert!(
            !cli.contains(forbidden),
            "CLI creator surface changed: {forbidden}"
        );
    }
    for configured in [false, true] {
        let env = Env::new();
        let manager = if configured {
            env.manager.clone()
        } else {
            Manager::open(Some(env.temp.path().join("home")), "test", false).unwrap()
        };
        fs::write(env.temp.path().join("build/manifest.json"), manifest(SLOT)).unwrap();
        let build = env.temp.path().join("build");
        let legacy = || {
            let registry = env.registry();
            assert_eq!(registry["version"], 2);
            assert!(registry.get("secrets").is_none());
            assert!(registry["installed"]
                .as_object()
                .unwrap()
                .values()
                .all(|entry| entry.get("generation").is_none()));
            assert!(!env.root().exists(), "management must not enroll");
            assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
        };
        manager.install(&build).unwrap();
        legacy();
        manager.catalog().unwrap();
        legacy();
        manager.managed(&manager.catalog().unwrap());
        legacy();
        manager.change("enable", PLUGIN).unwrap();
        legacy();
        manager.change("disable", PLUGIN).unwrap();
        legacy();
        fs::write(
            build.join("plugin.js"),
            "export function apply() { return 2; }",
        )
        .unwrap();
        manager.reload_live(PLUGIN).unwrap();
        legacy();
        manager.change("rollback", PLUGIN).unwrap();
        legacy();
        manager.change("disable", "buzz.codex").unwrap();
        legacy();
        manager.change("enable", "buzz.codex").unwrap();
        legacy();
        manager.change("remove", PLUGIN).unwrap();
        legacy();
        manager.recover().unwrap();
        legacy();
        let registry = env.registry();
        assert_eq!(registry["version"], 2);
        assert!(registry.get("secrets").is_none());
        assert!(
            !env.root().exists(),
            "declarations/management must not enroll"
        );
        assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    }
}

// Only the calling test thread pauses after the actual Manager read. No public
// API or production behavior changes; the writer holds the old R inode.
thread_local! {
    pub(crate) static AFTER_READ: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
}
pub(crate) fn after_read() {
    if let Some(hook) = AFTER_READ.take() {
        hook();
    }
}

#[test]
fn real_manager_paused_v3_writer_reappears_but_broken_continuity_refuses() {
    let env = Env::new();
    let revision = env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    // Lose global continuity while preserving the available namespace debt.
    fs::remove_file(env.root().join(STATE)).unwrap();
    let namespace = fs::read(env.ns_path()).unwrap();
    let captured = env.registry();
    let adds = env.store.adds.load(Ordering::SeqCst);
    let (read, observed) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer = env.manager.clone();
    let job = std::thread::spawn(move || {
        AFTER_READ.set(Some(Box::new(move || {
            read.send(()).unwrap();
            released.recv().unwrap();
        })));
        writer.change("disable", "buzz.codex")
    });
    // Bounded only as a defect watchdog, not the ordering primitive.
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let home = env.temp.path().join("home");
    fs::rename(&home, env.temp.path().join("displaced")).unwrap();
    release.send(()).unwrap();
    job.join().unwrap().unwrap();
    assert_eq!(
        env.registry()["version"],
        3,
        "actual Manager republished v3 by pathname"
    );
    assert!(env
        .temp
        .path()
        .join("displaced/profiles/test/registry.json")
        .exists());
    let republished = env.registry();
    assert_eq!(republished["secrets"], captured["secrets"]);
    assert_eq!(republished["installed"], captured["installed"]);
    // Keep artifacts available so refusal tests lost continuity, not merely
    // the earlier missing-artifact error caused by moving the whole home.
    fs::rename(
        env.temp.path().join("displaced/profiles/test/artifacts"),
        home.join("profiles/test/artifacts"),
    )
    .unwrap();
    assert_eq!(
        env.manager
            .secret_status(PLUGIN, &revision, "api-key", ALICE)
            .unwrap(),
        SecretStatus::Unreadable
    );
    assert!(env
        .manager
        .secret_set(PLUGIN, &revision, "api-key", ALICE, "sk-new", &|| true)
        .is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds, "zero new adds");
    assert_eq!(
        fs::read(env.ns_path()).unwrap(),
        namespace,
        "available debt retained"
    );
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(
        env.manager
            .credential_cleanup(Duration::ZERO)
            .unwrap()
            .unreadable
    );
    assert_eq!(env.store.count(), 1, "no account reuse/dispatch");
}

#[test]
fn latent_snapshot_after_completed_clean_scan_reappears_and_fails_closed() {
    let env = Env::new();
    let revision = env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let captured = env.registry();
    let adds = env.store.adds.load(Ordering::SeqCst);
    let namespace = fs::read(env.ns_path()).unwrap();
    // Preserve available debt off-path. No active inventory at inspection time.
    let namespace_path = env.ns_path();
    let debt = env.temp.path().join("retained-debt");
    fs::rename(env.root(), &debt).unwrap();
    let (read, observed) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let writer = env.manager.clone();
    let job = std::thread::spawn(move || {
        AFTER_READ.set(Some(Box::new(move || {
            read.send(()).unwrap();
            released.recv().unwrap();
        })));
        writer.change("disable", "buzz.codex")
    });
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let home = env.temp.path().join("home");
    let displaced = env.temp.path().join("historical-wipe");
    fs::rename(&home, &displaced).unwrap();
    // A historical erase discards the captured registry/old R pathname, not
    // the CLI's in-memory snapshot. Keep artifacts to isolate continuity.
    let artifacts = env.temp.path().join("artifacts");
    fs::rename(displaced.join("profiles/test/artifacts"), &artifacts).unwrap();
    fs::remove_dir_all(displaced).unwrap();
    let base = fs::canonicalize(env.temp.path()).unwrap();
    let scope = preflight::Scope {
        inventories: vec![base.join("secrets"), base.join("secrets.debug")],
        homes: vec![base.join("home"), base.join("home.sign-out-trash")],
    };
    let clean = preflight::inspect(&scope);
    // Always release/join before asserting, even if the scanner is defective.
    release.send(()).unwrap();
    job.join().unwrap().unwrap();
    assert!(clean.is_ok(), "completed clean-looking scan: {clean:?}");
    assert_eq!(env.registry()["version"], 3, "reappearance, NOT exclusion");
    assert_eq!(env.registry()["secrets"], captured["secrets"]);
    assert_eq!(env.registry()["installed"], captured["installed"]);
    assert!(preflight::inspect(&scope).is_err(), "a later scan refuses");
    fs::rename(artifacts, home.join("profiles/test/artifacts")).unwrap();
    // Restore only the available namespace, not global continuity. Inspection
    // did not delete it; it cannot make the resurrected generation usable.
    fs::create_dir(env.root()).unwrap();
    fs::rename(
        debt.join(namespace_path.file_name().unwrap()),
        &namespace_path,
    )
    .unwrap();
    assert_eq!(
        env.manager
            .secret_status(PLUGIN, &revision, "api-key", ALICE)
            .unwrap(),
        SecretStatus::Unreadable
    );
    assert!(env
        .manager
        .secret_set(PLUGIN, &revision, "api-key", ALICE, "sk-new", &|| true)
        .is_err());
    assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
    assert_eq!(
        fs::read(env.ns_path()).unwrap(),
        namespace,
        "available debt retained"
    );
    assert!(env.manager.credential_cleanup_status().unwrap().unreadable);
    assert!(
        env.manager
            .credential_cleanup(Duration::ZERO)
            .unwrap()
            .unreadable
    );
    assert_eq!(env.store.count(), 1, "no account reuse/dispatch");
}
