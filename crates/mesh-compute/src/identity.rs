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
