//! Admission regressions use temporary native locks, never the shared store.
use super::*;

thread_local! {
    pub(crate) static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default();
}
pub(crate) fn before_commit() {
    if let Some(hook) = BEFORE_COMMIT.take() {
        hook();
    }
}

#[allow(clippy::incompatible_msrv)]
pub(super) fn exclusive(path: &Path) -> bool {
    OpenOptions::new()
        .write(true)
        .open(path)
        .unwrap()
        .try_lock()
        .is_ok()
}

/// Completion can precede the worker's final Arc drop or a concurrently forked
/// child's exec. Retry only positive release probes, with the existing WAIT.
#[allow(clippy::incompatible_msrv)]
pub(super) fn released_lock(path: &Path) {
    let mut last_error = None;
    let acquired = wait_for(|| {
        let result = OpenOptions::new().write(true).open(path).and_then(|file| {
            file.try_lock().map_err(|error| match error {
                fs::TryLockError::WouldBlock => std::io::Error::from(ErrorKind::WouldBlock),
                fs::TryLockError::Error(error) => error,
            })
        });
        result.map_err(|error| last_error = Some(error))
    });
    assert!(
        acquired,
        "{} not released within {WAIT:?}: kind={:?}, error={last_error:?}",
        path.display(),
        last_error.as_ref().map(std::io::Error::kind),
    );
}

#[test]
fn creator_before_establishment_blocks_begin_without_releasing_instance() {
    for choices in [PLAIN, WIPE] {
        let (dir, paths) = fixture();
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let lease = instance.creator().unwrap();
        assert_eq!(instance.begin(choices, None), Err(refuse(SAVING)));
        assert!(!exclusive(&paths.key_lock));
        assert!(!exclusive(&paths.lock));
        assert!(!dir.path().join("inventory").exists());
        drop(lease);
        assert_eq!(instance.begin(choices, None), Ok(()));
    }
}

#[test]
fn dropping_the_instance_does_not_drop_the_creators_native_ownership() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let lease = instance.creator().unwrap();
    drop(instance);
    assert!(!exclusive(&paths.key_lock));
    assert!(!exclusive(&paths.lock));
    drop(lease);
    released_lock(&paths.key_lock);
    released_lock(&paths.lock);
}

#[test]
fn creators_and_plain_journals_try_the_other_variant_before_metadata() {
    for service in ["identity", OTHER_KEY] {
        let (dir, _) = fixture();
        let paths = paths_for(dir.path(), service);
        let other = paths_for(
            dir.path(),
            if service == OTHER_KEY {
                "identity"
            } else {
                OTHER_KEY
            },
        );
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let signing_out = boot(&other, None, no_agents, || panic!("no marker")).unwrap();
        signing_out.begin(PLAIN, None).unwrap();
        assert!(
            instance.creator().is_err(),
            "other K exclusive refuses a creator"
        );
        let commit = || panic!("other K conflict must precede journal establishment");
        let pending = || Ok(false);
        let journal = Journal {
            commit: &commit,
            pending: &pending,
            admit: &|| Ok(()),
        };
        assert_eq!(
            run(attempt(
                &instance,
                &paths,
                PLAIN,
                || async { Ok(()) },
                Some(&journal),
                || {},
                || async { panic!("no shutdown") },
                || async { panic!("no exit") }
            )),
            Err(refuse(SAVING))
        );
        assert!(!instance.marker.exists());
        assert!(!instance.shared.gate.lock().unwrap().closed);
        assert!(!exclusive(&paths.key_lock), "own K shared restored");
    }
}

#[test]
fn creator_other_key_lease_blocks_cross_process_plain_and_erase() {
    for choices in [PLAIN, WIPE] {
        let (dir, paths) = fixture();
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let mut other = Child::spawn_as(dir.path(), OTHER_KEY, choices);
        let lease = instance.creator().unwrap();
        assert_eq!(other.go(), "child: refused");
        other.finish();
        drop(lease);
        let mut other = Child::spawn_as(dir.path(), OTHER_KEY, PLAIN);
        assert_eq!(other.go(), "child: signing out");
        other.finish();
    }
}

#[test]
fn first_observe_is_admitted_before_it_can_create_inventory() {
    let (dir, paths) = fixture();
    let root = dir.path().join("inventory");
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    instance.begin(PLAIN, None).unwrap();
    assert!(instance.observe_sign_outs(Some(&root)).is_err());
    assert!(!root.exists());
    drop(instance);
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    instance.observe_sign_outs(Some(&root)).unwrap();
    assert!(root.exists());
    assert!(!buzzodz_plugins::secrets::sign_out_pending(&root).unwrap());
}

