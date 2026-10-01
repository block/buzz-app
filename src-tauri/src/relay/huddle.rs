//! Client-side Huddle owner. Uses the existing relay's ephemeral channels and v2 audio.
//! No key, arbitrary signer, or arbitrary WebSocket endpoint is exposed to plugins.
mod audio;

use super::{origin, request_url, send, verify_signature, Result};
use crate::identity::{EventTemplate, IdentityHost};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, watch};

#[derive(Clone, Default)]
pub(crate) struct Huddles(Arc<Mutex<Option<Active>>>);
impl Huddles {
    pub(crate) fn contains(&self, id: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|slot| slot.as_ref().is_some_and(|call| call.id == id))
    }
}
struct Active {
    id: String,
    stop: watch::Sender<bool>,
    done: watch::Receiver<bool>,
    pcm: mpsc::Sender<Vec<f32>>,
    touched: Arc<AtomicU64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Call {
    id: String,
    community: String,
    viewer: String,
    parent: String,
    room: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Update {
    Connected {
        room: String,
        participants: Vec<String>,
    },
    Participants {
        participants: Vec<String>,
    },
    Audio {
        peer: String,
        samples: Vec<f32>,
    },
    Ended {
        error: Option<String>,
    },
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn lease_time() -> u64 {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    START
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_secs()
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
fn validate(call: &Call) -> Result<()> {
    origin(&call.community)?;
    if !uuid(&call.id)
        || !uuid(&call.parent)
        || !super::hex_key(&call.viewer)
        || call
            .room
            .as_ref()
            .is_some_and(|id| !uuid(id) || id == &call.parent)
    {
        return Err("Invalid Huddle destination".into());
    }
    Ok(())
}
fn check_cancelled(stop: &watch::Receiver<bool>, touched: &AtomicU64) -> Result<()> {
    if *stop.borrow() || lease_time().saturating_sub(touched.load(Ordering::Relaxed)) > 20 {
        Err("Huddle cancelled".into())
    } else {
        Ok(())
    }
}
fn template(kind: u16, tags: Vec<Vec<String>>, content: String) -> EventTemplate {
    EventTemplate {
        kind,
        created_at: now(),
        tags,
        content,
    }
}
fn lifecycle(kind: u16, parent: &str, room: &str) -> EventTemplate {
    template(
        kind,
        vec![vec!["h".into(), parent.into()]],
        json!({"ephemeral_channel_id": room}).to_string(),
    )
}
fn create(room: &str) -> EventTemplate {
    template(
        9007,
        vec![
            vec!["h".into(), room.into()],
            vec!["name".into(), "Huddle".into()],
            vec!["visibility".into(), "private".into()],
            vec!["channel_type".into(), "stream".into()],
            vec!["ttl".into(), "3600".into()],
        ],
        String::new(),
    )
}
async fn publish(host: &IdentityHost, community: &str, event: EventTemplate) -> Result<()> {
    let signed = host.sign(event).await?;
    let expected = signed["id"]
        .as_str()
        .ok_or("Invalid signed Huddle event")?
        .to_owned();
    let reply = send(
        host,
        request_url(community, "/events", "POST")?,
        "POST",
        Some(signed.to_string()),
        true,
        65536,
    )
    .await?;
    let value: Value = serde_json::from_str(&reply.body).map_err(|_| "Invalid Huddle receipt")?;
    if !(200..300).contains(&reply.status) {
        return Err(format!("Huddle operation rejected (HTTP {})", reply.status));
    }
    // Same /events acknowledgement contract as ordinary client publications.
    if value["event_id"] != expected || value["accepted"] != true {
        return Err("Relay did not accept the Huddle event".into());
    }
    Ok(())
}

async fn admit_parent(host: &IdentityHost, call: &Call) -> Result<()> {
    if host.viewer().await? != call.viewer {
        return Err("Your identity changed. Reopen Huddles.".into());
    }
    let info = send(host, origin(&call.community)?, "GET", None, false, 65536).await?;
    let info: Value = serde_json::from_str(&info.body).map_err(|_| "Relay identity unavailable")?;
    let authority = info["self"]
        .as_str()
        .or(info["pubkey"].as_str())
        .filter(|s| super::hex_key(s))
        .ok_or("Relay identity unavailable")?;
    let reply = send(
        host,
        request_url(&call.community, "/query", "POST")?,
        "POST",
        Some(
            json!([{"kinds":[39002], "authors":[authority], "#d":[call.parent], "limit":1}])
                .to_string(),
        ),
        true,
        1024 * 1024,
    )
    .await?;
    if !(200..300).contains(&reply.status) {
        return Err("Could not verify channel membership".into());
    }
    let events: Vec<Value> =
        serde_json::from_str(&reply.body).map_err(|_| "Invalid channel membership")?;
    let allowed = events.iter().any(|e| {
        verify_signature(e).is_ok()
            && e["kind"] == 39002
            && e["pubkey"] == authority
            && has_tag(e, "d", &call.parent)
            && has_tag(e, "p", &call.viewer)
    });
    if !allowed {
        return Err("You must be a current member of this channel to join a Huddle".into());
    }
    Ok(())
}
fn has_tag(event: &Value, name: &str, value: &str) -> bool {
    event["tags"]
        .as_array()
        .is_some_and(|tags| tags.iter().any(|t| t[0] == name && t[1] == value))
}

#[tauri::command]
pub(crate) fn huddle_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, IdentityHost>,
    huddles: tauri::State<'_, Huddles>,
    call: Call,
    updates: Channel<Update>,
) -> Result<()> {
    validate(&call)?;
    let (stop, cancelled) = watch::channel(false);
    let (done, finished) = watch::channel(false);
    // Drop excess microphone frames instead of accumulating seconds of delayed speech.
    let (pcm, receiver) = mpsc::channel(5);
    let touched = Arc::new(AtomicU64::new(lease_time()));
    let mut slot = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
    if slot.is_some() {
        return Err("Leave your current Huddle first".into());
    }
    *slot = Some(Active {
        id: call.id.clone(),
        stop,
        done: finished,
        pcm,
        touched: touched.clone(),
    });
    let host = host.inner().clone();
    let huddles = huddles.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = run(&host, &call, &updates, cancelled.clone(), receiver, touched).await;
        let error = result.err().filter(|_| !*cancelled.borrow());
        let _ = updates.send(Update::Ended { error });
        if let Ok(mut slot) = huddles.0.lock() {
            if slot.as_ref().is_some_and(|a| a.id == call.id) {
                *slot = None;
            }
        }
        crate::huddle_window::retire(&app, &call.id);
        let _ = done.send(true);
    });
    Ok(())
}

async fn run(
    host: &IdentityHost,
    call: &Call,
    updates: &Channel<Update>,
    mut stop: watch::Receiver<bool>,
    pcm: mpsc::Receiver<Vec<f32>>,
    touched: Arc<AtomicU64>,
) -> Result<()> {
    admit_parent(host, call).await?;
    check_cancelled(&stop, &touched)?;
    let room = call
        .room
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let creating = call.room.is_none();
    let mut attempted_create = false;
    let mut advertised = false;
    let result = async {
        if creating {
            attempted_create = true;
            // Do not cancel an in-flight publication: its outcome may be uncertain.
            publish(host, &call.community, create(&room)).await?;
            check_cancelled(&stop, &touched)?;
            // Once the advisory might be visible, another person can join. Never
            // archive that shared room on our own failed/cancelled connection.
            advertised = true;
            publish(host, &call.community, lifecycle(48100, &call.parent, &room)).await?;
        }
        check_cancelled(&stop, &touched)?;
        let (socket, peers) = tokio::select! {
            _ = stop.changed() => return Err("Huddle cancelled".into()),
            result = tokio::time::timeout(Duration::from_secs(15), audio::connect(host, call, &room)) => result.map_err(|_| "Huddle connection timed out")??,
        };
        check_cancelled(&stop, &touched)?;
        updates.send(Update::Connected { room: room.clone(), participants: peers.values().cloned().collect() }).map_err(|_| "Huddle view closed")?;
        audio::run(socket, peers, pcm, stop.clone(), updates, &touched).await
    }.await;
    // Only unadvertised creation can be rolled back without ending someone else's
    // call. Otherwise socket/TTL cleanup belongs to the existing relay.
    if attempted_create && !advertised {
        let archive = template(
            9002,
            vec![
                vec!["h".into(), room.clone()],
                vec!["archived".into(), "true".into()],
            ],
            String::new(),
        );
        let cleanup = publish(host, &call.community, archive).await;
        if cleanup.is_err() {
            return Err(format!(
                "{}. The temporary Huddle could not be closed; it will expire.",
                result.err().unwrap_or_else(|| "Huddle cancelled".into())
            ));
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn huddle_close(huddles: tauri::State<'_, Huddles>, id: String) -> Result<()> {
    let done = {
        let slot = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
        slot.as_ref().filter(|a| a.id == id).map(|a| {
            let _ = a.stop.send(true);
            a.done.clone()
        })
    };
    if let Some(mut done) = done {
        if !*done.borrow() {
            let _ = done.changed().await;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn huddle_touch(huddles: tauri::State<'_, Huddles>, id: String) -> Result<()> {
    let slot = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
    if let Some(a) = slot.as_ref().filter(|a| a.id == id) {
        a.touched.store(lease_time(), Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn huddle_pcm(
    huddles: tauri::State<'_, Huddles>,
    id: String,
    samples: Vec<f32>,
) -> Result<()> {
    if samples.len() != 960 || samples.iter().any(|s| !s.is_finite() || s.abs() > 1.0) {
        return Err("Invalid Huddle audio frame".into());
    }
    let slot = huddles.0.lock().map_err(|_| "Huddles unavailable")?;
    if let Some(a) = slot.as_ref().filter(|a| a.id == id && !*a.stop.borrow()) {
        let _ = a.pcm.try_send(samples);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn huddle_templates_match_existing_protocol() {
        let room = uuid::Uuid::new_v4().to_string();
        let parent = uuid::Uuid::new_v4().to_string();
        let e = create(&room);
        assert_eq!(e.kind, 9007);
        assert_eq!(e.tags.last().unwrap(), &["ttl", "3600"]);
        assert_eq!(e.tags[2], ["visibility", "private"]);
        let e = lifecycle(48100, &parent, &room);
        assert_eq!(e.tags, vec![vec!["h", &parent]]);
        assert_eq!(
            serde_json::from_str::<Value>(&e.content).unwrap(),
            json!({"ephemeral_channel_id":room})
        );
    }
    #[test]
    fn destination_rejects_paths_credentials_and_noncanonical_ids() {
        let mut call = Call {
            id: uuid::Uuid::new_v4().to_string(),
            community: "https://relay.example".into(),
            viewer: "a".repeat(64),
            parent: uuid::Uuid::new_v4().to_string(),
            room: None,
        };
        assert!(validate(&call).is_ok());
        call.community = "https://relay.example/other".into();
        assert!(validate(&call).is_err());
        call.community = "https://user@relay.example".into();
        assert!(validate(&call).is_err());
        call.community = "https://relay.example".into();
        call.room = Some(call.parent.clone());
        assert!(validate(&call).is_err());
    }
}
