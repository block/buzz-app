//! Concrete native adapters with injected fake stores and temporary roots.
use super::super::creators::{exclusive, released_lock};
use super::*;
use crate::identity::IdentityHost;

fn ready(vault: &Vault, home: &Path) -> (Manager, String) {
    vault.enroll(home, "default", &[]);
    let manager = Manager::open(Some(home.to_owned()), "default", false)
        .unwrap()
        .with_secret_storage(vault.root.clone(), vault.store.clone());
    let revision = manager
        .catalog()
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == PLUGIN)
        .unwrap()
        .revision;
    (manager, revision)
}
fn set(
    instance: &Instance,
    manager: Manager,
    identity: IdentityHost,
    revision: String,
    wait: Duration,
) -> Result<(), String> {
    let snapshot = identity.current_viewer().unwrap().unwrap();
    instance.set_secret(
        manager,
        identity,
        snapshot,
        PLUGIN.into(),
        revision,
        "api-key".into(),
        zeroize::Zeroizing::new("sk-fixture".into()),
        Arc::new(|| true),
        wait,
    )
}
fn creators_done(instance: &Instance) {
    let start = Instant::now();
    while instance.shared.gate.lock().unwrap().active != 0 {
        assert!(start.elapsed() < LIMIT, "creator did not complete");
        std::thread::yield_now();
    }
}

#[test]
fn concrete_set_timeout_keeps_both_key_modes_through_add_and_own_cleanup() {
    for service in ["identity", OTHER_KEY] {
        for choices in [PLAIN, WIPE] {
            for failed_add in [false, true] {
                let (dir, _) = fixture();
                let paths = paths_for(dir.path(), service);
                let vault = Vault::new(dir.path().join("inventory"));
                let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
                let identity = IdentityHost::fixture();
                let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
                let (started, at_add) = mpsc::channel();
                let (release, released) = mpsc::channel();
                *vault.store.add_stall.lock().unwrap() = Some((started, released));
                *vault.store.add_denied.lock().unwrap() = failed_add;
                let (cleanup, at_cleanup) = mpsc::channel();
                let (finish, finished) = mpsc::channel();
                *vault.store.stall.lock().unwrap() = Some((cleanup, finished));
                assert_eq!(
                    set(
                        &instance,
                        manager.clone(),
                        identity.clone(),
                        revision,
                        BRIEFLY
                    ),
                    Err(SAVING.into())
                );
                assert_eq!(at_add.recv_timeout(LIMIT).unwrap(), Step::Stalled);
                assert!(vault.root.exists(), "intent established before fake add");
                assert_eq!(instance.begin(choices, None), Err(refuse(SAVING)));
                assert!(!exclusive(&paths.key_lock));
                assert!(!exclusive(&paths.other_key_lock));
                assert!(!exclusive(&paths.lock));
                // Ineligible completion must clean up its own account, still admitted.
                identity.close();
                release.send(()).unwrap();
                assert_eq!(at_cleanup.recv_timeout(LIMIT).unwrap(), Step::Stalled);
                assert_eq!(instance.begin(choices, None), Err(refuse(SAVING)));
                assert!(!exclusive(&paths.other_key_lock));
                finish.send(()).unwrap();
                creators_done(&instance);
                assert_eq!(instance.begin(choices, None), Ok(()));
                assert_eq!(
                    vault
                        .calls()
                        .iter()
                        .filter(|call| call.starts_with("add "))
                        .count(),
                    1
                );
                assert!(vault.saved().is_empty());
            }
        }
    }
}

#[test]
fn set_worker_outlives_dropped_caller_and_instance_and_finishes_successfully() {
    let (dir, paths) = fixture();
    let vault = Vault::new(dir.path().join("inventory"));
    let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let (started, at_add) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *vault.store.add_stall.lock().unwrap() = Some((started, released));
    let shared = instance.shared.clone();
    assert_eq!(
        set(
            &instance,
            manager,
            IdentityHost::fixture(),
            revision,
            BRIEFLY
        ),
        Err(SAVING.into())
    );
    at_add.recv_timeout(LIMIT).unwrap();
    drop(instance);
    assert!(!exclusive(&paths.key_lock));
    assert!(!exclusive(&paths.lock));
    assert!(!exclusive(&paths.other_key_lock));
    release.send(()).unwrap();
    let start = Instant::now();
    while shared.gate.lock().unwrap().active != 0 {
        assert!(start.elapsed() < LIMIT);
        std::thread::yield_now();
    }
    drop(shared);
    assert_eq!(vault.saved().len(), 1);
    released_lock(&paths.key_lock);
    released_lock(&paths.lock);
}

