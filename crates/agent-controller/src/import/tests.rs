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
            "wss://relay.example",
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
            "wss://relay.example",
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
            "wss://relay.example",
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
            "wss://relay.example",
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
                "wss://relay.example",
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
            .preview(
                selected,
                old.path().into(),
                dest.path().into(),
                "wss://chosen.example",
            )
            .unwrap();
        assert!(preview.source_path.contains(selected.app_directory()));
        assert_eq!(preview.candidates[0].relay_url, "wss://chosen.example");
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

#[test]
fn changed_source_during_credential_acquisition_never_commits_settings() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let mut imports = Imports::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .unwrap();
    let mut store = Store::open(dest.path().into()).unwrap();
    let prepared = imports
        .prepare(&preview.token, &[preview.candidates[0].id.clone()], &store)
        .unwrap();
    let credentials = Memory::default();
    let acquired = prepared.acquire(&credentials).unwrap();
    fs::write(
        old.path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/global-agent-config.json"),
        "{}",
    )
    .unwrap();
    assert!(acquired
        .commit(&mut store)
        .unwrap_err()
        .contains("Source changed"));
    assert!(store.agents().unwrap().is_empty());
    // Create-only app custody can remain after a cancelled/failed import; never
    // delete keys that a prior successful import may already reference.
    assert_eq!(credentials.keys.lock().unwrap().len(), 1);
}

