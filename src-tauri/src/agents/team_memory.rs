//! Explicit snapshot-memory restore, signed by the saved member identity.
use super::{run, AgentHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use buzz_agent_controller::Memory;
use hmac::{Hmac, Mac};
use nostr_pairing::{
    nips::nip44, EventBuilder, JsonUtil, Keys, Kind, PublicKey, SecretKey, Tag, Timestamp,
};
use serde::Serialize;
use serde_json::json;
use sha2::Sha256;

#[derive(Serialize)]
pub(crate) struct RestoreResult {
    written: usize,
    total: usize,
    errors: Vec<String>,
}
#[tauri::command]
pub(crate) async fn agent_control_team_memory_restore(
    state: tauri::State<'_, AgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    id: String,
    memory: Memory,
) -> Result<RestoreResult, String> {
    memory.validate()?;
    let viewer = identity.with_key(|_, viewer| Ok(viewer.to_owned())).await?;
    let target = id.clone();
    let captured = viewer.clone();
    let (agent, credential, credentials, auth) = run(state.inner().clone(), move |host| {
        let agent = host
            .snapshot()?
            .data
            .agents
            .into_iter()
            .find(|a| a.id == target)
            .ok_or("Agent no longer exists")?;
        if agent.status != buzz_agent_controller::ProcessStatus::Stopped {
            return Err("Stop the imported member before restoring memories".into());
        }
        // Verify the current native owner before any credential access.
        host.controller
            .verify_team_member_owner(&target, &captured)?;
        let credential = host.controller.credential_request(&target)?.0;
        let auth = host
            .controller
            .team_member_authorization(&target, &captured)?;
        Ok((agent, credential, host.credentials.clone(), auth))
    })
    .await?;
    let pubkey = agent.pubkey.clone();
    let key = tauri::async_runtime::spawn_blocking(move || {
        credentials.retry();
        credentials.read(&credential, &pubkey)
    })
    .await
    .map_err(|_| "Native credential operation failed")??
    .ok_or("Agent key unavailable")?;
    let secret = SecretKey::from_hex(key.hex().as_str()).map_err(|_| "Invalid agent key")?;
    let keys = Keys::new(secret);
    let recipient = PublicKey::from_hex(&viewer).map_err(|_| "Invalid owner")?;
    let conversation = nip44::v2::ConversationKey::derive(keys.secret_key(), &recipient)
        .map_err(|_| "Invalid memory target")?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "Memory client unavailable")?;
    let url = format!(
        "{}/events",
        agent.relay_url.replacen("wss://", "https://", 1)
    );
    let community = agent.relay_url.replacen("wss://", "https://", 1);
    let previous = crate::relay::agent::relay_agent_memories_read(
        identity.clone(),
        community.clone(),
        agent.pubkey.clone(),
    )
    .await?;
    if previous["partial"].as_bool() != Some(false) {
        return Err("Memory listing is incomplete; restore was not started".into());
    }
    let mut result = RestoreResult {
        written: 0,
        total: memory.entries.len(),
        errors: vec![],
    };
    for entry in memory.entries {
        if previous["entries"].as_array().is_some_and(|entries| {
            entries.iter().any(|item| {
                item["slug"].as_str() == Some(entry.slug.as_str())
                    && item["body"].as_str() == Some(entry.body.as_str())
            })
        }) {
            result.written += 1;
            continue;
        }

        let host = state.inner().clone();
        let target = id.clone();
        let captured = viewer.clone();
        let expected = agent.revision;

        let operation = async {
            let current = identity.with_key(|_, viewer| Ok(viewer.to_owned())).await?;
            if current != viewer {
                return Err("Identity changed during memory restore".to_owned());
            }
            run(host, move |host| {
                host.controller
                    .verify_team_member_owner(&target, &captured)?;
                let current = host
                    .snapshot()?
                    .data
                    .agents
                    .into_iter()
                    .find(|a| a.id == target)
                    .ok_or("Agent no longer exists")?;
                if current.revision != expected
                    || current.status != buzz_agent_controller::ProcessStatus::Stopped
                {
                    return Err("Member changed during memory restore".into());
                }
                Ok(())
            })
            .await?;
            let value = if entry.slug == "core" {
                json!({"slug": entry.slug, "profile": entry.body})
            } else {
                json!({"slug": entry.slug, "value": entry.body})
            };
            let mut mac = Hmac::<Sha256>::new_from_slice(conversation.as_bytes())
                .map_err(|_| "Invalid memory address")?;
            mac.update(b"agent-memory/v1/d-tag\0");
            mac.update(entry.slug.as_bytes());
            let address: String = mac
                .finalize()
                .into_bytes()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            let content = nip44::encrypt(
                keys.secret_key(),
                &recipient,
                value.to_string(),
                nip44::Version::V2,
            )
            .map_err(|_| "Memory encryption failed")?;
            let timestamp = previous["entries"]
                .as_array()
                .and_then(|entries| {
                    entries
                        .iter()
                        .find(|item| item["slug"].as_str() == Some(entry.slug.as_str()))
                })
                .and_then(|item| item["createdAt"].as_u64())
                .map_or(Timestamp::now().as_secs(), |at| {
                    Timestamp::now().as_secs().max(at.saturating_add(1))
                });
            let event = EventBuilder::new(Kind::Custom(30174), content)
                .custom_created_at(Timestamp::from(timestamp))
                .tags([
                    Tag::parse(["d", address.as_str()]).map_err(|_| "Invalid memory tag")?,
                    Tag::parse(["p", viewer.as_str()]).map_err(|_| "Invalid memory tag")?,
                ])
                .sign_with_keys(&keys)
                .map_err(|_| "Memory signing failed")?;
            publish_memory(&client, &url, &auth, &keys, &event).await?;
            let listing = crate::relay::agent::relay_agent_memories_read(
                identity.clone(),
                community.clone(),
                agent.pubkey.clone(),
            )
            .await?;
            confirm_current(&listing, &entry.slug, &event.id.to_hex())?;
            Ok::<(), String>(())
        }
        .await;
        match operation {
            Ok(()) => result.written += 1,
            Err(_) => result.errors.push(format!(
                "{}: memory restore failed; retry this member",
                entry.slug
            )),
        }
    }
    Ok(result)
}

