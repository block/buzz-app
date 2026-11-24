//! Fake store only; inventory and declared filesystem discovery are real.
use super::*;
use crate::secrets::{continuity as installation, preflight};
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::sync::mpsc;

fn scope(env: &Env) -> preflight::Scope {
    let base = fs::canonicalize(env.temp.path()).unwrap();
    preflight::Scope {
        inventories: vec![base.join("secrets"), base.join("other-build-inventory")],
        homes: vec![base.join("home"), base.join("alternate-home")],
    }
}
/// The other build's root, bound to `scope`, with a separate witness store.
fn peer(scope: &preflight::Scope, store: &Arc<Fake>) -> installation::Peer {
    installation::Peer::new(scope.inventories[1].clone(), scope.clone(), store.clone())
}
fn establish(env: &Env, scope: &preflight::Scope) -> Result<installation::Established> {
    installation::establish(
        scope,
        &scope.inventories[0],
        env.store.as_ref(),
        peer(scope, &Arc::default()),
    )
}
fn state(scope: &preflight::Scope) -> Value {
    serde_json::from_slice(&fs::read(scope.inventories[0].join(STATE)).unwrap()).unwrap()
}
fn write_state(scope: &preflight::Scope, state: &Value) {
    fs::write(
        scope.inventories[0].join(STATE),
        serde_json::to_vec(state).unwrap(),
    )
    .unwrap();
}

#[test]
fn fresh_pair_survives_restart_provider_clear_and_journaled_sign_out() {
    let env = Env::new();
    env.ready(SLOT);
    let scope = scope(&env);
    let observed = establish(&env, &scope).unwrap();
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
    assert!(state(&scope)["installation"]["committed"]
        .as_bool()
        .unwrap());
    assert!(state(&scope).get("signedOutSeen").is_none());
    assert!(
        preflight::inspect(&scope).is_err(),
        "a pair is not no-H1 absence"
    );
    let witness = env.store.items.lock().unwrap()[installation::ACCOUNT].clone();
    observe_sign_outs(&scope.inventories[0], 0).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    observed.inspect(&scope).unwrap();
    establish(&env, &scope).unwrap();
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 2);
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    begin_sign_out(&scope.inventories[0], Some(ALICE), None).unwrap();
    finish_sign_out(
        &scope.inventories[0],
        env.store.as_ref(),
        Duration::from_secs(5),
    )
    .unwrap();
    observe_sign_outs(&scope.inventories[0], 1).unwrap();
    establish(&env, &scope).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    assert_eq!(env.store.items.lock().unwrap().len(), 1);
    assert_eq!(
        env.store.items.lock().unwrap()[installation::ACCOUNT],
        witness
    );
}

#[test]
fn count_only_preexisting_v3_and_foreign_evidence_never_get_retroactive_witnesses() {
    for prior in ["count", "zero", "v3", "foreign"] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        match prior {
            "count" | "zero" => {
                fs::create_dir(&scope.inventories[0]).unwrap();
                write_state(
                    &scope,
                    &json!({"version":1,"namespaces":[],"signedOutSeen":if prior == "zero" {0} else {1}}),
                );
            }
            "v3" => {
                env.set(ALICE, SENTINEL).unwrap();
            }
            _ => {
                fs::create_dir(&scope.inventories[1]).unwrap();
            }
        }
        let adds = env.store.adds.load(Ordering::SeqCst);
        assert!(establish(&env, &scope).is_err(), "{prior}");
        assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
        assert!(!env
            .store
            .items
            .lock()
            .unwrap()
            .contains_key(installation::ACCOUNT));
    }
}

#[test]
fn missing_malformed_mismatched_or_denied_pair_refuses_without_repair() {
    for damage in ["inventory", "witness", "malformed", "scope", "denied"] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        establish(&env, &scope).unwrap();
        match damage {
            "inventory" => fs::remove_dir_all(&scope.inventories[0]).unwrap(),
            "witness" => {
                env.store
                    .items
                    .lock()
                    .unwrap()
                    .remove(installation::ACCOUNT);
            }
            "malformed" => {
                env.store
                    .items
                    .lock()
                    .unwrap()
                    .insert(installation::ACCOUNT.into(), b"broken".to_vec());
            }
            "denied" => {
                *env.store.fail_read.lock().unwrap() = Some(Error::Denied);
            }
            _ => {
                let mut record = state(&scope);
                if damage == "scope" {
                    record["installation"]["installation"]["scope"] = json!("0".repeat(64));
                } else {
                    record["installation"]["committed"] = json!(false);
                }
                write_state(&scope, &record);
            }
        }
        let adds = env.store.adds.load(Ordering::SeqCst);
        let deletes = env.store.deletes.load(Ordering::SeqCst);
        assert!(establish(&env, &scope).is_err(), "{damage}");
        assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
        assert_eq!(env.store.deletes.load(Ordering::SeqCst), deletes);
    }
}

#[test]
fn changed_intent_is_neither_completed_nor_cancelled_later() {
    let env = Env::new();
    env.ready(SLOT);
    let scope = scope(&env);
    let root = scope.inventories[0].clone();
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |account| {
        if account == installation::ACCOUNT {
            let path = root.join(STATE);
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["signedOutSeen"] = json!(0);
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
    }));
    assert!(establish(&env, &scope).is_err());
    assert_eq!(state(&scope)["installation"]["committed"], false);
    *env.store.on_add.lock().unwrap() = None;
    let (adds, deletes) = counts(&env.store);
    assert!(establish(&env, &scope).is_err());
    assert_eq!(counts(&env.store), (adds, deletes));
    assert!(has_witness(&env));
}

