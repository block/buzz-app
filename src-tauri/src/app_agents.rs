//! Native custody for agents the app runs through a plugin (Agents2). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event at a time, and native signs and posts it to the agent's community.
use crate::agents::profile_http::authorization;
use buzz_agent_controller::{AppAgent, AppAgents, Credentials, NewAppAgent, PlatformCredentials};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// The identity file (which locks its own writes across app instances) and the
/// keys awaiting attestation, by pubkey. It owns its credential handle so Agents2
/// never waits on, or fails with, the harness agent controller (whose storage
/// lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost(
    Result<AppAgents, String>,
    Arc<std::sync::Mutex<Vec<NewAppAgent>>>,
    Arc<dyn Credentials>,
);
/// Creates abandoned before commit are dropped, oldest first, past this many.
const PENDING_LIMIT: usize = 8;
impl AppAgentHost {
    pub(crate) fn new(path: Result<PathBuf, String>) -> Self {
        Self(
            path.map(AppAgents::open),
            Arc::default(),
            Arc::new(PlatformCredentials::default()),
        )
    }
    fn agents(&self) -> Result<AppAgents, String> {
        self.0.clone()
    }
    fn pending(&self) -> std::sync::MutexGuard<'_, Vec<NewAppAgent>> {
        self.1
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Runs blocking file and credential work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Native credential operation failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppAgentSummary {
    pubkey: String,
    relay: String,
    owner: String,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
        }
    }
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`. The caller has the community
/// attest it (its `authorize-agent` route), then commits that attestation.
#[tauri::command]
pub(crate) async fn app_agent_create_prepare(
    state: tauri::State<'_, AppAgentHost>,
    destination: String,
    owner: String,
) -> Result<String, String> {
    let prepared = AppAgents::prepare(&destination, &owner)?;
    let pubkey = prepared.pubkey().to_owned();
    let mut pending = state.pending();
    if pending.len() >= PENDING_LIMIT {
        pending.remove(0);
    }
    pending.push(prepared);
    Ok(pubkey)
}

/// Has the signed-in owner attest only the pending key, for its prepared owner.
/// Agents2 never goes through the harness agent host for this.
#[tauri::command]
pub(crate) async fn app_agent_create_authorize(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    pubkey: String,
) -> Result<Vec<String>, String> {
    let owner = state
        .pending()
        .iter()
        .find(|prepared| prepared.pubkey() == pubkey)
        .map(|prepared| prepared.owner().to_owned())
        .ok_or("Create request expired; try again")?;
    identity.inner().authorize_agent(owner, pubkey).await
}

/// Saves the pending key with its owner attestation.
#[tauri::command]
pub(crate) async fn app_agent_create_commit(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    auth: Vec<String>,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents()?;
    let prepared = {
        let mut pending = state.pending();
        pending
            .iter()
            .position(|prepared| prepared.pubkey() == pubkey)
            .map(|index| pending.remove(index))
    }
    .ok_or("Create request expired; try again")?;
    let credentials = state.2.clone();
    blocking(move || {
        credentials.retry();
        agents.commit(prepared, &auth, credentials.as_ref())
    })
    .await
    .map(Into::into)
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents()?;
    let credentials = state.2.clone();
    blocking(move || agents.remove(&pubkey, credentials.as_ref())).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppAgentEvent {
    kind: u16,
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Signs one event as the agent and posts it to the agent's own community.
#[tauri::command]
pub(crate) async fn app_agent_publish(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let agents = state.agents()?;
    let credentials = state.2.clone();
    let (agent, key) = blocking(move || {
        let agent = agents.get(&pubkey)?;
        agent.read_key(credentials.as_ref()).map(|key| (agent, key))
    })
    .await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    let bytes = serde_json::to_vec(&signed).map_err(|_| "Could not encode agent event")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Agent client unavailable")?;
    let response = client
        .post(agent.events_url())
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(&key, &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent event unconfirmed; it may or may not have been accepted")?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    if !status.is_success()
        || receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id.as_str())
    {
        let reason = receipt
            .get("message")
            .or_else(|| receipt.get("error"))
            .and_then(Value::as_str)
            .map(|text| text.chars().take(300).collect::<String>())
            .unwrap_or_else(|| format!("status {}", status.as_u16()));
        return Err(format!("The community refused the agent event: {reason}"));
    }
    Ok(signed)
}
