//! The production Slots/Manager construction uses only injected fake OS storage here.
use super::*;
use crate::identity::IdentityHost;

fn manager(paths: &Paths) -> Manager {
    Manager::open(Some(paths.app_data.clone()), "default", false).unwrap()
}

#[test]
fn production_inventory_selection_boot_configuration_and_sign_out_are_bound() {
    for choices in [PLAIN, choices(true)] {
        let (_dir, paths) = fixture();
        let root = paths.plugin_inventory().unwrap();
        assert_eq!(
            root,
            paths
                .lock
                .parent()
                .unwrap()
                .join(format!(".{}", secrets::SERVICE))
        );
        assert!(!root.starts_with(&paths.app_data));
        assert!(!root.exists());
        assert!(paths.preflight_scope().unwrap().inventories.contains(&root));
        let vault = Vault::new(root);
        let instance = boot(
            &paths,
            Some(
                paths
                    .plugin_slots(&vault.root, vault.store.clone())
                    .unwrap(),
            ),
            no_agents,
            || panic!("no marker"),
        )
        .unwrap();
        assert_eq!(instance.plugin_inventory(), Some(vault.root.as_path()));
        let manager = instance.configure_plugin_secrets(manager(&paths), vault.store.clone());
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(vault.root.join("state.json")).unwrap()).unwrap();
        assert_eq!(state["installation"]["committed"], true);
        assert_eq!(state["signedOutSeen"], 0);
        let witness = vault.saved();
        assert_eq!(witness.len(), 1);
        // Install via the existing fixture, then use the Manager returned by the production adapter.
        vault.enroll(&paths.app_data, "default", &[]);
        let revision = manager
            .catalog()
            .unwrap()
            .plugins
            .into_iter()
            .find(|p| p.manifest.id == PLUGIN)
            .unwrap()
            .revision;
        let identity = IdentityHost::fixture();
        let viewer = identity.current_viewer().unwrap().unwrap();
        manager
            .secret_set(
                PLUGIN,
                &revision,
                "api-key",
                &viewer,
                "FAKE-CALLER",
                &|| true,
            )
            .unwrap();
        run(attempt_native(
            &instance,
            &paths,
            choices,
            instance.plugin_inventory(),
            &identity,
            || async { Ok(()) },
            || {},
            || async { Ok(()) },
            || async { panic!("no forced exit") },
        ))
        .unwrap();
        assert!(vault.pending());
        drop(instance);
        let instance = boot(
            &paths,
            Some(
                paths
                    .plugin_slots(&vault.root, vault.store.clone())
                    .unwrap(),
            ),
            |_| Ok(()),
            || Ok(()),
        )
        .unwrap();
        let _manager = instance.configure_plugin_secrets(manager, vault.store.clone());
        assert!(!instance.h1_unknown());
        assert!(!vault.pending());
        assert_eq!(vault.saved(), witness);
    }
}

#[test]
fn production_configuration_refuses_preexisting_v3_and_late_count_uncertainty() {
    for prior in [true, false] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        if prior {
            vault.enroll(&paths.app_data, "default", &[ALICE]);
        }
        let instance = boot(
            &paths,
            Some(
                paths
                    .plugin_slots(&vault.root, vault.store.clone())
                    .unwrap(),
            ),
            no_agents,
            || panic!("no marker"),
        )
        .unwrap();
        if !prior {
            fs::write(vault.root.join("state.json"), b"broken").unwrap();
        }
        let before = fs::read(vault.root.join("state.json")).unwrap();
        vault.calls();
        let manager = instance.configure_plugin_secrets(manager(&paths), vault.store.clone());
        assert!(instance.h1_unknown());
        assert!(
            manager.credential_cleanup_status().is_err(),
            "unqualified Manager must have no store/root"
        );
        assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
        assert!(vault.calls().is_empty());
        assert!(!paths.marker.exists());
    }
}

#[test]
fn unreadable_inventory_without_marker_must_disable_custody_not_ordinary_launch() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    fs::create_dir(&vault.root).unwrap();
    fs::write(vault.root.join("state.json"), b"broken").unwrap();
    let result = boot(
        &paths,
        Some(
            paths
                .plugin_slots(&vault.root, vault.store.clone())
                .unwrap(),
        ),
        no_agents,
        || panic!("no marker"),
    );
    assert!(
        result.is_ok(),
        "unreadable inventory without a marker must preserve ordinary launch"
    );
    let instance = result.unwrap();
    assert!(instance.h1_unknown());
    assert!(instance.plugin_inventory().is_none());
    assert!(vault.calls().is_empty());
}

#[test]
fn unreadable_inventory_with_real_marker_still_fences_before_os_or_destructive_work() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    fs::create_dir(&vault.root).unwrap();
    fs::write(vault.root.join("state.json"), b"broken").unwrap();
    mark(&paths, false, false);
    assert!(boot(
        &paths,
        Some(
            paths
                .plugin_slots(&vault.root, vault.store.clone())
                .unwrap()
        ),
        no_agents,
        || panic!("must not delete key")
    )
    .is_err());
    assert!(paths.marker.exists());
    assert!(vault.calls().is_empty());
}

