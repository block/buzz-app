//! Native-only grant for one saved Mesh agent start. Never persisted or serialized.
use crate::{config::Agent, Result};

/// Holds an acquired consumer until cancellation, failed launch, or process teardown.
/// The native owner receives a release signal; clones are deliberately forbidden.
pub struct MeshLaunch {
    agent_id: String,
    revision: u64,
    relay: String,
    model: String,
    port: u16,
    context: u64,
    release: std::sync::mpsc::Sender<String>,
    token: Option<String>,
}

impl MeshLaunch {
    /// Create only after native discovery and consumer readiness succeed.
    /// A port, rather than an arbitrary URL, limits child routing to loopback.
    pub fn new(
        agent_id: String,
        revision: u64,
        relay: String,
        model: String,
        endpoint: (u16, u64),
        release: (std::sync::mpsc::Sender<String>, String),
    ) -> Result<Self> {
        let grant = Self {
            agent_id: agent_id.clone(),
            revision,
            relay,
            model,
            port: endpoint.0,
            context: endpoint.1,
            token: Some(release.1),
            release: release.0,
        };
        if grant.port == 0 || grant.model.trim().is_empty() || grant.context == 0 {
            return Err("Shared compute requires a ready endpoint and model".into());
        }
        Ok(grant)
    }

    /// Retain the native acquisition when process teardown cannot be established.
    /// MeshHost keeps the unresolved token until app shutdown/recovery.
    pub(crate) fn retain_unconfirmed(&mut self) {
        if self.token.take().is_some() {
            eprintln!("Shared compute consumer retained: agent teardown unconfirmed; app shutdown required");
        }
    }

    pub(crate) fn apply(&self, agent: &Agent) -> Result<Agent> {
        if agent.id != self.agent_id
            || agent.revision != self.revision
            || agent.relay_url != self.relay
            || agent.harness.provider != "relay-mesh"
            || agent.harness.command != "buzz-agent"
            || !agent.imported["record"]["relay_mesh"].is_null()
        {
            return Err("Shared compute grant no longer matches the saved agent".into());
        }
        let output = agent
            .environment
            .get("BUZZ_AGENT_MAX_OUTPUT_TOKENS")
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| "Invalid agent output token budget")
            })
            .transpose()?
            .unwrap_or(8192.min(self.context / 4));
        if output == 0 || self.context <= output {
            return Err("Shared model context must exceed the agent output token budget".into());
        }
        let mut runtime = agent.clone();
        runtime.harness.provider = "openai".into();
        runtime.harness.model.clone_from(&self.model);
        // Explicit last-writer runtime settings; user environment cannot reroute this grant.
        for (name, value) in [
            ("BUZZ_AGENT_MAX_CONTEXT_TOKENS", self.context.to_string()),
            ("BUZZ_AGENT_MAX_OUTPUT_TOKENS", output.to_string()),
            ("BUZZ_AGENT_LLM_TIMEOUT_SECS", "660".to_owned()),
            ("BUZZ_AGENT_PROVIDER", "openai".to_owned()),
            ("BUZZ_AGENT_MODEL", self.model.clone()),
            ("OPENAI_COMPAT_MODEL", self.model.clone()),
            (
                "OPENAI_COMPAT_BASE_URL",
                format!("http://127.0.0.1:{}/v1", self.port),
            ),
            ("OPENAI_COMPAT_API_KEY", "mesh-local".to_owned()),
            ("OPENAI_COMPAT_API", "chat".to_owned()),
        ] {
            runtime.environment.insert(name.into(), value);
        }
        Ok(runtime)
    }
}
impl Drop for MeshLaunch {
    fn drop(&mut self) {
        // Unbounded std channel send does not wait for a receiver or node shutdown.
        if let Some(token) = self.token.take() {
            let _ = self.release.send(token);
        }
    }
}