#[test]
fn native_set_refuses_other_key_before_inventory_establishment() {
    let (dir, paths) = fixture();
    let vault = Vault::new(dir.path().join("inventory"));
    let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let other = boot(&paths_for(dir.path(), OTHER_KEY), None, no_agents, || {
        panic!("no marker")
    })
    .unwrap();
    other.begin(PLAIN, None).unwrap();
    assert!(set(
        &instance,
        manager,
        IdentityHost::fixture(),
        revision,
        BRIEFLY
    )
    .is_err());
    assert!(!vault.root.exists());
    assert!(vault.calls().is_empty());
}

#[test]
fn native_journal_adapter_borrows_modes_and_preserves_cancelled_commit() {
    for choices in [PLAIN, WIPE] {
        let (dir, paths) = fixture();
        let root = dir.path().join("inventory");
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let identity = IdentityHost::fixture();
        let mut attempt = Box::pin(attempt_native(
            &instance,
            &paths,
            choices,
            Some(&root),
            &identity,
            || async { Ok(()) },
            || identity.close(),
            std::future::pending::<Result<(), String>>,
            || std::future::ready(Err(refuse("exited"))),
        ));
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(attempt.as_mut().poll(&mut cx).is_pending());
        drop(attempt);
        assert!(paths.marker.exists());
        assert!(secrets::sign_out_pending(&root).unwrap());
        assert!(held_alone(&paths.key_lock));
        assert_eq!(instance.begin(choices, None), Err(refuse(ALREADY)));
    }
}

#[test]
fn confirmed_missing_identity_erase_journals_but_unread_identity_refuses_without_commit() {
    for readable in [false, true] {
        let (dir, paths) = fixture();
        let root = dir.path().join("inventory");
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let identity = IdentityHost::fixture_without_key(readable);
        let result = run(attempt_native(
            &instance,
            &paths,
            WIPE,
            Some(&root),
            &identity,
            || async { Ok(()) },
            || {},
            || std::future::ready(Ok(())),
            || async { panic!("no forced exit for confirmed absence or pre-admission refusal") },
        ));
        if readable {
            assert_eq!(result, Ok(()));
            assert!(secrets::sign_out_pending(&root).unwrap());
        } else {
            assert_eq!(result, Err(refuse(IDENTITY_UNAVAILABLE)));
            assert!(!root.exists() && !paths.marker.exists());
        }
    }
}

#[test]
fn native_adapter_partial_commit_and_marker_failure_stay_fenced_for_retry() {
    for choices in [PLAIN, WIPE] {
        for marker_fails in [false, true] {
            let (dir, mut paths) = fixture();
            let vault = Vault::new(paths.lock.parent().unwrap().join("inventory"));
            let identity = IdentityHost::fixture();
            let viewer = identity.current_viewer().unwrap().unwrap();
            // Qualify before same-launch evidence; no pre-existing v3 witness.
            let instance = boot(&paths, Some(vault.slots(BUDGET)), no_agents, || {
                panic!("no marker")
            })
            .unwrap();
            vault.enroll(&paths.app_data, "default", &[&viewer]);
            if marker_fails {
                paths.marker = dir.path().join("missing/marker");
            } else {
                fs::write(vault.record(), "{bad").unwrap();
            }
            let exited = Cell::new(false);
            assert_eq!(
                run(attempt_native(
                    &instance,
                    &paths,
                    choices,
                    Some(&vault.root),
                    &identity,
                    || async { Ok(()) },
                    || identity.close(),
                    || std::future::ready(Ok(())),
                    || async {
                        exited.set(true);
                        Err(refuse("exited"))
                    }
                )),
                Err(refuse("exited"))
            );
            assert!(exited.get() && vault.pending());
            assert!(held_alone(&paths.key_lock));
            assert_eq!(instance.begin(PLAIN, None), Err(refuse(ALREADY)));
            assert!(
                !paths.marker.exists(),
                "journal does not invent destructive authority"
            );
        }
    }
}

