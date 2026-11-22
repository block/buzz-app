//! Structural reads and native preparation with observed fake storage only.
use super::*;
use serde_json::{json, Value};

fn fixture() -> Env {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env
}
fn inspect(env: &Env) -> Admission<usize> {
    read::with_structural(&env.manager, |evidence| {
        assert_eq!(evidence.registry.version, 3);
        assert_eq!(evidence.state.version, 1);
        evidence.namespace.entries.len()
    })
}
fn snapshot(path: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    for entry in fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            files.insert(path.clone(), Vec::new());
            files.extend(snapshot(&path));
        } else if path.is_file() {
            files.insert(path.clone(), fs::read(path).unwrap());
        }
    }
    files
}
fn refused(env: &Env) {
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    assert!(inspect(env).is_err());
    assert_eq!(snapshot(env.temp.path()), before);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
}
fn namespace(env: &Env) -> Value {
    serde_json::from_slice(&fs::read(env.ns_path()).unwrap()).unwrap()
}
fn write(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

#[test]
fn structural_success_is_read_only_holds_all_locks_and_never_reads_storage() {
    let env = fixture();
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    read::with_structural(&env.manager, |evidence| {
        assert_eq!(evidence.namespace.entries.len(), 1);
        for path in [
            env.manager.root.join("registry.lock"),
            env.root().join("state.lock"),
            env.ns_path().with_extension("lock"),
        ] {
            assert!(matches!(
                File::open(path).unwrap().try_lock(),
                Err(fs::TryLockError::WouldBlock)
            ));
        }
    })
    .unwrap();
    assert_eq!(inspect(&env).unwrap(), 1);
    assert_eq!(snapshot(env.temp.path()), before);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads + 1);
    *env.store.fail_read.lock().unwrap() = Some(Error::Denied);
    assert!(env.store.read("absent").is_err());
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads + 2);
}

#[test]
fn established_files_are_required_and_content_is_bounded_without_repairs() {
    let empty = Env::new();
    refused(&empty);
    for index in 0..6 {
        for damage in ["missing", "corrupt", "oversize"] {
            let env = fixture();
            let path = [
                env.manager.root.join("registry.lock"),
                env.root().join("state.lock"),
                env.ns_path().with_extension("lock"),
                env.manager.root.join("registry.json"),
                env.root().join(STATE),
                env.ns_path(),
            ][index]
                .clone();
            if damage == "missing" {
                fs::remove_file(&path).unwrap();
            } else if index >= 3 {
                let limit = if index == 3 {
                    crate::LIMIT as usize
                } else {
                    MAX_RECORD_BYTES
                };
                fs::write(
                    &path,
                    if damage == "corrupt" {
                        vec![b'!']
                    } else {
                        vec![b' '; limit + 1]
                    },
                )
                .unwrap();
            } else {
                continue;
            }
            refused(&env);
        }
    }
}

#[cfg(unix)]
#[test]
fn leaf_links_special_files_and_busy_locks_refuse_but_home_aliases_work() {
    use std::os::unix::fs::symlink;
    for index in 0..6 {
        let env = fixture();
        let path = [
            env.manager.root.join("registry.lock"),
            env.root().join("state.lock"),
            env.ns_path().with_extension("lock"),
            env.manager.root.join("registry.json"),
            env.root().join(STATE),
            env.ns_path(),
        ][index]
            .clone();
        let moved = path.with_extension("original");
        fs::rename(&path, &moved).unwrap();
        symlink(&moved, &path).unwrap();
        refused(&env);
        fs::remove_file(&path).unwrap();
        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        refused(&env);
        fs::remove_file(&path).unwrap();
        fs::rename(moved, &path).unwrap();
        if index < 3 {
            let held = File::open(&path).unwrap();
            held.lock().unwrap();
            refused(&env);
            held.unlock().unwrap();
            drop(held);
            assert_eq!(inspect(&env).unwrap(), 1);
        }
    }
    let env = fixture();
    let alias = env.temp.path().join("alias");
    symlink(env.temp.path().join("home"), &alias).unwrap();
    let manager = Manager::open(Some(alias), "test", false)
        .unwrap()
        .with_secret_storage(env.root(), env.store.clone());
    assert_eq!(
        read::with_structural(&manager, |s| s.namespace.entries.len()).unwrap(),
        1
    );
}

