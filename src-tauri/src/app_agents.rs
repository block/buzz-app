//! Native custody for agents the app runs through a plugin (Agents2). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event at a time, and native signs and posts it to the agent's community.
use crate::agents::profile_http::authorization;
use buzz_agent_controller::{
    AppAgent, AppAgents, Credentials, PlatformCredentials, Published, Secret,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The identity file (which locks its own writes across app instances) and its
/// own credential handle, so Agents2 never waits on, or fails with, the harness
/// agent controller (whose storage lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost {
    agents: Result<AppAgents, String>,
    credentials: Arc<dyn Credentials>,
    /// Each key after its first read, so only create and first use reach the
    /// credential store, whose lock refuses rather than waits. Waiting on this
    /// lock instead lets concurrent publications queue for that first read.
    keys: Arc<Mutex<HashMap<String, Arc<Secret>>>>,
    /// One profile publication at a time, so each is newer than the last.
    profiles: Arc<tokio::sync::Mutex<()>>,
}
impl AppAgentHost {
    pub(crate) fn new(path: Result<PathBuf, String>) -> Self {
        Self {
            agents: path.map(AppAgents::open),
            credentials: Arc::new(PlatformCredentials::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
        }
    }
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// The agent's key; read from the credential store only on first use.
    async fn key(&self, agent: AppAgent) -> Result<(AppAgent, Arc<Secret>), String> {
        let host = self.clone();
        blocking(move || {
            let pubkey = agent.pubkey.clone();
            let mut keys = host.keys();
            let key = match keys.get(&pubkey) {
                Some(key) => key.clone(),
                None => {
                    let key = Arc::new(agent.read_key(host.credentials.as_ref())?);
                    keys.insert(pubkey, key.clone());
                    key
                }
            };
            Ok((agent, key))
        })
        .await
    }
    /// The agent, if it still has its key. One deleted elsewhere loses its cached key.
    async fn agent(&self, pubkey: String) -> Result<AppAgent, String> {
        let host = self.clone();
        blocking(move || {
            let agent = host.agents.clone()?.get(&pubkey);
            if agent.is_err() {
                host.keys().remove(&pubkey);
            }
            agent
        })
        .await
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
    #[serde(rename = "type")]
    agent_type: String,
    name: String,
    deleted: bool,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
            agent_type: agent.agent_type,
            name: agent.name,
            deleted: agent.deleted,
        }
    }
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents.clone()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`, has the signed-in owner attest
/// it, and saves both. Nothing is saved unless all three succeed.
#[tauri::command]
pub(crate) async fn app_agent_create(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    agent_type: String,
    name: String,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents.clone()?;
    let prepared = AppAgents::prepare(&destination, &owner, &agent_type, &name)?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let mut keys = host.keys();
        host.credentials.retry();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(agent.into())
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_rename(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.rename(&pubkey, &name)).await
}

/// Deletes the key now. The row stays, marked deleted, until the WebView has
/// cleaned up the community and calls `app_agent_forget`.
#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let host = state.inner().clone();
    blocking(move || {
        // Held across the deletion, so no publication re-reads the key meanwhile.
        let mut keys = host.keys();
        keys.remove(&pubkey);
        host.agents
            .clone()?
            .remove(&pubkey, host.credentials.as_ref())
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_forget(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.forget(&pubkey)).await
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
    let (agent, key) = state.key(state.agent(pubkey).await?).await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    post(&agent, &key, signed).await
}

/// Publishes the agent's profile if its name differs from the last one its
/// community accepted. Safe to call any time; one runs at a time.
#[tauri::command]
pub(crate) async fn app_agent_publish_profile(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let _turn = state.profiles.lock().await;
    let agent = state.agent(pubkey).await?;
    if agent.profile.as_ref().map(|last| &last.name) == Some(&agent.name) {
        return Ok(());
    }
    let (agent, key) = state.key(agent).await?;
    let signed = post(&agent, &key, agent.profile_event(&key)?).await?;
    let created_at = signed
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or("Invalid agent event")?;
    let agents = state.agents.clone()?;
    blocking(move || {
        agents.published(
            &agent.pubkey,
            Published {
                name: agent.name,
                created_at,
            },
        )
    })
    .await
}

async fn post(agent: &AppAgent, key: &Secret, signed: Value) -> Result<Value, String> {
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
            authorization(agent.http_auth(key, &bytes)?)?,
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