#[test]
fn unread_identity_after_handoff_refuses_before_native_journal_admission() {
    let (dir, paths) = fixture();
    let root = dir.path().join("inventory");
    let identity = IdentityHost::fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let same = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let closing = identity.clone();
    HANDOFF.set(Some(Box::new(move || {
        closing.close();
        drop(same);
    })));
    let pending = || secrets::sign_out_pending(&root);
    let journal = Journal {
        commit: &|| Ok(()),
        pending: &pending,
        admit: &|| Ok(()),
    };
    // Initial same-key upgrade refuses; identity changes during handoff.
    assert_eq!(instance.begin(PLAIN, Some(&journal)), Err(refuse(OTHERS)));
    assert_eq!(
        run(attempt_native(
            &instance,
            &paths,
            PLAIN,
            Some(&root),
            &identity,
            || async { Ok(()) },
            || {},
            || std::future::ready(Ok(())),
            || async { panic!("no commit") }
        )),
        Err(refuse(IDENTITY_UNAVAILABLE))
    );
    assert!(!root.exists() && !paths.marker.exists());
}

#[test]
fn post_begin_identity_change_fences_before_journal_and_keeps_owned_modes() {
    for choices in [PLAIN, WIPE] {
        let (dir, paths) = fixture();
        let root = dir.path().join("inventory");
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let identity = IdentityHost::fixture();
        let changed = identity.clone();
        super::super::creators::BEFORE_COMMIT.set(Some(Box::new(move || changed.close())));
        let exited = Cell::new(false);
        assert_eq!(
            run(attempt_native(
                &instance,
                &paths,
                choices,
                Some(&root),
                &identity,
                || async { Ok(()) },
                || {},
                || std::future::ready(Ok(())),
                || async {
                    exited.set(true);
                    Err(refuse("exited"))
                }
            )),
            Err(refuse("exited"))
        );
        assert!(exited.get());
        assert!(!root.exists() && !paths.marker.exists());
        assert!(held_alone(&paths.key_lock));
        assert_eq!(instance.begin(choices, None), Err(refuse(ALREADY)));
    }
}

#[test]
fn observe_blocked_on_manager_global_holds_creator_lease_until_save_returns() {
    let (dir, paths) = fixture();
    let root = dir.path().join("inventory");
    fs::create_dir(&root).unwrap();
    let global = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(root.join("state.lock"))
        .unwrap();
    global.lock().unwrap();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    std::thread::scope(|scope| {
        let observing = scope.spawn(|| instance.observe_sign_outs(Some(&root)));
        let start = Instant::now();
        while instance.shared.gate.lock().unwrap().active == 0 {
            assert!(start.elapsed() < LIMIT);
            std::thread::yield_now();
        }
        assert_eq!(instance.begin(PLAIN, None), Err(refuse(SAVING)));
        assert!(!exclusive(&paths.other_key_lock));
        drop(global);
        observing.join().unwrap().unwrap();
    });
    assert!(root.join("state.json").exists());
    assert_eq!(instance.begin(PLAIN, None), Ok(()));
}

#[test]
fn unknown_boot_cannot_establish_via_set_or_finished_count_observation() {
    for error in [false, true] {
        let (dir, paths) = fixture();
        let profiles = paths.app_data.join("profiles");
        fs::create_dir(&profiles).unwrap();
        let stray = profiles.join("stray");
        fs::write(&stray, "not a profile").unwrap();
        super::super::preflight::INJECT_ERROR.set(error);
        let launched = boot(&paths, None, no_agents, || panic!("no marker"));
        super::super::preflight::INJECT_ERROR.set(false);
        let instance = launched.unwrap();
        assert!(instance.h1_unknown);
        fs::remove_file(stray).unwrap();
        assert!(
            paths.preflight().is_ok(),
            "later clean scan cannot clear sticky unknown"
        );
        let vault = Vault::new(dir.path().join("inventory"));
        let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
        assert!(!vault.root.exists());
        assert!(set(
            &instance,
            manager,
            IdentityHost::fixture(),
            revision,
            BUDGET
        )
        .is_err());
        assert!(instance.observe_sign_outs(Some(&vault.root)).is_err());
        assert!(!vault.root.exists(), "neither creator may first-establish");
        assert!(vault.saved().is_empty(), "zero fake OS adds");
    }
}

