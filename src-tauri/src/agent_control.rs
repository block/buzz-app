//! Remote Stop for agents this copy of the app runs: NIP-AO control frames the
//! owner sends from another device to an agent's key. The WebView gets only a
//! checked `cancel_turn` request, and can answer it only with that request's
//! `control_result`; no other plaintext, and no key, leaves native code.
use crate::app_agents::AppAgentHost;
use crate::identity::IdentityHost;
use crate::relay::agent::{exact, verified, AgentEvent};
use buzz_agent_controller::{AppAgent, Secret};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::sync::Mutex;

const KIND: u16 = 24200;
/// The relay's freshness window for observer frames, either way.
const FRESH_SECS: u64 = 300;
/// Control frames remembered at once. A frame stays only while it is fresh,
/// and owners send one per Stop press, so this is far beyond real use; past
/// it, new frames are refused rather than letting an old one in again.
const SEEN_LIMIT: usize = 1024;

/// The control frames this copy acted on while they are still fresh, so a
/// replayed frame stops nothing twice.
#[derive(Default)]
pub(crate) struct ControlFrames(Mutex<SeenFrames>);

#[derive(Default)]
struct SeenFrames {
    order: VecDeque<(u64, String)>,
    ids: HashSet<String>,
}
impl SeenFrames {
    /// Notes `id` as acted on; false when it already was, or when too many
    /// fresh frames are held to tell.
    fn admit(&mut self, id: &str, created_at: u64, now: u64) -> bool {
        // A frame no longer fresh is refused by its time alone.
        while self
            .order
            .front()
            .is_some_and(|(at, _)| at.saturating_add(FRESH_SECS) < now)
        {
            if let Some((_, old)) = self.order.pop_front() {
                self.ids.remove(&old);
            }
        }
        if self.ids.contains(id) || self.ids.len() >= SEEN_LIMIT {
            return false;
        }
        self.ids.insert(id.into());
        self.order.push_back((created_at, id.into()));
        true
    }
}

fn now() -> Result<u64, String> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "Invalid clock")?
        .as_secs())
}
/// A channel ID as live routes accept it.
fn channel_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn event_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The agent an owner's control frame is for, once its envelope checks out:
/// signed by `viewer`, this device's identity, to one agent named alike by its
/// `p` and `agent` tags, as a `control` frame within the freshness window.
fn envelope(viewer: &str, event: &AgentEvent, now: u64) -> Result<String, String> {
    verified(event)?;
    let agent = event
        .tags
        .iter()
        .find(|tag| tag.first().map(String::as_str) == Some("p"))
        .and_then(|tag| tag.get(1))
        .cloned()
        .unwrap_or_default();
    if event.kind != KIND
        || event.pubkey != viewer
        || !event_id(&agent)
        || agent == viewer
        || !exact(event, "p", &agent)
        || !exact(event, "agent", &agent)
        || !exact(event, "frame", "control")
        || event.created_at > now + FRESH_SECS
        || now.saturating_sub(event.created_at) > FRESH_SECS
        || event.content.len() < 132
        || event.content.len() > 87472
    {
        return Err("Invalid control frame".into());
    }
    Ok(agent)
}

