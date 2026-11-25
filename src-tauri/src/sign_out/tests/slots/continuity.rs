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
        secrets::continuity::qualify(&scope, &root, store.as_ref(), peer)
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

/// This build's failed fresh setup: its exact intent, no witness saved.
fn failed_setup(paths: &Paths, vault: &Vault, other: &Arc<Fake>) -> Vec<u8> {
    *vault.store.add_denied.lock().unwrap() = true;
    drop(boot_fixed(paths, vault, other));
    *vault.store.add_denied.lock().unwrap() = false;
    vault.calls();
    fs::read(vault.root.join("state.json")).unwrap()
}

fn installation(vault: &Vault) -> serde_json::Value {
    serde_json::from_slice::<serde_json::Value>(&fs::read(vault.root.join("state.json")).unwrap())
        .unwrap()["installation"]
        .clone()
}

/// Remove from an unqualified launch, which records no journal.
fn remove(instance: &Instance, paths: &Paths, choices: Choices) -> Result<(), Failure> {
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
}

#[test]
fn remove_cancels_failed_setup_then_restart_removes_the_key_before_one_fresh_setup() {
    for legacy in [false, true] {
        let (_dir, mut paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let other = Arc::<Fake>::default();
        failed_setup(&paths, &vault, &other);
        // Still denied: this launch cancels, then its one fresh setup fails.
        *vault.store.add_denied.lock().unwrap() = true;
        let instance = boot_fixed(&paths, &vault, &other);
        *vault.store.add_denied.lock().unwrap() = false;
        assert!(instance.h1_unknown() && instance.partial);
        assert!(instance.plugin_inventory().is_none());
        let intent = installation(&vault);
        assert_eq!(intent["committed"], false);
        vault.calls();
        remove(&instance, &paths, PLAIN).unwrap();
        assert!(paths.marker.exists() && !vault.pending());
        assert_eq!(installation(&vault), serde_json::Value::Null);
        assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));
        drop(instance);
        if legacy {
            // A legacy marker is pending before migration moves it to ours.
            let source = paths.lock.parent().unwrap().join("legacy-marker");
            fs::rename(&paths.marker, &source).unwrap();
            paths.moves = vec![(source, paths.marker.clone())];
        }
        let removed = std::cell::Cell::new(0);
        let instance = boot(
            &paths,
            Some(fixed_slots(&paths, &vault, &other)),
            |_| Ok(()),
            || {
                let calls = vault.store.log.lock().unwrap().clone();
                assert!(
                    !calls.iter().any(|call| call.starts_with("add ")),
                    "{calls:?}"
                );
                removed.set(removed.get() + 1);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(removed.get(), 1, "legacy={legacy}");
        assert!(!paths.marker.exists());
        // Initialized afresh only after removal, and usable in this launch.
        assert!(
            !instance.h1_unknown() && !instance.partial,
            "legacy={legacy}"
        );
        assert_eq!(instance.plugin_inventory(), Some(vault.root.as_path()));
        let fresh = installation(&vault);
        assert_eq!(fresh["committed"], true);
        assert_ne!(fresh["installation"], intent["installation"]);
        let adds = vault.calls();
        assert_eq!(adds.iter().filter(|c| c.starts_with("add ")).count(), 1);
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
    }
}

#[test]
fn invalidated_empty_or_an_independent_unknown_refuses_and_keeps_the_marker() {
    // Evidence beside the cancelled setup invalidates its empty proof at boot.
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = Arc::<Fake>::default();
    failed_setup(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = true;
    let instance = boot_fixed(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = false;
    remove(&instance, &paths, PLAIN).unwrap();
    drop(instance);
    let profile = paths.app_data.join("profiles/foreign");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("registry.json"), b"foreign evidence").unwrap();
    vault.calls();
    let booted = boot(
        &paths,
        Some(fixed_slots(&paths, &vault, &other)),
        |_| panic!("no removal"),
        || panic!("no removal"),
    );
    assert_eq!(booted.err(), Some(H1_UNKNOWN.into()));
    assert!(paths.marker.exists());
    assert!(!vault.calls().iter().any(|call| call.starts_with("add ")));

    // A sticky runtime unknown refuses Remove before cancelling anything.
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    failed_setup(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = true;
    let instance = boot_fixed(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.partial);
    let before = fs::read(vault.root.join("state.json")).unwrap();
    instance.mark_h1_unknown();
    vault.calls();
    assert_eq!(remove(&instance, &paths, PLAIN), Err(refuse(H1_UNKNOWN)));
    assert!(!paths.marker.exists());
    assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
    assert!(vault.calls().is_empty());

    // Unknown custody without this build's own state is never partial.
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let profile = paths.app_data.join("profiles/foreign");
    fs::create_dir_all(&profile).unwrap();
    fs::write(profile.join("registry.json"), b"foreign evidence").unwrap();
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(instance.h1_unknown() && !instance.partial);
    vault.calls();
    assert_eq!(remove(&instance, &paths, PLAIN), Err(refuse(H1_UNKNOWN)));
    assert!(!vault.root.exists() && !paths.marker.exists());
    assert!(vault.calls().is_empty());
}

#[test]
fn remove_cancel_timeout_keeps_its_lease_and_late_completion_records_no_marker() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = Arc::<Fake>::default();
    failed_setup(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = true;
    let mut slots = fixed_slots(&paths, &vault, &other);
    slots.wait = Duration::from_millis(300);
    let instance = boot(&paths, Some(slots), no_agents, || panic!("no marker")).unwrap();
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.partial);
    let (entered, release) = hold_read(&vault.store);
    assert_eq!(remove(&instance, &paths, PLAIN), Err(refuse(SAVING)));
    assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
    // The completion owns its lease and the installation lock, even unseen.
    assert!(!exclusive(&paths.other_key_lock));
    assert!(remove(&instance, &paths, PLAIN).is_err());
    let shared = instance.shared.clone();
    drop(instance);
    assert!(!exclusive(&paths.other_key_lock));
    release.send(()).unwrap();
    idle(&shared);
    drop(shared);
    released_lock(&paths.other_key_lock);
    assert!(!paths.marker.exists(), "a late cancel never continues");
    // The late cancel left E; an ordinary launch sets up afresh from it.
    assert_eq!(installation(&vault), serde_json::Value::Null);
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(!instance.h1_unknown());
    assert_eq!(installation(&vault)["committed"], true);
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
fn remove_cancel_owns_its_peer_read_through_timeout_and_instance_drop() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = install_other(&paths, &[]);
    let parked = park_other(&paths);
    failed_setup(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = true;
    let mut slots = fixed_slots(&paths, &vault, &other);
    slots.wait = Duration::from_millis(300);
    let instance = boot(&paths, Some(slots), |_| Ok(()), || Ok(())).unwrap();
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.partial);
    let intent = fs::read(vault.root.join("state.json")).unwrap();
    expose_other(parked);
    other_reads(&other);
    let (entered, release) = hold_read(&other);
    let shared = instance.shared.clone();
    // A failing assertion drops `release` before the scope joins the reader.
    let release = std::thread::scope(|scope| {
        let release = release;
        let removing = scope.spawn(|| remove(&instance, &paths, PLAIN));
        assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
        assert_eq!(active(&shared), 1);
        assert!(!exclusive(&paths.other_key_lock));
        assert_eq!(
            fs::read(vault.root.join("state.json")).unwrap(),
            intent,
            "nothing is cancelled first"
        );
        assert_eq!(removing.join().unwrap(), Err(refuse(SAVING)));
        release
    });
    drop(instance);
    assert_eq!(active(&shared), 1, "the cancel still owns its lease");
    assert!(!exclusive(&paths.other_key_lock));
    release.send(()).unwrap();
    idle(&shared);
    drop(shared);
    released_lock(&paths.other_key_lock);
    assert!(!paths.marker.exists(), "a late cancel never continues");
    assert_eq!(other_reads(&other), 1);
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

#[test]
fn erase_rechecks_the_other_builds_custody_at_boot_deletion() {
    for enrolled in [true, false] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let identities: &[&str] = if enrolled { &[BOB] } else { &[] };
        let other = install_other(&paths, identities);
        let parked = park_other(&paths);
        failed_setup(&paths, &vault, &other);
        *vault.store.add_denied.lock().unwrap() = true;
        let instance = boot_fixed(&paths, &vault, &other);
        *vault.store.add_denied.lock().unwrap() = false;
        assert!(instance.partial);
        // Admitted while the other build has no custody in any wiped home.
        remove(&instance, &paths, WIPE).unwrap();
        assert!(paths.marker.exists());
        drop(instance);
        // It enrolls there before this restart owns cleanup.
        expose_other(parked);
        let evidence = other_evidence(&paths, &other);
        let removed = std::cell::Cell::new(0);
        let booted = boot(
            &paths,
            Some(fixed_slots(&paths, &vault, &other)),
            |_| panic!("no agent keys are removed"),
            || {
                removed.set(removed.get() + 1);
                Ok(())
            },
        );
        if enrolled {
            assert_eq!(booted.err(), Some(PEER_CUSTODY.into()));
            assert_eq!(removed.get(), 0);
            assert!(paths.marker.exists(), "intent is kept");
            assert!(paths.app_data.join("archive.sqlite3").exists());
        } else {
            booted.unwrap();
            assert_eq!(removed.get(), 1);
            assert!(!paths.marker.exists());
        }
        assert_eq!(other_evidence(&paths, &other), evidence);
    }
}

#[test]
fn own_setup_beside_an_independent_boot_unknown_never_becomes_removable() {
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = install_other(&paths, &[]);
    let exact = other.items.lock().unwrap()[WITNESS].clone();
    failed_setup(&paths, &vault, &other);
    // The other build's witness no longer matches its pair: boot can't
    // qualify the scope, whatever this build's own intent looks like.
    let mut value: serde_json::Value = serde_json::from_slice(&exact).unwrap();
    value["id"] = "00000000-0000-4000-8000-000000000000".into();
    other
        .items
        .lock()
        .unwrap()
        .insert(WITNESS.into(), serde_json::to_vec(&value).unwrap());
    let before = fs::read(vault.root.join("state.json")).unwrap();
    let instance = boot_fixed(&paths, &vault, &other);
    assert!(instance.h1_unknown() && !instance.partial);
    assert_eq!(installation(&vault)["committed"], false);
    // Resolving the other build's problem doesn't requalify this launch.
    other
        .items
        .lock()
        .unwrap()
        .insert(WITNESS.into(), exact.clone());
    vault.calls();
    assert_eq!(remove(&instance, &paths, PLAIN), Err(refuse(H1_UNKNOWN)));
    assert!(!paths.marker.exists());
    assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
    assert!(vault.calls().is_empty(), "nothing cancelled");
    drop(instance);
    // A launch whose only failure is this build's own add can.
    *vault.store.add_denied.lock().unwrap() = true;
    let instance = boot_fixed(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.h1_unknown() && instance.partial);
    remove(&instance, &paths, PLAIN).unwrap();
    assert!(paths.marker.exists());
}

/// Boot with a pending plain removal, asserting no witness add precedes it.
fn boot_removing<'a>(
    paths: &Paths,
    vault: &'a Vault,
    slots: Slots<'a>,
    removed: &std::cell::Cell<usize>,
) -> Result<Instance, String> {
    boot(paths, Some(slots), no_agents, || {
        let calls = vault.store.log.lock().unwrap().clone();
        assert!(!calls.iter().any(|c| c.starts_with("add ")), "{calls:?}");
        removed.set(removed.get() + 1);
        Ok(())
    })
}

fn adds(vault: &Vault) -> usize {
    vault
        .calls()
        .iter()
        .filter(|c| c.starts_with("add "))
        .count()
}

#[test]
fn pending_removal_with_no_own_inventory_initializes_only_after_it() {
    for (legacy, peer) in [(false, false), (true, false), (false, true), (true, true)] {
        let (_dir, mut paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let other = if peer {
            install_other(&paths, &[])
        } else {
            Arc::default()
        };
        mark(&paths, false, false);
        if legacy {
            let source = paths.lock.parent().unwrap().join("legacy-marker");
            fs::rename(&paths.marker, &source).unwrap();
            paths.moves = vec![(source, paths.marker.clone())];
        }
        let removed = std::cell::Cell::new(0);
        let slots = fixed_slots(&paths, &vault, &other);
        let instance = boot_removing(&paths, &vault, slots, &removed).unwrap();
        let case = format!("legacy={legacy} peer={peer}");
        assert_eq!(removed.get(), 1, "{case}");
        assert!(!paths.marker.exists(), "{case}");
        assert!(!instance.h1_unknown(), "{case}");
        assert_eq!(installation(&vault)["committed"], true, "{case}");
        assert_eq!(adds(&vault), 1, "{case}");
    }
}

#[test]
fn malformed_or_unreadable_legacy_intent_refuses_before_any_setup() {
    for case in ["malformed", "folder", "dangling"] {
        let (_dir, mut paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let source = paths.lock.parent().unwrap().join("legacy-marker");
        match case {
            "malformed" => fs::write(&source, b"{\"wipe\":").unwrap(),
            "folder" => fs::create_dir(&source).unwrap(),
            _ => std::os::unix::fs::symlink(source.with_extension("gone"), &source).unwrap(),
        }
        paths.moves = vec![(source.clone(), paths.marker.clone())];
        let booted = boot(
            &paths,
            Some(fixed_slots(&paths, &vault, &Arc::default())),
            |_| panic!("no removal"),
            || panic!("no removal"),
        );
        assert_eq!(booted.err(), Some(FAILED.into()), "{case}");
        assert!(!vault.root.exists(), "{case}: nothing set up");
        assert!(vault.calls().is_empty(), "{case}");
        assert!(fs::symlink_metadata(&source).is_ok() && !paths.marker.exists());
    }
}

#[test]
fn fresh_setup_failing_after_removal_leaves_it_complete() {
    for stall in [false, true] {
        let (_dir, paths) = fixture();
        let vault = Vault::new(paths.plugin_inventory().unwrap());
        let other = Arc::<Fake>::default();
        failed_setup(&paths, &vault, &other);
        *vault.store.add_denied.lock().unwrap() = true;
        let instance = boot_fixed(&paths, &vault, &other);
        let intent = installation(&vault);
        remove(&instance, &paths, PLAIN).unwrap();
        drop(instance);
        vault.calls();
        let mut slots = fixed_slots(&paths, &vault, &other);
        let held = stall.then(|| {
            *vault.store.add_denied.lock().unwrap() = false;
            slots.wait = Duration::from_millis(300);
            let (started, entered) = mpsc::channel();
            let (release, released) = mpsc::channel();
            *vault.store.add_stall.lock().unwrap() = Some((started, released));
            (entered, release)
        });
        let removed = std::cell::Cell::new(0);
        let booted = boot_removing(&paths, &vault, slots, &removed);
        // Removal finished before setup was asked for, whatever it does.
        assert_eq!(removed.get(), 1, "stall={stall}");
        assert!(!paths.marker.exists(), "stall={stall}");
        assert_eq!(adds(&vault), 1, "one attempt, stall={stall}");
        match held {
            None => {
                let instance = booted.unwrap();
                assert!(instance.h1_unknown() && instance.partial);
                assert!(instance.plugin_inventory().is_none());
                let fresh = installation(&vault);
                assert_eq!(fresh["committed"], false);
                assert_ne!(fresh["installation"], intent["installation"]);
                assert!(vault.saved().is_empty(), "no witness, old or new");
            }
            Some((entered, release)) => {
                // Timed out: this launch stops, its worker keeps the locks.
                assert_eq!(booted.err(), Some(SAVING.into()));
                assert_eq!(entered.recv_timeout(BUDGET).unwrap(), Step::Stalled);
                assert!(!exclusive(&paths.key_lock) && !exclusive(&paths.lock));
                release.send(()).unwrap();
                released_lock(&paths.key_lock);
                released_lock(&paths.lock);
                assert!(!paths.marker.exists());
                let instance = boot_fixed(&paths, &vault, &other);
                assert!(!instance.h1_unknown());
                assert_eq!(adds(&vault), 0, "the late setup is not repeated");
            }
        }
        *vault.store.add_denied.lock().unwrap() = false;
    }
}

#[test]
fn empty_state_write_failing_before_rename_refuses_then_retries() {
    use std::os::unix::fs::PermissionsExt;
    let (_dir, paths) = fixture();
    let vault = Vault::new(paths.plugin_inventory().unwrap());
    let other = Arc::<Fake>::default();
    failed_setup(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = true;
    let instance = boot_fixed(&paths, &vault, &other);
    *vault.store.add_denied.lock().unwrap() = false;
    assert!(instance.partial);
    let before = fs::read(vault.root.join("state.json")).unwrap();
    let permissions = |mode| fs::set_permissions(&vault.root, fs::Permissions::from_mode(mode));
    permissions(0o555).unwrap();
    // The fixture really stops new files here, as the atomic write needs.
    let probe = fs::write(vault.root.join("probe"), b"").unwrap_err();
    assert_eq!(probe.kind(), ErrorKind::PermissionDenied);
    let refused = remove(&instance, &paths, PLAIN);
    permissions(0o755).unwrap();
    assert_eq!(refused, Err(refuse(H1_UNKNOWN)));
    assert!(!paths.marker.exists());
    assert_eq!(fs::read(vault.root.join("state.json")).unwrap(), before);
    remove(&instance, &paths, PLAIN).unwrap();
    assert!(paths.marker.exists());
    assert_eq!(installation(&vault), serde_json::Value::Null);
}
