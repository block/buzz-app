//! Dedicated worker process: SDK threads and native libraries die with this
//! process, so cancelling a download/start never strands a listener in the app.
use crate::{
    broker::Broker,
    discovery,
    identity::{self, OwnerIdentity},
    transport_policy,
};
use anyhow::{bail, Context};
use mesh_llm_events::{ConsoleSessionMode, OutputEvent, OutputSink};
use mesh_llm_sdk::{client, serve, EmbeddedNodeHandle, MeshDiscoveryMode, TrustPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    sync::Arc,
    time::Duration,
};

pub const WORKER_ARG: &str = "--buzz-community-compute-worker";
pub const OUTPUT_PREFIX: &str = "BUZZ_COMPUTE ";
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Serve,
    Client,
}
impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Serve => "serve",
            Self::Client => "client",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartRequest {
    #[serde(default)]
    pub mode: Mode,
    pub community: String,
    pub viewer: String,
    pub model_id: String,
    pub max_vram_gb: Option<f64>,
}
impl StartRequest {
    pub fn validate(&self) -> anyhow::Result<()> {
        nostr::PublicKey::from_hex(&self.viewer)?;
        let url = url::Url::parse(&self.community)?;
        if !matches!(url.scheme(), "https" | "wss")
            && !(matches!(url.scheme(), "http" | "ws")
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
        {
            bail!("Select a secure community URL");
        }
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            bail!("Invalid community URL");
        }
        if self.model_id.trim().is_empty()
            || self.model_id.len() > 512
            || self.model_id.chars().any(char::is_control)
            || self.model_id.trim() == "auto"
        {
            bail!("Choose a local model to share");
        }
        if self
            .max_vram_gb
            .is_some_and(|gb| !gb.is_finite() || gb <= 0.0 || gb > 100000.0)
        {
            bail!("Memory limit must be positive");
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerInput {
    pub api_port: u16,
    pub console_port: u16,
    pub broker_origin: String,
    pub owner_key: std::path::PathBuf,
    pub request: StartRequest,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Download {
    pub received: u64,
    pub total: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    #[serde(default)]
    pub usage_sample: bool,
    #[serde(default)]
    pub usage: Option<crate::usage::Usage>,
    pub state: String,
    pub detail: Option<String>,
    pub download: Option<Download>,
}
fn emit(update: Update) {
    if let Ok(json) = serde_json::to_string(&update) {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{OUTPUT_PREFIX}{json}");
        let _ = out.flush();
    }
}
fn state(value: &str, detail: &str) {
    emit(Update {
        usage_sample: false,
        usage: None,
        state: value.into(),
        detail: Some(detail.into()),
        download: None,
    });
}
struct Progress;
impl OutputSink for Progress {
    fn emit_event(&self, event: OutputEvent) -> std::io::Result<()> {
        if let OutputEvent::ModelDownloadProgress {
            downloaded_bytes,
            total_bytes,
            ..
        } = event
        {
            emit(Update {
                usage_sample: false,
                usage: None,
                state: "starting".into(),
                detail: Some("Downloading model or native runtime…".into()),
                download: Some(Download {
                    received: downloaded_bytes.unwrap_or(0),
                    total: total_bytes,
                }),
            });
        }
        Ok(())
    }
    fn console_session_mode(&self) -> Option<ConsoleSessionMode> {
        Some(ConsoleSessionMode::InteractiveDashboard)
    }
}
fn bind(owner: &OwnerIdentity, viewer: &str, mut payload: Value) -> anyhow::Result<Value> {
    let tokens = identity::advertised_endpoint_tokens(&payload)
        .context("Malformed local compute targets")?;
    payload["ownerId"] = json!(owner.owner_id);
    payload["ownerVerifyingKey"] = json!(owner.verifying_key_hex);
    payload["ownerBindingSig"] = json!(owner.sign_member_binding(viewer)?);
    payload["ownerEndpointBindingSig"] =
        json!(owner.sign_member_endpoint_binding(viewer, &tokens)?);
    Ok(payload)
}
fn idle(owner: &OwnerIdentity, viewer: &str) -> anyhow::Result<Value> {
    bind(
        owner,
        viewer,
        json!({"serveTargets":[],"models":[],"node_state":"standby"}),
    )
}
fn owners(events: &[nostr::Event], self_owner: &str) -> Vec<String> {
    let members = discovery::latest_membership_list(events).unwrap_or_default();
    let mut owners = events
        .iter()
        .filter(|e| {
            e.kind.as_u16() == 30003
                && members.contains(&e.pubkey.to_hex())
                && e.created_at <= nostr::Timestamp::now()
        })
        .filter_map(discovery::owner_id_from_status_event)
        .collect::<Vec<_>>();
    owners.push(self_owner.into());
    owners.sort();
    owners.dedup();
    owners
}
fn mesh_name(relay: &str) -> String {
    use sha2::{Digest, Sha256};
    let normalized = relay
        .replacen("https://", "wss://", 1)
        .trim_end_matches('/')
        .to_string();
    let digest = hex::encode(Sha256::digest(normalized.as_bytes()));
    format!("buzz-community-{}", &digest[..32])
}
fn preflight(api: u16, console: u16) -> anyhow::Result<()> {
    if api == 0 || console == 0 || api == console {
        bail!("Compute ports must be distinct nonzero ports");
    }
    // Bind both simultaneously and drop only after both are proven available.
    let _api = std::net::TcpListener::bind(("127.0.0.1", api))
        .with_context(|| format!("Compute API port {api} is already in use"))?;
    let _console = std::net::TcpListener::bind(("127.0.0.1", console))
        .with_context(|| format!("Compute console port {console} is already in use"))?;
    Ok(())
}
fn status_payload(
    status: mesh_llm_sdk::EmbeddedNodeStatus,
    owner: &OwnerIdentity,
    viewer: &str,
) -> anyhow::Result<Value> {
    let models = models::models_from_status_payload(Some(&status.payload));
    let targets = if let Some(token) = status
        .invite_token
        .filter(|token| transport_policy::validate_advertised_endpoint(token).is_ok())
    {
        models
            .iter()
            .map(|model| json!({"modelId":model.id,"endpointAddr":token}))
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let mut payload = json!({"serveTargets":targets,"models":models,"node_state":if targets.is_empty(){"loading"}else{"serving"}});
    for field in ["my_vram_gb", "model_size_gb"] {
        if let Some(value) = status.payload[field]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.0)
        {
            payload[field] = json!(value);
        }
    }
    if let Some(label) = discovery::device_name_from_status(&status.payload, None) {
        payload["deviceName"] = json!(label.chars().take(128).collect::<String>());
    }
    bind(owner, viewer, payload)
}
async fn fresh_evidence(broker: &Broker) -> anyhow::Result<Vec<nostr::Event>> {
    tokio::time::timeout(Duration::from_secs(12), broker.evidence())
        .await
        .context("Community admission refresh timed out; sharing stopped")?
}
async fn run(
    input: WorkerInput,
    cleanup: Arc<tokio::sync::Mutex<Option<(Broker, OwnerIdentity)>>>,
) -> anyhow::Result<()> {
    input.request.validate()?;
    preflight(input.api_port, input.console_port)?;
    let broker = Broker::connect(&input.broker_origin, &input.request).await?;
    fresh_evidence(&broker).await?; // Membership before keys, downloads, or publication.
    let owner = identity::ensure_owner_identity_at(input.owner_key)?;
    *cleanup.lock().await = Some((broker.clone(), owner.clone()));
    broker.publish(idle(&owner, &broker.viewer)?).await?;
    if input.request.mode == Mode::Serve {
        state("starting", "Preparing native compute runtime…");
        mesh_llm_host_runtime::initialize_host_runtime().await?;
        mesh_llm_host_runtime::models::download_model_ref_with_progress_details(
            &input.request.model_id,
            true,
        )
        .await?;
    }
    preflight(input.api_port, input.console_port)?;
    let events = fresh_evidence(&broker).await?;
    let trusted = owners(&events, &owner.owner_id);
    let (disabled, relays) = match transport_policy::iroh_relay_mode()? {
        transport_policy::IrohRelayMode::Disabled => (true, vec![]),
        transport_policy::IrohRelayMode::Default => (
            false,
            transport_policy::MESH_LLM_DEFAULT_RELAYS
                .iter()
                .map(|s| s.to_string())
                .collect(),
        ),
        transport_policy::IrohRelayMode::Custom(urls) => {
            (false, urls.into_iter().map(|u| u.to_string()).collect())
        }
    };
    let startup = async {
        if input.request.mode == Mode::Client {
            state("starting", "Connecting to community compute…");
            let builder = client::EmbeddedClientConfig::builder()
                .api_port(input.api_port)
                .console_port(input.console_port)
                .publish(false)
                .auto_join(false)
                .discovery_mode(MeshDiscoveryMode::Nostr)
                .startup_timeout(Duration::from_secs(180))
                .console_ui(true)
                .mesh_name(mesh_name(&broker.relay))
                .disable_iroh_relays(disabled)
                .iroh_relays(relays)
                .owner_key(owner.keystore_path.clone())
                .owner_required(true)
                .trust_policy(TrustPolicy::Allowlist)
                .trust_owners(trusted.clone());
            client::start(builder.build()).await
        } else {
            let mut builder = serve::EmbeddedServeConfig::builder()
                .model(input.request.model_id.clone())
                .api_port(input.api_port)
                .console_port(input.console_port)
                .publish(false)
                .auto_join(false)
                .discovery_mode(MeshDiscoveryMode::Nostr)
                .startup_timeout(Duration::from_secs(180))
                .console_ui(true)
                .mesh_name(mesh_name(&broker.relay))
                .disable_iroh_relays(disabled)
                .iroh_relays(relays)
                .owner_key(owner.keystore_path.clone())
                .owner_required(true)
                .trust_policy(TrustPolicy::Allowlist)
                .trust_owners(trusted.clone());
            if let Some(gb) = input.request.max_vram_gb {
                builder = builder.max_vram_gb(gb);
            }
            state("starting", "Loading the model…");
            serve::start(builder.build()).await
        }
    };
    tokio::pin!(startup);
    let mut checks = tokio::time::interval(Duration::from_secs(15));
    checks.tick().await;
    let runtime = loop {
        tokio::select! {
            result=&mut startup=>break result?,
            _=checks.tick()=>{
                let evidence=fresh_evidence(&broker).await?;
                if owners(&evidence,&owner.owner_id)!=trusted {bail!("Community admission changed during startup; retry sharing");}
            }
        }
    };
    let sharing = std::sync::atomic::AtomicBool::new(false);
    let admission = async {
        loop {
            // No serving heartbeat is published until membership is freshly verified.
            let evidence = fresh_evidence(&broker).await?;
            if owners(&evidence, &owner.owner_id) != trusted {
                bail!(
                "Community admission changed; sharing stopped. Turn sharing off and on to refresh."
            );
            }
            let status = tokio::time::timeout(Duration::from_secs(8), runtime.status()).await??;
            let payload = if input.request.mode == Mode::Client {
                // Consumers publish ownership only, never remote models as their own serving targets.
                idle(&owner, &broker.viewer)?
            } else {
                status_payload(status, &owner, &broker.viewer)?
            };
            let ready = input.request.mode == Mode::Client || payload["node_state"] == "serving";
            broker.publish(payload).await?;
            sharing.store(ready, std::sync::atomic::Ordering::SeqCst);
            emit(Update {
                usage_sample: false,
                state: if ready { "running" } else { "starting" }.into(),
                detail: Some(
                    if input.request.mode == Mode::Client {
                        "Connected locally; waiting for a verified provider"
                    } else if ready {
                        "Sharing with verified community members"
                    } else {
                        "Waiting for the model to become ready…"
                    }
                    .into(),
                ),
                download: None,
                usage: None,
            });
            join_peers(&runtime, &evidence, &owner.owner_id).await;
            checks.tick().await;
        }
    };
    let samples = async {
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            if !sharing.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }
            let sample = tokio::time::timeout(Duration::from_secs(2), runtime.status()).await;
            if !sharing.load(std::sync::atomic::Ordering::SeqCst) {
                continue;
            }
            let usage = sample
                .ok()
                .and_then(Result::ok)
                .and_then(|status| crate::usage::Usage::from_payload(&status.payload));
            emit(Update {
                usage_sample: true,
                state: "running".into(),
                detail: Some("Sharing with verified community members".into()),
                download: None,
                usage,
            });
        }
    };
    tokio::select! {
        result = admission => result,
        _ = samples => unreachable!(),
    }
}

async fn join_peers(runtime: &EmbeddedNodeHandle, events: &[nostr::Event], self_owner: &str) {
    let members = discovery::latest_membership_list(events).unwrap_or_default();
    // Bounded peer bootstrap. Every endpoint is owner-bound, member-scoped and sanitized.
    let mut joined = std::collections::BTreeSet::new();
    for e in events {
        if e.kind.as_u16() != 30003
            || !members.contains(&e.pubkey.to_hex())
            || e.created_at > nostr::Timestamp::now()
            || !discovery::status_is_fresh(e, nostr::Timestamp::now().as_secs())
        {
            continue;
        }
        let Some(owner) = discovery::owner_id_from_status_event(e) else {
            continue;
        };
        if owner == self_owner {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(&e.content) else {
            continue;
        };
        if !discovery::endpoint_binding_is_valid(e, &payload) {
            continue;
        }
        for token in identity::advertised_endpoint_tokens(&payload).unwrap_or_default() {
            let Ok(endpoint) = transport_policy::validate_advertised_endpoint(&token) else {
                continue;
            };
            if !joined.insert(endpoint.endpoint_id) {
                continue;
            }
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                runtime.join_token(endpoint.join_token),
            )
            .await;
            if joined.len() >= 3 {
                return;
            }
        }
    }
}
/// Called before Tauri setup. Stdin EOF also stops the child after a parent crash.
pub fn entry() -> ! {
    if !cfg!(debug_assertions) {
        std::process::exit(2);
    }
    let mut line = String::new();
    if std::io::stdin()
        .lock()
        .take(8193)
        .read_line(&mut line)
        .is_err()
        || line.len() > 8192
    {
        std::process::exit(2);
    }
    let input: WorkerInput = match serde_json::from_str(&line) {
        Ok(input) => input,
        Err(_) => std::process::exit(2),
    };
    let rt = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .thread_stack_size(8 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("compute worker runtime");
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
        let _ = stop_tx.send(());
    });
    mesh_llm_events::set_output_sink(Arc::new(Progress));
    rt.block_on(async move {
        let cleanup = Arc::new(tokio::sync::Mutex::new(None));
        let result = tokio::select! {
            result=run(input,cleanup.clone())=>result,
            _=stop_rx=>Ok(()),
        };
        state("stopping", "Stopping shared compute…");
        if let Some((broker, owner)) = cleanup.lock().await.as_ref() {
            if let Ok(payload) = idle(owner, &broker.viewer) {
                let _ = tokio::time::timeout(Duration::from_secs(4), broker.publish(payload)).await;
            }
        }
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                state("failed", &format!("{error:#}"));
                std::process::exit(1);
            }
        }
    })
}
mod models;

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag, Timestamp};
    #[test]
    fn admission_uses_membership_and_owner_proof_but_not_device_liveness() {
        let member = Keys::generate();
        let stranger = Keys::generate();
        let owner = mesh_llm_host_runtime::crypto::OwnerKeypair::generate();
        let payload = json!({"ownerId":owner.owner_id(),"ownerVerifyingKey":hex::encode(owner.verifying_key().as_bytes()),"ownerBindingSig":hex::encode(owner.sign_bytes(&identity::member_binding_bytes(&member.public_key().to_hex())))});
        let status = EventBuilder::new(Kind::Custom(30003), payload.to_string())
            .custom_created_at(Timestamp::from_secs(1))
            .sign_with_keys(&member)
            .unwrap();
        let roster = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member".to_string(), member.public_key().to_hex()]).unwrap()])
            .sign_with_keys(&stranger)
            .unwrap();
        // Broker independently verifies the roster authority before this pure projection.
        let trusted = owners(&[roster.clone(), status.clone()], "self");
        assert!(trusted.contains(&owner.owner_id()));
        let removed = EventBuilder::new(Kind::Custom(13534), "")
            .sign_with_keys(&stranger)
            .unwrap();
        assert_eq!(owners(&[removed, status], "self"), vec!["self"]);
    }
    #[test]
    fn validates_start_intent_and_preserves_old_community_mesh_name() {
        let request = StartRequest {
            community: "https://community.example".into(),
            viewer: Keys::generate().public_key().to_hex(),
            mode: Mode::Serve,
            model_id: "local-model".into(),
            max_vram_gb: Some(8.0),
        };
        assert!(request.validate().is_ok());
        for model in ["", "auto", "bad\nmodel"] {
            let mut bad = request.clone();
            bad.model_id = model.into();
            assert!(bad.validate().is_err());
        }
        for cap in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            let mut bad = request.clone();
            bad.max_vram_gb = Some(cap);
            assert!(bad.validate().is_err());
        }
        use sha2::{Digest, Sha256};
        let digest = hex::encode(Sha256::digest(b"wss://community.example"));
        assert_eq!(
            mesh_name("https://community.example"),
            format!("buzz-community-{}", &digest[..32])
        );
    }
}