#[test]
fn held_os_add_keeps_completion_lock_but_no_metadata_lock() {
    let env = Env::new();
    env.ready(SLOT);
    let scope = scope(&env);
    let root = scope.inventories[0].clone();
    let (started, entered) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let released = Mutex::new(released);
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |account| {
        if account == installation::ACCOUNT {
            assert!(try_lock(&root.join("installation.lock")).unwrap().is_none());
            let _g = try_lock(&root.join("state.lock")).unwrap().unwrap();
            started.send(()).unwrap();
            drop(_g);
            released
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(10))
                .unwrap();
        }
    }));
    std::thread::scope(|threads| {
        let worker = threads.spawn(|| establish(&env, &scope));
        entered.recv_timeout(Duration::from_secs(10)).unwrap();
        let duplicate = establish(&env, &scope);
        release.send(()).unwrap();
        assert!(duplicate.is_err());
        worker.join().unwrap().unwrap().inspect(&scope).unwrap();
    });
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 1);
}

#[test]
fn valid_pair_does_not_hide_alternate_inventory_registry_or_link_evidence() {
    for damage in ["inventory", "registry", "link"] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        let observed = establish(&env, &scope).unwrap();
        observe_sign_outs(&scope.inventories[0], 0).unwrap();
        env.set(ALICE, SENTINEL).unwrap();
        let alternate = scope.homes[1].join("profiles/test");
        match damage {
            "inventory" => fs::create_dir(&scope.inventories[1]).unwrap(),
            "registry" => {
                fs::create_dir_all(&alternate).unwrap();
                fs::copy(
                    env.manager.root.join("registry.json"),
                    alternate.join("registry.json"),
                )
                .unwrap();
            }
            _ => {
                fs::create_dir_all(alternate.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(env.manager.root.clone(), &alternate).unwrap();
            }
        }
        assert!(observed.inspect(&scope).is_err(), "{damage}");
        assert!(establish(&env, &scope).is_err(), "{damage}");
    }
}

