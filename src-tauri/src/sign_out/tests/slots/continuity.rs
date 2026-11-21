//! Native boot/creator ownership with real temporary discovery and fake OS work.
use super::super::creators::{exclusive, released_lock};
use super::*;
use crate::identity::IdentityHost;

/// The other build's own paths in this data directory: the same shared
/// homes, but its own backup home, so its scope genuinely differs.
fn other_paths(paths: &Paths) -> Paths {
    paths_for(paths.lock.parent().unwrap(), OTHER_KEY)
}

/// The scope the other build binds at its fixed root.
fn peer_scope(paths: &Paths) -> secrets::preflight::Scope {
    let fixed = paths.plugin_peer_inventory().unwrap();
    other_paths(paths).inspection_scope(Some(&fixed)).unwrap()
}

/// The other build's fixed root, with a witness store of its own.
fn peer(paths: &Paths, store: &Arc<Fake>) -> secrets::continuity::Peer {
    secrets::continuity::Peer::new(
        paths.plugin_peer_inventory().unwrap(),
        peer_scope(paths),
        store.clone(),
    )
}

fn slots<'a>(paths: &Paths, vault: &'a Vault, wait: Duration) -> Slots<'a> {
    let scope = paths.inspection_scope(Some(&vault.root)).unwrap();
    let (root, store) = (vault.root.clone(), vault.store.clone());
    let peer = peer(paths, &Arc::default());
    let mut slots = vault.slots_waiting(BUDGET, wait);
    slots.continuity = Some(Box::new(move || {
        secrets::continuity::establish(&scope, &root, store.as_ref(), peer)
    }));
    slots
}

#[test]
fn continuity_boot_count_creator_journal_and_restart_share_one_witness() {
    for choices in [PLAIN, choices(true)] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.lock.parent().unwrap().join("inventory"));
        let instance = boot(
            &paths,
            Some(slots(&paths, &vault, BUDGET)),
            no_agents,
            || panic!("no marker"),
        )
        .unwrap();
        assert!(!instance.h1_unknown());
        assert!(instance.continuity.is_some());
        assert!(paths.preflight_with_inventory(Some(&vault.root)).is_err());
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        drop(instance.creator().unwrap());
        let identity = IdentityHost::fixture();
        let viewer = identity.current_viewer().unwrap().unwrap();
        let accounts = vault.enroll(&paths.app_data, "default", &[&viewer]);
        instance.inspect_continuity().unwrap();
        let calls = vault.calls();
        let witness = calls
            .iter()
            .find_map(|call| {
                call.strip_prefix("add ")
                    .filter(|account| !accounts.iter().any(|value| value == account))
            })
            .unwrap()
            .to_owned();
        let bytes = vault.store.items.lock().unwrap()[&witness].clone();
        run(attempt_native(
            &instance,
            &paths,
            choices,
            Some(&vault.root),
            &identity,
            || async { Ok(()) },
            || {},
            || async { Ok(()) },
            || async { panic!("no forced exit") },
        ))
        .unwrap();
        assert!(vault.pending() && paths.marker.exists());
        drop(instance);
        let instance = boot(
            &paths,
            Some(slots(&paths, &vault, BUDGET)),
            |_| Ok(()),
            || Ok(()),
        )
        .unwrap();
        assert!(!instance.h1_unknown());
        assert!(!vault.pending() && !paths.marker.exists());
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        drop(instance.creator().unwrap());
        assert_eq!(vault.saved(), vec![witness.clone()]);
        assert_eq!(vault.store.items.lock().unwrap()[&witness], bytes);
        assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));
    }
}