#[test]
fn raw_maps_reject_both_duplicate_orders_and_equal_values_before_compatibility() {
    let env = fixture();
    let registry = env.registry();
    let mut first = registry["installed"][PLUGIN].clone();
    let second = first.clone();
    first["enabled"] = false.into();
    for field in ["installed", "bundledOverrides"] {
        let (key, a, b) = if field == "installed" {
            (PLUGIN, first.to_string(), second.to_string())
        } else {
            ("buzz.claude-code", "false".into(), "true".into())
        };
        for (a, b) in [(&a, &b), (&b, &a), (&a, &a)] {
            let mut base = registry.clone();
            base.as_object_mut().unwrap().remove(field);
            let text = base.to_string();
            let raw = format!(
                "{},\"{field}\":{{\"{key}\":{a},\"{key}\":{b}}}}}",
                &text[..text.len() - 1]
            );
            fs::write(env.manager.root.join("registry.json"), raw).unwrap();
            refused(&env);
        }
    }
    let mut former = second;
    former["manifest"]["id"] = "buzz.claude-code".into();
    former["enabled"] = false.into();
    let mut good = registry.clone();
    good["installed"]["buzz.claude-code"] = former;
    good["bundledOverrides"] = json!({"buzz.claude-code": true});
    env.write_registry(&good);
    read::with_structural(&env.manager, |s| {
        assert!(s.installed.contains_key("buzz.claude-code"));
        assert!(!s.registry.installed.contains_key("buzz.claude-code"));
        assert!(s.registry.bundled_overrides["buzz.claude-code"]);
    })
    .unwrap();
    for damage in ["uuid", "version"] {
        let mut bad = good.clone();
        if damage == "uuid" {
            bad["installed"]["buzz.claude-code"]["generation"] = "bad".into();
        } else {
            bad["installed"][PLUGIN]["generation"] = Value::Null;
            bad["version"] = 2.into();
            bad.as_object_mut().unwrap().remove("secrets");
            let mut empty = namespace(&env);
            empty["lineage"] = Value::Null;
            empty["entries"] = json!([]);
            write(&env.ns_path(), &empty);
            let mut legacy = bad.clone();
            legacy["installed"]["buzz.claude-code"]["generation"] = Value::Null;
            env.write_registry(&legacy);
            assert_eq!(
                read::with_structural(&env.manager, |s| s.namespace.entries.len()).unwrap(),
                0
            );
        }
        env.write_registry(&bad);
        refused(&env);
    }
}

#[test]
fn membership_binding_and_all_history_are_structural_not_current_authority() {
    let env = fixture();
    let original = namespace(&env);
    let state: Value = serde_json::from_slice(&fs::read(env.root().join(STATE)).unwrap()).unwrap();
    for damage in ["unlisted", "duplicate", "journal", "version"] {
        let mut bad = state.clone();
        match damage {
            "unlisted" => bad["namespaces"] = json!([]),
            "duplicate" => bad["namespaces"]
                .as_array_mut()
                .unwrap()
                .push(state["namespaces"][0].clone()),
            "journal" => bad["journal"] = json!({"identity":"bad","home":null}),
            _ => bad["version"] = 0.into(),
        }
        write(&env.root().join(STATE), &bad);
        refused(&env);
    }
    write(&env.root().join(STATE), &state);
    for (field, value) in [
        ("home", json!("a".repeat(64))),
        ("profile", json!("other")),
        ("lineage", json!(null)),
        ("version", json!(2)),
    ] {
        let mut bad = original.clone();
        bad[field] = value;
        write(&env.ns_path(), &bad);
        refused(&env);
    }
    for (field, value) in [
        ("account", json!("v1.bad")),
        ("plugin", json!("../bad")),
        ("slot", json!("../bad")),
        ("identity", json!("bad")),
        ("lineage", json!("bad")),
        ("generation", json!("bad")),
        ("cause", json!("failed")),
        ("phase", json!("other")),
        (
            "policy",
            json!({"origins":["https://api.example.test"],"header":"Authorization","scheme":"Bearer"}),
        ),
    ] {
        let mut bad = original.clone();
        bad["entries"][0][field] = value;
        write(&env.ns_path(), &bad);
        refused(&env);
    }
    let mut bad = original.clone();
    bad["entries"][0]["generation"] = uuid::Uuid::new_v4().to_string().into();
    write(&env.ns_path(), &bad);
    refused(&env);
    for damage in ["account", "live", "writing"] {
        let mut bad = original.clone();
        let mut extra = bad["entries"][0].clone();
        if damage != "account" {
            extra["account"] = format!("v1.{}", "b".repeat(32)).into();
        }
        if damage == "writing" {
            bad["entries"][0]["phase"] = "writing".into();
            extra["phase"] = "writing".into();
        }
        bad["entries"].as_array_mut().unwrap().push(extra);
        write(&env.ns_path(), &bad);
        refused(&env);
    }
    let mut good = original;
    let mut writing = good["entries"][0].clone();
    writing["phase"] = "writing".into();
    writing["account"] = format!("v1.{}", "c".repeat(32)).into();
    let mut retired = writing.clone();
    retired["phase"] = "retired".into();
    retired["cause"] = "failed".into();
    retired["account"] = format!("v1.{}", "d".repeat(32)).into();
    retired["generation"] = uuid::Uuid::new_v4().to_string().into();
    retired["lineage"] = uuid::Uuid::new_v4().to_string().into();
    retired["policy"]["scheme"] = "".into();
    good["entries"]
        .as_array_mut()
        .unwrap()
        .extend([writing, retired]);
    for policy in [
        json!({"origins":["http://api.example.test"],"header":"authorization","scheme":"Bearer"}),
        json!({"origins":["https://api.example.test","https://api.example.test"],"header":"authorization","scheme":"Bearer"}),
        json!({"origins":["https://api.example.test"],"header":"cookie","scheme":"Bearer"}),
        json!({"origins":["https://api.example.test"],"header":"authorization","scheme":"bad scheme"}),
    ] {
        let mut bad = good.clone();
        bad["entries"][2]["policy"] = policy;
        write(&env.ns_path(), &bad);
        refused(&env);
    }
    write(&env.ns_path(), &good);
    assert_eq!(inspect(&env).unwrap(), 3);
    let mut journal = state;
    journal["journal"] = json!({"identity":ALICE,"home":null});
    write(&env.root().join(STATE), &journal);
    fs::write(
        env.root().join(format!("ns-{}.json", "e".repeat(64))),
        b"corrupt",
    )
    .unwrap();
    assert_eq!(inspect(&env).unwrap(), 3);
}

