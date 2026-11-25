use super::*;

fn evidence(home: &Path) -> PathBuf {
    let profile = home.join("profiles/not-selected");
    fs::create_dir_all(&profile).unwrap();
    let registry = profile.join("registry.json");
    fs::write(&registry, b"unreadable evidence").unwrap();
    registry
}

#[test]
fn fallback_prepare_refuses_before_marker_closure_or_shutdown() {
    for wipe in [false, true] {
        let (_dir, paths) = fixture();
        evidence(&paths.app_data);
        let result = run(prepare(
            &paths,
            Choices {
                wipe,
                remove_agents: false,
            },
            || async { Ok(()) },
            Admission::Scanner,
            || panic!("must not close"),
            || async { panic!("must not stop") },
        ));
        assert!(result.is_err());
        assert!(!result.unwrap_err().fenced);
        assert!(!paths.marker.exists());
    }
}

#[test]
fn fallback_boot_refuses_before_destructive_cleanup() {
    for wipe in [false, true] {
        let (_dir, paths) = fixture();
        evidence(&paths.app_data);
        mark(&paths, wipe, wipe);
        let before = listing(paths.lock.parent().unwrap());
        assert!(boot(
            &paths,
            None,
            |_| panic!("no agent delete"),
            || panic!("no key delete")
        )
        .is_err());
        let mut after = data(paths.lock.parent().unwrap());
        let mut before: Vec<_> = before
            .into_iter()
            .filter(|s| !s.ends_with("instance.lock"))
            .collect();
        before.sort();
        after.sort();
        assert_eq!(after, before, "evidence and marker must remain");
    }
}

#[test]
fn fallback_boot_handoff_does_not_turn_unknown_into_an_ordinary_launch_veto() {
    let (_dir, paths) = fixture();
    mark(&paths, false, false);
    let home = paths.app_data.clone();
    HANDOFF.set(Some(Box::new(move || {
        evidence(&home);
    })));
    let removes = Cell::new(0);
    let result = boot(&paths, None, no_agents, || {
        removes.set(removes.get() + 1);
        Ok(())
    });
    assert!(result.is_ok(), "ordinary launch must not be vetoed");
    assert!(paths.preflight().is_err(), "no affirmative H1 observation");
    assert_eq!(removes.get(), 1);
}

#[test]
fn fixed_candidates_all_profiles_and_exact_deduplication() {
    use super::super::legacy_identifier::{CURRENT, DEV, LEGACY};
    let (temp, mut paths) = fixture();
    let base = fs::canonicalize(temp.path()).unwrap();
    paths.plugin_home = Some(base.join("env-home"));
    paths.seeds = vec![base.join("seed")];
    paths.moves = vec![
        (base.join("legacy"), base.join("new")),
        (base.join("old-marker"), paths.marker.clone()),
    ];
    let scope = paths.preflight_scope().unwrap();
    assert_eq!(scope.inventories.len(), 2);
    for path in [
        &paths.app_data,
        paths.plugin_home.as_ref().unwrap(),
        &base.join("legacy"),
        &base.join("new"),
        &base.join("seed").join(DEV),
        &base.join("seed").join(CURRENT),
        &base.join("seed").join(LEGACY),
        &base.join("seed").join(format!("{DEV}.seeding")),
        &trash(&base.join("seed").join(format!("{DEV}.seeding"))),
    ] {
        assert!(scope.homes.contains(path), "missing {path:?}");
    }
    assert!(!scope.homes.contains(&paths.marker));
    assert!(!scope.homes.contains(&base.join("old-marker")));
    assert!(scope.homes.windows(2).all(|pair| pair[0] < pair[1]));
    for home in &scope.homes {
        let registry = evidence(home);
        assert!(paths.preflight().is_err(), "candidate {home:?}");
        fs::remove_file(registry).unwrap();
    }
    assert!(paths.preflight().is_ok());
    for inventory in scope.inventories {
        fs::create_dir(&inventory).unwrap();
        assert!(paths.preflight().is_err());
        fs::remove_dir(inventory).unwrap();
    }
    paths.plugin_home = Some("relative".into());
    assert!(paths.preflight().is_err());
}

