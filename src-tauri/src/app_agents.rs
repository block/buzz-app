//! Native custody for agents the app runs through a plugin (Agents2). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event at a time, and native signs and posts it to the agent's community.
use crate::agents::{profile_http::authorization, AgentHost};
use buzz_agent_controller::{AppAgent, AppAgents, NewAppAgent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

/// Serializes identity file writes, and holds the one key awaiting attestation.
#[derive(Clone)]
pub(crate) struct AppAgentHost(
    Arc<tokio::sync::Mutex<Result<AppAgents, String>>>,
    Arc<tokio::sync::Mutex<Option<NewAppAgent>>>,
);
impl AppAgentHost {
    pub(crate) fn new(path: Result<PathBuf, String>) -> Self {
        Self(
            Arc::new(tokio::sync::Mutex::new(path.map(AppAgents::open))),
            Arc::default(),
        )
    }
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
    let agents = state.0.lock().await;
    let agents = agents.as_ref().map_err(Clone::clone)?;
    Ok(agents.list()?.into_iter().map(Into::into).collect())
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
    *state.1.lock().await = Some(prepared);
    Ok(pubkey)
}

/// Saves the pending key with its owner attestation.
#[tauri::command]
pub(crate) async fn app_agent_create_commit(
    state: tauri::State<'_, AppAgentHost>,
    host: tauri::State<'_, AgentHost>,
    pubkey: String,
    auth: Vec<String>,
) -> Result<AppAgentSummary, String> {
    let prepared = state
        .1
        .lock()
        .await
        .take_if(|prepared| prepared.pubkey() == pubkey)
        .ok_or("Create request expired; try again")?;
    let credentials = host.inner().credentials().await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agents = state.0.blocking_lock();
        let agents = agents.as_ref().map_err(Clone::clone)?;
        credentials.retry();
        agents.commit(prepared, &auth, credentials.as_ref())
    })
    .await
    .map_err(|_| "Native credential operation failed")?
    .map(Into::into)
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    host: tauri::State<'_, AgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let credentials = host.inner().credentials().await?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agents = state.0.blocking_lock();
        agents
            .as_ref()
            .map_err(Clone::clone)?
            .remove(&pubkey, credentials.as_ref())
    })
    .await
    .map_err(|_| "Native credential operation failed")?
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
    host: tauri::State<'_, AgentHost>,
    pubkey: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let agent = {
        let agents = state.0.lock().await;
        agents.as_ref().map_err(Clone::clone)?.get(&pubkey)?
    };
    let credentials = host.inner().credentials().await?;
    let (agent, key) = tauri::async_runtime::spawn_blocking(move || {
        agent.read_key(credentials.as_ref()).map(|key| (agent, key))
    })
    .await
    .map_err(|_| "Native credential operation failed")??;
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
        .header("Authorization", authorization(agent.http_auth(&key, &bytes)?)?)
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent event unconfirmed; it may or may not have been accepted")?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let receipt: Value = serde_json::from_slice(&body[..body.len().min(16 * 1024)])
        .unwrap_or(Value::Null);
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
