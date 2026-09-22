use super::*;
use crate::config::{agent_id, HarnessEdit};
use serde_json::json;

pub(crate) fn fixture() -> Agent {
    let pubkey = "ab".repeat(32);
    let relay_url = "wss://relay.example".to_owned();
    Agent {
        id: agent_id(&pubkey, &relay_url),
        pubkey,
        relay_url,
        name: "Test Brain".into(),
        system_prompt: "Take over the test world".into(),
        workspace: "/tmp".into(),
        harness: HarnessEdit {
            databricks: None,
            command: "buzz-agent".into(),
            args: vec![],
            model: "test-model".into(),
            provider: "test-provider".into(),
        },
        environment: BTreeMap::from([("TEST_TOKEN".into(), "secret-env-value".into())]),
        revision: 1,
        enabled: false,
        credential_id: "test-credential".into(),
        auth_tag: Some("private-attestation".into()),
        imported: json!({"futureSetting": {"opaque": "preserve-me"}}),
        extra: BTreeMap::from([("futureTopLevel".into(), json!([1, 2, 3]))]),
    }
}
fn edit() -> AgentEdit {
    AgentEdit {
        name: "Edited Brain".into(),
        system_prompt: "New prompt".into(),
        workspace: "/tmp".into(),
        harness: fixture().harness,
        environment: BTreeMap::new(),
    }
}
#[test]
fn real_store_save_cas_unknown_fields_secret_projection_and_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().to_owned()).unwrap();
    let agent = fixture();
    store.insert(vec![agent.clone()]).unwrap();
    store.save(&agent.id, 1, edit()).unwrap();
    let stale = store.save(&agent.id, 1, edit()).unwrap_err();
    assert!(stale.contains("Reload"));
    let view = serde_json::to_string(&store.snapshot().unwrap()).unwrap();
    for secret in [
        "secret-env-value",
        "private-attestation",
        "preserve-me",
        "test-credential",
        "futureTopLevel",
    ] {
        assert!(!view.contains(secret), "projected {secret}");
    }
    assert!(view.contains("TEST_TOKEN"));
    assert!(view.contains("Edited Brain"));
    assert_eq!(store.agents().unwrap()[0].revision, 2);
    let before = fs::read(store.path()).unwrap();
    assert!(Store::open(dir.path().to_owned()).is_err());
    drop(store);
    let store = Store::open(dir.path().to_owned()).unwrap();
    assert_eq!(fs::read(store.path()).unwrap(), before);
    let saved = &store.agents().unwrap()[0];
    assert_eq!(saved.environment, agent.environment);
    assert_eq!(saved.imported, agent.imported);
    assert_eq!(saved.extra, agent.extra);
    assert_eq!(saved.auth_tag, agent.auth_tag);
    assert_eq!(saved.credential_id, agent.credential_id);
    let backup: Value =
        serde_json::from_slice(&fs::read(dir.path().join("agents.previous.json")).unwrap())
            .unwrap();
    assert_eq!(backup["agents"][0]["revision"], 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn environment_patch_preserves_deletes_and_rejects_host_overrides_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().to_owned()).unwrap();
    let a = fixture();
    store.insert(vec![a.clone()]).unwrap();
    let mut update = edit();
    update.environment.insert("TEST_TOKEN".into(), None);
    update
        .environment
        .insert("PROVIDER_TOKEN".into(), Some("new-secret".into()));
    store.save(&a.id, 1, update).unwrap();
    assert_eq!(
        store.agents().unwrap()[0].environment,
        BTreeMap::from([("PROVIDER_TOKEN".into(), "new-secret".into())])
    );
    let before = fs::read(store.path()).unwrap();
    for key in [
        "BUZZ_PRIVATE_KEY",
        "buzz_auth_tag",
        "BUZZ_ACP_LAZY_POOL",
        "BUZZ_MANAGED_AGENT",
        "GIT_CONFIG_COUNT",
        "NOSTR_PRIVATE_KEY",
        "bad=key",
    ] {
        let mut update = edit();
        update
            .environment
            .insert(key.into(), Some("do-not-echo".into()));
        let error = store.save(&a.id, 2, update).unwrap_err();
        assert!(!error.contains("do-not-echo"));
        assert_eq!(fs::read(store.path()).unwrap(), before);
    }
}
#[test]
fn malformed_store_never_becomes_empty_or_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().to_owned()).unwrap();
    let a = fixture();
    store.insert(vec![a.clone()]).unwrap();
    fs::write(store.path(), b"{broken-secret").unwrap();
    assert!(store.save(&a.id, 1, edit()).is_err());
    assert!(store.snapshot().is_err());
    assert_eq!(fs::read(store.path()).unwrap(), b"{broken-secret");
    drop(store);
    assert!(Store::open(dir.path().to_owned()).is_err());
}
#[test]
fn durable_enablement_is_not_a_config_revision() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().to_owned()).unwrap();
    let a = fixture();
    store.insert(vec![a.clone()]).unwrap();
    store.enabled(&a.id, true).unwrap();
    store.enabled(&a.id, false).unwrap();
    drop(store);
    let store = Store::open(dir.path().to_owned()).unwrap();
    assert!(!store.agents().unwrap()[0].enabled);
    assert_eq!(store.agents().unwrap()[0].revision, 1);
}
#[test]
fn identity_and_transport_validation_rejects_duplicates_and_argument_loss() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = Store::open(dir.path().to_owned()).unwrap();
    let a = fixture();
    assert!(store.insert(vec![a.clone(), a.clone()]).is_err());
    store.insert(vec![a.clone()]).unwrap();
    for argument in ["one,two", "", "a\0b"] {
        let mut update = edit();
        update.harness.args = vec![argument.into()];
        assert!(store.save(&a.id, 1, update).is_err());
    }
    assert_eq!(store.agents().unwrap()[0].revision, 1);
}
#[cfg(unix)]
#[test]
fn symlink_store_and_lock_are_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    fs::write(&target, "untouched").unwrap();
    symlink(&target, dir.path().join("controller.lock")).unwrap();
    assert!(Store::open(dir.path().to_owned()).is_err());
    fs::remove_file(dir.path().join("controller.lock")).unwrap();
    symlink(&target, dir.path().join("agents.json")).unwrap();
    assert!(Store::open(dir.path().to_owned()).is_err());
    assert_eq!(fs::read(target).unwrap(), b"untouched");
}

#[test]
fn closing_store_releases_lock_even_with_inherited_file_description() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    // dup/fork share the flock's open-file description. A concurrently spawning
    // child can retain it until exec despite the parent's close-on-exec flag.
    let inherited = store._lock.try_clone().unwrap();
    assert!(Store::open(dir.path().to_owned()).is_err());
    drop(store);
    let reopened = Store::open(dir.path().to_owned()).unwrap();
    drop(inherited);
    assert!(Store::open(dir.path().to_owned()).is_err());
    drop(reopened);
    Store::open(dir.path().to_owned()).unwrap();
}