#[test]
fn boot_plain_cleanup_always_owns_all_buzz_shared() {
    for late in [false, true] {
        let (_dir, paths) = fixture();
        if late {
            mark(&paths, false, false);
        }
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let completed = ran.clone();
        let pending = || {
            let call = calls.fetch_add(1, Ordering::SeqCst);
            Ok(!ran.load(Ordering::SeqCst) && (!late || call > 0))
        };
        let all = paths.lock.clone();
        let key = paths.key_lock.clone();
        let cleanup = move || {
            assert!(
                !exclusive(&all),
                "plain cleanup must exclude migration/erase"
            );
            assert!(File::open(&all).unwrap().try_lock_shared().is_ok());
            assert!(File::open(&key).unwrap().try_lock_shared().is_err());
            assert!(!completed.swap(true, Ordering::SeqCst));
            Ok(())
        };
        let _instance = boot(
            &paths,
            Some(Slots {
                continuity: None,
                finish: None,
                inventory: None,
                pending: Box::new(pending),
                cleanup: Some(Box::new(cleanup)),
                wait: WAIT,
            }),
            no_agents,
            || Ok(()),
        )
        .unwrap();
        assert!(
            ran.load(Ordering::SeqCst),
            "cleanup assertions must execute"
        );
    }
}

#[test]
fn erase_journal_borrows_exclusive_all_without_acquiring_other_key() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let pending = || Ok(false);
    let commit = || Ok(());
    let journal = Journal {
        commit: &commit,
        pending: &pending,
        admit: &|| Ok(()),
    };
    instance.begin(WIPE, Some(&journal)).unwrap();
    // It is legal to open the other K independently while A is exclusive;
    // the erase transaction itself must not acquire it, even shared.
    let other = paths_for(paths.lock.parent().unwrap(), OTHER_KEY).key_lock;
    let other = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(other)
        .unwrap();
    assert!(other.try_lock().is_ok());
    assert!(!exclusive(&paths.lock));
}

#[test]
fn pending_plain_releases_exclusive_key_before_waiting_for_all() {
    let (_dir, paths) = fixture();
    let all = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)
        .unwrap();
    let key = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.key_lock)
        .unwrap();
    key.lock_shared().unwrap();
    mark(&paths, false, false);
    let key_path = paths.key_lock.clone();
    HANDOFF.set(Some(Box::new(move || {
        // Initial K-exclusive cleanup try fails, after initial shared boot.
        drop(key);
        all.lock().unwrap();
        HANDOFF.set(Some(Box::new(move || {
            assert!(
                File::open(&key_path).unwrap().try_lock_shared().is_ok(),
                "K X released before A retry"
            );
            drop(all);
        })));
    })));
    let _instance = boot(&paths, None, no_agents, || Ok(())).unwrap();
    assert!(!paths.marker.exists());
}

#[test]
fn migration_observes_only_under_all_exclusive_without_taking_key() {
    let (dir, mut paths) = fixture();
    let old = dir.path().join("old");
    let new = dir.path().join("new");
    fs::create_dir(&old).unwrap();
    paths.moves = vec![(old, new.clone())];
    let observations = Cell::new(0);
    let pending = || {
        let call = observations.get();
        observations.set(call + 1);
        if call == 1 {
            assert!(!exclusive(&paths.lock));
            assert!(
                exclusive(&paths.key_lock),
                "migration callback never acquires K under A X"
            );
        }
        Ok(false)
    };
    let _instance = boot(
        &paths,
        Some(Slots {
            continuity: None,
            finish: None,
            inventory: None,
            pending: Box::new(pending),
            cleanup: None,
            wait: WAIT,
        }),
        no_agents,
        || panic!("no marker"),
    )
    .unwrap();
    assert!(new.exists() && observations.get() >= 2);
}

#[test]
fn ordinary_creator_excludes_migration_until_completion() {
    let (dir, paths) = fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let lease = instance.creator().unwrap();
    let old = dir.path().join("old");
    let new = dir.path().join("new");
    fs::create_dir(&old).unwrap();
    let all = OpenOptions::new().write(true).open(&paths.lock).unwrap();
    let inspected = Cell::new(false);
    assert!(legacy_identifier::migrate(
        &[(old.clone(), new.clone())],
        &[],
        &all,
        &paths.ownership,
        || {
            assert!(!exclusive(&paths.lock));
            Ok(false)
        }
    )
    .is_err());
    assert!(old.exists() && !new.exists());
    drop(lease);
    // The idle Instance still owns A S; native migration cannot steal it.
    drop(instance);
    legacy_identifier::migrate(&[(old, new.clone())], &[], &all, &paths.ownership, || {
        inspected.set(true);
        Ok(false)
    })
    .unwrap();
    assert!(new.exists() && inspected.get());
}