#[test]
fn unknown_boot_refuses_native_journal_before_first_inventory_establishment() {
    let (dir, paths) = fixture();
    fs::create_dir(paths.app_data.join("profiles")).unwrap();
    fs::write(paths.app_data.join("profiles/stray"), "not a profile").unwrap();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let vault = Vault::new(dir.path().join("inventory"));
    let identity = IdentityHost::fixture();
    assert_eq!(
        run(attempt_native(
            &instance,
            &paths,
            PLAIN,
            Some(&vault.root),
            &identity,
            || async { Ok(()) },
            || panic!("no closure"),
            || async { panic!("no shutdown") },
            || async { panic!("no exit") }
        )),
        Err(refuse(H1_UNKNOWN))
    );
    assert!(!paths.marker.exists() && !vault.root.exists());
    assert!(vault.saved().is_empty());
}

#[test]
fn reviewer_prepare_only_unknown_must_block_all_native_creators() {
    let mut escaped = Vec::new();
    for operation in ["set", "count", "journal"] {
        let (dir, paths) = fixture();
        let vault = Vault::new(dir.path().join("inventory"));
        let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
        let identity = IdentityHost::fixture();
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        super::super::preflight::INJECT_ERROR.set(true);
        let refusal = run(attempt(
            &instance,
            &paths,
            PLAIN,
            || async { Ok(()) },
            None,
            || panic!("no closure on initial refusal"),
            || async { panic!("no shutdown on initial refusal") },
            || async { panic!("no exit on initial refusal") },
        ));
        super::super::preflight::INJECT_ERROR.set(false);
        assert_eq!(refusal, Err(refuse(H1_UNKNOWN)));
        assert!(paths.preflight().is_ok());
        assert!(!vault.root.exists());
        let accepted = match operation {
            "set" => set(&instance, manager, identity, revision, BUDGET).is_ok(),
            "count" => instance.observe_sign_outs(Some(&vault.root)).is_ok(),
            "journal" => run(attempt_native(
                &instance,
                &paths,
                PLAIN,
                Some(&vault.root),
                &identity,
                || async { Ok(()) },
                || {},
                || async { Ok(()) },
                || async { panic!("no fenced failure") },
            ))
            .is_ok(),
            _ => unreachable!(),
        };
        eprintln!("reviewer evidence: operation={operation}, accepted={accepted}, inventory={}, saved_fake_accounts={}, marker={}",
            vault.root.exists(), vault.saved().len(), paths.marker.exists());
        if accepted || vault.root.exists() || !vault.saved().is_empty() {
            escaped.push(operation);
        }
    }
    assert!(
        escaped.is_empty(),
        "prepare-only uncertainty granted creator permission: {escaped:?}"
    );
}

thread_local! {
    static PHASES: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}
pub(crate) fn phase(name: &'static str) {
    PHASES.with_borrow_mut(|phases| phases.push(name));
}
fn negative_slots(root: &Path) -> Slots<'_> {
    Slots {
        continuity: None,
        finish: None,
        inventory: Some(root),
        pending: Box::new(|| secrets::sign_out_pending(root)),
        cleanup: None,
        wait: BUDGET,
    }
}
fn launch(paths: &Paths, root: &Path) -> Instance {
    let no_key = || panic!("no key");
    boot(paths, Some(negative_slots(root)), no_agents, no_key).unwrap()
}
pub(super) fn bytes(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    if root.is_dir() {
        for entry in fs::read_dir(root).unwrap() {
            found.extend(bytes(&entry.unwrap().path()));
        }
    } else if root.is_file() {
        found.push((root.to_owned(), fs::read(root).unwrap()));
    }
    found.sort();
    found
}
fn unavailable(instance: &Instance, paths: &Paths, root: &Path) {
    assert!(instance.h1_unknown());
    assert_eq!(instance.creator().err().as_deref(), Some(H1_UNKNOWN));
    assert_eq!(
        instance.observe_sign_outs(Some(root)),
        Err(H1_UNKNOWN.into())
    );
    assert_eq!(
        run(attempt_native(
            instance,
            paths,
            PLAIN,
            Some(root),
            &IdentityHost::fixture(),
            || async { Ok(()) },
            || panic!("no close"),
            || async { panic!("no shutdown") },
            || async { panic!("no exit") }
        )),
        Err(refuse(H1_UNKNOWN))
    );
}

