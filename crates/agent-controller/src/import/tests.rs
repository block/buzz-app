use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Mutex,
};
const KEY: &str = "0000000000000000000000000000000000000000000000000000000000000001";
const PUB: &str = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
#[derive(Default)]
struct Memory {
    keys: Mutex<BTreeMap<String, String>>,
    reads: AtomicUsize,
    fail: bool,
    sources: Mutex<Vec<LegacySource>>,
    expected_source: Option<LegacySource>,
}
impl Credentials for Memory {
    fn read_legacy(&self, source: LegacySource, pubkey: &str) -> Result<Secret> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.sources.lock().unwrap().push(source);
        if self
            .expected_source
            .is_some_and(|expected| expected != source)
        {
            return Err("Selected fixture credential is absent".into());
        }
        Secret::parse(KEY, pubkey)
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        self.keys
            .lock()
            .unwrap()
            .get(id)
            .map(|key| Secret::parse(key, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        if self.fail {
            return Err("Test credential store refused".into());
        }
        let mut keys = self.keys.lock().unwrap();
        if keys.contains_key(id) {
            return Err("Already exists".into());
        }
        keys.insert(id.into(), key.hex().to_string());
        Ok(())
    }
}
fn source(root: &Path) -> Vec<u8> {
    let root = root.join(LegacySource::Installed.app_directory());
    fs::create_dir_all(root.join("agents")).unwrap();
    let records = json!([
        {"pubkey":"", "slug":"brain", "system_prompt":"definition-prompt", "model":"definition-model", "runtime":"buzz-agent", "env_vars":{"DEF_VALUE":"definition"}},
        {"pubkey":PUB, "relay_url":"https://RELAY.example/", "name":"Brain", "persona_id":"brain", "system_prompt":"stale-prompt", "model":"stale-model", "agent_command":"goose", "agent_args":[], "auth_tag":"attestation", "env_vars":{"PRIVATE_PROVIDER_TOKEN":"never-project"}, "future":{"preserve":true}, "start_on_app_launch":true}
    ]);
    let bytes = serde_json::to_vec(&records).unwrap();
    fs::write(root.join("agents/managed-agents.json"), &bytes).unwrap();
    fs::write(
        root.join("agents/global-agent-config.json"),
        br#"{"provider":"global-provider","env_vars":{"GLOBAL_VALUE":"global"}}"#,
    )
    .unwrap();
    bytes
}
#[test]
fn preview_is_keyless_commit_resolves_preserves_and_never_enables_or_mutates_source() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let before = source(old.path());
    let mut imports = Imports::default();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
        )
        .unwrap();
    let serialized = serde_json::to_string(&preview).unwrap();
    for hidden in [
        "never-project",
        "definition-prompt",
        "attestation",
        "global-provider",
    ] {
        assert!(!serialized.contains(hidden));
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys,
        )
        .unwrap();
    let saved = &store.agents().unwrap()[0];
    assert_eq!(saved.pubkey, PUB);
    assert!(!saved.enabled);
    assert_eq!(saved.system_prompt, "definition-prompt");
    assert_eq!(saved.harness.model, "definition-model");
    assert_eq!(saved.harness.provider, "global-provider");
    assert_eq!(saved.harness.command, "buzz-agent");
    assert_eq!(saved.environment.len(), 3);
    assert_eq!(saved.imported["record"]["future"]["preserve"], true);
    assert_eq!(saved.auth_tag.as_deref(), Some("attestation"));
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        before
    );
    assert_eq!(keys.reads.load(Ordering::SeqCst), 1);
    let snapshot = serde_json::to_string(&store.snapshot().unwrap()).unwrap();
    assert!(!snapshot.contains("never-project"));
    assert!(!snapshot.contains(KEY));
    assert!(imports
        .commit(
            &preview.token,
            std::slice::from_ref(&saved.id),
            &mut store,
            &keys
        )
        .is_err());
}
#[test]
fn changed_source_duplicate_selection_and_credential_failure_do_not_commit() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let mut imports = Imports::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
        )
        .unwrap();
    let id = preview.candidates[0].id.clone();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    assert!(imports
        .commit(&preview.token, &[id.clone(), id.clone()], &mut store, &keys)
        .is_err());
    fs::write(
        old.path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/global-agent-config.json"),
        b"{}",
    )
    .unwrap();
    assert!(imports
        .commit(&preview.token, std::slice::from_ref(&id), &mut store, &keys)
        .unwrap_err()
        .contains("Source changed"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
        )
        .unwrap();
    let unavailable = Memory {
        fail: true,
        ..Default::default()
    };
    assert!(imports
        .commit(&preview.token, &[id], &mut store, &unavailable)
        .is_err());
    assert!(store.agents().unwrap().is_empty());
}
#[test]
fn inline_key_is_verified_and_not_copied_to_native_config() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    records[1]["private_key_nsec"] = json!(KEY);
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    let mut imports = Imports::default();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
        )
        .unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys,
        )
        .unwrap();
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(
        !String::from_utf8(fs::read(dest.path().join("agents.json")).unwrap())
            .unwrap()
            .contains(KEY)
    );
    assert!(Secret::parse(KEY, &"aa".repeat(32)).is_err());
}
#[test]
fn orphan_or_reserved_env_refuses_before_any_key_read() {
    for update in [
        json!({"persona_id":"missing"}),
        json!({"env_vars":{"BUZZ_MANAGED_AGENT":"old-owner"}}),
    ] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let path = old
            .path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/managed-agents.json");
        let mut records: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for (k, v) in update.as_object().unwrap() {
            records[1][k] = v.clone();
        }
        fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
        let mut imports = Imports::default();
        let keys = Memory::default();
        let preview = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
            )
            .unwrap();
        let mut store = Store::open(dest.path().into()).unwrap();
        assert!(imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
        assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn chosen_source_binds_config_and_credentials_without_fallback() {
    for selected in [LegacySource::Installed, LegacySource::Development] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let development = old.path().join(LegacySource::Development.app_directory());
        fs::create_dir_all(development.join("agents")).unwrap();
        fs::write(
            development.join("agents/managed-agents.json"),
            serde_json::to_vec(&json!([
                {"pubkey": PUB, "relay_url": "wss://development.example", "name": "Development"}
            ]))
            .unwrap(),
        )
        .unwrap();
        let mut imports = Imports::default();
        let preview = imports
            .preview(selected, old.path().into(), dest.path().into())
            .unwrap();
        assert!(preview.source_path.contains(selected.app_directory()));
        assert_eq!(
            preview.candidates[0].relay_url,
            match selected {
                LegacySource::Installed => "wss://relay.example",
                LegacySource::Development => "wss://development.example",
            }
        );
        let mut store = Store::open(dest.path().into()).unwrap();
        let other = match selected {
            LegacySource::Installed => LegacySource::Development,
            LegacySource::Development => LegacySource::Installed,
        };
        let keys = Memory {
            expected_source: Some(other),
            ..Default::default()
        };
        // Another service could satisfy this key, but it must never be consulted.
        assert!(imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
        assert_eq!(*keys.sources.lock().unwrap(), vec![selected]);
        assert!(store.agents().unwrap().is_empty());
        let keys = Memory {
            expected_source: Some(selected),
            ..Default::default()
        };
        imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &keys,
            )
            .unwrap();
        assert_eq!(*keys.sources.lock().unwrap(), vec![selected]);
        assert_eq!(
            store.agents().unwrap()[0].relay_url,
            preview.candidates[0].relay_url
        );
    }
    assert_eq!(LegacySource::Installed.keyring_service(), "buzz-desktop");
    assert_eq!(
        LegacySource::Development.keyring_service(),
        "buzz-desktop-dev"
    );
}