#[test]
fn continuity_timeout_retains_all_native_locks_until_actual_os_completion() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.lock.parent().unwrap().join("inventory"));
    let (started, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *vault.store.add_stall.lock().unwrap() = Some((started, released));
    let result = boot(
        &paths,
        Some(slots(&paths, &vault, Duration::from_millis(20))),
        no_agents,
        || panic!("no marker"),
    );
    assert!(result.is_err());
    assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
    assert!(!exclusive(&paths.key_lock));
    assert!(!exclusive(&paths.lock));
    assert!(!exclusive(&paths.other_key_lock));
    // The intent exists, but the native owner cannot be replaced while OS work is held.
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(vault.root.join("state.json")).unwrap()).unwrap();
    assert_eq!(value["installation"]["committed"], false);
    release.send(()).unwrap();
    released_lock(&paths.key_lock);
    released_lock(&paths.lock);
    released_lock(&paths.other_key_lock);
    let instance = boot(
        &paths,
        Some(slots(&paths, &vault, BUDGET)),
        no_agents,
        || panic!("no marker"),
    )
    .unwrap();
    assert!(!instance.h1_unknown());
    assert_eq!(
        vault
            .calls()
            .iter()
            .filter(|call| call.starts_with("add "))
            .count(),
        1
    );
}

#[test]
fn continuity_failure_never_suppresses_readable_journal_cleanup() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.lock.parent().unwrap().join("inventory"));
    let instance = boot(
        &paths,
        Some(slots(&paths, &vault, BUDGET)),
        no_agents,
        || panic!("no marker"),
    )
    .unwrap();
    instance.observe_sign_outs(Some(&vault.root)).unwrap();
    let accounts = vault.enroll(&paths.app_data, "default", &[ALICE]);
    secrets::begin_sign_out(&vault.root, Some(ALICE), None).unwrap();
    // Lose just the witness. A committed journal still owns its cleanup attempt.
    vault
        .store
        .items
        .lock()
        .unwrap()
        .retain(|account, _| accounts.contains(account));
    drop(instance);
    vault.deny(Some(StoreError::Denied));
    assert!(boot(
        &paths,
        Some(slots(&paths, &vault, BUDGET)),
        no_agents,
        || panic!("no marker")
    )
    .is_err());
    assert_eq!(vault.attempts(), 1);
    assert!(vault.pending());
    vault.deny(None);
    let instance = boot(
        &paths,
        Some(slots(&paths, &vault, BUDGET)),
        no_agents,
        || panic!("no marker"),
    )
    .unwrap();
    assert_eq!(vault.attempts(), 2);
    assert!(!vault.pending());
    assert!(vault.saved().is_empty());
    assert!(instance.h1_unknown());
    assert!(instance.creator().is_err());
    assert!(instance.observe_sign_outs(Some(&vault.root)).is_err());
}

#[test]
fn continuity_reinspection_refuses_every_declared_candidate_without_repair() {
    let (_dir, mut paths) = fixture();
    let base = paths.lock.parent().unwrap().to_owned();
    paths.plugin_home = Some(base.join("alternate-home"));
    paths.seeds = vec![base.join("seed")];
    paths.moves = vec![(base.join("old-home"), base.join("new-home"))];
    let vault = Vault::new(base.join("inventory"));
    let scope = paths.inspection_scope(Some(&vault.root)).unwrap();
    // Establish directly: artificial seed configuration must not start real seeding.
    let established = secrets::continuity::establish(
        &scope,
        &vault.root,
        vault.store.as_ref(),
        peer(&paths, &Arc::default()),
    )
    .unwrap();
    let adds = vault.calls();
    assert_eq!(
        adds.iter().filter(|call| call.starts_with("add ")).count(),
        1
    );
    for home in &scope.homes {
        let profile = home.join("profiles/not-selected");
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            profile.join("registry.json"),
            b"unreadable candidate evidence",
        )
        .unwrap();
        assert!(
            paths
                .inspect_continuity(Some(&vault.root), Some(&established))
                .is_err(),
            "{home:?}"
        );
        fs::remove_dir_all(home.join("profiles")).unwrap();
    }
    for inventory in scope.inventories.iter().filter(|path| **path != vault.root) {
        fs::create_dir_all(inventory).unwrap();
        assert!(
            paths
                .inspect_continuity(Some(&vault.root), Some(&established))
                .is_err(),
            "{inventory:?}"
        );
        fs::remove_dir_all(inventory).unwrap();
    }
    paths
        .inspect_continuity(Some(&vault.root), Some(&established))
        .unwrap();
    assert!(
        vault.calls().is_empty(),
        "reinspection performs no OS read, repair or add"
    );
}