#[test]
fn h1_2di_some_slots_absence_legacy_and_unknown_matrix() {
    for case in "absent legacy copied-v3 lost corrupt unknown foreign both".split_whitespace() {
        let (_dir, paths) = fixture();
        let scope = paths.preflight_scope().unwrap();
        let root = &scope.inventories[0];
        let registry = paths.app_data.join("profiles/default/registry.json");
        if matches!(
            case,
            "legacy" | "copied-v3" | "lost" | "corrupt" | "unknown"
        ) {
            fs::create_dir_all(registry.parent().unwrap()).unwrap();
            let text = match case {
                "legacy" => r#"{"version":2,"bundledEnabled":true,"installed":{}}"#,
                "copied-v3" | "lost" => {
                    r#"{"version":3,"bundledEnabled":true,"installed":{},"secrets":{"lineage":"11111111-1111-4111-8111-111111111111","variant":"debug"}}"#
                }
                "unknown" => r#"{"version":4,"installed":{}}"#,
                _ => "broken",
            };
            fs::write(&registry, text).unwrap();
        }
        if matches!(case, "foreign" | "both") {
            secrets::observe_sign_outs(&scope.inventories[1], 7).unwrap();
        }
        if matches!(case, "both" | "lost") {
            fs::create_dir(root).unwrap();
        }
        let before = bytes(_dir.path());
        let instance = launch(&paths, root);
        if matches!(case, "absent" | "legacy") {
            assert!(!instance.h1_unknown(), "{case}");
            instance.observe_sign_outs(Some(root)).unwrap();
            assert!(instance.creator().is_ok());
            assert!(!secrets::sign_out_pending(root).unwrap());
        } else {
            unavailable(&instance, &paths, root);
            let after: Vec<_> = bytes(_dir.path())
                .into_iter()
                .filter(|(p, _)| !p.to_string_lossy().ends_with("instance.lock"))
                .collect();
            assert_eq!(after, before, "no evidence write: {case}");
        }
        assert!(!paths.marker.exists());
    }
}

#[test]
fn h1_2di_present_inventory_without_witness_held_for_2d_ii() {
    // HELD FOR 2d-ii: even readable count-only/zero history is not a witness.
    let (_dir, paths) = fixture();
    let root = paths.lock.parent().unwrap().join("injected-not-fixed");
    secrets::observe_sign_outs(&root, 0).unwrap();
    let before = bytes(&root);
    let instance = launch(&paths, &root);
    unavailable(&instance, &paths, &root);
    assert_eq!(bytes(&root), before);
    drop(instance);
    let vault = Vault::new(root.clone());
    vault.enroll(&paths.app_data, "default", &[ALICE]);
    let before = bytes(&root);
    unavailable(&launch(&paths, &root), &paths, &root);
    assert_eq!(
        bytes(&root),
        before,
        "pre-existing v3 cannot start a new journal"
    );
    assert!(vault.calls().iter().all(|call| call.starts_with("add ")));
}

#[test]
fn h1_2di_pending_read_unknown_is_ordinary_but_marker_is_conservative() {
    for marker in [false, true] {
        let (_dir, paths) = fixture();
        let root = paths.lock.parent().unwrap().join("inventory");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("state.json"), "broken").unwrap();
        if marker {
            mark(&paths, false, false);
        }
        let before = bytes(&root);
        let result = boot(&paths, Some(negative_slots(&root)), no_agents, || {
            panic!("no key")
        });
        if marker {
            assert!(result.is_err());
            assert!(paths.marker.exists());
        } else {
            unavailable(&result.unwrap(), &paths, &root);
        }
        assert_eq!(bytes(&root), before);
    }
}

#[test]
fn h1_2di_other_key_busy_then_release_does_not_retry_or_restore() {
    for service in ["identity", OTHER_KEY] {
        let (dir, _) = fixture();
        let paths = paths_for(dir.path(), service);
        let root = paths.lock.parent().unwrap().join("inventory");
        let instance = launch(&paths, &root);
        assert!(
            !instance.h1_unknown(),
            "busy refusal must be newly observed"
        );
        let other = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&paths.other_key_lock)
            .unwrap();
        other.lock().unwrap();
        assert!(instance.observe_sign_outs(Some(&root)).is_err());
        assert!(!root.exists(), "busy refused before metadata establishment");
        drop(other);
        unavailable(&instance, &paths, &root);
        assert!(!root.exists(), "release is not an unattended retry");
    }
}

