//! One opt-in recent-DM history read through the existing native agent broker.
use super::{query, AppAgent, AppAgentHost};
use buzz_ifc::{
    derive_execution_domain, CapabilityPolicy, CapabilitySet, CommunityId, ConversationKind,
    DomainFacts, ExecutionDomain, IfcSession, OperationEffect, Principal, ResourceLabel,
};
use nostr::{event::Event, key::PublicKey};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use tokio::sync::Mutex;
use uuid::Uuid;

const READ: &str = "channel.read";
const LIMIT: usize = 13;
const CHAT: [u16; 2] = [9, 40002];
const METADATA: u16 = 39000;
const MEMBERS: u16 = 39002;

/// Trusted native configuration for exactly one agent and DM.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    agent_pubkey: PublicKey,
    relay: String,
    community_id: Uuid,
    channel_id: Uuid,
    relay_pubkey: PublicKey,
}

struct Retained {
    generation: Uuid,
    session: IfcSession,
}

pub(super) struct HistoryRead {
    config: Result<Option<Config>, String>,
    // A single configured conversation bounds storage and serializes reads.
    retained: Mutex<Option<Retained>>,
}

#[derive(Serialize)]
pub(crate) struct History {
    generation: Uuid,
    events: Vec<Event>,
}

impl HistoryRead {
    pub(super) fn from_env() -> Self {
        let config = match std::env::var("BUZZ_APP_IFC_READ") {
            Ok(value) => serde_json::from_str(&value)
                .map(Some)
                .map_err(|error| format!("Invalid BUZZ_APP_IFC_READ configuration: {error}")),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(error) => Err(format!("Invalid BUZZ_APP_IFC_READ configuration: {error}")),
        };
        Self {
            config,
            retained: Mutex::new(None),
        }
    }

    #[cfg(test)]
    pub(super) fn disabled() -> Self {
        Self {
            config: Ok(None),
            retained: Mutex::new(None),
        }
    }

    pub(super) async fn read(
        &self,
        host: &AppAgentHost,
        pubkey: String,
        channel: String,
        trigger: Event,
    ) -> Result<Option<History>, String> {
        let Some(config) = self.config.as_ref().map_err(Clone::clone)? else {
            return Ok(None);
        };
        if pubkey != config.agent_pubkey.to_hex() || channel != config.channel_id.to_string() {
            return Ok(None);
        }
        let (agent, key) = host.key(host.agent(pubkey).await?).await?;
        self.read_as(config, &agent, &key, &trigger).await.map(Some)
    }

    async fn read_as(
        &self,
        config: &Config,
        agent: &AppAgent,
        key: &buzz_agent_controller::Secret,
        trigger: &Event,
    ) -> Result<History, String> {
        let mut retained = self.retained.lock().await;
        let channel = config.channel_id.to_string();
        check(
            agent.relay == config.relay,
            "IFC community does not match the agent",
        )?;
        verify_message(trigger, &channel)?;
        let (domain, label) = config.snapshot(agent, key, trigger).await?;
        if retained
            .as_ref()
            .map_or(true, |value| value.session.domain() != &domain)
        {
            let mut session = IfcSession::enter(domain.clone());
            // Tools, memory, instructions and other inputs remain unmediated.
            session.mark_unknown_input();
            *retained = Some(Retained {
                generation: Uuid::new_v4(),
                session,
            });
        }
        let retained = retained.as_ref().ok_or("Missing IFC read session")?;
        retained
            .session
            .call(READ)
            .map_err(|error| error.to_string())?;
        retained
            .session
            .read(&label)
            .map_err(|error| error.to_string())?;
        let events: Vec<Event> = serde_json::from_value(
            query(
                agent,
                key,
                &[json!({
                    "kinds": CHAT, "#h": [channel], "limit": LIMIT
                })],
            )
            .await?,
        )
        .map_err(|_| "Invalid IFC DM history")?;
        check(
            events.len() <= LIMIT,
            "IFC history exceeds the requested limit",
        )?;
        for event in &events {
            verify_message(event, &channel)?;
        }
        let (current, label) = config.snapshot(agent, key, trigger).await?;
        check(
            current == domain,
            "IFC domain changed while reading DM history",
        )?;
        retained
            .session
            .read(&label)
            .map_err(|error| error.to_string())?;
        Ok(History {
            generation: retained.generation,
            events,
        })
    }
}