fn prepare(env: &Env, identity: &str, origin: &str, deadline: Instant) -> Result<PreparedSecret> {
    env.manager.prepare_secret(SecretRequest {
        plugin: PLUGIN,
        revision: env.registry()["installed"][PLUGIN]["current"]
            .as_str()
            .unwrap(),
        slot: "api-key",
        identity,
        origin,
        deadline,
    })
}
#[test]
fn preparation_uses_one_exact_fake_read_and_rejects_noncanonical_bytes_without_repairs() {
    let env = fixture();
    let account = namespace(&env)["entries"][0]["account"]
        .as_str()
        .unwrap()
        .to_owned();
    let expected = account.clone();
    *env.store.on_read.lock().unwrap() =
        Some(Arc::new(move |account| assert_eq!(account, expected)));
    for value in [
        SENTINEL.as_bytes(),
        b"",
        b" key ",
        b"key\n",
        b"bad\x00",
        b"\xff",
        &[b'a'; 513],
        &[b'a'; 512],
    ] {
        env.store
            .items
            .lock()
            .unwrap()
            .insert(account.clone(), value.to_vec());
        let before = snapshot(env.temp.path());
        let reads = env.store.reads.load(Ordering::SeqCst);
        let result = prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(5),
        );
        assert_eq!(
            result.is_ok(),
            value == SENTINEL.as_bytes() || value.len() == 512
        );
        if let Err(error) = &result {
            assert_eq!(error, UNAVAILABLE);
        }
        if let Ok(prepared) = result {
            prepared.with_header(|name, header| {
                assert_eq!(name, "authorization");
                assert_eq!(header.as_bytes(), [b"Bearer ".as_slice(), value].concat());
            });
        }
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads + 1);
        assert_eq!(snapshot(env.temp.path()), before);
    }
    for error in [Some(Error::Denied), Some(Error::Absent)] {
        *env.store.fail_read.lock().unwrap() = error;
        let reads = env.store.reads.load(Ordering::SeqCst);
        assert_eq!(
            prepare(
                &env,
                ALICE,
                "https://api.example.test",
                Instant::now() + Duration::from_secs(5)
            )
            .err()
            .as_deref(),
            Some(UNAVAILABLE)
        );
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads + 1);
    }
}
#[test]
fn preparation_qualifies_actual_artifact_and_scope_before_lookup() {
    for damage in [
        "safe",
        "disabled",
        "stale",
        "undeclared",
        "unavailable",
        "missing",
        "corrupt",
        "oversize",
        "link",
        "special",
        "signature",
        "cached",
        "identity",
        "profile",
        "namespace",
        "lineage",
        "account",
        "journal",
        "expired",
        "sibling",
        "subdomain",
        "port",
        "scheme",
        "credentials",
    ] {
        let mut env = fixture();
        let revision = env.registry()["installed"][PLUGIN]["current"]
            .as_str()
            .unwrap()
            .to_owned();
        let artifact = env
            .manager
            .root
            .join("artifacts")
            .join(PLUGIN)
            .join(format!("{revision}.json"));
        let mut selected_revision = revision.clone();
        let mut slot = "api-key";
        let mut identity = ALICE;
        let mut origin = "https://api.example.test";
        let mut deadline = Instant::now() + Duration::from_secs(5);
        match damage {
            "safe" => env.manager.safe_mode = true,
            "disabled" => {
                let mut registry = env.registry();
                registry["installed"][PLUGIN]["enabled"] = false.into();
                env.write_registry(&registry);
            }
            "stale" => selected_revision = "a".repeat(64),
            "undeclared" => slot = "other",
            "unavailable" => env.manager.secrets = Storage::default(),
            "missing" => fs::remove_file(&artifact).unwrap(),
            "corrupt" => fs::write(&artifact, b"{}").unwrap(),
            "oversize" => fs::write(&artifact, vec![b' '; crate::LIMIT as usize + 1]).unwrap(),
            "link" => {
                fs::remove_file(&artifact).unwrap();
                #[cfg(unix)]
                std::os::unix::fs::symlink(env.temp.path().join("build/plugin.js"), &artifact)
                    .unwrap();
            }
            "special" => {
                fs::remove_file(&artifact).unwrap();
                fs::create_dir(&artifact).unwrap();
            }
            "signature" => {
                let mut registry = env.registry();
                registry["installed"][PLUGIN]["currentSignature"] = json!({});
                env.write_registry(&registry);
            }
            "cached" => {
                let mut registry = env.registry();
                registry["installed"][PLUGIN]["manifest"]["host"]["secrets"][0]["scheme"] =
                    "Token".into();
                env.write_registry(&registry);
                let mut ns = namespace(&env);
                ns["entries"][0]["policy"]["scheme"] = "Token".into();
                write(&env.ns_path(), &ns);
                assert!(inspect(&env).is_ok());
            }
            "identity" => identity = BOB,
            "profile" => env.manager = Env::open(&env.temp, "other", env.store.clone()),
            "namespace" | "lineage" | "account" => {
                let mut ns = namespace(&env);
                if damage == "namespace" {
                    ns["home"] = json!("a".repeat(64));
                }
                if damage == "lineage" {
                    ns["lineage"] = json!(uuid::Uuid::new_v4().to_string());
                }
                if damage == "account" {
                    ns["entries"][0]["phase"] = "retired".into();
                    ns["entries"][0]["cause"] = "cleared".into();
                }
                write(&env.ns_path(), &ns);
            }
            "journal" => {
                let mut state: Value =
                    serde_json::from_slice(&fs::read(env.root().join(STATE)).unwrap()).unwrap();
                state["journal"] = json!({"identity":ALICE,"home":null});
                write(&env.root().join(STATE), &state);
            }
            "expired" => deadline = Instant::now(),
            "sibling" => origin = "https://other.example.test",
            "subdomain" => origin = "https://sub.api.example.test",
            "port" => origin = "https://api.example.test:444",
            "scheme" => origin = "http://api.example.test",
            _ => origin = "https://user:pass@api.example.test",
        }
        let reads = env.store.reads.load(Ordering::SeqCst);
        let before = snapshot(env.temp.path());
        let result = env.manager.prepare_secret(SecretRequest {
            plugin: PLUGIN,
            revision: &selected_revision,
            slot,
            identity,
            origin,
            deadline,
        });
        assert_eq!(result.err().as_deref(), Some(UNAVAILABLE), "{damage}");
        assert_eq!(snapshot(env.temp.path()), before);
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    }
}
#[test]
fn preparation_drops_locks_during_read_and_never_rotates_or_returns_expired_material() {
    for change in ["clear", "replace", "update", "policy", "journal", "expire"] {
        let env = fixture();
        let manager = env.manager.clone();
        let revision = env.registry()["installed"][PLUGIN]["current"]
            .as_str()
            .unwrap()
            .to_owned();
        let source = env.temp.path().join("build");
        let deadline = Instant::now()
            + if change == "expire" {
                Duration::from_millis(200)
            } else {
                Duration::from_secs(30)
            };
        let state_path = env.root().join(STATE);
        *env.store.on_read.lock().unwrap() = Some(Arc::new(move |_| {
            read::with_structural(&manager, |_| ()).unwrap();
            match change {
                "clear" => manager
                    .secret_clear(PLUGIN, &revision, "api-key", ALICE)
                    .unwrap(),
                "replace" => manager
                    .secret_set(PLUGIN, &revision, "api-key", ALICE, "replacement", &|| true)
                    .unwrap(),
                "update" | "policy" => {
                    fs::write(
                        source.join("plugin.js"),
                        "export function apply() { return 1; }",
                    )
                    .unwrap();
                    if change == "policy" {
                        fs::write(
                            source.join("manifest.json"),
                            manifest(&SLOT.replace("Bearer", "Token")),
                        )
                        .unwrap();
                    }
                    manager.install(&source).unwrap();
                }
                "journal" => {
                    let mut state: Value =
                        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
                    state["journal"] = json!({"identity":ALICE,"home":null});
                    write(&state_path, &state);
                }
                _ => std::thread::sleep(deadline.saturating_duration_since(Instant::now())),
            }
        }));
        let reads = env.store.reads.load(Ordering::SeqCst);
        let result = prepare(&env, ALICE, "https://api.example.test", deadline);
        *env.store.on_read.lock().unwrap() = None;
        assert_eq!(result.err().as_deref(), Some(UNAVAILABLE), "{change}");
        if change != "expire" {
            assert!(Instant::now() < deadline);
        }
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads + 1);
    }
}
#[test]
fn preparation_verifies_valid_release_binding_and_actual_manifest_subset() {
    use crate::{EventBuilder, FinalizeEvent, Keys, Tag, RELEASE_KIND, RELEASE_MARKER};
    let env = fixture();
    let mut registry = env.registry();
    let revision = registry["installed"][PLUGIN]["current"].as_str().unwrap();
    let artifact = env
        .manager
        .root
        .join("artifacts")
        .join(PLUGIN)
        .join(format!("{revision}.json"));
    let bytes = fs::read(&artifact).unwrap();
    let key = Keys::generate();
    for content in [&bytes[..], b"different artifact bytes"] {
        let signature = EventBuilder::new(RELEASE_KIND, "")
            .tags([
                Tag::custom("x", [crate::hash(content)]),
                Tag::custom("t", [RELEASE_MARKER]),
            ])
            .finalize(&key)
            .unwrap();
        signature.verify().unwrap();
        assert!(crate::publisher(content, &signature).is_ok());
        registry["installed"][PLUGIN]["currentSignature"] =
            serde_json::to_value(&signature).unwrap();
        env.write_registry(&registry);
        assert!(inspect(&env).is_ok());
        let before = snapshot(env.temp.path());
        let reads = env.store.reads.load(Ordering::SeqCst);
        let result = prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(5),
        );
        assert_eq!(result.is_ok(), content == bytes);
        if content != bytes {
            assert_eq!(result.err().as_deref(), Some(UNAVAILABLE));
        }
        assert_eq!(
            env.store.reads.load(Ordering::SeqCst),
            reads + usize::from(content == bytes)
        );
        assert_eq!(snapshot(env.temp.path()), before);
    }
    let mut invalid: Value = serde_json::from_slice(&bytes).unwrap();
    invalid["manifest"]["host"]["networkOrigins"] = json!(["https://other.example.test"]);
    let bytes = serde_json::to_vec(&invalid).unwrap();
    let hash = crate::hash(&bytes);
    let path = artifact.with_file_name(format!("{hash}.json"));
    fs::write(&path, &bytes).unwrap();
    assert_eq!(crate::hash(&fs::read(&path).unwrap()), hash);
    assert!(serde_json::from_slice::<crate::Artifact>(&bytes).is_ok());
    registry["installed"][PLUGIN]["current"] = hash.into();
    registry["installed"][PLUGIN]["currentSignature"] = Value::Null;
    env.write_registry(&registry);
    assert!(inspect(&env).is_ok());
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    assert_eq!(
        prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(5)
        )
        .err()
        .as_deref(),
        Some(UNAVAILABLE)
    );
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(snapshot(env.temp.path()), before);
}

