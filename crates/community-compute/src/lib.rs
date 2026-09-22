//! Read-only protocol projection adapted from block/buzz PR #7691 (Apache-2.0).
//! This crate does not create keys, start a node, or authorize mesh admission.
mod broker;
mod catalog;
pub mod consumer;
pub mod usage;
pub mod worker;
pub use catalog::{model_catalog, MeshModelCatalog};
mod discovery;
mod identity;
mod snapshot;
mod transport_policy;

use serde::Deserialize;
pub use snapshot::MeshSnapshot;
const MESH_STATUS_KIND: u64 = 30003;
const MESH_IROH_RELAYS_ENV: &str = "BUZZ_MESH_IROH_RELAYS";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeshServeTarget {
    model_id: String,
    endpoint_addr: String,
}

/// Project signed relay evidence for display. The host supplies its connected
/// community's explicit NIP-11 self; renderer input must never authorize serving.
pub fn project(
    events: Vec<nostr::Event>,
    authority: &str,
    viewer: &str,
) -> Result<MeshSnapshot, String> {
    let authority =
        nostr::PublicKey::from_hex(authority).map_err(|_| "Invalid community authority")?;
    nostr::PublicKey::from_hex(viewer).map_err(|_| "Invalid viewer")?;
    if events.len() > 10000 {
        return Err("Community status exceeds the display limit".into());
    }
    let now = nostr::Timestamp::now();
    let mut verified = Vec::new();
    for event in events {
        if event.content.len() > 256 * 1024 || event.tags.len() > 20000 {
            return Err("Community status exceeds the display limit".into());
        }
        event
            .verify()
            .map_err(|_| "Invalid community event signature")?;
        if event.created_at > now {
            continue;
        }
        match event.kind.as_u16() {
            13534 if event.pubkey == authority => verified.push(event),
            30003
                if event.tags.iter().any(|tag| {
                    let parts = tag.as_slice();
                    parts.first().map(String::as_str) == Some("k")
                        && parts.get(1).map(String::as_str) == Some("buzz-mesh-status")
                }) =>
            {
                verified.push(event)
            }
            _ => {}
        }
    }
    if !verified.iter().any(|event| event.kind.as_u16() == 13534) {
        return Err("Waiting for a verified current member roster".into());
    }
    Ok(snapshot::snapshot_from_events(verified, Some(viewer)))
}

#[cfg(test)]
mod tests;