#[test]
fn unknown_stray_or_error_does_not_veto_launch_moves_or_seeds() {
    use super::super::legacy_identifier::{CURRENT, DEV};
    for error in [false, true] {
        for operation in ["launch", "move", "seed", "agents"] {
            let (dir, mut paths) = fixture();
            let profiles = paths.app_data.join("profiles");
            fs::create_dir_all(&profiles).unwrap();
            fs::write(profiles.join("stray"), "not a profile").unwrap();
            if operation == "move" {
                paths = legacy(paths);
            }
            if operation == "seed" {
                paths.seeds = installed(dir.path(), CURRENT);
                let source = paths.seeds[1].join(CURRENT).join("profiles");
                fs::create_dir_all(&source).unwrap();
                fs::write(source.join("stray"), "not a profile").unwrap();
            }
            if operation == "agents" {
                fs::rename(
                    paths.app_data.join(AGENTS),
                    paths.app_data.join(migrate_agents::LEGACY),
                )
                .unwrap();
            }
            INJECT_ERROR.set(error);
            let before = paths.preflight();
            let result = boot(&paths, None, no_agents, || panic!("no key deletion"));
            let after = paths.preflight();
            INJECT_ERROR.set(false);
            assert!(
                before.is_err() && after.is_err(),
                "unknown is not clean: {operation}"
            );
            assert!(
                result.as_ref().unwrap().h1_unknown,
                "sticky unknown: {operation}"
            );
            if operation == "seed" {
                assert!(paths.seeds[1].join(DEV).join("profiles/stray").exists());
            }
            if operation == "move" {
                assert!(!paths.moves[1].0.exists());
            }
            if operation == "agents" {
                assert!(paths.app_data.join(AGENTS).exists());
            }
        }
    }
}

thread_local! { pub(crate) static INJECT_ERROR: Cell<bool> = const { Cell::new(false) }; }

#[cfg(unix)]
#[test]
fn linked_launch_move_and_seed_proceed_but_have_no_affirmative_observation() {
    use super::super::legacy_identifier::{CURRENT, DEV};
    use std::os::unix::fs::symlink;
    for operation in ["launch", "move", "seed"] {
        let (dir, mut paths) = fixture();
        let target = if operation == "move" {
            paths = legacy(paths);
            paths.moves[1].0.clone()
        } else if operation == "seed" {
            paths.seeds = installed(dir.path(), CURRENT);
            paths.seeds[1].join(CURRENT)
        } else {
            paths.app_data.clone()
        };
        let relocated = fs::canonicalize(dir.path()).unwrap().join("relocated");
        fs::rename(&target, &relocated).unwrap();
        symlink(&relocated, &target).unwrap();
        assert!(paths.preflight().is_err());
        let instance = boot(&paths, None, no_agents, || panic!("no key deletion"));
        assert!(instance.as_ref().unwrap().h1_unknown, "{operation}");
        assert!(paths.preflight().is_err(), "no affirmation: {operation}");
        if operation == "move" {
            assert_eq!(fs::read_link(&paths.app_data).unwrap(), relocated);
        }
        if operation == "seed" {
            assert!(paths.seeds[1].join(DEV).is_dir());
        }
    }
}

#[test]
fn pending_completion_reinspects_after_waiting_for_cleanup_ownership() {
    let (_dir, paths) = fixture();
    mark(&paths, false, false);
    let holder = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.key_lock)
        .unwrap();
    #[allow(clippy::incompatible_msrv)]
    holder.lock_shared().unwrap();
    let home = paths.app_data.clone();
    HANDOFF.set(Some(Box::new(move || {
        evidence(&home);
        drop(holder);
    })));
    assert!(boot(&paths, None, no_agents, || panic!(
        "reinspection must precede deletion"
    ))
    .is_err());
    assert!(paths.marker.exists());
}

#[test]
fn scanner_error_prevents_prepare_and_pending_deletion_not_launch() {
    let (_dir, paths) = fixture();
    INJECT_ERROR.set(true);
    let launched = boot(&paths, None, no_agents, || panic!("no marker"));
    let prepared = run(prepare(
        &paths,
        PLAIN,
        || async { Ok(()) },
        Admission::Scanner,
        || panic!("no closure"),
        || async { panic!("no shutdown") },
    ));
    let launch_ok = launched.is_ok();
    drop(launched);
    mark(&paths, false, false);
    let pending = boot(&paths, None, no_agents, || panic!("no deletion"));
    INJECT_ERROR.set(false);
    assert!(launch_ok && prepared.is_err() && pending.is_err());
    assert!(paths.marker.exists());
}

