use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
pub(crate) const STATUS_FRESHNESS_SECS: u64 = 120;

pub(crate) fn status_is_fresh(event: &nostr::Event, now: u64) -> bool {
    event
        .created_at
        .as_secs()
        .saturating_add(STATUS_FRESHNESS_SECS)
        >= now
}

pub(crate) fn latest_membership_list(events: &[nostr::Event]) -> Option<BTreeSet<String>> {
    events
        .iter()
        .filter(|event| event.kind.as_u16() == 13_534)
        .max_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| b.id.cmp(&a.id))
        })
        .map(|event| {
            event
                .tags
                .iter()
                .filter_map(|tag| {
                    let slice = tag.as_slice();
                    let name = slice.first()?;
                    if name != "member" && name != "p" {
                        return None;
                    }
                    slice
                        .get(1)
                        .map(|pubkey| pubkey.trim().to_ascii_lowercase())
                })
                .filter(|pubkey| nostr::PublicKey::from_hex(pubkey).is_ok())
                .collect()
        })
}

pub(crate) fn owner_id_from_status_event(event: &nostr::Event) -> Option<String> {
    let content = serde_json::from_str::<serde_json::Value>(&event.content).ok()?;
    let owner_id = content
        .get("ownerId")
        .or_else(|| content.get("owner_id"))?
        .as_str()?
        .trim();
    let verifying_key_bytes: [u8; 32] =
        hex::decode(content.get("ownerVerifyingKey")?.as_str()?.trim())
            .ok()?
            .try_into()
            .ok()?;
    let derived_owner = hex::encode(Sha256::digest(verifying_key_bytes));
    if owner_id != derived_owner {
        return None;
    }
    let signature_bytes = hex::decode(content.get("ownerBindingSig")?.as_str()?.trim()).ok()?;
    let signature = Signature::from_slice(&signature_bytes).ok()?;
    let verifying_key = VerifyingKey::from_bytes(&verifying_key_bytes).ok()?;
    verifying_key
        .verify(
            &super::identity::member_binding_bytes(&event.pubkey.to_hex()),
            &signature,
        )
        .ok()?;
    Some(owner_id.to_string())
}

pub(crate) fn endpoint_binding_is_valid(event: &nostr::Event, content: &serde_json::Value) -> bool {
    let Some(endpoint_tokens) = super::identity::advertised_endpoint_tokens(content) else {
        return false;
    };
    let Some(verifying_key_bytes) = content
        .get("ownerVerifyingKey")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .and_then(|value| hex::decode(value).ok())
        .and_then(|value| <[u8; 32]>::try_from(value).ok())
    else {
        return false;
    };
    let Some(signature) = content
        .get("ownerEndpointBindingSig")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .and_then(|value| hex::decode(value).ok())
        .and_then(|value| Signature::from_slice(&value).ok())
    else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&verifying_key_bytes) else {
        return false;
    };
    verifying_key
        .verify(
            &super::identity::member_endpoint_binding_bytes(
                &event.pubkey.to_hex(),
                &endpoint_tokens,
            ),
            &signature,
        )
        .is_ok()
}

pub(crate) fn device_name_from_status(
    payload: &serde_json::Value,
    endpoint_id: Option<&str>,
) -> Option<String> {
    string_value(payload, "deviceName")
        .or_else(|| string_value(payload, "device_name"))
        .or_else(|| string_value(payload, "my_hostname"))
        .or_else(|| string_value(payload, "hostname"))
        .or_else(|| endpoint_id.map(short_endpoint_label))
}

pub(crate) fn endpoint_id_from_status(
    payload: &serde_json::Value,
    invite_token: Option<&str>,
) -> Option<String> {
    string_value(payload, "endpointId")
        .or_else(|| string_value(payload, "endpoint_id"))
        .or_else(|| string_value(payload, "node_id"))
        .or_else(|| invite_token.and_then(endpoint_id_from_invite_token))
}

pub(crate) fn string_value(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(crate) fn short_endpoint_label(endpoint_id: &str) -> String {
    endpoint_id.chars().take(12).collect()
}
fn endpoint_id_from_invite_token(token: &str) -> Option<String> {
    super::transport_policy::validate_advertised_endpoint(token)
        .ok()
        .map(|endpoint| endpoint.endpoint_id)
}