#[test]
fn readable_committed_journal_cleanup_remains_available_after_witness_loss() {
    let env = Env::new();
    env.ready(SLOT);
    let scope = scope(&env);
    establish(&env, &scope).unwrap();
    observe_sign_outs(&scope.inventories[0], 0).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    begin_sign_out(&scope.inventories[0], Some(ALICE), None).unwrap();
    env.store
        .items
        .lock()
        .unwrap()
        .remove(installation::ACCOUNT);
    assert!(establish(&env, &scope).is_err());
    *env.store.fail_delete.lock().unwrap() = Some(Error::Denied);
    assert!(finish_sign_out(
        &scope.inventories[0],
        env.store.as_ref(),
        Duration::from_secs(5)
    )
    .is_err());
    assert!(sign_out_pending(&scope.inventories[0]).unwrap());
    *env.store.fail_delete.lock().unwrap() = None;
    finish_sign_out(
        &scope.inventories[0],
        env.store.as_ref(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert!(!sign_out_pending(&scope.inventories[0]).unwrap());
    assert!(
        establish(&env, &scope).is_err(),
        "cleanup does not repair missing continuity"
    );
}

#[test]
fn established_namespace_accepts_exact_registry_limit() {
    let env = Env::new();
    env.ready(SLOT);
    let scope = scope(&env);
    let observed = establish(&env, &scope).unwrap();
    observe_sign_outs(&scope.inventories[0], 0).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    let path = env.manager.root.join("registry.json");
    let mut bytes = fs::read(&path).unwrap();
    bytes.resize(crate::LIMIT as usize, b' ');
    fs::write(&path, &bytes).unwrap();
    observed.inspect(&scope).unwrap();
}

#[test]
fn established_namespace_refuses_oversized_valid_json_prefix_and_whitespace() {
    for extra in [1, 2, 1024] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        let observed = establish(&env, &scope).unwrap();
        observe_sign_outs(&scope.inventories[0], 0).unwrap();
        env.set(ALICE, SENTINEL).unwrap();
        let path = env.manager.root.join("registry.json");
        let mut bytes = fs::read(&path).unwrap();
        bytes.resize(crate::LIMIT as usize + extra, b' ');
        if extra == 1024 {
            *bytes.last_mut().unwrap() = b'{';
        }
        fs::write(&path, &bytes).unwrap();
        let adds = env.store.adds.load(Ordering::SeqCst);
        let before = fs::read(scope.inventories[0].join(STATE)).unwrap();
        assert!(observed.inspect(&scope).is_err(), "oversized registry with {extra} bytes beyond the limit must not qualify its valid bounded prefix");
        assert!(establish(&env, &scope).is_err());
        assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
        assert_eq!(fs::read(scope.inventories[0].join(STATE)).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

// ------------------------------------------------ supported-build coexistence

use installation::Build;

/// Both supported builds' views: this build at `inventories[0]` with `env.store`,
/// the other at `inventories[1]` with its own store and its own, different scope
/// (an extra home), as the native builds' backup homes differ.
struct Builds {
    scope: preflight::Scope,
    other_scope: preflight::Scope,
    other: Arc<Fake>,
}
impl Builds {
    fn new(env: &Env) -> Self {
        let scope = scope(env);
        let mut other_scope = scope.clone();
        other_scope.homes.push(
            fs::canonicalize(env.temp.path())
                .unwrap()
                .join("other-home"),
        );
        assert_ne!(scope, other_scope);
        Self {
            scope,
            other_scope,
            other: Arc::default(),
        }
    }
    /// This build's peer: the other's root, bound to the other's own scope.
    fn peer_of_this(&self) -> installation::Peer {
        installation::Peer::new(
            self.scope.inventories[1].clone(),
            self.other_scope.clone(),
            self.other.clone(),
        )
    }
    fn this(&self, env: &Env) -> Result<installation::Established> {
        installation::establish_as(
            Build::THIS,
            &self.scope,
            &self.scope.inventories[0],
            env.store.as_ref(),
            self.peer_of_this(),
        )
    }
    fn other(&self, env: &Env) -> Result<installation::Established> {
        self.other_in(env, &self.other_scope, &self.scope.inventories[1])
    }
    /// The other build establishing under `scope` at `root`.
    fn other_in(
        &self,
        env: &Env,
        scope: &preflight::Scope,
        root: &Path,
    ) -> Result<installation::Established> {
        installation::establish_as(
            Build::OTHER,
            scope,
            root,
            self.other.as_ref(),
            installation::Peer::new(
                self.scope.inventories[0].clone(),
                self.scope.clone(),
                env.store.clone(),
            ),
        )
    }
    fn other_state(&self) -> Value {
        serde_json::from_slice(&fs::read(self.scope.inventories[1].join(STATE)).unwrap()).unwrap()
    }
    fn write_other_state(&self, state: &Value) {
        fs::write(
            self.scope.inventories[1].join(STATE),
            serde_json::to_vec(state).unwrap(),
        )
        .unwrap();
    }
}
fn counts(store: &Fake) -> (usize, usize) {
    (
        store.adds.load(Ordering::SeqCst),
        store.deletes.load(Ordering::SeqCst),
    )
}

#[test]
fn supported_builds_coexist_in_either_order_and_sign_out_independently() {
    for this_first in [true, false] {
        let env = Env::new();
        env.ready(SLOT);
        let builds = Builds::new(&env);
        let (first, second) = if this_first {
            (builds.this(&env).unwrap(), builds.other(&env).unwrap())
        } else {
            (builds.other(&env).unwrap(), builds.this(&env).unwrap())
        };
        let (this, other) = if this_first {
            (first, second)
        } else {
            (second, first)
        };
        // Each build added only its own witness.
        assert_eq!(counts(&env.store), (1, 0));
        assert_eq!(counts(&builds.other), (1, 0));
        let other_witness = builds.other.items.lock().unwrap().clone();
        // This build's enrollment is accounted for by its owner in both views.
        observe_sign_outs(&builds.scope.inventories[0], 0).unwrap();
        env.set(ALICE, SENTINEL).unwrap();
        this.requalify(&builds.scope).unwrap();
        other.requalify(&builds.other_scope).unwrap();
        // Revisiting either build requalifies its existing pair without a write.
        builds.this(&env).unwrap();
        builds.other(&env).unwrap();
        assert_eq!(counts(&env.store), (2, 0));
        assert_eq!(counts(&builds.other), (1, 0));
        // This build's sign-out cleans only its own accounts.
        let before = fs::read(builds.scope.inventories[1].join(STATE)).unwrap();
        begin_sign_out(&builds.scope.inventories[0], Some(ALICE), None).unwrap();
        finish_sign_out(
            &builds.scope.inventories[0],
            env.store.as_ref(),
            Duration::from_secs(5),
        )
        .unwrap();
        observe_sign_outs(&builds.scope.inventories[0], 1).unwrap();
        assert_eq!(env.status(ALICE), SecretStatus::Missing);
        builds.this(&env).unwrap();
        builds.other(&env).unwrap();
        other.inspect(&builds.other_scope).unwrap();
        assert_eq!(counts(&builds.other), (1, 0));
        assert_eq!(*builds.other.items.lock().unwrap(), other_witness);
        assert_eq!(
            fs::read(builds.scope.inventories[1].join(STATE)).unwrap(),
            before
        );
    }
}

#[test]
fn other_build_evidence_qualifies_only_as_its_exact_committed_pair() {
    for damage in [
        "uncommitted",
        "witness",
        "mismatch",
        "denied",
        "malformed",
        "variant",
        "no-record",
        "empty",
        "orphan",
        "lost-registry",
    ] {
        let env = Env::new();
        env.ready(SLOT);
        let builds = Builds::new(&env);
        builds.other(&env).unwrap();
        let mut state = builds.other_state();
        match damage {
            "uncommitted" => {
                state["installation"]["committed"] = json!(false);
                builds.write_other_state(&state);
            }
            "witness" => {
                builds.other.items.lock().unwrap().clear();
            }
            "mismatch" => {
                let mut witness: Value = serde_json::from_slice(
                    &builds.other.items.lock().unwrap()[installation::ACCOUNT],
                )
                .unwrap();
                witness["id"] = json!(fresh());
                builds.other.items.lock().unwrap().insert(
                    installation::ACCOUNT.into(),
                    serde_json::to_vec(&witness).unwrap(),
                );
            }
            "denied" => *builds.other.fail_read.lock().unwrap() = Some(Error::Denied),
            "malformed" => fs::write(builds.scope.inventories[1].join(STATE), b"{").unwrap(),
            "variant" => {
                state["installation"]["installation"]["variant"] = json!(VARIANT);
                builds.write_other_state(&state);
            }
            "no-record" => {
                state.as_object_mut().unwrap().remove("installation");
                builds.write_other_state(&state);
            }
            "empty" => {
                fs::remove_dir_all(&builds.scope.inventories[1]).unwrap();
                fs::create_dir(&builds.scope.inventories[1]).unwrap();
            }
            "orphan" => fs::write(
                builds.scope.inventories[1].join(format!("ns-{}.json", "a".repeat(64))),
                b"{}",
            )
            .unwrap(),
            _ => {
                // The other build's live enrollment, its registry since lost:
                // swap roles so this build's real Manager is "the other".
                let peer_of_other = builds.other(&env).unwrap();
                builds.this(&env).unwrap();
                observe_sign_outs(&builds.scope.inventories[0], 0).unwrap();
                env.set(ALICE, SENTINEL).unwrap();
                peer_of_other.requalify(&builds.other_scope).unwrap();
                fs::remove_file(env.manager.root.join("registry.json")).unwrap();
                assert!(peer_of_other.inspect(&builds.other_scope).is_err());
                continue;
            }
        }
        let adds = counts(&env.store);
        assert!(builds.this(&env).is_err(), "{damage}");
        assert_eq!(counts(&env.store), adds, "{damage}");
        assert!(!env
            .store
            .items
            .lock()
            .unwrap()
            .contains_key(installation::ACCOUNT));
        assert!(
            !builds.scope.inventories[0].exists(),
            "{damage}: no intent written beside unqualified evidence"
        );
    }
}

#[test]
fn other_build_appearing_after_qualification_is_read_once_per_installation() {
    let env = Env::new();
    env.ready(SLOT);
    let builds = Builds::new(&env);
    let this = builds.this(&env).unwrap();
    builds.other(&env).unwrap();
    let reads = || builds.other.reads.load(Ordering::SeqCst);
    let before = reads();
    assert!(this.inspect(&builds.scope).is_err());
    assert_eq!(
        reads(),
        before,
        "filesystem inspection never opens the store"
    );
    this.requalify(&builds.scope).unwrap();
    assert_eq!(reads(), before + 1, "a new peer is read fresh");
    this.inspect(&builds.scope).unwrap();
    this.requalify(&builds.scope).unwrap();
    assert_eq!(reads(), before + 1, "the same installation is not re-read");
    // A replaced installation is a new peer, read afresh and refused on mismatch.
    let mut state = builds.other_state();
    state["installation"]["installation"]["id"] = json!(fresh());
    builds.write_other_state(&state);
    assert!(this.inspect(&builds.scope).is_err());
    assert_eq!(reads(), before + 1);
    assert!(this.requalify(&builds.scope).is_err());
    assert_eq!(reads(), before + 2);
}

#[test]
fn peer_witness_is_read_on_the_requalifying_thread() {
    let env = Env::new();
    env.ready(SLOT);
    let builds = Builds::new(&env);
    let this = builds.this(&env).unwrap();
    builds.other(&env).unwrap();
    let readers = Arc::new(Mutex::new(Vec::new()));
    let seen = readers.clone();
    *builds.other.on_read.lock().unwrap() = Some(Arc::new(move |_| {
        seen.lock().unwrap().push(std::thread::current().id());
    }));
    this.requalify(&builds.scope).unwrap();
    // The caller's completion ownership spans the OS read only if it runs here.
    assert_eq!(*readers.lock().unwrap(), [std::thread::current().id()]);
}

/// Plant the other build's committed pair, matching its own witness, at its
/// fixed root but bound to a scope other than its expected one.
fn plant_misbound_peer(env: &Env, builds: &Builds, case: &str) {
    let base = fs::canonicalize(env.temp.path()).unwrap();
    let mut foreign = builds.other_scope.clone();
    let root = builds.scope.inventories[1].clone();
    match case {
        "root" => {
            let elsewhere = base.join("relocated-inventory");
            foreign.inventories[1] = elsewhere.clone();
            builds.other_in(env, &foreign, &elsewhere).unwrap();
            fs::rename(&elsewhere, &root).unwrap();
        }
        "home" => {
            foreign.homes.push(base.join("stray-home"));
            builds.other_in(env, &foreign, &root).unwrap();
        }
        _ => {
            foreign.inventories.push(base.join("third-inventory"));
            builds.other_in(env, &foreign, &root).unwrap();
        }
    }
    let witness: Value =
        serde_json::from_slice(&builds.other.items.lock().unwrap()[installation::ACCOUNT]).unwrap();
    assert_eq!(
        builds.other_state()["installation"]["installation"],
        witness
    );
    assert_eq!(builds.other_state()["installation"]["committed"], true);
}

#[test]
fn other_build_pair_bound_elsewhere_refuses_despite_its_matching_witness() {
    for case in ["root", "home", "declared"] {
        for join in ["fresh", "established", "cancel"] {
            let env = Env::new();
            env.ready(SLOT);
            let builds = Builds::new(&env);
            let established = (join == "established").then(|| builds.this(&env).unwrap());
            plant_misbound_peer(&env, &builds, case);
            if join == "cancel" {
                // The other build refuses beside an intent: park its unchanged
                // pair while this build's fresh setup fails, then expose it.
                let parked = env.temp.path().join("parked");
                fs::rename(&builds.scope.inventories[1], &parked).unwrap();
                *env.store.fail_add.lock().unwrap() = Some(Error::Denied);
                assert!(builds.this(&env).is_err());
                *env.store.fail_add.lock().unwrap() = None;
                fs::rename(&parked, &builds.scope.inventories[1]).unwrap();
            }
            let before = fs::read(builds.scope.inventories[0].join(STATE)).ok();
            let witness = env.store.items.lock().unwrap().clone();
            let adds = counts(&env.store);
            let refused = match &established {
                Some(observed) => {
                    observed.requalify(&builds.scope).is_err()
                        && observed.inspect(&builds.scope).is_err()
                }
                None if join == "cancel" => installation::cancel(
                    &builds.scope,
                    &builds.scope.inventories[0],
                    env.store.as_ref(),
                    builds.peer_of_this(),
                )
                .is_err(),
                None => builds.this(&env).is_err(),
            };
            assert!(refused, "{case}/{join}");
            assert_eq!(counts(&env.store), adds, "{case}/{join}");
            assert_eq!(*env.store.items.lock().unwrap(), witness, "{case}/{join}");
            assert_eq!(
                fs::read(builds.scope.inventories[0].join(STATE)).ok(),
                before,
                "{case}/{join}: no selected intent or commit"
            );
        }
    }
}

/// Each file's path and bytes.
type Files = Vec<(PathBuf, Vec<u8>)>;

/// Snapshot of the files a set leaves at the moment of its OS add.
fn capture_writing(env: &Env, inventory: &Path) -> Arc<Mutex<Files>> {
    let stash = Arc::new(Mutex::new(Vec::new()));
    let (inventory, registry, into) = (
        inventory.to_owned(),
        env.manager.root.join("registry.json"),
        stash.clone(),
    );
    *env.store.on_add.lock().unwrap() = Some(Arc::new(move |account| {
        if account == installation::ACCOUNT {
            return;
        }
        let mut files = vec![registry.clone(), inventory.join(STATE)];
        for entry in fs::read_dir(&inventory).unwrap() {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if name.starts_with("ns-") && name.ends_with(".json") {
                files.push(path);
            }
        }
        *into.lock().unwrap() = files
            .into_iter()
            .map(|path| {
                let bytes = fs::read(&path).unwrap();
                (path, bytes)
            })
            .collect();
    }));
    stash
}

fn delist(inventory: &Path) {
    let path = inventory.join(STATE);
    let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(state["namespaces"].as_array().unwrap().len(), 1);
    state["namespaces"] = json!([]);
    fs::write(path, serde_json::to_vec(&state).unwrap()).unwrap();
}

#[test]
fn valid_namespace_and_registry_missing_only_from_the_index_never_qualify() {
    for owner in ["selected", "peer"] {
        for phase in ["live", "writing"] {
            let env = Env::new();
            env.ready(SLOT);
            let builds = Builds::new(&env);
            // The selected view is this build's; the peer view is the other
            // build's, whose peer is this build's real enrollment.
            let peer_view = (owner == "peer").then(|| builds.other(&env).unwrap());
            let this = builds.this(&env).unwrap();
            let inventory = builds.scope.inventories[0].clone();
            observe_sign_outs(&inventory, 0).unwrap();
            env.set(ALICE, SENTINEL).unwrap();
            if phase == "writing" {
                let stash = capture_writing(&env, &inventory);
                env.set(ALICE, "replacement").unwrap();
                *env.store.on_add.lock().unwrap() = None;
                for (path, bytes) in stash.lock().unwrap().iter() {
                    fs::write(path, bytes).unwrap();
                }
            }
            let (scope, observed) = match &peer_view {
                Some(view) => (&builds.other_scope, view),
                None => (&builds.scope, &this),
            };
            observed.requalify(scope).unwrap();
            observed.inspect(scope).unwrap();
            delist(&inventory);
            let files: Vec<_> = fs::read_dir(&inventory)
                .unwrap()
                .chain(fs::read_dir(&env.manager.root).unwrap())
                .map(|entry| {
                    let path = entry.unwrap().path();
                    let bytes = fs::read(&path).ok();
                    (path, bytes)
                })
                .collect();
            let (ours, theirs) = (counts(&env.store), counts(&builds.other));
            assert!(observed.inspect(scope).is_err(), "{owner}/{phase}");
            assert!(observed.requalify(scope).is_err(), "{owner}/{phase}");
            let fresh = match owner {
                "peer" => builds.other(&env),
                _ => builds.this(&env),
            };
            assert!(fresh.is_err(), "{owner}/{phase}");
            for (path, bytes) in files {
                assert_eq!(fs::read(&path).ok(), bytes, "{owner}/{phase}: {path:?}");
            }
            assert_eq!((counts(&env.store), counts(&builds.other)), (ours, theirs));
        }
    }
}

#[test]
fn unlisted_retired_debt_without_a_live_registry_still_qualifies() {
    for owner in ["selected", "peer"] {
        let env = Env::new();
        env.ready(SLOT);
        let builds = Builds::new(&env);
        let peer_view = (owner == "peer").then(|| builds.other(&env).unwrap());
        let this = builds.this(&env).unwrap();
        let inventory = builds.scope.inventories[0].clone();
        observe_sign_outs(&inventory, 0).unwrap();
        env.set(ALICE, SENTINEL).unwrap();
        env.manager
            .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
            .unwrap();
        delist(&inventory);
        fs::remove_file(env.manager.root.join("registry.json")).unwrap();
        match &peer_view {
            Some(view) => view.requalify(&builds.other_scope).unwrap(),
            None => this.inspect(&builds.scope).unwrap(),
        }
    }
}

#[test]
fn erase_scope_reports_only_the_other_builds_unretired_custody_in_wiped_homes() {
    let env = Env::new();
    env.ready(SLOT);
    let builds = Builds::new(&env);
    builds.this(&env).unwrap();
    // From the other build's view, this build's real enrollment is peer custody.
    let other = builds.other(&env).unwrap();
    let home = builds.scope.homes[0].clone();
    let alternate = builds.scope.homes[1].clone();
    assert!(!other.peer_custody_in(std::slice::from_ref(&home)).unwrap());
    observe_sign_outs(&builds.scope.inventories[0], 0).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    assert!(other.peer_custody_in(std::slice::from_ref(&home)).unwrap());
    assert!(!other.peer_custody_in(&[alternate]).unwrap());
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    assert!(
        !other.peer_custody_in(std::slice::from_ref(&home)).unwrap(),
        "retired debt survives a wipe"
    );
    fs::write(env.ns_path(), b"{").unwrap();
    assert!(other.peer_custody_in(&[home]).is_err());
}

// ------------------------------------------------ setup cancellation

fn cancel(env: &Env, scope: &preflight::Scope) -> Result<installation::Empty> {
    installation::cancel(
        scope,
        &scope.inventories[0],
        env.store.as_ref(),
        peer(scope, &Arc::default()),
    )
}
fn witness_id(env: &Env) -> Value {
    serde_json::from_slice::<Value>(&env.store.items.lock().unwrap()[installation::ACCOUNT])
        .unwrap()["id"]
        .clone()
}
fn has_witness(env: &Env) -> bool {
    env.store
        .items
        .lock()
        .unwrap()
        .contains_key(installation::ACCOUNT)
}
/// This build's uncommitted intent, with its exact witness when `added`.
fn interrupted(env: &Env, scope: &preflight::Scope, added: bool) -> Value {
    let late = scope.homes[0].join("profiles/late");
    if added {
        // The add succeeds; unrelated evidence then stops the commit.
        let late = late.clone();
        *env.store.on_add.lock().unwrap() = Some(Arc::new(move |_| {
            fs::create_dir_all(&late).unwrap();
            fs::write(late.join("registry.json"), b"interrupted").unwrap();
        }));
    } else {
        *env.store.fail_add.lock().unwrap() = Some(Error::Denied);
    }
    assert!(establish(env, scope).is_err());
    *env.store.fail_add.lock().unwrap() = None;
    *env.store.on_add.lock().unwrap() = None;
    let _ = fs::remove_dir_all(&late);
    let intent = state(scope)["installation"].clone();
    assert_eq!(intent["committed"], false);
    assert_eq!(has_witness(env), added);
    intent
}
/// A fresh pair that can enroll, use and clear a credential, then sign out.
fn usable(env: &Env, scope: &preflight::Scope, observed: &installation::Established) {
    assert_eq!(state(scope)["installation"]["committed"], true);
    assert_eq!(
        witness_id(env),
        state(scope)["installation"]["installation"]["id"]
    );
    observe_sign_outs(&scope.inventories[0], 0).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    observed.inspect(scope).unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    env.manager
        .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
        .unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
    env.set(ALICE, SENTINEL).unwrap();
    begin_sign_out(&scope.inventories[0], Some(ALICE), None).unwrap();
    finish_sign_out(
        &scope.inventories[0],
        env.store.as_ref(),
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(env.status(ALICE), SecretStatus::Missing);
}

#[test]
fn interrupted_setup_is_cancelled_then_freshly_initialized_never_finished() {
    for added in [false, true] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        let intent = interrupted(&env, &scope, added);
        let (adds, deletes) = counts(&env.store);
        let observed = establish(&env, &scope).unwrap();
        // Only the old exact witness was deleted, and one new one added.
        assert_eq!(counts(&env.store), (adds + 1, deletes + usize::from(added)));
        assert_ne!(witness_id(&env), intent["installation"]["id"]);
        assert_ne!(
            state(&scope)["installation"]["installation"]["id"],
            intent["installation"]["id"]
        );
        usable(&env, &scope, &observed);
        // The next launch qualifies the new pair without a write.
        let used = counts(&env.store);
        establish(&env, &scope).unwrap();
        assert_eq!(counts(&env.store), used);
    }
}

#[test]
fn cancellation_leaves_explicit_empty_state_and_holds_off_initializers() {
    for added in [false, true] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        let intent = interrupted(&env, &scope, added);
        let lock = scope.inventories[0].join("installation.lock");
        let identity = fs::metadata(&lock).unwrap().ino();
        let empty = cancel(&env, &scope).unwrap();
        assert_eq!(state(&scope), json!({"version": 1, "namespaces": []}));
        assert!(!has_witness(&env));
        assert_eq!(fs::metadata(&lock).unwrap().ino(), identity);
        empty.inspect(&scope).unwrap();
        // An initializer cannot replace the empty state while it is relied on.
        let adds = env.store.adds.load(Ordering::SeqCst);
        assert!(establish(&env, &scope).is_err());
        assert_eq!(env.store.adds.load(Ordering::SeqCst), adds);
        assert_eq!(state(&scope), json!({"version": 1, "namespaces": []}));
        drop(empty);
        // A retry reaffirms the empty state without an OS delete.
        let deletes = env.store.deletes.load(Ordering::SeqCst);
        drop(cancel(&env, &scope).unwrap());
        assert_eq!(env.store.deletes.load(Ordering::SeqCst), deletes);
        let observed = establish(&env, &scope).unwrap();
        assert_ne!(witness_id(&env), intent["installation"]["id"]);
        assert_eq!(fs::metadata(&lock).unwrap().ino(), identity);
        usable(&env, &scope, &observed);
    }
}

#[test]
fn empty_state_inspection_refuses_any_later_evidence() {
    for change in ["witness", "count", "unlisted"] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        interrupted(&env, &scope, true);
        let empty = cancel(&env, &scope).unwrap();
        match change {
            "witness" => {
                env.store
                    .items
                    .lock()
                    .unwrap()
                    .insert(installation::ACCOUNT.into(), b"late".to_vec());
                // Filesystem only: a late witness is for the next fresh read.
                empty.inspect(&scope).unwrap();
                drop(empty);
                assert!(cancel(&env, &scope).is_err());
                assert!(establish(&env, &scope).is_err());
                continue;
            }
            "count" => write_state(
                &scope,
                &json!({"version": 1, "namespaces": [], "signedOutSeen": 0}),
            ),
            _ => fs::write(
                scope.inventories[0].join(format!("ns-{}.json", "a".repeat(64))),
                b"{}",
            )
            .unwrap(),
        }
        assert!(empty.inspect(&scope).is_err(), "{change}");
    }
}

#[test]
fn cancellation_refuses_everything_but_the_exact_empty_intent_without_writes() {
    for case in [
        "absent",
        "bare",
        "committed",
        "scope",
        "variant",
        "mismatch",
        "malformed",
        "denied",
        "listed",
        "unlisted",
        "zero",
        "count",
        "journal",
        "v3",
        "peer",
        "busy",
        "delete-denied",
        "delete-unconfirmed",
        "late",
    ] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        if case == "absent" {
            assert!(cancel(&env, &scope).is_err());
            assert!(!scope.inventories[0].exists());
            continue;
        }
        let mut record = interrupted(&env, &scope, true);
        record = json!({"version": 1, "namespaces": [], "installation": record});
        let mut edit = |change: &dyn Fn(&mut Value)| {
            change(&mut record);
            write_state(&scope, &record);
        };
        let mut held = None;
        match case {
            "bare" => fs::remove_file(scope.inventories[0].join(STATE)).unwrap(),
            "committed" => edit(&|state| state["installation"]["committed"] = json!(true)),
            "scope" => edit(&|state| {
                state["installation"]["installation"]["scope"] = json!("0".repeat(64))
            }),
            "variant" => edit(&|state| {
                state["installation"]["installation"]["variant"] = json!(PEER_VARIANT)
            }),
            "listed" => edit(&|state| state["namespaces"] = json!(["a".repeat(64)])),
            "zero" => edit(&|state| state["signedOutSeen"] = json!(0)),
            "count" => edit(&|state| state["signedOutSeen"] = json!(1)),
            "journal" => edit(&|state| state["journal"] = json!({"identity": ALICE})),
            "mismatch" | "malformed" => {
                let bytes = if case == "malformed" {
                    b"broken".to_vec()
                } else {
                    let mut witness = record["installation"]["installation"].clone();
                    witness["id"] = json!(fresh());
                    serde_json::to_vec(&witness).unwrap()
                };
                env.store
                    .items
                    .lock()
                    .unwrap()
                    .insert(installation::ACCOUNT.into(), bytes);
            }
            "denied" => *env.store.fail_read.lock().unwrap() = Some(Error::Denied),
            "unlisted" => fs::write(
                scope.inventories[0].join(format!("ns-{}.json", "a".repeat(64))),
                b"{}",
            )
            .unwrap(),
            "v3" => {
                // This build's custody evidence from another inventory's enrollment.
                let source = Env::new();
                source.ready(SLOT);
                let source_scope = self::scope(&source);
                establish(&source, &source_scope).unwrap();
                observe_sign_outs(&source_scope.inventories[0], 0).unwrap();
                source.set(ALICE, SENTINEL).unwrap();
                let copied = scope.homes[1].join("profiles/test");
                fs::create_dir_all(&copied).unwrap();
                fs::copy(
                    source.manager.root.join("registry.json"),
                    copied.join("registry.json"),
                )
                .unwrap();
            }
            "peer" => fs::create_dir(&scope.inventories[1]).unwrap(),
            "busy" => {
                held = Some(
                    try_lock(&scope.inventories[0].join("installation.lock"))
                        .unwrap()
                        .unwrap(),
                );
            }
            "delete-denied" => env.store.deny_delete(Some(Error::Denied)),
            "delete-unconfirmed" => {}
            _ => {
                // Changed after the confirmed delete, before the empty state.
                let (root, store) = (scope.inventories[0].clone(), Arc::downgrade(&env.store));
                *env.store.on_read.lock().unwrap() = Some(Arc::new(move |account| {
                    let deleted = !store
                        .upgrade()
                        .unwrap()
                        .items
                        .lock()
                        .unwrap()
                        .contains_key(account);
                    if deleted {
                        let path = root.join(STATE);
                        let mut value: Value =
                            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                        value["signedOutSeen"] = json!(0);
                        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
                    }
                }));
            }
        }
        let before = fs::read(scope.inventories[0].join(STATE)).ok();
        let witness = env.store.items.lock().unwrap().clone();
        let deletes = env.store.deletes.load(Ordering::SeqCst);
        let result = if case == "delete-unconfirmed" {
            installation::cancel(
                &scope,
                &scope.inventories[0],
                &Unconfirmed(env.store.clone()),
                peer(&scope, &Arc::default()),
            )
        } else {
            cancel(&env, &scope)
        };
        assert!(result.is_err(), "{case}");
        drop(result);
        drop(held);
        *env.store.on_read.lock().unwrap() = None;
        let deleted = matches!(case, "delete-denied" | "delete-unconfirmed" | "late");
        assert_eq!(
            env.store.deletes.load(Ordering::SeqCst),
            deletes + usize::from(deleted),
            "{case}"
        );
        let after = fs::read(scope.inventories[0].join(STATE)).ok();
        if case == "late" {
            assert_eq!(state(&scope)["installation"], record["installation"]);
            assert_eq!(state(&scope)["signedOutSeen"], 0);
            continue;
        }
        assert_eq!(after, before, "{case}");
        assert_eq!(*env.store.items.lock().unwrap(), witness, "{case}");
    }
}

/// Reports every delete as done without deleting anything.
struct Unconfirmed(Arc<Fake>);
impl SecretStore for Unconfirmed {
    fn read(&self, account: &str) -> std::result::Result<Zeroizing<Vec<u8>>, Error> {
        self.0.read(account)
    }
    fn add(&self, account: &str, value: &[u8]) -> std::result::Result<(), Error> {
        self.0.add(account, value)
    }
    fn delete(&self, _: &str) -> std::result::Result<(), Error> {
        self.0.deletes.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn explicit_empty_peer_with_absent_witness_lets_this_build_qualify() {
    for case in ["empty", "witness", "unlisted", "count", "bare"] {
        let env = Env::new();
        env.ready(SLOT);
        let builds = Builds::new(&env);
        *builds.other.fail_add.lock().unwrap() = Some(Error::Denied);
        assert!(builds.other(&env).is_err());
        *builds.other.fail_add.lock().unwrap() = None;
        drop(
            installation::cancel_as(
                Build::OTHER,
                &builds.other_scope,
                &builds.scope.inventories[1],
                builds.other.as_ref(),
                installation::Peer::new(
                    builds.scope.inventories[0].clone(),
                    builds.scope.clone(),
                    env.store.clone(),
                ),
            )
            .unwrap(),
        );
        assert_eq!(
            builds.other_state(),
            json!({"version": 1, "namespaces": []})
        );
        match case {
            "witness" => {
                builds
                    .other
                    .items
                    .lock()
                    .unwrap()
                    .insert(installation::ACCOUNT.into(), b"late".to_vec());
            }
            "unlisted" => fs::write(
                builds.scope.inventories[1].join(format!("ns-{}.json", "a".repeat(64))),
                b"{}",
            )
            .unwrap(),
            "count" => builds
                .write_other_state(&json!({"version": 1, "namespaces": [], "signedOutSeen": 0})),
            "bare" => fs::remove_file(builds.scope.inventories[1].join(STATE)).unwrap(),
            _ => {}
        }
        let before = fs::read(builds.scope.inventories[1].join(STATE)).ok();
        let result = builds.this(&env);
        assert_eq!(result.is_ok(), case == "empty", "{case}");
        assert_eq!(
            env.store.adds.load(Ordering::SeqCst),
            usize::from(case == "empty")
        );
        assert_eq!(
            fs::read(builds.scope.inventories[1].join(STATE)).ok(),
            before
        );
        if let Ok(this) = result {
            // The empty peer is cached: a filesystem-only inspection reads nothing.
            let reads = builds.other.reads.load(Ordering::SeqCst);
            this.inspect(&builds.scope).unwrap();
            assert_eq!(builds.other.reads.load(Ordering::SeqCst), reads);
            builds.other(&env).unwrap();
            this.requalify(&builds.scope).unwrap();
        }
    }
}

#[test]
fn established_inspection_refuses_malformed_state_and_namespace_records() {
    for damage in ["duplicate", "version", "journal", "entry"] {
        let env = Env::new();
        env.ready(SLOT);
        let scope = scope(&env);
        let observed = establish(&env, &scope).unwrap();
        observe_sign_outs(&scope.inventories[0], 0).unwrap();
        env.set(ALICE, SENTINEL).unwrap();
        observed.inspect(&scope).unwrap();
        let mut record = state(&scope);
        match damage {
            "duplicate" => {
                let listed = record["namespaces"][0].clone();
                record["namespaces"].as_array_mut().unwrap().push(listed);
                write_state(&scope, &record);
            }
            "version" => {
                record["version"] = json!(0);
                write_state(&scope, &record);
            }
            "journal" => {
                record["journal"] = json!({"identity": "bad", "home": null});
                write_state(&scope, &record);
            }
            _ => {
                let path = env.ns_path();
                let mut namespace: Value =
                    serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                namespace["entries"][0]["account"] = json!("v1.bad");
                fs::write(&path, serde_json::to_vec(&namespace).unwrap()).unwrap();
            }
        }
        let reads = env.store.reads.load(Ordering::SeqCst);
        assert!(observed.inspect(&scope).is_err(), "{damage}");
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads, "{damage}");
    }
}
