//! App-owned mesh identity, distinct from the Buzz/Nostr signing key.
//! The native parent chooses a persistent app-data path. Keeping this separate
//! from the old Buzz app prevents its stopped-status publisher from replacing
//! this worker's serving note for the same owner coordinate.

use std::path::PathBuf;

use mesh_llm_host_runtime::crypto::{keystore_exists, load_keystore, save_keystore, OwnerKeypair};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct OwnerIdentity {
    pub keystore_path: PathBuf,
    pub owner_id: String,
    pub verifying_key_hex: String,
}

impl OwnerIdentity {
    /// Sign a Buzz-to-MeshLLM ownership binding. The member's Nostr signature
    /// authenticates the discovery event; this Ed25519 signature proves the
    /// advertised owner id is backed by the MeshLLM owner key itself.
    pub fn sign_member_binding(&self, member_pubkey: &str) -> anyhow::Result<String> {
        let keypair = load_keystore(&self.keystore_path, None).map_err(|error| {
            anyhow::anyhow!("failed to load mesh owner keystore for binding: {error}")
        })?;
        Ok(hex::encode(
            keypair.sign_bytes(&member_binding_bytes(member_pubkey)),
        ))
    }

    /// Sign the exact endpoint tokens advertised by this member. This prevents
    /// a holder of only the Nostr member key from reusing a valid owner binding
    /// while substituting an attacker-selected dial target.
    pub fn sign_member_endpoint_binding(
        &self,
        member_pubkey: &str,
        endpoint_tokens: &[String],
    ) -> anyhow::Result<String> {
        let keypair = load_keystore(&self.keystore_path, None).map_err(|error| {
            anyhow::anyhow!("failed to load mesh owner keystore for endpoint binding: {error}")
        })?;
        Ok(hex::encode(keypair.sign_bytes(
            &member_endpoint_binding_bytes(member_pubkey, endpoint_tokens),
        )))
    }
}

pub fn member_binding_bytes(member_pubkey: &str) -> Vec<u8> {
    format!(
        "buzz-mesh-owner-binding-v1:{}",
        member_pubkey.trim().to_ascii_lowercase()
    )
    .into_bytes()
}

/// Canonical bytes binding a member-associated node identity to the exact set
/// of endpoint tokens in its status event.
pub fn member_endpoint_binding_bytes(member_pubkey: &str, endpoint_tokens: &[String]) -> Vec<u8> {
    let mut endpoints = endpoint_tokens
        .iter()
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect::<Vec<_>>();
    endpoints.sort_unstable();
    endpoints.dedup();

    let mut digest = Sha256::new();
    for endpoint in endpoints {
        digest.update((endpoint.len() as u64).to_be_bytes());
        digest.update(endpoint.as_bytes());
    }
    format!(
        "buzz-mesh-owner-endpoint-binding-v1:{}:{}",
        member_pubkey.trim().to_ascii_lowercase(),
        hex::encode(digest.finalize())
    )
    .into_bytes()
}

/// Extract endpoint tokens from a status payload using the same canonical
/// field rules for publication and verification.
pub fn advertised_endpoint_tokens(payload: &serde_json::Value) -> Option<Vec<String>> {
    let Some(targets) = payload
        .get("serveTargets")
        .or_else(|| payload.get("serve_targets"))
    else {
        return Some(Vec::new());
    };
    let targets = targets.as_array()?;
    targets
        .iter()
        .map(|target| {
            target
                .get("endpointAddr")
                .or_else(|| target.get("endpoint_addr"))?
                .as_str()
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(ToString::to_string)
        })
        .collect()
}

fn owner_identity(path: PathBuf, keypair: &OwnerKeypair) -> OwnerIdentity {
    OwnerIdentity {
        owner_id: keypair.owner_id(),
        verifying_key_hex: hex::encode(keypair.verifying_key().as_bytes()),
        keystore_path: path,
    }
}

/// Called only inside the explicitly started/restored worker, never for status reads.
pub fn ensure_owner_identity_at(path: PathBuf) -> anyhow::Result<OwnerIdentity> {
    if keystore_exists(&path) {
        let keypair = load_keystore(&path, None).map_err(|error| {
            anyhow::anyhow!(
                "failed to load mesh owner keystore at {}: {error}",
                path.display()
            )
        })?;
        return Ok(owner_identity(path, &keypair));
    }
    let keypair = OwnerKeypair::generate();
    save_keystore(&path, &keypair, None, false).map_err(|error| {
        anyhow::anyhow!(
            "failed to save mesh owner keystore at {}: {error}",
            path.display()
        )
    })?;
    Ok(owner_identity(path, &keypair))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_owner_is_persistent_and_isolated_from_other_runtime_keys() {
        let root = std::env::temp_dir().join(format!(
            "buzz-owner-test-{}",
            nostr::Keys::generate().public_key()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let first = ensure_owner_identity_at(root.join("app.json")).unwrap();
        let restored = ensure_owner_identity_at(root.join("app.json")).unwrap();
        let other = ensure_owner_identity_at(root.join("other.json")).unwrap();
        assert_eq!(first.owner_id, restored.owner_id);
        assert_eq!(first.verifying_key_hex, restored.verifying_key_hex);
        assert_ne!(first.owner_id, other.owner_id);
        assert_eq!(first.keystore_path, root.join("app.json"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
