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
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.keys.lock().unwrap().remove(id);
        Ok(())
    }
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
    // Source `start_on_app_launch: true` does not auto-start an imported record.
    assert_eq!(saved.start_on_app_launch, Some(false));
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
        "",
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

fn team_source(root: &Path, teams: Value) {
    source(root);
    let base = root
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    let path = base.join("managed-agents.json");
    let mut rows: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    rows[1]["team_id"] = json!("powerpuff");
    rows[1]["backend"] = json!({"type":"local"});
    fs::write(path, serde_json::to_vec(&rows).unwrap()).unwrap();
    fs::write(base.join("teams.json"), serde_json::to_vec(&teams).unwrap()).unwrap();
}
fn preview_team(imports: &mut Imports, old: &Path, workspace: &Path) -> ImportPreview {
    imports
        .preview(
            LegacySource::Installed,
            old.into(),
            workspace.into(),
            "wss://relay.example",
        )
        .unwrap()
}
#[test]
fn explicit_team_import_snapshots_instructions_and_publication_without_start_or_source_write() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(
        old.path(),
        json!([{ "id":"powerpuff", "instructions":"  Preserve team instructions.  ", "future":"kept" }]),
    );
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/teams.json");
    let before = fs::read(&path).unwrap();
    let mut imports = Imports::default();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    assert!(!serde_json::to_string(&preview)
        .unwrap()
        .contains("Preserve team instructions"));
    let mut store = Store::open(dest.path().into()).unwrap();
    imports
        .commit(
            &preview.token,
            &[preview.candidates[0].id.clone()],
            &mut store,
            &Memory::default(),
        )
        .unwrap();
    let agent = store.agents().unwrap().remove(0);
    assert_eq!(
        crate::team::instructions(&agent).unwrap(),
        Some("Preserve team instructions.")
    );
    assert_eq!(agent.imported["team"]["future"], "kept");
    assert_eq!(agent.extra["activityPublication"], true);
    assert!(!agent.enabled);
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_file(path).unwrap();
    assert_eq!(
        crate::team::instructions(&store.agents().unwrap()[0]).unwrap(),
        Some("Preserve team instructions.")
    );
}
#[test]
fn incomplete_team_completion_preserves_native_settings_and_credentials_with_atomic_revision_fence()
{
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(old.path(), json!([{ "id":"powerpuff" }])); // Absent instructions are legitimately empty.
    let data = read_source(&old.path().join(LegacySource::Installed.app_directory())).unwrap();
    let mut saved = resolve(&data, &data.records[1], dest.path(), "wss://relay.example").unwrap();
    saved.imported.as_object_mut().unwrap().remove("team");
    saved.extra.remove("activityPublication");
    saved.system_prompt = "Current native prompt, not legacy prompt".into();
    saved.harness.model = "current-native-model".into();
    saved
        .environment
        .insert("CUSTOM_CURRENT".into(), "preserve".into());
    let id = saved.id.clone();
    let mut store = Store::open(dest.path().into()).unwrap();
    store.insert(vec![saved.clone()]).unwrap();
    assert!(store.snapshot().unwrap().agents[0].team_import_required);
    let mut imports = Imports::default();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    let credentials = Memory::default();
    imports
        .commit(
            &preview.token,
            std::slice::from_ref(&id),
            &mut store,
            &credentials,
        )
        .unwrap();
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
    assert!(credentials.keys.lock().unwrap().is_empty());
    let completed = store.agents().unwrap().remove(0);
    assert_eq!(completed.revision, saved.revision + 1);
    assert!(!completed.enabled);
    assert_eq!(completed.credential_id, saved.credential_id);
    assert_eq!(completed.auth_tag, saved.auth_tag);
    assert_eq!(completed.pubkey, saved.pubkey);
    assert_eq!(completed.relay_url, saved.relay_url);
    assert_eq!(completed.workspace, saved.workspace);
    assert_eq!(completed.system_prompt, saved.system_prompt);
    assert_eq!(completed.harness.model, saved.harness.model);
    assert_eq!(completed.environment, saved.environment);
    assert_eq!(completed.imported["record"], saved.imported["record"]);
    assert_eq!(crate::team::instructions(&completed).unwrap(), None);
    assert!(!store.snapshot().unwrap().agents[0].team_import_required);
    assert!(imports.prepare(&preview.token, &[id], &store).is_err());
}
#[test]
fn team_source_drift_and_bad_snapshots_fail_before_keys_and_do_not_guess_defaults() {
    for teams in [
        json!([]),
        json!([{ "id":"other" }]),
        json!([{ "id":"powerpuff", "instructions": 3 }]),
        json!([{ "id":"powerpuff", "source_dir":"/some/pack" }]),
        json!([{ "id":"powerpuff", "instructions":"x".repeat(128*1024+1) }]),
    ] {
        let old = tempfile::tempdir().unwrap();
        let dest = tempfile::tempdir().unwrap();
        team_source(old.path(), teams);
        let mut imports = Imports::default();
        let preview = preview_team(&mut imports, old.path(), dest.path());
        let mut store = Store::open(dest.path().into()).unwrap();
        let credentials = Memory::default();
        assert!(imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &credentials
            )
            .is_err());
        assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
        assert!(store.agents().unwrap().is_empty());
    }
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(
        old.path(),
        json!([{ "id":"powerpuff", "instructions":"one" }]),
    );
    let mut imports = Imports::default();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    let mut store = Store::open(dest.path().into()).unwrap();
    let credentials = Memory::default();
    let prepared = imports
        .prepare(&preview.token, &[preview.candidates[0].id.clone()], &store)
        .unwrap();
    let acquired = prepared.acquire(&credentials).unwrap();
    let path = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents/teams.json");
    fs::write(&path, r#"[{"id":"powerpuff","instructions":"changed"}]"#).unwrap();
    assert!(acquired.commit(&mut store).is_err());
    assert!(store.agents().unwrap().is_empty());
    fs::write(&path, r#"[{"id":"powerpuff"},{"id":"powerpuff"}]"#).unwrap();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    assert!(imports
        .prepare(&preview.token, &[preview.candidates[0].id.clone()], &store)
        .is_err());
    fs::remove_file(&path).unwrap();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    assert!(imports
        .prepare(&preview.token, &[preview.candidates[0].id.clone()], &store)
        .is_err());
}
#[test]
fn team_completion_refuses_native_changes_while_prepared() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(
        old.path(),
        json!([{ "id":"powerpuff", "instructions":"team" }]),
    );
    let data = read_source(&old.path().join(LegacySource::Installed.app_directory())).unwrap();
    let mut agent = resolve(&data, &data.records[1], dest.path(), "wss://relay.example").unwrap();
    agent.imported.as_object_mut().unwrap().remove("team");
    let id = agent.id.clone();
    let mut store = Store::open(dest.path().into()).unwrap();
    store.insert(vec![agent]).unwrap();
    let mut imports = Imports::default();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    let prepared = imports
        .prepare(&preview.token, std::slice::from_ref(&id), &store)
        .unwrap()
        .acquire(&Memory::default())
        .unwrap();
    store.enabled(&id, true).unwrap();
    assert!(prepared.commit(&mut store).is_err());
    assert!(store.agents().unwrap()[0].imported.get("team").is_none());
    assert!(imports
        .prepare(&preview.token, std::slice::from_ref(&id), &store)
        .is_err());
}

