//! Legacy Mesh owner identity, separate from the host-owned Nostr key.
use mesh_llm_host_runtime::crypto::{keystore_exists, load_keystore, save_keystore, OwnerKeypair};
use std::path::Path;

/// Explicit host-selected path permits isolated smoke tests without touching the shared owner.
/// Existing encrypted files fail without a passphrase; this function never consults Keychain.
pub fn ensure_owner_at(path: &Path) -> anyhow::Result<String> {
    let key = if keystore_exists(path) {
        load_keystore(path, None)?
    } else {
        let key = OwnerKeypair::generate();
        save_keystore(path, &key, None, false)?;
        key
    };
    Ok(key.owner_id())
}

use sha2::{Digest, Sha256};
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