#[test]
fn continuity_late_evidence_refuses_creator_and_journal_before_metadata() {
    for boundary in ["creator", "journal"] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.lock.parent().unwrap().join("inventory"));
        let instance = boot(
            &paths,
            Some(slots(&paths, &vault, BUDGET)),
            no_agents,
            || panic!("no marker"),
        )
        .unwrap();
        let profile = paths.app_data.join("profiles/late");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join("registry.json"), b"foreign evidence").unwrap();
        vault.calls();
        let before = fs::read(vault.root.join("state.json")).unwrap();
        if boundary == "creator" {
            assert!(instance.creator().is_err());
        } else {
            let identity = IdentityHost::fixture();
            assert_eq!(
                run(attempt_native(
                    &instance,
                    &paths,
                    PLAIN,
                    Some(&vault.root),
                    &identity,
                    || async { Ok(()) },
                    || panic!("must not close"),
                    || async { panic!("must not stop") },
                    || async { panic!("must not exit") }
                )),
                Err(refuse(H1_UNKNOWN))
            );
        }
        assert!(instance.h1_unknown());
        assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
        assert!(vault.calls().is_empty());
        assert!(!paths.marker.exists());
    }
}

// ------------------------------------------------ the other supported build

const WITNESS: &str = "installation-continuity-v1";
const THIS_VARIANT: &str = if cfg!(debug_assertions) {
    "debug"
} else {
    "release"
};
const OTHER_VARIANT: &str = if cfg!(debug_assertions) {
    "release"
} else {
    "debug"
};

/// This build's production slots at its fixed root, beside the other build's.
fn fixed_slots<'a>(paths: &Paths, vault: &'a Vault, other: &Arc<Fake>) -> Slots<'a> {
    paths
        .plugin_slots_with_peer(
            &vault.root,
            vault.store.clone(),
            other.clone(),
            peer_scope(paths),
        )
        .unwrap()
}

fn boot_fixed(paths: &Paths, vault: &Vault, other: &Arc<Fake>) -> Instance {
    boot(
        paths,
        Some(fixed_slots(paths, vault, other)),
        |_| Ok(()),
        || Ok(()),
    )
    .unwrap()
}

/// The other build, installed at its fixed root under its own scope as it
/// installs itself: a committed pair, with `identities` enrolled in app data's
/// `other` profile. Made under this build's rules, then re-owned by variant,
/// which the binding does not cover. Install before this build exists; a later
/// appearance parks and exposes the unchanged pair.
fn install_other(paths: &Paths, identities: &[&str]) -> Arc<Fake> {
    let ours = paths.plugin_inventory().unwrap();
    assert!(!ours.exists(), "the other build installs into fresh data");
    let fixed = paths.plugin_peer_inventory().unwrap();
    let vault = Vault::new(fixed.clone());
    secrets::continuity::establish(
        &peer_scope(paths),
        &fixed,
        vault.store.as_ref(),
        secrets::continuity::Peer::new(
            ours.clone(),
            paths.inspection_scope(Some(&ours)).unwrap(),
            Arc::<Fake>::default(),
        ),
    )
    .unwrap();
    secrets::observe_sign_outs(&fixed, 0).unwrap();
    let registry = paths.app_data.join("profiles/other/registry.json");
    if !identities.is_empty() {
        vault.enroll(&paths.app_data, "other", identities);
    }
    let records = fs::read_dir(&fixed)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"));
    for file in records.chain(registry.exists().then_some(registry)) {
        let bytes = reown(&fs::read(&file).unwrap());
        fs::write(&file, bytes).unwrap();
    }
    let mut items = vault.store.items.lock().unwrap();
    let witness = reown(&items[WITNESS]);
    items.insert(WITNESS.into(), witness);
    drop(items);
    vault.calls();
    vault.store.clone()
}

/// The other build's installed files, moved out of discovery unchanged.
struct Parked {
    dir: tempfile::TempDir,
    moved: Vec<PathBuf>,
}

