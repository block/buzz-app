use super::*;
use base64::Engine;
use buzz_agent_controller::{AppAgent, Credentials, LegacySource, Secret};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tauri::{
    ipc::{CallbackFn, InvokeBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewUrl, WebviewWindowBuilder,
};

// Only the credential backing is synthetic. The host, IPC handlers, signing,
// admission, HTTP authentication and receipt validation remain production code.
struct Custody {
    key: Secret,
    reads: AtomicUsize,
    denied: AtomicBool,
}
impl Credentials for Custody {
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret, String> {
        panic!("no legacy credentials")
    }
    fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.denied.load(Ordering::SeqCst) {
            return Err("Test credential access denied".into());
        }
        Secret::parse(&self.key.hex(), pubkey).map(Some)
    }
    fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
        panic!("no credential creation")
    }
    fn delete(&self, _: &str, _: &str) -> Result<(), String> {
        panic!("no credential deletion")
    }
}

fn agent(relay: String, key: &Secret) -> AppAgent {
    use secp256k1::{Keypair, Secp256k1, SecretKey};
    let secp = Secp256k1::new();
    let owner = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array([2; 32]).unwrap());
    let proof = secp.sign_schnorr_no_aux_rand(
        &Sha256::digest(format!("nostr:agent-auth:{}:", key.pubkey())),
        &owner,
    );
    let auth = serde_json::json!([
        "auth",
        owner.x_only_public_key().0.to_string(),
        "",
        proof.to_string()
    ]);
    AppAgent {
        pubkey: key.pubkey().into(),
        relay,
        owner: owner.x_only_public_key().0.to_string(),
        auth: auth.to_string(),
        agent_type: "fixture/local".into(),
        name: "Local agent".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
        home: None,
        joining: false,
        protection: None,
        protection_revision: 0,
    }
}