#[test]
fn a_seed_discard_cannot_turn_unknown_into_destructive_permission() {
    use super::super::legacy_identifier::{CURRENT, DEV};
    for pending in [false, true] {
        let (dir, mut paths) = fixture();
        paths.seeds = installed(dir.path(), CURRENT);
        let partial = paths.seeds[1].join(format!("{DEV}.seeding"));
        evidence(&partial);
        if pending {
            mark(&paths, false, false);
        }
        let result = boot(&paths, None, no_agents, || {
            panic!("unknown must not delete")
        });
        assert!(
            !partial.exists(),
            "existing seed behavior discards partial tree"
        );
        assert!(
            paths.preflight().is_ok(),
            "later scan sees no active evidence"
        );
        if pending {
            assert!(result.is_err());
            assert!(paths.marker.exists());
        } else {
            let instance = result.unwrap();
            assert!(instance.h1_unknown);
            let attempted = run(attempt(
                &instance,
                &paths,
                PLAIN,
                || async { Ok(()) },
                Admission::Scanner,
                || panic!("no closure"),
                || async { panic!("no shutdown") },
                || async { panic!("precommit refusal, no exit") },
            ));
            assert!(attempted.is_err());
            assert!(!paths.marker.exists());
        }
    }
}

#[test]
fn stray_profiles_refuse_plain_and_erase_before_marker_or_key_deletion() {
    for wipe in [false, true] {
        let (_dir, paths) = fixture();
        fs::create_dir(paths.app_data.join("profiles")).unwrap();
        fs::write(paths.app_data.join("profiles/stray"), "not a profile").unwrap();
        let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        let refused = run(attempt(
            &instance,
            &paths,
            Choices {
                wipe,
                remove_agents: false,
            },
            || async { Ok(()) },
            Admission::Scanner,
            || panic!("no closure"),
            || async { panic!("no shutdown") },
            || async { panic!("no exit") },
        ));
        assert_eq!(refused, Err(refuse(H1_UNKNOWN)));
        assert!(!paths.marker.exists());
        drop(instance);
        mark(&paths, wipe, false);
        assert!(boot(&paths, None, no_agents, || panic!("no key deletion")).is_err());
        assert!(paths.marker.exists());
        assert!(paths.app_data.join("profiles/stray").exists());
    }
}

#[cfg(unix)]
#[test]
fn linked_data_ancestor_preserves_launch_but_refuses_plain_sign_out() {
    let (dir, paths) = fixture();
    let alias = fs::canonicalize(dir.path()).unwrap().join("linked-data");
    std::os::unix::fs::symlink(paths.app_data.parent().unwrap(), &alias).unwrap();
    let mut linked = paths_for(dir.path(), "identity");
    linked.app_data = alias.join("app");
    let instance = boot(&linked, None, no_agents, || panic!("no marker")).unwrap();
    assert!(instance.h1_unknown);
    assert_eq!(
        run(attempt(
            &instance,
            &linked,
            PLAIN,
            || async { Ok(()) },
            Admission::Scanner,
            || panic!("no closure"),
            || async { panic!("no shutdown") },
            || async { panic!("no exit") }
        )),
        Err(refuse(H1_UNKNOWN))
    );
    assert!(!paths.marker.exists());
}

#[test]
fn reviewer_prepare_only_unknown_must_survive_a_clean_retry() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    assert!(!instance.h1_unknown);
    INJECT_ERROR.set(true);
    let first = run(attempt(
        &instance,
        &paths,
        PLAIN,
        || async { Ok(()) },
        Admission::Scanner,
        || panic!("first refusal must not close"),
        || async { panic!("first refusal must not shut down") },
        || async { panic!("first refusal must not exit") },
    ));
    INJECT_ERROR.set(false);
    assert_eq!(first, Err(refuse(H1_UNKNOWN)));
    assert!(!paths.marker.exists());
    assert!(!instance.shared.gate.lock().unwrap().closed);
    assert!(paths.preflight().is_ok());
    let closes = Cell::new(0);
    let second = run(attempt(
        &instance,
        &paths,
        PLAIN,
        || async { Ok(()) },
        Admission::Scanner,
        || closes.set(closes.get() + 1),
        || async { Ok(()) },
        || async { panic!("no fenced failure") },
    ));
    eprintln!(
        "reviewer evidence: retry={second:?}, closes={}, marker={}, h1_unknown={}",
        closes.get(),
        paths.marker.exists(),
        instance.h1_unknown
    );
    assert_eq!(
        second,
        Err(refuse(H1_UNKNOWN)),
        "prepare uncertainty must remain sticky for this launch"
    );
}