fn park_other(paths: &Paths) -> Parked {
    let dir = tempfile::tempdir_in(paths.lock.parent().unwrap()).unwrap();
    let moved: Vec<_> = [
        paths.plugin_peer_inventory().unwrap(),
        paths.app_data.join("profiles/other"),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .collect();
    for (index, path) in moved.iter().enumerate() {
        fs::rename(path, dir.path().join(index.to_string())).unwrap();
    }
    Parked { dir, moved }
}

/// The parked pair reappears exactly where, and as, it was bound.
fn expose_other(parked: Parked) {
    for (index, path) in parked.moved.iter().enumerate() {
        fs::rename(parked.dir.path().join(index.to_string()), path).unwrap();
    }
}

/// Exactly the owning variant changes; every other byte stays as written.
fn reown(bytes: &[u8]) -> Vec<u8> {
    let mut text = std::str::from_utf8(bytes).unwrap().to_owned();
    for space in ["", " "] {
        text = text.replace(
            &format!(r#""variant":{space}"{THIS_VARIANT}""#),
            &format!(r#""variant":{space}"{OTHER_VARIANT}""#),
        );
    }
    text.into_bytes()
}

/// Everything the other build owns that this build must never change.
fn other_evidence(paths: &Paths, other: &Fake) -> (Vec<(PathBuf, Vec<u8>)>, Vec<String>) {
    let fixed = paths.plugin_peer_inventory().unwrap();
    let mut files: Vec<_> = fs::read_dir(&fixed)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .chain(std::iter::once(
            paths.app_data.join("profiles/other/registry.json"),
        ))
        .filter(|path| path.is_file())
        .map(|path| {
            let bytes = fs::read(&path).unwrap();
            (path, bytes)
        })
        .collect();
    files.sort();
    let mut items: Vec<_> = other.items.lock().unwrap().keys().cloned().collect();
    items.sort();
    (files, items)
}

fn other_reads(other: &Fake) -> usize {
    std::mem::take(&mut *other.log.lock().unwrap())
        .iter()
        .map(|call| {
            assert_eq!(
                call,
                &format!("read {WITNESS}"),
                "the other build is read-only"
            );
        })
        .count()
}

fn sign_out(
    instance: &Instance,
    paths: &Paths,
    vault: &Vault,
    choices: Choices,
) -> Result<(), Failure> {
    run(attempt_native(
        instance,
        paths,
        choices,
        instance.plugin_inventory(),
        &IdentityHost::fixture(),
        || async { Ok(()) },
        || {},
        || async { Ok(()) },
        || async { panic!("no forced exit") },
    ))
    .inspect(|_| assert!(vault.pending() || choices.wipe))
}

#[test]
fn supported_builds_share_fixed_data_in_either_order_and_sign_out_independently() {
    for other_first in [true, false] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let viewer = IdentityHost::fixture().current_viewer().unwrap().unwrap();
        let other = install_other(&paths, &[BOB]);
        let parked = (!other_first).then(|| park_other(&paths));
        let instance = boot_fixed(&paths, &vault, &other);
        assert!(!instance.h1_unknown(), "other first: {other_first}");
        assert_eq!(other_reads(&other), usize::from(other_first));
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        let accounts = vault.enroll(&paths.app_data, "default", &[&viewer]);
        drop(instance);
        if let Some(parked) = parked {
            // Quit, then the other build's pair appears beside this one.
            expose_other(parked);
        }
        let evidence = other_evidence(&paths, &other);
        vault.calls();
        // Each launch, revisits included, requalifies both pairs without a write.
        for _ in 0..2 {
            let instance = boot_fixed(&paths, &vault, &other);
            assert!(!instance.h1_unknown(), "other first: {other_first}");
            assert_eq!(other_reads(&other), 1);
            drop(instance.creator().unwrap());
            assert_eq!(other_reads(&other), 0, "qualified once per launch");
        }
        assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));
        // A plain sign-out here cleans this build's accounts and nothing else.
        let instance = boot_fixed(&paths, &vault, &other);
        sign_out(&instance, &paths, &vault, PLAIN).unwrap();
        drop(instance);
        let instance = boot_fixed(&paths, &vault, &other);
        assert!(!instance.h1_unknown());
        assert!(!vault.pending());
        assert!(vault
            .saved()
            .iter()
            .all(|account| !accounts.contains(account)));
        assert_eq!(other_evidence(&paths, &other), evidence);
        other_reads(&other);
    }
}