async fn publish_memory(
    client: &reqwest::Client,
    url: &str,
    auth: &str,
    keys: &Keys,
    event: &nostr_pairing::Event,
) -> Result<(), String> {
    let bytes = event.as_json().into_bytes();
    let authorization = EventBuilder::new(Kind::Custom(27235), "")
        .tags([
            Tag::parse(["u", url]).map_err(|_| "Invalid authorization")?,
            Tag::parse(["method", "POST"]).map_err(|_| "Invalid authorization")?,
            Tag::parse([
                "payload",
                &format!("{:x}", <Sha256 as sha2::Digest>::digest(&bytes)),
            ])
            .map_err(|_| "Invalid authorization")?,
        ])
        .sign_with_keys(keys)
        .map_err(|_| "Memory authorization failed")?;
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            format!("Nostr {}", STANDARD.encode(authorization.as_json())),
        )
        .header("x-auth-tag", auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Memory publication unconfirmed")?;
    if !response.status().is_success() {
        return Err("Memory publication refused".into());
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Memory receipt unavailable")?
    {
        if body.len() + chunk.len() > 16 * 1024 {
            return Err("Memory receipt too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    let receipt: serde_json::Value =
        serde_json::from_slice(&body).map_err(|_| "Invalid memory receipt")?;
    if receipt["accepted"].as_bool() != Some(true)
        || receipt["event_id"].as_str() != Some(event.id.to_hex().as_str())
    {
        return Err("Memory publication unconfirmed".into());
    }
    Ok(())
}

fn confirm_current(listing: &serde_json::Value, slug: &str, event_id: &str) -> Result<(), String> {
    if listing["partial"].as_bool() != Some(false)
        || !listing["entries"].as_array().is_some_and(|entries| {
            entries.iter().any(|item| {
                item["slug"].as_str() == Some(slug) && item["eventId"].as_str() == Some(event_id)
            })
        })
    {
        return Err("Memory restore is not confirmed as current".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