#[test]
fn explicit_destination_replaces_legacy_pins_without_hiding_keys_or_reading_credentials() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let pins = [
        Value::Null,
        json!(""),
        json!("  "),
        json!("not a URL"),
        json!("ws://insecure.example"),
        json!("wss://raw.example/path"),
        json!("wss://raw.example?private=query"),
        json!("wss://user:secret@raw.example"),
        json!("wss://stale.example"),
    ];
    let mut records = vec![json!({"pubkey":"", "slug":"keyless", "relay_url":""})];
    for (index, pin) in pins.iter().enumerate() {
        let mut record = json!({"pubkey": if index == 0 { PUB.into() } else { format!("{:064x}", index + 100) },
            "name":format!("Agent {index}"), "private_key_nsec":KEY, "system_prompt":"private-prompt"});
        if !pin.is_null() {
            record["relay_url"] = pin.clone();
        }
        records.push(record);
    }
    let bytes = serde_json::to_vec(&records).unwrap();
    fs::write(&path, &bytes).unwrap();
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "https://CHOSEN.example/",
        )
        .unwrap();
    assert_eq!(preview.candidates.len(), pins.len());
    for candidate in &preview.candidates {
        assert_eq!(candidate.relay_url, "wss://chosen.example");
        assert_eq!(
            candidate.id,
            agent_id(&candidate.pubkey, "wss://chosen.example")
        );
    }
    let serialized = serde_json::to_string(&preview).unwrap();
    for hidden in [
        "raw.example",
        "insecure.example",
        "stale.example",
        "not a URL",
        "private-prompt",
        KEY,
    ] {
        assert!(!serialized.contains(hidden));
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    // A missing legacy pin is ordinary source data, not a reason to skip this key.
    let selected = &preview.candidates[0];
    imports
        .commit(
            &preview.token,
            std::slice::from_ref(&selected.id),
            &mut store,
            &keys,
        )
        .unwrap();
    let saved = &store.agents().unwrap()[0];
    assert_eq!(saved.pubkey, PUB);
    assert_eq!(saved.relay_url, "wss://chosen.example");
    assert_eq!(saved.id, selected.id);
    assert_eq!(saved.credential_id, selected.id);
    assert!(!saved.enabled);
    assert_eq!(keys.keys.lock().unwrap().len(), 1);
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn commit_routes_blank_malformed_and_valid_stale_pins_only_to_the_confirmed_destination() {
    for pin in [
        "",
        "ws://insecure.example",
        "wss://stale.example",
        "wss://user:secret@raw.example/path?token=private",
    ] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        source(old.path());
        let path = old
            .path()
            .join(LegacySource::Installed.app_directory())
            .join("agents/managed-agents.json");
        let bytes =
            serde_json::to_vec(&json!([{"pubkey": PUB, "name":"Selected", "relay_url":pin}]))
                .unwrap();
        fs::write(&path, &bytes).unwrap();
        let mut imports = Imports::default();
        let keys = Memory::default();
        let mut store = Store::open(dest.path().into()).unwrap();
        let a = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "wss://first.example",
            )
            .unwrap();
        let b = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "https://CONFIRMED.example/",
            )
            .unwrap();
        assert_ne!(a.token, b.token);
        // An old token must not authorize even IDs from the new preview.
        assert!(imports
            .commit(&a.token, &[b.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert!(imports
            .commit(&a.token, &[a.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert!(imports
            .commit(&b.token, &[a.candidates[0].id.clone()], &mut store, &keys)
            .is_err());
        assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
        assert!(keys.keys.lock().unwrap().is_empty());
        imports
            .commit(&b.token, &[b.candidates[0].id.clone()], &mut store, &keys)
            .unwrap();
        let saved = &store.agents().unwrap()[0];
        assert_eq!(saved.relay_url, "wss://confirmed.example");
        assert_eq!(saved.id, agent_id(PUB, "wss://confirmed.example"));
        assert_eq!(saved.credential_id, saved.id);
        assert_eq!(saved.imported["record"]["relay_url"], pin);
        assert!(!saved.enabled);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn invalid_destination_discards_pending_without_echoing_inputs_or_acquiring_keys() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    for invalid in [
        " ",
        "not a URL",
        "ws://raw.example",
        "http://raw.example",
        "wss://user:secret@raw.example",
        "wss://raw.example/path",
        "wss://raw.example?token=private",
        "wss://raw.example#private",
    ] {
        let prior = imports
            .preview(
                LegacySource::Installed,
                old.path().into(),
                dest.path().into(),
                "wss://chosen.example",
            )
            .unwrap();
        assert_eq!(
            imports
                .preview(
                    LegacySource::Installed,
                    old.path().into(),
                    dest.path().into(),
                    invalid
                )
                .err()
                .unwrap(),
            "Choose a secure community origin without credentials, path or query"
        );
        assert!(imports
            .commit(
                &prior.token,
                &[prior.candidates[0].id.clone()],
                &mut store,
                &keys
            )
            .is_err());
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        bytes
    );
}

#[test]
fn duplicate_keys_ignore_pin_differences_and_source_pin_changes_still_invalidate() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    source(old.path());
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/managed-agents.json");
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    for other_pin in ["", "wss://stale.example", "wss://different.example"] {
        fs::write(&path, serde_json::to_vec(&json!([
            {"pubkey":PUB,"relay_url":"wss://stale.example"}, {"pubkey":PUB,"relay_url":other_pin}
        ])).unwrap()).unwrap();
        assert_eq!(
            imports
                .preview(
                    LegacySource::Installed,
                    old.path().into(),
                    dest.path().into(),
                    "wss://chosen.example"
                )
                .err()
                .unwrap(),
            "Source contains duplicate agent identities"
        );
    }
    let mut records = json!([{"pubkey":PUB,"relay_url":""}]);
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    let preview = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://chosen.example",
        )
        .unwrap();
    records[0]["relay_url"] = json!("wss://ignored-but-changed.example");
    fs::write(&path, serde_json::to_vec(&records).unwrap()).unwrap();
    assert!(imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &keys
        )
        .unwrap_err()
        .contains("Source changed"));
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
}

#[test]
fn local_browse_without_destination_cannot_commit_or_reuse_prior_authority() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    let bytes = source(old.path());
    let mut imports = Imports::default();
    let mut store = Store::open(dest.path().into()).unwrap();
    let keys = Memory::default();
    let prior = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://chosen.example",
        )
        .unwrap();
    let browse = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "",
        )
        .unwrap();
    assert_eq!(browse.candidates.len(), 1);
    assert_eq!(browse.candidates[0].pubkey, PUB);
    assert!(browse.candidates[0].relay_url.is_empty());
    assert!(browse.token.is_empty());
    for (token, id) in [
        (&browse.token, &browse.candidates[0].id),
        (&prior.token, &prior.candidates[0].id),
    ] {
        assert!(imports
            .commit(token, std::slice::from_ref(id), &mut store, &keys)
            .is_err());
    }
    assert_eq!(keys.reads.load(Ordering::SeqCst), 0);
    assert!(keys.keys.lock().unwrap().is_empty());
    assert!(store.agents().unwrap().is_empty());
    assert_eq!(
        fs::read(
            old.path()
                .join(LegacySource::Installed.app_directory())
                .join("agents/managed-agents.json")
        )
        .unwrap(),
        bytes
    );
    let serialized = serde_json::to_string(&browse).unwrap();
    assert!(!serialized.contains("private_key"));
}