#[test]
fn other_build_appearing_after_boot_qualifies_fresh_or_refuses() {
    for witness in ["exact", "absent", "replaced"] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let installed = install_other(&paths, &[]);
        let items = std::mem::take(&mut *installed.items.lock().unwrap());
        let parked = park_other(&paths);
        let other = Arc::<Fake>::default();
        let instance = boot_fixed(&paths, &vault, &other);
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        expose_other(parked);
        match witness {
            "exact" => *other.items.lock().unwrap() = items,
            "absent" => {}
            _ => {
                let mut value: serde_json::Value = serde_json::from_slice(&items[WITNESS]).unwrap();
                value["id"] = "00000000-0000-4000-8000-000000000000".into();
                other
                    .items
                    .lock()
                    .unwrap()
                    .insert(WITNESS.into(), serde_json::to_vec(&value).unwrap());
            }
        }
        vault.calls();
        let before = fs::read(vault.root.join("state.json")).unwrap();
        let result = instance.creator().map(drop);
        assert_eq!(other_reads(&other), 1, "{witness}");
        if witness == "exact" {
            result.unwrap();
            drop(instance.creator().unwrap());
            assert_eq!(other_reads(&other), 0, "a qualified peer is not re-read");
            assert!(!instance.h1_unknown());
        } else {
            assert_eq!(result, Err(H1_UNKNOWN.into()), "{witness}");
            assert!(instance.h1_unknown(), "sticky: {witness}");
            assert!(instance.creator().is_err());
        }
        assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
        assert!(vault.calls().is_empty(), "{witness}");
    }
}

#[test]
fn erase_refuses_before_revoke_while_the_other_build_keeps_custody_there() {
    for enrolled in [true, false] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let identities: &[&str] = if enrolled { &[BOB] } else { &[] };
        let other = install_other(&paths, identities);
        let evidence = other_evidence(&paths, &other);
        let instance = boot_fixed(&paths, &vault, &other);
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        let result = run(attempt_native(
            &instance,
            &paths,
            choices(false),
            instance.plugin_inventory(),
            &IdentityHost::fixture(),
            || async {
                assert!(!enrolled, "refused before revoking");
                Ok(())
            },
            || {},
            || async { Ok(()) },
            || async { panic!("no forced exit") },
        ));
        if enrolled {
            assert_eq!(result, Err(refuse(PEER_CUSTODY)));
            assert!(!paths.marker.exists());
            assert!(!vault.pending());
            assert!(!instance.h1_unknown());
            // Plain sign-out stays independent of the other build.
            sign_out(&instance, &paths, &vault, PLAIN).unwrap();
        } else {
            result.unwrap();
            assert!(paths.marker.exists());
        }
        assert_eq!(other_evidence(&paths, &other), evidence);
    }
}

#[test]
fn failed_setup_finishes_only_explicitly_then_qualifies_after_restart() {
    for interruption in ["denied-add", "after-add"] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let other = Arc::<Fake>::default();
        let state = vault.root.join("state.json");
        if interruption == "denied-add" {
            *vault.store.add_denied.lock().unwrap() = true;
            let instance = boot_fixed(&paths, &vault, &other);
            assert!(instance.h1_unknown());
        } else {
            // Witness saved, then the launch ended before its commit.
            drop(boot_fixed(&paths, &vault, &other));
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
            value["installation"]["committed"] = false.into();
            fs::write(&state, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        let intent: serde_json::Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
        assert_eq!(intent["installation"]["committed"], false);
        *vault.store.add_denied.lock().unwrap() = false;
        vault.calls();
        // Restored access: ordinary boot still refuses, writing nothing.
        let instance = boot_fixed(&paths, &vault, &other);
        assert!(instance.h1_unknown(), "{interruption}");
        assert!(instance.plugin_inventory().is_none());
        assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));
        let failure = sign_out(&instance, &paths, &vault, PLAIN).unwrap_err();
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"message": H1_UNKNOWN, "finishSetup": true})
        );
        instance.finish_credential_setup().unwrap();
        let adds = vault
            .calls()
            .iter()
            .filter(|call| *call == &format!("add {WITNESS}"))
            .count();
        assert_eq!(
            adds,
            usize::from(interruption == "denied-add"),
            "{interruption}"
        );
        let committed: serde_json::Value =
            serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
        assert_eq!(committed["installation"]["committed"], true);
        assert_eq!(
            committed["installation"]["installation"],
            intent["installation"]["installation"]
        );
        // This launch stays unknown and unwired; only a restart qualifies.
        assert!(instance.h1_unknown());
        assert!(instance.plugin_inventory().is_none());
        assert_eq!(instance.creator().map(drop), Err(H1_UNKNOWN.into()));
        assert!(
            instance.finish_credential_setup().is_err(),
            "committed is final"
        );
        assert!(
            !sign_out(&instance, &paths, &vault, PLAIN)
                .unwrap_err()
                .finish_setup
        );
        drop(instance);
        let instance = boot_fixed(&paths, &vault, &other);
        assert!(!instance.h1_unknown(), "{interruption}");
        assert_eq!(
            instance.finish_credential_setup(),
            Err(SETUP_UNAVAILABLE.into())
        );
        instance.observe_sign_outs(Some(&vault.root)).unwrap();
        let viewer = IdentityHost::fixture().current_viewer().unwrap().unwrap();
        let accounts = vault.enroll(&paths.app_data, "default", &[&viewer]);
        sign_out(&instance, &paths, &vault, PLAIN).unwrap();
        drop(instance);
        let instance = boot_fixed(&paths, &vault, &other);
        assert!(!instance.h1_unknown());
        assert!(vault
            .saved()
            .iter()
            .all(|account| !accounts.contains(account)));
        assert_eq!(vault.saved(), vec![WITNESS.to_owned()]);
    }
}