impl Config {
    async fn snapshot(
        &self,
        agent: &AppAgent,
        key: &buzz_agent_controller::Secret,
        trigger: &Event,
    ) -> Result<(ExecutionDomain, ResourceLabel), String> {
        let channel = self.channel_id.to_string();
        let events: Vec<Event> = serde_json::from_value(
            query(
                agent,
                key,
                &[json!({
                    "kinds": [METADATA, MEMBERS], "authors": [self.relay_pubkey.to_hex()],
                    "#d": [channel], "limit": 2, "consistency": "strong"
                })],
            )
            .await?,
        )
        .map_err(|_| "Invalid IFC DM policy")?;
        let (mut metadata, mut membership) = (None, None);
        for event in &events {
            check(
                event.verify().is_ok()
                    && event.pubkey == self.relay_pubkey
                    && exact_tag(event, "d", &channel),
                "Unverified IFC DM policy",
            )?;
            let slot = match event.kind.as_u16() {
                METADATA => &mut metadata,
                MEMBERS => &mut membership,
                _ => return Err("Unexpected IFC DM policy event".into()),
            };
            check(
                slot.replace(event).is_none(),
                "Duplicate IFC DM policy event",
            )?;
        }
        let metadata = metadata.ok_or("Missing IFC DM metadata")?;
        check(
            exact_tag(metadata, "t", "dm")
                && metadata
                    .tags
                    .iter()
                    .any(|tag| tag.as_slice() == ["private"])
                && !metadata.tags.iter().any(|tag| {
                    matches!(
                        tag.as_slice().first().map(String::as_str),
                        Some("public" | "archived")
                    )
                }),
            "IFC channel is not an active private DM",
        )?;
        let membership = membership.ok_or("Missing IFC DM membership")?;
        let members = membership
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "p"))
            .map(|tag| {
                Principal::from_hex(tag.as_slice().get(1).ok_or("Invalid IFC member")?)
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<BTreeSet<_>, _>>()?;
        let community = CommunityId::from_uuid(self.community_id);
        let label = ResourceLabel::from_conversation(
            community,
            self.channel_id,
            ConversationKind::DirectMessage,
            members.iter().copied(),
        )
        .map_err(|error| error.to_string())?;
        let capabilities = CapabilitySet::from_operations([(READ, OperationEffect::NonEgressing)]);
        let domain = derive_execution_domain(
            DomainFacts {
                community,
                channel_id: self.channel_id,
                kind: ConversationKind::DirectMessage,
                members,
                executing_agent: Principal::from_hex(&agent.pubkey)
                    .map_err(|error| error.to_string())?,
                requesters: BTreeSet::from([Principal::from_public_key(&trigger.pubkey)
                    .map_err(|error| error.to_string())?]),
                owner: Some(Principal::from_hex(&agent.owner).map_err(|error| error.to_string())?),
                system_principal: Some(
                    Principal::from_public_key(&self.relay_pubkey)
                        .map_err(|error| error.to_string())?,
                ),
            },
            &CapabilityPolicy::new(capabilities.clone(), capabilities),
        )
        .map_err(|error| error.to_string())?;
        Ok((domain, label))
    }
}

fn verify_message(event: &Event, channel: &str) -> Result<(), String> {
    check(
        event.verify().is_ok()
            && CHAT.contains(&event.kind.as_u16())
            && exact_tag(event, "h", channel),
        "Unverified IFC DM message",
    )
}

fn exact_tag(event: &Event, name: &str, value: &str) -> bool {
    let mut tags = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|key| key == name));
    tags.next()
        .is_some_and(|tag| tag.as_slice().get(1).is_some_and(|item| item == value))
        && tags.next().is_none()
}

fn check(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

#[cfg(test)]
mod tests;