#[test]
fn effect_admission_holds_existing_metadata_locks_without_another_os_read() {
    let env = fixture();
    let prepared = prepare(
        &env,
        ALICE,
        "https://api.example.test",
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    let admissions = AtomicUsize::new(0);
    let result = env.manager.with_prepared_secret(&prepared, || {
        for path in [
            env.manager.root.join("registry.lock"),
            env.root().join("state.lock"),
            env.ns_path().with_extension("lock"),
        ] {
            assert!(matches!(
                File::open(path).unwrap().try_lock(),
                Err(fs::TryLockError::WouldBlock)
            ));
        }
        admissions.fetch_add(1, Ordering::SeqCst);
        Ok("admitted")
    });
    assert_eq!(result.unwrap(), "admitted");
    assert_eq!(admissions.load(Ordering::SeqCst), 1);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(snapshot(env.temp.path()), before);
    assert_eq!(
        env.manager
            .with_prepared_secret::<()>(&prepared, || Err("operation retired".into()))
            .unwrap_err(),
        "operation retired"
    );
}

#[test]
fn prepared_material_cannot_admit_after_exact_account_or_authority_loss() {
    for change in [
        "replace",
        "clear-delete-denied",
        "disable",
        "journal",
        "revision",
        "expired",
    ] {
        let env = fixture();
        let mut prepared = prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        let account = prepared.binding.account.clone();
        let generation = prepared.binding.generation.clone();
        match change {
            "replace" => {
                env.set(ALICE, "replacement").unwrap();
                let replacement = prepare(
                    &env,
                    ALICE,
                    "https://api.example.test",
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
                assert_eq!(replacement.binding.generation, generation);
                assert_ne!(replacement.binding.account, account);
                // Positive control: current enrollment can enter this same seam.
                env.manager
                    .with_prepared_secret(&replacement, || Ok(()))
                    .unwrap();
            }
            "clear-delete-denied" => {
                env.store.deny_delete(Some(Error::Denied));
                let _ = env
                    .manager
                    .secret_clear(PLUGIN, &env.current(), "api-key", ALICE);
                assert!(env.store.items.lock().unwrap().contains_key(&account));
            }
            "disable" => {
                env.manager.change("disable", PLUGIN).unwrap();
            }
            "journal" => {
                let path = env.root().join(STATE);
                let mut state: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                state["journal"] = json!({"identity": ALICE, "home": null});
                write(&path, &state);
            }
            "revision" => {
                fs::write(
                    env.temp.path().join("build/plugin.js"),
                    "export function apply() { return 1; }",
                )
                .unwrap();
                env.manager.install(&env.temp.path().join("build")).unwrap();
            }
            "expired" => prepared.deadline = Instant::now(),
            _ => unreachable!(),
        }
        let reads = env.store.reads.load(Ordering::SeqCst);
        let admissions = AtomicUsize::new(0);
        let result = env.manager.with_prepared_secret(&prepared, || {
            admissions.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        assert!(result.is_err(), "{change}");
        assert_eq!(admissions.load(Ordering::SeqCst), 0, "{change}");
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads, "{change}");
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
#[test]
fn reviewed_credential_admission_refuses_without_calling_the_effect() {
    let env = fixture();
    let prepared = prepare(
        &env,
        ALICE,
        "https://api.example.test",
        Instant::now() + Duration::from_secs(10),
    )
    .unwrap();
    let grant = crate::ReviewedInvocation {
        id: "create".into(),
        artifact: None,
        credential_http: Some(crate::ReviewedCredentialHttp {
            version: 1,
            slot: "api-key".into(),
            result_url: None,
        }),
    };
    let witness = crate::ReviewedInvocationWitness();
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    let mut dispatched = false;
    assert!(env
        .manager
        .with_reviewed_secret(&prepared, &grant, &witness, || {
            dispatched = true;
            Ok(())
        })
        .unwrap_err()
        .contains("requires macOS"));
    assert!(!dispatched);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(snapshot(env.temp.path()), before);
}

#[cfg(not(unix))]
#[test]
fn non_unix_refuses_secret_setup_and_preparation_without_store_work() {
    let env = Env::new();
    env.ready(SLOT);
    let before = snapshot(env.temp.path());
    assert_eq!(env.set(ALICE, SENTINEL).unwrap_err(), UNSUPPORTED);
    assert!(prepare(
        &env,
        ALICE,
        "https://api.example.test",
        Instant::now() + Duration::from_secs(10),
    )
    .is_err());
    assert!(env
        .manager
        .admit_reviewed_invocation(PLUGIN, &env.current(), "create")
        .err()
        .unwrap()
        .contains("requires macOS"));
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(snapshot(env.temp.path()), before);
}

#[cfg(target_os = "macos")]
fn reviewed_fixture() -> (
    Env,
    crate::ReviewedInvocation,
    crate::ReviewedInvocationWitness,
) {
    let env = Env::new();
    let mut declared: Value = serde_json::from_str(&manifest(SLOT)).unwrap();
    declared["host"]["reviewedInvocations"] = json!([
        {"id":"create", "credentialHttp":{"version":1,"slot":"api-key"}}
    ]);
    write(&env.temp.path().join("build/manifest.json"), &declared);
    env.manager.install(&env.temp.path().join("build")).unwrap();
    env.manager.change("enable", PLUGIN).unwrap();
    env.set(ALICE, SENTINEL).unwrap();
    // Capture only after establishment: that registry replacement revokes older reviews.
    let (grant, witness) = env
        .manager
        .admit_reviewed_invocation(PLUGIN, &env.current(), "create")
        .unwrap();
    (env, grant, witness)
}

#[cfg(target_os = "macos")]
#[test]
fn reviewed_credential_admission_composes_existing_locks_and_never_reads_os_storage() {
    let (env, grant, witness) = reviewed_fixture();
    let prepared = prepare(
        &env,
        ALICE,
        "https://api.example.test",
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let before = snapshot(env.temp.path());
    let reads = env.store.reads.load(Ordering::SeqCst);
    let admitted = env
        .manager
        .with_reviewed_secret(&prepared, &grant, &witness, || {
            for path in [
                env.manager.root.join("registry.lock"),
                env.root().join("state.lock"),
                env.ns_path().with_extension("lock"),
            ] {
                assert!(matches!(
                    File::open(path).unwrap().try_lock(),
                    Err(fs::TryLockError::WouldBlock)
                ));
            }
            Ok("admitted")
        })
        .unwrap();
    assert_eq!(admitted, "admitted");
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
    assert_eq!(snapshot(env.temp.path()), before);
    assert!(
        env.manager
            .with_reviewed_invocation(PLUGIN, &env.current(), &grant, &witness, || Ok(()))
            .is_err(),
        "HTTP grants never enter the synthetic executor"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn reviewed_credential_admission_requires_both_retained_grant_and_exact_enrollment() {
    for change in [
        "replace",
        "clear-delete-denied",
        "identical-registry-save",
        "wrong-grant",
        "wrong-slot",
        "added-result-url",
        "expired",
    ] {
        let (env, mut grant, witness) = reviewed_fixture();
        let mut prepared = prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        match change {
            "replace" => {
                let generation = prepared.binding.generation.clone();
                env.set(ALICE, "replacement").unwrap();
                let fresh = prepare(
                    &env,
                    ALICE,
                    "https://api.example.test",
                    Instant::now() + Duration::from_secs(30),
                )
                .unwrap();
                assert_eq!(generation, fresh.binding.generation);
                assert_ne!(prepared.binding.account, fresh.binding.account);
                env.manager
                    .with_reviewed_secret(&fresh, &grant, &witness, || Ok(()))
                    .unwrap();
            }
            "clear-delete-denied" => {
                env.store.deny_delete(Some(Error::Denied));
                assert!(env
                    .manager
                    .secret_clear(PLUGIN, &env.current(), "api-key", ALICE)
                    .is_err());
                assert!(env
                    .store
                    .items
                    .lock()
                    .unwrap()
                    .contains_key(&prepared.binding.account));
            }
            "identical-registry-save" => {
                let _lock = env.manager.lock().unwrap();
                env.manager.save(&env.manager.read().unwrap()).unwrap();
            }
            "wrong-grant" => grant.id = "other".into(),
            "wrong-slot" => grant.credential_http.as_mut().unwrap().slot = "other".into(),
            "added-result-url" => {
                grant.credential_http.as_mut().unwrap().result_url =
                    Some(crate::ReviewedResultUrl {
                        version: 1,
                        json_pointer: "/output/0".into(),
                    })
            }
            "expired" => prepared.deadline = Instant::now(),
            _ => unreachable!(),
        }
        let reads = env.store.reads.load(Ordering::SeqCst);
        let entered = AtomicUsize::new(0);
        // Terminal, not an earlier unrelated Busy, must refuse each change.
        assert!(
            matches!(
                env.manager
                    .try_reviewed_secret(&prepared, &grant, &witness, || {
                        entered.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    }),
                Err(Refusal::Terminal(_))
            ),
            "{change}"
        );
        assert_eq!(entered.load(Ordering::SeqCst), 0, "{change}");
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads, "{change}");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn reviewed_admission_is_busy_only_while_another_holder_has_a_metadata_lock() {
    let (env, grant, witness) = reviewed_fixture();
    let prepared = prepare(
        &env,
        ALICE,
        "https://api.example.test",
        Instant::now() + Duration::from_secs(30),
    )
    .unwrap();
    let locks = [
        env.manager.root.join("registry.lock"),
        env.root().join("state.lock"),
        env.ns_path().with_extension("lock"),
    ];
    let reads = env.store.reads.load(Ordering::SeqCst);
    let entered = AtomicUsize::new(0);
    let admit = || {
        entered.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    for path in &locks {
        let held = File::open(path).unwrap();
        held.try_lock().unwrap();
        assert_eq!(
            env.manager
                .try_reviewed_secret(&prepared, &grant, &witness, admit),
            Err(Refusal::Busy(UNREADABLE.into())),
            "{path:?}"
        );
        // String callers keep the same refusal.
        assert_eq!(
            env.manager
                .with_reviewed_secret(&prepared, &grant, &witness, admit)
                .unwrap_err(),
            UNREADABLE,
            "{path:?}"
        );
        assert_eq!(
            env.manager
                .with_prepared_secret(&prepared, admit)
                .unwrap_err(),
            UNREADABLE,
            "{path:?}"
        );
        held.unlock().unwrap();
        drop(held);
        // Every earlier lock was released when the attempt refused.
        for earlier in &locks {
            let probe = File::open(earlier).unwrap();
            probe.try_lock().unwrap();
            probe.unlock().unwrap();
        }
    }
    assert_eq!(entered.load(Ordering::SeqCst), 0);
    env.manager
        .try_reviewed_secret(&prepared, &grant, &witness, admit)
        .unwrap();
    assert_eq!(entered.load(Ordering::SeqCst), 1);
    assert_eq!(
        env.manager
            .try_reviewed_secret(&prepared, &grant, &witness, || {
                Err::<(), _>("operation retired".into())
            }),
        Err(Refusal::Terminal("operation retired".into())),
        "the admitted work's own refusal is terminal"
    );

    // A lock that cannot be opened, or malformed records, are terminal.
    let lock = env.ns_path().with_extension("lock");
    fs::remove_file(&lock).unwrap();
    fs::create_dir(&lock).unwrap();
    assert_eq!(
        env.manager
            .try_reviewed_secret(&prepared, &grant, &witness, admit),
        Err(Refusal::Terminal(UNREADABLE.into()))
    );
    fs::remove_dir(&lock).unwrap();
    File::create(&lock).unwrap();
    fs::write(env.root().join(STATE), b"{").unwrap();
    assert_eq!(
        env.manager
            .try_reviewed_secret(&prepared, &grant, &witness, admit),
        Err(Refusal::Terminal(UNREADABLE.into()))
    );
    assert_eq!(entered.load(Ordering::SeqCst), 1);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
}

#[cfg(target_os = "macos")]
#[test]
fn reviewed_admission_is_withdrawn_only_when_the_plugin_left_its_reviewed_revision() {
    for change in ["disable", "update", "safe"] {
        let (mut env, grant, witness) = reviewed_fixture();
        let prepared = prepare(
            &env,
            ALICE,
            "https://api.example.test",
            Instant::now() + Duration::from_secs(30),
        )
        .unwrap();
        match change {
            "disable" => {
                env.manager.change("disable", PLUGIN).unwrap();
            }
            "update" => {
                let mut registry = env.registry();
                registry["installed"][PLUGIN]["current"] = "a".repeat(64).into();
                env.write_registry(&registry);
            }
            "safe" => env.manager.safe_mode = true,
            _ => unreachable!(),
        }
        let reads = env.store.reads.load(Ordering::SeqCst);
        let entered = AtomicUsize::new(0);
        let admit = || {
            entered.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        let refusal = env
            .manager
            .try_reviewed_secret(&prepared, &grant, &witness, admit)
            .unwrap_err();
        // Safe mode refuses every plugin, so it is not this plugin's withdrawal.
        match change {
            "safe" => assert!(matches!(refusal, Refusal::Terminal(_)), "{change}"),
            _ => assert_eq!(refusal, Refusal::Withdrawn(WITHDRAWN.into()), "{change}"),
        }
        // String callers keep the same refusal.
        assert_eq!(
            env.manager
                .with_reviewed_secret(&prepared, &grant, &witness, admit)
                .unwrap_err(),
            refusal.message(),
            "{change}"
        );
        assert_eq!(entered.load(Ordering::SeqCst), 0, "{change}");
        assert_eq!(env.store.reads.load(Ordering::SeqCst), reads, "{change}");
    }
}

#[test]
fn reviewed_http_grants_require_one_effect_version_and_declared_slot() {
    let mut base: Value = serde_json::from_str(&manifest(SLOT)).unwrap();
    base["host"]["reviewedInvocations"] = json!([
        {"id":"create", "credentialHttp":{"version":1,"slot":"api-key"}}
    ]);
    serde_json::from_value::<Manifest>(base.clone())
        .unwrap()
        .validate()
        .unwrap();
    let mut selected = base.clone();
    selected["host"]["reviewedInvocations"][0]["credentialHttp"]["resultUrl"] =
        json!({"version":1,"jsonPointer":"/output/0/~0~1x"});
    serde_json::from_value::<Manifest>(selected.clone())
        .unwrap()
        .validate()
        .unwrap();
    selected["host"]["reviewedInvocations"][0]["credentialHttp"]["resultUrl"]["any"] = json!(1);
    assert!(serde_json::from_value::<Manifest>(selected).is_err());
    for grant in [
        json!({"id":"create"}),
        json!({"id":"create", "credentialHttp":{"version":2,"slot":"api-key"}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"other"}}),
        json!({"id":"create", "artifact":{"path":"/fixture/recipient","sha256":"ab".repeat(32)}, "credentialHttp":{"version":1,"slot":"api-key"}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":2,"jsonPointer":"/output/0"}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":""}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":"output/0"}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":"/a~2b"}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":"/a~"}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":"/a".repeat(17)}}}),
        json!({"id":"create", "credentialHttp":{"version":1,"slot":"api-key","resultUrl":{"version":1,"jsonPointer":format!("/{}", "a".repeat(256))}}}),
    ] {
        let mut invalid = base.clone();
        invalid["host"]["reviewedInvocations"][0] = grant;
        assert!(serde_json::from_value::<Manifest>(invalid)
            .unwrap()
            .validate()
            .is_err());
    }
}