#[test]
fn finish_setup_is_offered_and_runs_only_for_this_builds_own_intent() {
    // Unknown custody without an own intent: no offer, and finishing refuses.
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = Arc::<Fake>::default();
    let profile = paths.app_data.join("profiles/foreign");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("registry.json"), b"foreign evidence").unwrap();
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(instance.h1_unknown());
    assert!(!vault.root.exists());
    vault.calls();
    let failure = sign_out(&instance, &paths, &vault, PLAIN).unwrap_err();
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        serde_json::json!({"message": H1_UNKNOWN})
    );
    assert!(instance.finish_credential_setup().is_err());
    assert!(!vault.root.exists());
    assert!(vault.calls().is_empty());
    // No production slots: nothing to finish.
    drop(instance);
    fs::remove_dir_all(&profile).unwrap();
    let instance = boot(&paths, None, no_agents, || panic!("no marker")).unwrap();
    assert_eq!(
        instance.finish_credential_setup(),
        Err(SETUP_UNAVAILABLE.into())
    );
}

#[test]
fn finish_setup_timeout_keeps_its_lease_until_actual_completion() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = Arc::<Fake>::default();
    *vault.store.add_denied.lock().unwrap() = true;
    drop(boot_fixed(&paths, &vault, &other));
    *vault.store.add_denied.lock().unwrap() = false;
    let mut slots = fixed_slots(&paths, &vault, &other);
    slots.wait = Duration::from_millis(20);
    let instance = boot(&paths, Some(slots), no_agents, || panic!("no marker")).unwrap();
    let (started, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *vault.store.add_stall.lock().unwrap() = Some((started, released));
    assert_eq!(instance.finish_credential_setup(), Err(SAVING.into()));
    assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
    // The completion owns its lease and the installation lock, even unseen.
    assert!(!exclusive(&paths.other_key_lock));
    assert!(instance.finish_credential_setup().is_err());
    drop(instance);
    assert!(!exclusive(&paths.other_key_lock));
    release.send(()).unwrap();
    released_lock(&paths.other_key_lock);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
    assert_eq!(
        vault
            .calls()
            .iter()
            .filter(|call| *call == &format!("add {WITNESS}"))
            .count(),
        2,
        "the denied add, then the one late completion"
    );
}