fn app(host: AppAgentHost) -> (tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>) {
    let app = mock_builder()
        .manage(host)
        .invoke_handler(tauri::generate_handler![
            app_agent_prepare_dm_move,
            app_agent_publish_dm_move
        ])
        .build(crate::app_context())
        .unwrap();
    let window = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
        .build()
        .unwrap();
    (app, window)
}
fn invoke(
    window: &tauri::WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
) -> Result<Value, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: "tauri://localhost".parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
    .map(|response| response.deserialize().unwrap())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_ipc_restores_custody_and_retries_the_same_signed_copy() {
    use crate::federated_identity::{
        agent::AgentTokens,
        testing::{community, reply},
    };
    let community = community(false).await;
    let relay = community
        .origin
        .as_str()
        .trim_end_matches('/')
        .replacen("https:", "wss:", 1);
    let credentials = Arc::new(Custody {
        key: Secret::generate().unwrap(),
        reads: AtomicUsize::new(0),
        denied: AtomicBool::new(false),
    });
    let agent = agent(relay.clone(), &credentials.key);
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("identities.json");
    let host = AppAgentHost::holding(
        path.clone(),
        &agent,
        Secret::parse(&credentials.key.hex(), &agent.pubkey).unwrap(),
        AgentTokens::unconfigured(),
    )
    .with_credentials_for_test(credentials.clone());
    let template = serde_json::json!({"kind":9,"content":"Copied after unanimous approval","tags":[["h","10000000-0000-4000-8000-000000000002"],["e","a".repeat(64),"","reply"],["buzz:dm-move","e44c7b53-42b2-4c5e-8051-fce508998b96","b".repeat(64),"1700000000000"]]});
    let (first, window) = app(host);
    let prepared = invoke(
        &window,
        "app_agent_prepare_dm_move",
        serde_json::json!({"pubkey":agent.pubkey,"relay":relay,"event":template}),
    )
    .unwrap();
    let signed: nostr::event::Event = serde_json::from_value(prepared.clone()).unwrap();
    signed.verify().unwrap();
    assert_eq!(prepared["pubkey"], agent.pubkey);
    assert_eq!(prepared.as_object().unwrap().len(), 7);
    assert!(prepared["tags"]
        .as_array()
        .unwrap()
        .iter()
        .any(|tag| tag[0] == "auth"));
    let receipt = directory.path().join("pending-copy.json");
    std::fs::write(&receipt, serde_json::to_vec(&prepared).unwrap()).unwrap();
    drop(window);
    drop(first);

    let accepted = serde_json::json!({"accepted":true,"event_id":prepared["id"]}).to_string();
    let served = community.serve(vec![
        reply("200 OK", r#"{"accepted":true,"event_id":"wrong"}"#),
        reply("200 OK", &accepted),
    ]);
    let restore = || {
        AppAgentHost::new(
            Ok(path.clone()),
            Err("no legacy store".into()),
            true,
            AgentTokens::unconfigured(),
        )
        .with_credentials_for_test(credentials.clone())
    };
    let saved: Value = serde_json::from_slice(&std::fs::read(receipt).unwrap()).unwrap();
    let payload = serde_json::json!({"pubkey":agent.pubkey,"relay":relay,"event":saved});
    let (second, window) = app(restore());
    let uncertain = invoke(&window, "app_agent_publish_dm_move", payload.clone()).unwrap_err();
    assert!(uncertain.as_str().unwrap().contains("unconfirmed"));
    drop(window);
    drop(second);
    let (third, window) = app(restore());
    assert_eq!(
        invoke(&window, "app_agent_publish_dm_move", payload.clone()).unwrap(),
        prepared
    );
    assert_eq!(credentials.reads.load(Ordering::SeqCst), 3);

    let mut tampered = payload.clone();
    tampered["event"]["content"] = serde_json::json!("Changed after signing");
    assert!(invoke(&window, "app_agent_publish_dm_move", tampered)
        .unwrap_err()
        .as_str()
        .unwrap()
        .contains("signature"));
    let foreign = nostr_pairing::Keys::generate();
    let foreign_tags: Vec<Vec<String>> = serde_json::from_value(prepared["tags"].clone()).unwrap();
    let foreign_event = nostr_pairing::EventBuilder::new(
        nostr_pairing::Kind::Custom(9),
        prepared["content"].as_str().unwrap(),
    )
    .tags(
        foreign_tags
            .into_iter()
            .map(|tag| nostr_pairing::Tag::parse(tag).unwrap()),
    )
    .custom_created_at(nostr_pairing::Timestamp::from(
        prepared["created_at"].as_u64().unwrap(),
    ))
    .sign_with_keys(&foreign)
    .unwrap();
    assert!(invoke(
        &window,
        "app_agent_publish_dm_move",
        serde_json::json!({"pubkey":agent.pubkey,"relay":relay,"event":foreign_event})
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .contains("does not belong"));
    drop(window);
    drop(third);
    credentials.denied.store(true, Ordering::SeqCst);
    let (_fourth, window) = app(restore());
    assert!(invoke(&window, "app_agent_publish_dm_move", payload)
        .unwrap_err()
        .as_str()
        .unwrap()
        .contains("denied"));
    assert!(invoke(
        &window,
        "app_agent_prepare_dm_move",
        serde_json::json!({"pubkey":agent.pubkey,"relay":relay,"event":template})
    )
    .unwrap_err()
    .as_str()
    .unwrap()
    .contains("denied"));
    assert_eq!(served.received().len(), 2);
    let expected_hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&prepared).unwrap())
    );
    let mut authentication_ids = std::collections::HashSet::new();
    for head in served.heads().await {
        assert!(head.starts_with("POST /events "));
        let auth = head
            .lines()
            .find_map(|line| {
                line.split_once(':')
                    .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    .map(|(_, value)| value.trim().strip_prefix("Nostr ").unwrap())
            })
            .unwrap();
        let proof: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(auth)
                .unwrap(),
        )
        .unwrap();
        serde_json::from_value::<nostr::event::Event>(proof.clone())
            .unwrap()
            .verify()
            .unwrap();
        assert_eq!(proof["pubkey"], agent.pubkey);
        assert_eq!(proof["kind"], 27235);
        assert!(authentication_ids.insert(proof["id"].as_str().unwrap().to_owned()));
        assert!(proof["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(["method", "POST"])));
        assert!(proof["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(["u", agent.events_url()])));
        assert!(proof["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(["payload", expected_hash])));
    }
}
