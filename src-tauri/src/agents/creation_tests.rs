use super::tests::{fixture, invoke, use_credentials};
use super::*;
use buzz_agent_controller::Secret;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Memory {
    keys: Mutex<BTreeMap<String, String>>,
    writes: AtomicUsize,
}
impl Credentials for Memory {
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        self.keys
            .lock()
            .unwrap()
            .get(id)
            .map(|key| Secret::parse(key, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        self.keys
            .lock()
            .unwrap()
            .insert(id.into(), key.hex().to_string());
        Ok(())
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("unexpected delete")
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        panic!("unexpected legacy read")
    }
}
fn owner() -> secp256k1::Keypair {
    let mut bytes = [0; 32];
    bytes[31] = 2;
    secp256k1::Keypair::from_secret_key(
        &secp256k1::Secp256k1::new(),
        &secp256k1::SecretKey::from_byte_array(bytes).unwrap(),
    )
}
fn auth(pubkey: &str) -> String {
    use sha2::{Digest, Sha256};
    let owner = owner();
    let digest = Sha256::digest(format!("nostr:agent-auth:{pubkey}:"));
    json!([
        "auth",
        owner.x_only_public_key().0.to_string(),
        "",
        secp256k1::Secp256k1::new()
            .sign_schnorr_no_aux_rand(&digest, &owner)
            .to_string()
    ])
    .to_string()
}

#[test]
fn commit_binds_validated_draft_and_defaults_before_credentials_and_preserves_retries() {
    let (dir, host, _app, view) = fixture();
    let keys = Arc::new(Memory::default());
    use_credentials(&host, keys.clone());
    let defaults = |value: &str| {
        json!({"edit":{
            "harness":"buzz-agent", "provider":"databricks_v2", "model":"inherited-model", "effort":"",
            "environment":{"KEEP_ME":value}
        }})
    };
    invoke(&view, "agent_control_save_defaults", defaults("first")).unwrap();
    let edit = json!({"name":"Prepared", "systemPrompt":"", "workspace":dir.path(),
        "harness":{"command":"buzz-agent","args":[],"provider":"","model":"","configuration":{"mode":"default"}},
        "environment":{}});
    let request_id = uuid::Uuid::new_v4().to_string();
    let prepare = || {
        invoke(&view, "agent_control_create_prepare", json!({"requestId":request_id,
        "destination":"wss://relay.example", "owner":owner().x_only_public_key().0.to_string(), "edit":edit})).unwrap()
    };
    let prepared = prepare();
    let tag = auth(prepared["pubkey"].as_str().unwrap());
    let commit = |edit: &Value| {
        invoke(
            &view,
            "agent_control_create_commit",
            json!({"requestId":request_id,"edit":edit,"auth":tag}),
        )
    };
    for (pointer, replacement) in [
        (
            "/harness",
            json!({"command":"buzz-agent","args":[],"provider":"databricks_v2","model":"unvalidated-model",
            "configuration":{"mode":"advanced","effort":{"kind":"value","value":"unvalidated-effort"}}}),
        ),
        ("/harness/model", json!("not-validated")),
        ("/harness/provider", json!("openai")),
        (
            "/harness/configuration",
            json!({"mode":"advanced","effort":{"kind":"value","value":"unsupported"}}),
        ),
        ("/environment", json!({"KEEP_ME":"different"})),
        ("/workspace", json!("/different/workspace")),
    ] {
        let mut changed = edit.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        assert!(commit(&changed)
            .unwrap_err()
            .as_str()
            .unwrap()
            .contains("settings or defaults changed"));
        assert_eq!(keys.writes.load(Ordering::SeqCst), 0);
    }
    invoke(&view, "agent_control_save_defaults", defaults("second")).unwrap();
    assert!(commit(&edit)
        .unwrap_err()
        .as_str()
        .unwrap()
        .contains("settings or defaults changed"));
    assert_eq!(keys.writes.load(Ordering::SeqCst), 0);
    assert!(!dir.path().join("store/agents.json").exists());
    assert_eq!(prepare(), prepared);
    let saved = commit(&edit).unwrap();
    assert_eq!(saved["agents"][0]["pubkey"], prepared["pubkey"]);
    assert_eq!(prepare(), prepared);
    commit(&edit).unwrap();
    assert_eq!(keys.writes.load(Ordering::SeqCst), 1);
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.path().join("store/agents.json")).unwrap())
            .unwrap();
    assert_eq!(stored["agents"].as_array().unwrap().len(), 1);
    assert_eq!(stored["agents"][0]["environment"], json!({}));
    assert_eq!(stored["agents"][0]["harness"]["provider"], "");
    assert_eq!(stored["agents"][0]["harness"]["model"], "");
}