/// Holds `store`'s next read until the returned sender sends or drops.
fn hold_read(store: &Fake) -> (mpsc::Receiver<Step>, mpsc::Sender<()>) {
    let (started, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    *store.read_stall.lock().unwrap() = Some((started, released));
    (entered, release)
}

fn active(shared: &Shared) -> usize {
    shared.gate.lock().unwrap().active
}

/// Bounded: the released read's owner lets go of its lease.
fn idle(shared: &Shared) {
    let start = Instant::now();
    while active(shared) != 0 {
        assert!(
            start.elapsed() < BUDGET,
            "the completed read keeps its lease"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Booted at the fixed root with the other build's pair parked: it appears
/// only when exposed, unchanged.
fn boot_before_other(paths: &Paths, vault: &Vault) -> (Instance, Arc<Fake>, Parked) {
    let other = install_other(paths, &[]);
    let parked = park_other(paths);
    let mut slots = fixed_slots(paths, vault, &other);
    slots.wait = Duration::from_millis(300);
    let instance = boot(paths, Some(slots), |_| Ok(()), || Ok(())).unwrap();
    assert!(!instance.h1_unknown());
    instance.observe_sign_outs(Some(&vault.root)).unwrap();
    assert_eq!(other_reads(&other), 0);
    (instance, other, parked)
}

#[test]
fn boot_peer_read_held_past_its_wait_keeps_every_native_lock_until_it_returns() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = install_other(&paths, &[]);
    let (entered, release) = hold_read(&other);
    let mut slots = fixed_slots(&paths, &vault, &other);
    slots.wait = Duration::from_millis(50);
    assert!(boot(&paths, Some(slots), |_| Ok(()), || Ok(())).is_err());
    assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
    assert!(!exclusive(&paths.key_lock));
    assert!(!exclusive(&paths.lock));
    assert!(!exclusive(&paths.other_key_lock));
    release.send(()).unwrap();
    released_lock(&paths.key_lock);
    released_lock(&paths.lock);
    released_lock(&paths.other_key_lock);
    assert_eq!(other_reads(&other), 1);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
    assert_eq!(other_reads(&other), 1);
}

#[test]
fn creator_owns_a_new_peers_read_through_timeout_and_instance_drop() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let (instance, other, parked) = boot_before_other(&paths, &vault);
    expose_other(parked);
    let (entered, release) = hold_read(&other);
    let shared = instance.shared.clone();
    // A failing assertion drops `release` before the scope joins the reader.
    let release = std::thread::scope(|scope| {
        let release = release;
        let creator = scope.spawn(|| instance.creator().map(drop));
        assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
        // The read began under the creator's lease, before any caller timeout.
        assert_eq!(active(&shared), 1);
        assert!(!exclusive(&paths.other_key_lock));
        assert_eq!(creator.join().unwrap(), Err(H1_UNKNOWN.into()));
        release
    });
    assert!(instance.h1_unknown());
    assert_eq!(
        sign_out(&instance, &paths, &vault, PLAIN),
        Err(refuse(H1_UNKNOWN))
    );
    assert!(!paths.marker.exists());
    assert!(!vault.pending());
    drop(instance);
    assert_eq!(active(&shared), 1, "the read still owns its lease");
    assert!(!exclusive(&paths.other_key_lock));
    assert!(!exclusive(&paths.key_lock));
    release.send(()).unwrap();
    idle(&shared);
    assert!(
        shared.gate.lock().unwrap().h1_unknown,
        "late success stays unknown"
    );
    drop(shared);
    released_lock(&paths.other_key_lock);
    released_lock(&paths.key_lock);
    assert_eq!(other_reads(&other), 1);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
    assert_eq!(other_reads(&other), 1);
}

#[test]
fn finish_setup_owns_its_peer_read_through_timeout_and_instance_drop() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = install_other(&paths, &[]);
    let state = vault.root.join("state.json");
    *vault.store.add_denied.lock().unwrap() = true;
    drop(boot_fixed(&paths, &vault, &other));
    *vault.store.add_denied.lock().unwrap() = false;
    let intent = fs::read(&state).unwrap();
    let mut slots = fixed_slots(&paths, &vault, &other);
    slots.wait = Duration::from_millis(300);
    let instance = boot(&paths, Some(slots), |_| Ok(()), || Ok(())).unwrap();
    assert!(instance.h1_unknown());
    other_reads(&other);
    let (entered, release) = hold_read(&other);
    let shared = instance.shared.clone();
    // A failing assertion drops `release` before the scope joins the reader.
    let release = std::thread::scope(|scope| {
        let release = release;
        let finish = scope.spawn(|| instance.finish_credential_setup());
        assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
        assert_eq!(active(&shared), 1);
        assert!(!exclusive(&paths.other_key_lock));
        assert_eq!(fs::read(&state).unwrap(), intent, "nothing commits first");
        assert_eq!(finish.join().unwrap(), Err(SAVING.into()));
        release
    });
    assert!(instance.finish_credential_setup().is_err());
    drop(instance);
    assert_eq!(active(&shared), 1, "the finish still owns its lease");
    assert!(!exclusive(&paths.other_key_lock));
    assert_eq!(fs::read(&state).unwrap(), intent);
    release.send(()).unwrap();
    idle(&shared);
    drop(shared);
    released_lock(&paths.other_key_lock);
    let committed: serde_json::Value = serde_json::from_slice(&fs::read(&state).unwrap()).unwrap();
    assert_eq!(committed["installation"]["committed"], true);
    other_reads(&other);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
}

fn sign_out_unrevoked(instance: &Instance, paths: &Paths) -> Result<(), Failure> {
    run(attempt_native(
        instance,
        paths,
        PLAIN,
        instance.plugin_inventory(),
        &IdentityHost::fixture(),
        || async { panic!("refused before revoking") },
        || {},
        || async { Ok(()) },
        || async { panic!("no forced exit") },
    ))
}

#[test]
fn sign_out_owns_a_new_peers_read_before_admission_and_refuses_before_revoking() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let (instance, other, parked) = boot_before_other(&paths, &vault);
    expose_other(parked);
    let (entered, release) = hold_read(&other);
    let shared = instance.shared.clone();
    // A failing assertion drops `release` before the scope joins the reader.
    let release = std::thread::scope(|scope| {
        let release = release;
        let attempt = scope.spawn(|| sign_out_unrevoked(&instance, &paths));
        assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
        // Owned before admission: nothing closed, marked or journaled yet.
        assert_eq!(active(&shared), 1);
        assert!(!shared.gate.lock().unwrap().closed);
        assert!(!paths.marker.exists());
        assert_eq!(attempt.join().unwrap(), Err(refuse(H1_UNKNOWN)));
        release
    });
    assert!(instance.h1_unknown());
    assert!(!paths.marker.exists());
    assert!(!vault.pending());
    drop(instance);
    assert_eq!(active(&shared), 1, "the read still owns its lease");
    release.send(()).unwrap();
    idle(&shared);
    assert!(
        shared.gate.lock().unwrap().h1_unknown,
        "late success stays unknown"
    );
    drop(shared);
    released_lock(&paths.key_lock);
    assert_eq!(other_reads(&other), 1);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
}

