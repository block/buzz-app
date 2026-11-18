//! Bounded progress snapshots, encrypted only to the agent's recorded owner.
use crate::{AppAgent, Result, Secret};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivitySnapshot {
    pub channel_id: String,
    pub thread_root_id: Option<String>,
    pub turn_id: String,
    pub started_at: u64,
    pub seq: u64,
    pub active: bool,
    pub steps: Vec<String>,
}

impl AppAgent {
    /// Constructs an owner-only telemetry envelope. Callers cannot choose its
    /// recipient, signing identity, outer tags, or arbitrary transcript fields.
    pub fn activity_event(
        &self,
        key: &Secret,
        snapshot: ActivitySnapshot,
    ) -> Result<serde_json::Value> {
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        if key.pubkey() != self.pubkey
            || snapshot.channel_id.is_empty()
            || snapshot.channel_id.len() > 128
            || snapshot.thread_root_id.as_deref().is_some_and(|s| !hex(s))
            || snapshot.turn_id.is_empty()
            || snapshot.turn_id.len() > 128
            || snapshot.steps.len() > 32
            || snapshot.steps.iter().any(|s| s.is_empty() || s.len() > 320)
            || snapshot.seq > 9_007_199_254_740_991
        {
            return Err("Invalid activity snapshot".into());
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Invalid clock")?
            .as_millis() as u64;
        if snapshot.started_at > now + 60_000
            || now.saturating_sub(snapshot.started_at) > 86_400_000
        {
            return Err("Invalid activity start time".into());
        }
        let plaintext = serde_json::json!({
            "kind": "work_snapshot", "seq": snapshot.seq,
            "timestamp": chrono::DateTime::from_timestamp_millis(now as i64)
                .ok_or("Invalid clock")?.to_rfc3339(), "channelId": snapshot.channel_id,
            "turnId": snapshot.turn_id,
            "payload": {"threadRootId": snapshot.thread_root_id,
                "active": snapshot.active, "startedAt": snapshot.started_at, "updatedAt": now, "steps": snapshot.steps}
        })
        .to_string();
        let content = key.nip44_encrypt(&self.owner, &plaintext)?;
        key.signed(
            24200,
            content,
            vec![
                vec!["p".into(), self.owner.clone()],
                vec!["agent".into(), self.pubkey.clone()],
                vec!["frame".into(), "telemetry".into()],
            ],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_recorded_owner_can_decrypt_signed_bounded_progress() {
        let key = Secret::generate().unwrap();
        let owner = Secret::generate().unwrap();
        let other = Secret::generate().unwrap();
        let agent: AppAgent = serde_json::from_value(serde_json::json!({
            "pubkey":key.pubkey(), "owner":owner.pubkey(),
            "relay":"wss://example.org", "auth":"", "type":"example/agent"
        }))
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let snapshot = ActivitySnapshot {
            channel_id: "channel".into(),
            thread_root_id: None,
            turn_id: "turn".into(),
            started_at: now,
            seq: 1,
            active: true,
            steps: vec!["Read".into()],
        };
        let wire = agent.activity_event(&key, snapshot.clone()).unwrap();
        let event: ::nostr::event::Event = serde_json::from_value(wire.clone()).unwrap();
        event.verify().unwrap();
        let body = wire["content"].as_str().unwrap();
        assert!(!body.contains("Read"));
        assert!(other.nip44_decrypt(key.pubkey(), body).is_err());
        let plain = owner.nip44_decrypt(key.pubkey(), body).unwrap();
        let decoded: serde_json::Value = serde_json::from_str(&plain).unwrap();
        assert_eq!(decoded["kind"], "work_snapshot");
        assert_eq!(decoded["payload"]["steps"], serde_json::json!(["Read"]));
        assert_eq!(
            wire["tags"],
            serde_json::json!([
                ["p", owner.pubkey()],
                ["agent", key.pubkey()],
                ["frame", "telemetry"]
            ])
        );
        assert!(agent.activity_event(&other, snapshot.clone()).is_err());
        let mut oversized = snapshot;
        oversized.steps = vec!["x".repeat(321)];
        assert!(agent.activity_event(&key, oversized).is_err());
    }
}
