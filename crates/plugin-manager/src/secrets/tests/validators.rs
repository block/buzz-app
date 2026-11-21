//! Shared structural validators at their current owner, `read::inspect_namespace`.
use super::*;
use serde_json::{json, Value};

fn fixture() -> Env {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env
}
fn inspect_at(env: &Env, manager: &Manager) -> Result<()> {
    let bytes = fs::read(env.manager.root.join("registry.json")).unwrap();
    let namespace: Namespace =
        serde_json::from_slice(&fs::read(env.ns_path()).unwrap()).map_err(|_| UNREADABLE)?;
    read::inspect_namespace(&bytes, &namespace, &manager.home, &manager.profile, VARIANT)
}
fn inspect(env: &Env) -> Result<()> {
    inspect_at(env, &env.manager)
}
fn refused(env: &Env) {
    let reads = env.store.reads.load(Ordering::SeqCst);
    assert!(inspect(env).is_err());
    assert_eq!(env.store.reads.load(Ordering::SeqCst), reads);
}
fn namespace(env: &Env) -> Value {
    serde_json::from_slice(&fs::read(env.ns_path()).unwrap()).unwrap()
}
fn write(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
}

#[test]
fn corrupt_registry_or_namespace_content_refuses() {
    let env = fixture();
    inspect(&env).unwrap();
    for path in [env.manager.root.join("registry.json"), env.ns_path()] {
        let original = fs::read(&path).unwrap();
        fs::write(&path, b"!").unwrap();
        refused(&env);
        fs::write(&path, original).unwrap();
    }
    inspect(&env).unwrap();
}

#[cfg(unix)]
#[test]
fn home_alias_binds_to_the_same_namespace() {
    let env = fixture();
    let alias = env.temp.path().join("alias");
    std::os::unix::fs::symlink(env.temp.path().join("home"), &alias).unwrap();
    let manager = Manager::open(Some(alias), "test", false)
        .unwrap()
        .with_secret_storage(env.root(), env.store.clone());
    inspect_at(&env, &manager).unwrap();
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
    // A formerly installed copy is still validated raw, before compatibility drops it.
    let mut former = second;
    former["manifest"]["id"] = "buzz.claude-code".into();
    former["enabled"] = false.into();
    let mut good = registry.clone();
    good["installed"]["buzz.claude-code"] = former;
    good["bundledOverrides"] = json!({"buzz.claude-code": true});
    env.write_registry(&good);
    inspect(&env).unwrap();
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
            inspect(&env).unwrap();
        }
        env.write_registry(&bad);
        refused(&env);
    }
}

#[test]
fn namespace_binding_entries_and_history_are_validated() {
    let env = fixture();
    let original = namespace(&env);
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
    inspect(&env).unwrap();
}

#[test]
fn retired_only_debt_validates_history_without_a_registry() {
    let env = fixture();
    let mut debt = namespace(&env);
    debt["entries"][0]["phase"] = "retired".into();
    debt["entries"][0]["cause"] = "failed".into();
    let check = |value: &Value| {
        read::inspect_retired(&serde_json::from_value(value.clone()).map_err(|_| UNREADABLE)?)
    };
    check(&debt).unwrap();
    let mut live = debt.clone();
    live["entries"][0]["phase"] = "live".into();
    live["entries"][0]["cause"] = Value::Null;
    assert!(check(&live).is_err());
    for (field, value) in [
        ("account", json!("v1.bad")),
        ("generation", json!("bad")),
        ("cause", json!(null)),
    ] {
        let mut bad = debt.clone();
        bad["entries"][0][field] = value;
        assert!(check(&bad).is_err(), "{field}");
    }
    let mut bad = debt;
    bad["lineage"] = "bad".into();
    assert!(check(&bad).is_err());
}

#[cfg(not(unix))]
#[test]
fn non_unix_refuses_secret_setup_without_store_work() {
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
    let env = Env::new();
    env.ready(SLOT);
    let before = snapshot(env.temp.path());
    assert_eq!(env.set(ALICE, SENTINEL).unwrap_err(), UNSUPPORTED);
    assert_eq!(env.store.adds.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.reads.load(Ordering::SeqCst), 0);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(snapshot(env.temp.path()), before);
}