#[test]
fn a_peer_appearing_after_sign_out_admission_refuses_with_no_os_read() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let (instance, other, parked) = boot_before_other(&paths, &vault);
    vault.calls();
    super::super::creators::BEFORE_COMMIT.set(Some(Box::new(move || expose_other(parked))));
    assert_eq!(
        sign_out_unrevoked(&instance, &paths),
        Err(refuse(H1_UNKNOWN))
    );
    assert_eq!(other_reads(&other), 0, "closed phase reads no OS witness");
    assert!(vault.calls().is_empty());
    assert!(!paths.marker.exists());
    assert!(!vault.pending());
    assert!(instance.h1_unknown());
}

#[test]
fn production_peer_scope_is_the_other_identifiers_recipe_with_its_own_backup_home() {
    use super::super::super::legacy_identifier::{CURRENT, DEV};
    let (this, that) = if cfg!(debug_assertions) {
        (DEV, CURRENT)
    } else {
        (CURRENT, DEV)
    };
    let paths = Paths::resolve(this).unwrap();
    let theirs = Paths::resolve(that).unwrap();
    let own = paths.inspection_scope(None).unwrap();
    let peer = paths.peer_inspection_scope().unwrap();
    assert_eq!(peer.inventories, own.inventories, "both fixed roots");
    let backup = paths
        .backups
        .with_file_name(buzz_credential_store::human_store(!cfg!(debug_assertions)));
    assert_ne!(backup, paths.backups);
    assert!(peer.homes.contains(&backup));
    assert!(!peer.homes.contains(&paths.backups));
    for home in &theirs.others {
        assert!(peer.homes.contains(home), "{home:?}");
    }
    assert_ne!(peer, own);
}