#[test]
fn second_pending_check_preserves_new_uncertainty_and_committed_cleanup() {
    for outcome in ["unknown", "marker", "journal"] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        if outcome == "marker" {
            mark(&paths, false, false);
        }
        let checks = Cell::new(0);
        let mut slots = paths
            .plugin_slots(&vault.root, vault.store.clone())
            .unwrap();
        slots.pending = Box::new(|| {
            checks.set(checks.get() + 1);
            if checks.get() == 1 {
                return Ok(false);
            }
            if outcome == "journal" {
                secrets::begin_sign_out(&vault.root, Some(ALICE), None)?;
                return secrets::sign_out_pending(&vault.root);
            }
            Err("Injected second-check uncertainty".into())
        });
        let result = boot(&paths, Some(slots), no_agents, || {
            panic!("must not remove key")
        });
        assert!(
            checks.get() >= 2,
            "the fresh second check must actually run"
        );
        if outcome == "unknown" {
            let instance = result.unwrap();
            assert!(instance.h1_unknown());
            assert!(instance.plugin_inventory().is_none());
            assert!(!vault.root.exists());
        } else {
            assert!(result.is_err());
            if outcome == "marker" {
                assert!(paths.marker.exists());
            } else {
                assert!(
                    vault.pending(),
                    "late committed debt must remain for deliberate cleanup"
                );
                let calls = vault.calls();
                assert!(
                    calls.iter().all(|call| call.starts_with("read ")),
                    "legacy debt must not acquire or repair a witness: {calls:?}"
                );
                // The next deliberate launch completes cleanup, leaving exact E,
                // before its single fresh witness add.
                let (stalled, entered) = mpsc::channel();
                let (release, released) = mpsc::channel();
                *vault.store.add_stall.lock().unwrap() = Some((stalled, released));
                let launched = std::thread::scope(|scope| {
                    let launch = scope.spawn(|| {
                        let instance = boot(
                            &paths,
                            Some(
                                paths
                                    .plugin_slots(&vault.root, vault.store.clone())
                                    .unwrap(),
                            ),
                            no_agents,
                            || panic!("no marker"),
                        )
                        .unwrap();
                        (instance.h1_unknown(), instance.plugin_inventory().is_some())
                    });
                    assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
                    assert!(!vault.pending());
                    let state: serde_json::Value =
                        serde_json::from_slice(&fs::read(vault.root.join("state.json")).unwrap())
                            .unwrap();
                    assert_eq!(state["namespaces"], serde_json::json!([]));
                    assert!(state.get("signedOutSeen").is_none() && state.get("journal").is_none());
                    assert_eq!(state["installation"]["committed"], false);
                    release.send(()).unwrap();
                    launch.join().unwrap()
                });
                assert_eq!(launched, (false, true));
                let state: serde_json::Value =
                    serde_json::from_slice(&fs::read(vault.root.join("state.json")).unwrap())
                        .unwrap();
                let installation = &state["installation"];
                assert_eq!(installation["committed"], true);
                let id = installation["installation"]["id"].as_str().unwrap();
                assert!(uuid::Uuid::parse_str(id).is_ok());
                assert_eq!(vault.saved().len(), 1);
                let calls = vault.calls();
                assert_eq!(
                    calls.iter().filter(|call| call.starts_with("add ")).count(),
                    1,
                    "{calls:?}"
                );
                continue;
            }
        }
        assert!(
            vault.calls().is_empty(),
            "no witness operation after journal uncertainty"
        );
    }
}

#[test]
fn production_remove_after_interrupted_setup_restarts_into_a_usable_fresh_manager() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let slots = || {
        paths
            .plugin_slots(&vault.root, vault.store.clone())
            .unwrap()
    };
    // Interrupted at its witness save, twice: once fresh, once after cancelling.
    *vault.store.add_denied.lock().unwrap() = true;
    drop(boot(&paths, Some(slots()), no_agents, || panic!("no marker")).unwrap());
    let instance = boot(&paths, Some(slots()), no_agents, || panic!("no marker")).unwrap();
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.h1_unknown() && instance.partial);
    let unqualified = instance.configure_plugin_secrets(manager(&paths), vault.store.clone());
    assert!(unqualified.credential_cleanup_status().is_err());
    let identity = IdentityHost::fixture();
    vault.calls();
    run(attempt_native(
        &instance,
        &paths,
        PLAIN,
        instance.plugin_inventory(),
        &identity,
        || async { Ok(()) },
        || {},
        || async { Ok(()) },
        || async { panic!("no forced exit") },
    ))
    .unwrap();
    assert!(paths.marker.exists());
    assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));
    drop((unqualified, instance));
    let removed = Cell::new(0);
    let instance = boot(&paths, Some(slots()), no_agents, || {
        removed.set(removed.get() + 1);
        Ok(())
    })
    .unwrap();
    assert_eq!(removed.get(), 1);
    assert!(!paths.marker.exists());
    assert!(!instance.h1_unknown());
    assert_eq!(instance.plugin_inventory(), Some(vault.root.as_path()));
    assert_eq!(vault.saved().len(), 1);
    let manager = instance.configure_plugin_secrets(manager(&paths), vault.store.clone());
    vault.enroll(&paths.app_data, "default", &[]);
    let revision = manager
        .catalog()
        .unwrap()
        .plugins
        .into_iter()
        .find(|p| p.manifest.id == PLUGIN)
        .unwrap()
        .revision;
    let viewer = identity.current_viewer().unwrap().unwrap();
    let status = || {
        manager
            .secret_status(PLUGIN, &revision, "api-key", &viewer)
            .unwrap()
    };
    manager
        .secret_set(PLUGIN, &revision, "api-key", &viewer, "FAKE-LATER", &|| {
            true
        })
        .unwrap();
    assert_eq!(status(), secrets::SecretStatus::Saved);
    manager
        .secret_clear(PLUGIN, &revision, "api-key", &viewer)
        .unwrap();
    assert_eq!(status(), secrets::SecretStatus::Missing);
}