/// The `cancel_turn` request a checked frame carries, decrypted with the
/// agent's key, if its agent's owner sent it and this copy has not acted on
/// it already. Any other request type is refused.
fn open(
    agent: &AppAgent,
    key: &Secret,
    event: &AgentEvent,
    seen: &mut SeenFrames,
    now: u64,
) -> Result<Value, String> {
    if agent.owner != event.pubkey || key.pubkey() != agent.pubkey {
        return Err("Invalid control frame".into());
    }
    let text = key
        .nip44_decrypt(&event.pubkey, &event.content)
        .map_err(|_| "Invalid control frame")?;
    if text.len() > 4096 {
        return Err("Invalid control frame".into());
    }
    let body: Value = serde_json::from_str(&text).map_err(|_| "Invalid control frame")?;
    let field = |name: &str| body.get(name).and_then(Value::as_str);
    let channel = field("channelId").filter(|id| channel_id(id));
    let request = field("requestId").filter(|id| channel_id(id));
    let root = match body.get("threadRootId") {
        None | Some(Value::Null) => None,
        Some(Value::String(root)) if event_id(root) => Some(root.as_str()),
        Some(_) => return Err("Invalid control frame".into()),
    };
    let (Some(channel), Some(request)) = (channel, request) else {
        return Err("Invalid control frame".into());
    };
    if field("type") != Some("cancel_turn") {
        return Err("Unsupported control request".into());
    }
    if !seen.admit(&event.id, event.created_at, now) {
        return Err("Control frame already handled".into());
    }
    let mut payload = json!({
        "type": "cancel_turn",
        "channelId": channel,
        "requestId": request,
    });
    if let Some(root) = root {
        payload["threadRootId"] = root.into();
    }
    Ok(json!({ "eventId": event.id, "agent": agent.pubkey, "request": payload }))
}

