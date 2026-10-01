//! Host-only startup configuration. Never deserialize admission policy from plugin input.

use mesh_llm_sdk::{client, MeshDiscoveryMode, TrustPolicy};
use std::path::PathBuf;
use std::time::Duration;

/// A consumer starts closed and learns dial targets through verified host discovery.
/// Provider admission and model acquisition are deliberately not enabled here.
pub struct ClientConfig {
    pub api_port: u16,
    pub console_port: u16,
    pub owner_key: PathBuf,
    pub trusted_owners: Vec<String>,
}

impl ClientConfig {
    pub fn build(self) -> Result<client::EmbeddedClientConfig, &'static str> {
        if self.api_port == 0 || self.console_port == 0 || self.api_port == self.console_port {
            return Err("Mesh needs two distinct non-zero ports");
        }
        if !self.owner_key.is_absolute() {
            return Err("Mesh owner keystore path must be absolute");
        }
        // Empty/unknown membership must not silently become TrustPolicy::Off.
        if self.trusted_owners.is_empty()
            || self
                .trusted_owners
                .iter()
                .any(|owner| owner.trim().is_empty())
        {
            return Err("Verified Mesh owner admission is required");
        }
        Ok(client::EmbeddedClientConfig::builder()
            .api_port(self.api_port)
            .console_port(self.console_port)
            .owner_key(self.owner_key)
            .owner_required(true)
            .trust_policy(TrustPolicy::Allowlist)
            .trust_owners(self.trusted_owners)
            .publish(false)
            .auto_join(false)
            .discovery_mode(MeshDiscoveryMode::Nostr)
            .nostr_relays(Vec::<String>::new())
            .isolated_config(true)
            .console_ui(false)
            .startup_timeout(Duration::from_secs(180))
            .build())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> ClientConfig {
        ClientConfig {
            api_port: 19337,
            console_port: 13131,
            owner_key: std::env::temp_dir().join("buzz-mesh-test-owner.json"),
            trusted_owners: vec!["fixture-owner".into()],
        }
    }

    #[test]
    fn client_is_private_and_uses_explicit_owner_path() {
        let expected_path = config().owner_key;
        let result = config().build().unwrap();
        assert!(!result.network.publish);
        assert!(!result.network.auto_join);
        assert!(result.network.nostr_relays.is_empty());
        assert!(result.network.join_tokens.is_empty());
        assert!(result.storage.isolated_config);
        assert_eq!(result.admission.owner_key, Some(expected_path));
        assert!(result.admission.owner_required);
        assert_eq!(result.admission.trust_policy, Some(TrustPolicy::Allowlist));
    }

    #[test]
    fn rejects_missing_admission_and_invalid_ports_or_paths() {
        let mut request = config();
        request.trusted_owners.clear();
        assert!(request.build().is_err());
        let mut request = config();
        request.console_port = request.api_port;
        assert!(request.build().is_err());
        let mut request = config();
        request.api_port = 0;
        assert!(request.build().is_err());
        let mut request = config();
        request.owner_key = "relative.json".into();
        assert!(request.build().is_err());
    }
}