#[test]
fn missing_or_unrelated_teams_do_not_block_selection_of_nonteam_agents() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(
        old.path(),
        json!([{ "invalid unrelated":"entry" }, {"id":"other"}, {"id":"other"}]),
    );
    let base = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    let mut rows: Value =
        serde_json::from_slice(&fs::read(base.join("managed-agents.json")).unwrap()).unwrap();
    // Unselected team-linked definition remains; selected keyed record is ordinary.
    rows[0]["team_id"] = json!("unrelated");
    rows[1].as_object_mut().unwrap().remove("team_id");
    fs::write(
        base.join("managed-agents.json"),
        serde_json::to_vec(&rows).unwrap(),
    )
    .unwrap();
    for missing in [false, true] {
        if missing {
            fs::remove_file(base.join("teams.json")).unwrap();
        }
        let target = tempfile::tempdir().unwrap();
        let mut store = Store::open(target.path().into()).unwrap();
        let mut imports = Imports::default();
        let preview = preview_team(&mut imports, old.path(), dest.path());
        imports
            .commit(
                &preview.token,
                &[preview.candidates[0].id.clone()],
                &mut store,
                &Memory::default(),
            )
            .unwrap();
        assert_eq!(store.agents().unwrap().len(), 1);
    }
}

#[test]
#[cfg(unix)]
fn chosen_team_source_rejects_symlink_files_without_echoing_paths() {
    use std::os::unix::fs::symlink;
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(old.path(), json!([{ "id":"powerpuff" }]));
    let base = old
        .path()
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    let path = base.join("teams.json");
    let actual = old.path().join("private-team-source");
    fs::rename(&path, &actual).unwrap();
    symlink(&actual, &path).unwrap();
    let mut imports = Imports::default();
    let error = imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example",
        )
        .err()
        .unwrap();
    assert!(!error.contains("private-team-source"));
    fs::remove_file(&path).unwrap();
    fs::rename(&actual, &path).unwrap();
    let held = old.path().join("held");
    fs::rename(&base, &held).unwrap();
    symlink(&held, &base).unwrap();
    assert!(imports
        .preview(
            LegacySource::Installed,
            old.path().into(),
            dest.path().into(),
            "wss://relay.example"
        )
        .is_err());
}

#[test]
fn team_completion_preserves_revisionless_launch_preference_and_profile_receipt() {
    let old = tempfile::tempdir().unwrap();
    let dest = tempfile::tempdir().unwrap();
    team_source(
        old.path(),
        json!([{ "id":"powerpuff", "instructions":"team" }]),
    );
    let data = read_source(&old.path().join(LegacySource::Installed.app_directory())).unwrap();
    let mut agent = resolve(&data, &data.records[1], dest.path(), "wss://relay.example").unwrap();
    agent.imported.as_object_mut().unwrap().remove("team");
    agent.extra.insert("profilePending".into(), json!(true));
    let id = agent.id.clone();
    let revision = agent.revision;
    let mut store = Store::open(dest.path().into()).unwrap();
    store.insert(vec![agent]).unwrap();
    let mut imports = Imports::default();
    let preview = preview_team(&mut imports, old.path(), dest.path());
    let credentials = Memory::default();
    let prepared = imports
        .prepare(&preview.token, std::slice::from_ref(&id), &store)
        .unwrap()
        .acquire(&credentials)
        .unwrap();
    store.start_on_app_launch(&id, true).unwrap();
    store.profile_published(&id, revision).unwrap();
    let before = store.agents().unwrap().remove(0);
    prepared.commit(&mut store).unwrap();
    let saved = store.agents().unwrap().remove(0);
    let mut expected = before;
    expected.imported["team"] = json!({"id":"powerpuff", "instructions":"team"});
    expected
        .extra
        .insert("activityPublication".into(), json!(true));
    expected.revision += 1;
    assert_eq!(
        serde_json::to_value(saved).unwrap(),
        serde_json::to_value(expected).unwrap()
    );
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 0);
}