/// Checks and decrypts an owner's control frame for `agent` in the community
/// at `relay`, as the copy of the app that runs that agent. Refused unless
/// this copy holds the agent's custody, so the others stay silent.
#[tauri::command]
pub(crate) async fn app_agent_control_decode(
    identity: tauri::State<'_, IdentityHost>,
    agents: tauri::State<'_, AppAgentHost>,
    frames: tauri::State<'_, ControlFrames>,
    relay: String,
    event: AgentEvent,
) -> Result<Value, String> {
    let viewer = identity.viewer().await?;
    let agent = envelope(&viewer, &event, now()?)?;
    let (agent, key) = agents.custodian_key(agent, relay).await?;
    let mut seen = frames
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    open(&agent, &key, &event, &mut seen, now()?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct ControlAnswer {
    agent: String,
    channel_id: String,
    request_id: String,
    status: String,
}

/// The signed telemetry frame that answers a `cancel_turn` request, encrypted
/// to the agent's owner with the agent's key (NIP-AO `control_result`).
fn answer_event(
    agent: &AppAgent,
    key: &Secret,
    answer: &ControlAnswer,
    now: u64,
) -> Result<Value, String> {
    if answer.agent != agent.pubkey
        || !channel_id(&answer.channel_id)
        || !channel_id(&answer.request_id)
        || !matches!(answer.status.as_str(), "sent" | "no_active_turn")
    {
        return Err("Invalid control answer".into());
    }
    let plaintext = json!({
        "kind": "control_result",
        "channelId": answer.channel_id,
        "payload": {
            "type": "cancel_turn",
            "status": answer.status,
            "requestId": answer.request_id,
        },
    })
    .to_string();
    let content = key.nip44_encrypt(&agent.owner, &plaintext)?;
    agent.sign_built(
        key,
        KIND,
        content,
        vec![
            vec!["p".into(), agent.owner.clone()],
            vec!["agent".into(), agent.pubkey.clone()],
            vec!["frame".into(), "telemetry".into()],
        ],
        now,
    )
}

/// Answers an owner's `cancel_turn` request as the agent, from the copy of the
/// app that runs it, in the community at `relay`.
#[tauri::command]
pub(crate) async fn app_agent_control_answer(
    agents: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    answer: ControlAnswer,
) -> Result<(), String> {
    let (agent, key, evidence) = agents.custodian_signer(pubkey, relay).await?;
    let signed = answer_event(&agent, &key, &answer, now()?)?;
    crate::app_agents::post_signed(&agent, &key, evidence, signed)
        .await
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_with(key: &Secret, owner: &Secret) -> AppAgent {
        serde_json::from_value(json!({
            "pubkey": key.pubkey(), "relay": "wss://relay.example", "owner": owner.pubkey(),
            "auth": "[]", "type": "p/t", "name": "Ada"
        }))
        .unwrap()
    }
    /// An event `signer` signs, as `agent_with(signer, signer)` signs it.
    fn signed(signer: &Secret, content: String, tags: Vec<Vec<String>>, at: u64) -> AgentEvent {
        let value = agent_with(signer, signer)
            .sign_built(signer, KIND, content, tags, at)
            .unwrap();
        serde_json::from_value(value).unwrap()
    }
    fn control_tags(agent: &str, frame: &str) -> Vec<Vec<String>> {
        vec![
            vec!["p".into(), agent.into()],
            vec!["agent".into(), agent.into()],
            vec!["frame".into(), frame.into()],
        ]
    }
    fn cancel(root: Option<&str>) -> String {
        let mut body = json!({"type": "cancel_turn", "channelId": "c-1", "requestId": "r-1"});
        if let Some(root) = root {
            body["threadRootId"] = root.into();
        }
        body.to_string()
    }
    struct Fixture {
        owner: Secret,
        key: Secret,
        agent: AppAgent,
        now: u64,
    }
    fn fixture() -> Fixture {
        let owner = Secret::generate().unwrap();
        let key = Secret::generate().unwrap();
        let agent = agent_with(&key, &owner);
        Fixture {
            owner,
            key,
            agent,
            now: now().unwrap(),
        }
    }
    impl Fixture {
        fn frame(&self, body: &str, frame: &str, at: u64) -> AgentEvent {
            let content = self.owner.nip44_encrypt(self.key.pubkey(), body).unwrap();
            signed(
                &self.owner,
                content,
                control_tags(self.key.pubkey(), frame),
                at,
            )
        }
        fn receive(&self, event: &AgentEvent, seen: &mut SeenFrames) -> Result<Value, String> {
            let agent = envelope(self.owner.pubkey(), event, self.now)?;
            assert_eq!(agent, self.agent.pubkey);
            open(&self.agent, &self.key, event, seen, self.now)
        }
    }

    #[test]
    fn the_owner_s_cancel_turn_is_decoded_once() {
        let f = fixture();
        let root = "e".repeat(64);
        let event = f.frame(&cancel(Some(&root)), "control", f.now);
        let mut seen = SeenFrames::default();
        assert_eq!(
            f.receive(&event, &mut seen).unwrap(),
            json!({
                "eventId": event.id, "agent": f.agent.pubkey,
                "request": {
                    "type": "cancel_turn", "channelId": "c-1", "requestId": "r-1",
                    "threadRootId": root,
                },
            })
        );
        // The same frame again, as a relay or an attacker might replay it.
        assert!(f.receive(&event, &mut seen).is_err());
        // Without a thread, it names the whole conversation.
        let flat = f.frame(&cancel(None), "control", f.now);
        assert!(f.receive(&flat, &mut seen).unwrap()["request"]
            .get("threadRootId")
            .is_none());
    }

    #[test]
    fn frames_not_from_this_owner_now_are_refused() {
        let f = fixture();
        let mut seen = SeenFrames::default();
        let body = cancel(None);
        // Another identity signs a frame to the agent.
        let stranger = Secret::generate().unwrap();
        let content = stranger.nip44_encrypt(f.key.pubkey(), &body).unwrap();
        let forged = signed(
            &stranger,
            content,
            control_tags(f.key.pubkey(), "control"),
            f.now,
        );
        assert!(envelope(f.owner.pubkey(), &forged, f.now).is_err());
        // This identity signs it, but is not the agent's owner.
        let mut other = f.agent.clone();
        other.owner = stranger.pubkey().into();
        let event = f.frame(&body, "control", f.now);
        assert!(open(&other, &f.key, &event, &mut seen, f.now).is_err());
        // Stale and future frames, and a telemetry frame.
        for at in [f.now - FRESH_SECS - 1, f.now + FRESH_SECS + 1] {
            assert!(f
                .receive(&f.frame(&body, "control", at), &mut seen)
                .is_err());
        }
        assert!(f
            .receive(&f.frame(&body, "telemetry", f.now), &mut seen)
            .is_err());
        // A changed signature.
        let mut tampered = f.frame(&body, "control", f.now);
        tampered.created_at += 1;
        assert!(f.receive(&tampered, &mut seen).is_err());
        // Only cancel_turn, with its IDs.
        for body in [
            json!({"type": "switch_model", "channelId": "c-1", "requestId": "r-1"}),
            json!({"type": "cancel_turn", "requestId": "r-1"}),
            json!({"type": "cancel_turn", "channelId": "c-1", "requestId": "r-1", "threadRootId": "x"}),
        ] {
            let event = f.frame(&body.to_string(), "control", f.now);
            assert!(f.receive(&event, &mut seen).is_err());
        }
    }

    #[test]
    fn frames_to_another_agent_are_refused() {
        let f = fixture();
        let other = Secret::generate().unwrap();
        // `p` and `agent` disagree.
        let content = f
            .owner
            .nip44_encrypt(f.key.pubkey(), &cancel(None))
            .unwrap();
        let mut tags = control_tags(f.key.pubkey(), "control");
        tags[1][1] = other.pubkey().into();
        let event = signed(&f.owner, content, tags, f.now);
        assert!(envelope(f.owner.pubkey(), &event, f.now).is_err());
        // Addressed to an agent whose key this device holds is not this one.
        let event = f.frame(&cancel(None), "control", f.now);
        let elsewhere = agent_with(&other, &f.owner);
        let mut seen = SeenFrames::default();
        assert!(open(&elsewhere, &other, &event, &mut seen, f.now).is_err());
    }

    #[tokio::test]
    async fn only_the_copy_holding_custody_decodes_or_answers() {
        let f = fixture();
        let dir = tempfile::tempdir().unwrap();
        let host = AppAgentHost::holding(
            dir.path().join("identities.json"),
            &f.agent,
            Secret::parse(&f.key.hex(), f.key.pubkey()).unwrap(),
            crate::federated_identity::agent::AgentTokens::unconfigured(),
        );
        let (pubkey, relay) = (f.agent.pubkey.clone(), f.agent.relay.clone());
        assert!(host
            .custodian_key(pubkey.clone(), relay.clone())
            .await
            .is_err());
        assert!(host
            .custodian_signer(pubkey.clone(), relay.clone())
            .await
            .is_err());
        host.claim_for_test(&pubkey);
        let (agent, _) = host.custodian_key(pubkey, relay).await.unwrap();
        assert_eq!(agent.pubkey, f.agent.pubkey);
    }

    #[test]
    fn the_answer_is_telemetry_encrypted_to_the_owner() {
        let f = fixture();
        let answer = ControlAnswer {
            agent: f.agent.pubkey.clone(),
            channel_id: "c-1".into(),
            request_id: "r-1".into(),
            status: "no_active_turn".into(),
        };
        let event: AgentEvent =
            serde_json::from_value(answer_event(&f.agent, &f.key, &answer, f.now).unwrap())
                .unwrap();
        verified(&event).unwrap();
        assert_eq!(event.kind, KIND);
        assert_eq!(event.pubkey, f.agent.pubkey);
        assert_eq!(event.tags, {
            let mut tags = control_tags(f.key.pubkey(), "telemetry");
            tags[0][1] = f.owner.pubkey().into();
            tags
        });
        let text = f
            .owner
            .nip44_decrypt(&f.agent.pubkey, &event.content)
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({
                "kind": "control_result", "channelId": "c-1",
                "payload": {"type": "cancel_turn", "status": "no_active_turn", "requestId": "r-1"},
            })
        );
        // Only a cancel_turn status.
        let refused = ControlAnswer {
            status: "ambiguous_target".into(),
            ..answer
        };
        assert!(answer_event(&f.agent, &f.key, &refused, f.now).is_err());
        // Only as the agent it answers for.
        let other = ControlAnswer {
            agent: f.owner.pubkey().into(),
            status: "sent".into(),
            ..refused
        };
        assert!(answer_event(&f.agent, &f.key, &other, f.now).is_err());
    }
}
