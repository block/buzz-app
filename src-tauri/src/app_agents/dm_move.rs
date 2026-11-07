//! Retryable copies of an owner's local agent messages. Keys stay in native custody.
use super::{post, AppAgentEvent, AppAgentHost};
use serde_json::Value;

fn hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn validate(event: &Value) -> Result<(), String> {
    let kind = event.get("kind").and_then(Value::as_u64);
    let tags: Vec<Vec<String>> =
        serde_json::from_value(event["tags"].clone()).map_err(|_| "Invalid moved message")?;
    let copies: Vec<_> = tags
        .iter()
        .filter(|t| t.first().map(String::as_str) == Some("buzz:dm-move"))
        .collect();
    let Some(tag) = copies.first() else {
        return Err("A moved message needs provenance".into());
    };
    let references: Vec<_> = tags
        .iter()
        .filter(|tag| tag.first().map(String::as_str) == Some("e"))
        .collect();
    let reference = |tag: &[String], marker: &str| matches!(tag, [k, id, relay, role] if k == "e" && hex_key(id) && relay.is_empty() && role == marker);
    let canonical_reply = match references.as_slice() {
        [reply] => reference(reply, "reply"),
        [root, reply] => {
            reference(root, "root") && reference(reply, "reply") && root[1] != reply[1]
        }
        _ => false,
    };
    if kind != Some(9)
        || copies.len() != 1
        || tag.len() != 4
        || uuid::Uuid::parse_str(&tag[1]).is_err()
        || !hex_key(&tag[2])
        || tag[3]
            .parse::<u64>()
            .ok()
            .filter(|n| *n <= 9_999_999_999_999)
            .is_none()
        || tags
            .iter()
            .filter(|t| t.first().map(String::as_str) == Some("h"))
            .count()
            != 1
        || !canonical_reply
    {
        return Err("Invalid moved message".into());
    }
    let content = event
        .get("content")
        .and_then(Value::as_str)
        .ok_or("Invalid moved message")?;
    buzz_agent_controller::bounded(9, content, &tags)?;
    Ok(())
}

/// Prepare once, persist the signed public event, then retry those exact bytes.
#[tauri::command]
pub(crate) async fn app_agent_prepare_dm_move(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    validate(
        &serde_json::json!({"kind": event.kind, "content": event.content, "tags": event.tags}),
    )?;
    let (agent, key, _evidence) = state.signer(pubkey, relay).await?;
    agent.sign(&key, event.kind, event.content, event.tags)
}

/// Reauthenticate as the same locally held agent; never relay somebody else's signature.
#[tauri::command]
pub(crate) async fn app_agent_publish_dm_move(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    event: Value,
) -> Result<Value, String> {
    validate(&event)?;
    let raw: nostr::event::Event =
        serde_json::from_value(event.clone()).map_err(|_| "Invalid moved message")?;
    raw.verify()
        .map_err(|_| "Invalid moved message signature")?;
    let (agent, key, evidence) = state.signer(pubkey, relay).await?;
    if event.get("pubkey").and_then(Value::as_str) != Some(agent.pubkey.as_str()) {
        return Err("Moved message does not belong to this agent".into());
    }
    evidence
        .run(true, post(&agent, &key, evidence.header(), event))
        .await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod envelope_tests {
    use super::*;
    #[test]
    fn move_boundary_rejects_other_events_and_bad_provenance() {
        let key = "a".repeat(64);
        let valid = serde_json::json!({"kind":9,"content":"Original text", "tags":[["h","channel"],["e","b".repeat(64),"","root"],["e",key,"","reply"],["buzz:dm-move","e44c7b53-42b2-4c5e-8051-fce508998b96",key,"1700000000000"]]});
        assert!(validate(&valid).is_ok());
        let mut direct = valid.clone();
        direct["tags"].as_array_mut().unwrap().remove(1);
        assert!(validate(&direct).is_ok());
        let mut duplicate = valid.clone();
        duplicate["tags"][1][1] = serde_json::json!(key);
        assert!(validate(&duplicate).is_err());
        let mut invalid = valid.clone();
        invalid["kind"] = serde_json::json!(40003);
        assert!(validate(&invalid).is_err());
        let mut invalid = valid.clone();
        invalid["tags"][3][2] = serde_json::json!("bad");
        assert!(validate(&invalid).is_err());
        let mut invalid = valid;
        invalid["tags"][1][3] = serde_json::json!("reply");
        assert!(validate(&invalid).is_err());
    }
}