#[test]
fn h1_2di_count_metadata_entry_error_retains_evidence_and_latches() {
    let (_dir, paths) = fixture();
    let root = paths.lock.parent().unwrap().join("inventory");
    let instance = launch(&paths, &root);
    assert!(
        !instance.h1_unknown(),
        "qualification must precede injected metadata error"
    );
    fs::create_dir(&root).unwrap();
    fs::write(
        root.join("state.json"),
        serde_json::to_vec(
            &serde_json::json!({"version":1,"namespaces":["a".repeat(64)],"signedOutSeen":9}),
        )
        .unwrap(),
    )
    .unwrap();
    let before = bytes(&root);
    assert!(instance.observe_sign_outs(Some(&root)).is_err());
    assert!(root.join("state.lock").exists(), "metadata was entered");
    assert_eq!(fs::read(&before[0].0).unwrap(), before[0].1);
    fs::remove_file(root.join("state.json")).unwrap();
    unavailable(&instance, &paths, &root);
    assert!(!root.join("state.json").exists(), "no retry after error");
}

#[test]
fn h1_2di_both_clean_and_after_c_schedules_are_symmetric() {
    for reverse in [false, true] {
        for first_count_before_second_c in [false, true] {
            let (dir, _) = fixture();
            let paths = [
                paths_for(dir.path(), "identity"),
                paths_for(dir.path(), OTHER_KEY),
            ];
            let roots = paths[0].preflight_scope().unwrap().inventories;
            let (a, b) = if reverse { (1, 0) } else { (0, 1) };
            let first = launch(&paths[a], &roots[a]);
            if first_count_before_second_c {
                first.observe_sign_outs(Some(&roots[a])).unwrap();
                let second = launch(&paths[b], &roots[b]);
                unavailable(&second, &paths[b], &roots[b]);
                assert!(!roots[b].exists(), "observed foreign evidence before C");
                assert!(first.creator().is_ok(), "no automatic recall after C");
            } else {
                let second = launch(&paths[b], &roots[b]);
                // Both clean C; publish in both orders, before/after the other's write.
                let order = [(&second, b), (&first, a)];
                for (instance, index) in order {
                    instance.observe_sign_outs(Some(&roots[index])).unwrap();
                }
                for (instance, root) in [(&first, &roots[a]), (&second, &roots[b])] {
                    assert!(!instance.h1_unknown());
                    assert!(instance.creator().is_ok());
                    let state: serde_json::Value =
                        serde_json::from_slice(&fs::read(root.join("state.json")).unwrap())
                            .unwrap();
                    assert_eq!(state["signedOutSeen"], 0);
                    assert_eq!(state["namespaces"], serde_json::json!([]));
                    assert!(!secrets::sign_out_pending(root).unwrap());
                }
                drop(second);
            }
            assert!(!paths[a].marker.exists() && !paths[b].marker.exists());
            drop(first);
            let later = launch(&paths[a], &roots[a]);
            unavailable(&later, &paths[a], &roots[a]);
        }
    }
}

#[test]
fn h1_2di_prebegin_zero_phases_preserves_existing_bytes_and_exact_copy() {
    let (_dir, paths) = fixture();
    let root = paths.lock.parent().unwrap().join("inventory");
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    secrets::begin_sign_out(&root, Some(ALICE), None).unwrap();
    mark(&paths, false, false);
    let before = (bytes(&root), fs::read(&paths.marker).unwrap());
    PHASES.with_borrow_mut(Vec::clear);
    let result = run(attempt_native(
        &instance,
        &paths,
        PLAIN,
        Some(&root),
        &IdentityHost::fixture_without_key(false),
        || async { Ok(()) },
        || panic!("zero close"),
        || async { panic!("zero shutdown") },
        || async { panic!("zero exit") },
    ));
    assert_eq!(result, Err(refuse("Buzz couldn't start this sign-out request because your identity is busy or unavailable. Try again later.")));
    PHASES.with_borrow(|phases| assert!(phases.is_empty(), "zero begin/commit/marker: {phases:?}"));
    assert_eq!((bytes(&root), fs::read(&paths.marker).unwrap()), before);
    assert!(!instance.shared.gate.lock().unwrap().closed);
}

