//! Native-only endpoint configuration for one saved Mesh agent start. Never persisted.
use crate::{config::Agent, Result};

/// Effective saved selectors for the native readiness check; contains no secrets.
pub struct MeshRequest {
    pub agent_id: String,
    pub revision: u64,
    pub relay: String,
    pub model: String,
}

impl crate::Controller {
    /// Resolve the same defaults and environment used at launch.
    pub fn mesh_request(&self, id: &str) -> Result<Option<MeshRequest>> {
        let agent = self.mesh_agent(id)?;
        if agent.harness.provider != "relay-mesh" {
            return Ok(None);
        }
        if agent.harness.command != "buzz-agent"
            || !agent.imported["record"]["relay_mesh"].is_null()
        {
            return Err("Shared compute supports the local Buzz Agent harness".into());
        }
        Ok(Some(MeshRequest {
            agent_id: agent.id,
            revision: agent.revision,
            relay: agent.relay_url,
            model: agent.harness.model,
        }))
    }
}

/// Prepared after node readiness; the app, not an agent process, owns the node.
pub struct MeshLaunch {
    agent_id: String,
    revision: u64,
    relay: String,
    model: String,
    port: u16,
    context: u64,
}

impl MeshLaunch {
    /// Create only after native discovery and node readiness succeed.
    /// A port, rather than an arbitrary URL, limits child routing to loopback.
    pub fn new(
        agent_id: String,
        revision: u64,
        relay: String,
        model: String,
        endpoint: (u16, u64),
    ) -> Result<Self> {
        let grant = Self {
            agent_id: agent_id.clone(),
            revision,
            relay,
            model,
            port: endpoint.0,
            context: endpoint.1,
        };
        if grant.port == 0 || grant.model.trim().is_empty() || grant.context == 0 {
            return Err("Shared compute requires a ready endpoint and model".into());
        }
        Ok(grant)
    }

    pub(crate) fn apply(&self, agent: &Agent) -> Result<Agent> {
        let mut agent = agent.clone();
        agent.harness = crate::build_defaults().resolve(&agent.harness, &agent.environment);
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
            .unwrap_or(4096.min(self.context / 4));
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
        // Match classic Buzz without overriding an explicit opt-out.
        runtime
            .environment
            .entry("BUZZ_AGENT_REQUIRE_REPLY".into())
            .or_insert_with(|| "1".into());
        // Mesh agents default to no reasoning; explicit user effort wins.
        runtime
            .environment
            .entry("BUZZ_AGENT_THINKING_EFFORT".into())
            .or_insert_with(|| "none".into());
        Ok(runtime)
    }
}