#[test]
fn reviewer_vanished_pending_marker_must_not_make_uncertainty_fatal() {
    let (_dir, paths) = fixture();
    mark(&paths, false, false);
    let holder = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.key_lock)
        .unwrap();
    #[allow(clippy::incompatible_msrv)]
    holder.lock_shared().unwrap();
    let competing_paths = Paths {
        marker: paths.marker.clone(),
        finished: paths.finished.clone(),
        lock: paths.lock.clone(),
        key_lock: paths.key_lock.clone(),
        other_key_lock: paths.other_key_lock.clone(),
        ownership: paths.ownership.clone(),
        app_data: paths.app_data.clone(),
        backups: paths.backups.clone(),
        others: paths.others.clone(),
        media: paths.media.clone(),
        moves: paths.moves.clone(),
        seeds: paths.seeds.clone(),
        plugin_home: paths.plugin_home.clone(),
    };
    HANDOFF.set(Some(Box::new(move || {
        // A has observed the marker and released K/A. Its first attempt at
        // cleanup ownership failed against holder. B now wins real ownership.
        drop(holder);
        let locks = Locks {
            key: OpenOptions::new()
                .write(true)
                .open(&competing_paths.key_lock)
                .unwrap(),
            all: OpenOptions::new()
                .write(true)
                .open(&competing_paths.lock)
                .unwrap(),
            other: None,
        };
        cleanup_locks(&locks, false).unwrap();
        assert!(competing_paths.preflight().is_ok());
        finish(&competing_paths, PLAIN, no_agents, || Ok(())).unwrap();
        assert!(!competing_paths.marker.exists());
        drop(locks);
        // B completed; a historical writer publishes uncertain evidence.
        evidence(&competing_paths.app_data);
    })));
    let result = boot(&paths, None, no_agents, || panic!("no second key removal"));
    eprintln!(
        "reviewer evidence: launch_error={:?}, marker={}, finished={}",
        result.as_ref().err(),
        paths.marker.exists(),
        finished(&paths.finished).unwrap()
    );
    assert!(!paths.marker.exists());
    assert_eq!(finished(&paths.finished).unwrap(), 1);
    assert!(
        result.is_ok(),
        "freshly absent intent must resume ordinary launch with unknown"
    );
    assert!(result.unwrap().h1_unknown);
}

#[test]
fn prepare_uncertainty_is_rechecked_at_shared_admission() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    INJECT_ERROR.set(true);
    let first = run(attempt(
        &instance,
        &paths,
        PLAIN,
        || async { Ok(()) },
        Admission::Scanner,
        || panic!("no closure"),
        || async { panic!("no shutdown") },
        || async { panic!("no exit") },
    ));
    INJECT_ERROR.set(false);
    assert_eq!(first, Err(refuse(H1_UNKNOWN)));
    assert!(!instance.h1_unknown, "boot observation was clean");
    assert!(instance.shared.gate.lock().unwrap().h1_unknown);
    // Direct boundaries exercise the locked recheck, as if an earlier adapter
    // check saw false before prepare recorded uncertainty and reopened admission.
    assert_eq!(instance.creator().err().as_deref(), Some(H1_UNKNOWN));
    assert_eq!(
        instance.begin(PLAIN, Admission::Scanner),
        Err(refuse(H1_UNKNOWN))
    );
    assert!(!instance.shared.gate.lock().unwrap().closed);
    assert!(!paths.marker.exists());
}

#[cfg(unix)]
#[test]
fn h1_2di_during_scan_predicate_schedule_is_symmetric_not_a_filesystem_hook() {
    use buzzodz_plugins::secrets::preflight::{Inspection, Observation};
    for reverse in [false, true] {
        let (dir, paths) = fixture();
        let other = paths_for(dir.path(), OTHER_KEY);
        let scope = paths.preflight_scope().unwrap();
        let (current, foreign) = if reverse { (1, 0) } else { (0, 1) };
        let foreign_paths = if reverse { &paths } else { &other };
        let qualified = boot(foreign_paths, None, no_agents, || panic!("no marker")).unwrap();
        let mut inspection = Inspection::new(&scope);
        for root in &scope.inventories {
            assert_eq!(
                fs::symlink_metadata(root).unwrap_err().kind(),
                ErrorKind::NotFound
            );
            inspection.observe(Observation::InventoryAbsent(root));
        }
        // Predicate-level schedule, not native filesystem-hook execution.
        // Foreign publication occurs after its root probe, before homes / C.
        qualified
            .observe_sign_outs(Some(&scope.inventories[foreign]))
            .unwrap();
        for home in &scope.homes {
            assert_eq!(
                fs::symlink_metadata(home.join("profiles"))
                    .unwrap_err()
                    .kind(),
                ErrorKind::NotFound
            );
            inspection.observe(Observation::NoProfiles(home));
        }
        assert!(inspection.conclude().is_ok());
        assert!(!qualified.h1_unknown() && qualified.creator().is_ok());
        assert!(!scope.inventories[current].exists());
        // No fabricated predicate witness enters boot or grants a native lease.
        let observed = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
        assert!(observed.h1_unknown());
        assert_eq!(observed.creator().err().as_deref(), Some(H1_UNKNOWN));
    }
}