#[test]
fn h1_2di_postbegin_revalidation_is_fenced_with_exact_recorded_copy() {
    let (_dir, paths) = fixture();
    let root = paths.lock.parent().unwrap().join("inventory");
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    let identity = IdentityHost::fixture();
    let changed = identity.clone();
    super::super::creators::BEFORE_COMMIT.set(Some(Box::new(move || changed.close())));
    PHASES.with_borrow_mut(Vec::clear);
    let exited = Cell::new(0);
    let result = run(attempt_native(
        &instance,
        &paths,
        PLAIN,
        Some(&root),
        &identity,
        || async { Ok(()) },
        || {},
        || async { panic!("no shutdown") },
        || async {
            exited.set(exited.get() + 1);
            Err(fenced())
        },
    ));
    assert_eq!(result, Err(Failure { message: "Buzz couldn't confirm whether this sign-out request was recorded. Open Buzz again to check for pending sign-out work.".into(), fenced: true, finish_setup: false }));
    assert_eq!(exited.get(), 1);
    PHASES.with_borrow(|phases| assert_eq!(phases, &["begin", "commit"]));
    assert!(!root.exists() && !paths.marker.exists());
    assert!(held_alone(&paths.key_lock));
    assert_eq!(instance.begin(PLAIN, None), Err(refuse(ALREADY)));
}

#[test]
fn h1_2di_owned_journal_only_settles_current_not_foreign_inventory() {
    let (_dir, paths) = fixture();
    let roots = paths.preflight_scope().unwrap().inventories;
    let current = Vault::new(roots[0].clone());
    let foreign = Vault::new(roots[1].clone());
    current.enroll(&paths.app_data, "default", &[ALICE]);
    foreign.enroll(&paths.app_data, "other", &[BOB]);
    secrets::begin_sign_out(&current.root, Some(ALICE), None).unwrap();
    let before = bytes(&foreign.root);
    let instance = boot(&paths, Some(current.slots(BUDGET)), no_agents, || {
        panic!("journal is not a marker")
    })
    .unwrap();
    assert!(!current.pending() && current.saved().is_empty());
    assert_eq!(current.attempts(), 1);
    assert_eq!(bytes(&foreign.root), before);
    assert_eq!(foreign.saved().len(), 1);
    unavailable(&instance, &paths, &current.root);
    assert!(!paths.marker.exists());
}

#[test]
fn native_set_cancelled_attempt_cannot_promote_with_the_same_viewer() {
    use std::sync::atomic::AtomicBool;
    for deny_cleanup in [false, true] {
        let (dir, paths) = fixture();
        let vault = Vault::new(dir.path().join("inventory"));
        let (manager, revision) = ready(&vault, &dir.path().join("plugins"));
        let identity = IdentityHost::fixture();
        let snapshot = identity.current_viewer().unwrap().unwrap();
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let (started, at_add) = mpsc::channel();
        let (release, released) = mpsc::channel();
        *vault.store.add_stall.lock().unwrap() = Some((started, released));
        if deny_cleanup {
            *vault.store.deny.lock().unwrap() = Some(StoreError::Denied);
        }
        let current = Arc::new(AtomicBool::new(true));
        let attempt = current.clone();
        assert_eq!(
            instance.set_secret(
                manager.clone(),
                identity.clone(),
                snapshot.clone(),
                PLUGIN.into(),
                revision.clone(),
                "api-key".into(),
                zeroize::Zeroizing::new("sk-fixture".into()),
                Arc::new(move || attempt.load(Ordering::SeqCst)),
                BRIEFLY,
            ),
            Err(SAVING.into())
        );
        at_add.recv_timeout(LIMIT).unwrap();
        current.store(false, Ordering::SeqCst);
        release.send(()).unwrap();
        creators_done(&instance);
        assert_eq!(
            identity.current_viewer().unwrap().as_deref(),
            Some(snapshot.as_str())
        );
        assert_eq!(
            manager
                .secret_status(PLUGIN, &revision, "api-key", &snapshot)
                .unwrap(),
            buzzodz_plugins::SecretStatus::Missing
        );
        assert_eq!(vault.saved().len(), usize::from(deny_cleanup));
        assert_eq!(
            manager.credential_cleanup_status().unwrap().pending,
            usize::from(deny_cleanup)
        );
    }
}
