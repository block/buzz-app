//! An agent's owner media (`owner_media_get`): one of its community's blobs,
//! read with its owner's own access into memory only. The WebView reviews the
//! reply, then publishes it: only then, and only while the owner is still
//! signed in and the agent was not deleted, is any byte written to a file.
//! Until then a discard, a reload or the window closing drops it.
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::oneshot;

use super::{media_name, mime_type, AppAgentHost, MEDIA_FILE_LIMIT, MEDIA_LIMIT, SHOWN_TYPES};
use crate::federated_identity::{agent::Stamp, FederatedIdentity};
use crate::identity::IdentityHost;

/// Media held at once, and the bytes they may reserve: one of the largest.
const OPS: usize = 16;
const BUDGET: u64 = 512 * 1024 * 1024;
/// Result protection waits up to 310 seconds for its checker; then a staged
/// blob, or a discard that overtook its stage, is dropped.
const LIFETIME: Duration = Duration::from_secs(330);
const TOMBSTONES: usize = 64;
/// Written while the owner and agent are held; the rest after.
const FIRST_WRITE: usize = 64 * 1024;

const CANCELLED: &str = "The owner media request was cancelled; nothing was saved";
const BUSY: &str = "Owner media is busy; try again shortly";
const NOTHING: &str = "This owner media request saved nothing; get it again";

struct Staged {
    agent: String,
    relay: String,
    owner: String,
    stamp: Stamp,
    retirements: u64,
    name: String,
    body: Vec<u8>,
    at: Instant,
}
enum Op {
    Fetching {
        cancel: Option<oneshot::Sender<()>>,
        reserved: u64,
    },
    Staged(Staged),
    /// Taken by its publication, whose body still counts until it is dropped.
    Publishing {
        reserved: u64,
    },
}
impl Op {
    fn reserved(&self) -> u64 {
        match self {
            Op::Fetching { reserved, .. } | Op::Publishing { reserved } => *reserved,
            Op::Staged(staged) => staged.body.capacity() as u64,
        }
    }
}
#[derive(Default)]
struct State {
    ops: HashMap<String, Op>,
    /// Discards that found nothing: one may have overtaken its stage.
    cancelled: HashMap<String, Instant>,
}
impl State {
    fn prune(&mut self, now: Instant) {
        self.ops.retain(|_, op| match op {
            Op::Staged(staged) => now.duration_since(staged.at) < LIFETIME,
            Op::Fetching { .. } | Op::Publishing { .. } => true,
        });
        self.cancelled
            .retain(|_, at| now.duration_since(*at) < LIFETIME);
    }
}

/// Owner media between its read and its publication, in memory only.
#[derive(Default)]
pub(crate) struct OwnerMedia(Mutex<State>);
impl OwnerMedia {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Registers `id`'s read, unless a discard already came for it.
    fn begin(&self, id: &str) -> Result<oneshot::Receiver<()>, String> {
        let mut state = self.lock();
        state.prune(Instant::now());
        if state.cancelled.remove(id).is_some() {
            return Err(CANCELLED.into());
        }
        if state.ops.contains_key(id) {
            return Err("This owner media request is already in progress".into());
        }
        if state.ops.len() >= OPS {
            return Err(BUSY.into());
        }
        let (cancel, cancelled) = oneshot::channel();
        state.ops.insert(
            id.into(),
            Op::Fetching {
                cancel: Some(cancel),
                reserved: 0,
            },
        );
        Ok(cancelled)
    }
    /// Reserves `bytes` for `id`'s body before any of it is read.
    fn reserve(&self, id: &str, bytes: u64) -> Result<(), String> {
        let mut state = self.lock();
        state.prune(Instant::now());
        let others: u64 = state
            .ops
            .iter()
            .filter(|(key, _)| key.as_str() != id)
            .map(|(_, op)| op.reserved())
            .sum();
        let Some(Op::Fetching { reserved, .. }) = state.ops.get_mut(id) else {
            return Err(CANCELLED.into());
        };
        if others + bytes > BUDGET {
            return Err(BUSY.into());
        }
        *reserved = bytes;
        Ok(())
    }
    /// Keeps `id`'s body until it is published or discarded.
    fn stage(&self, id: &str, staged: Staged) -> Result<(), String> {
        let mut state = self.lock();
        match state.ops.get_mut(id) {
            Some(op @ Op::Fetching { .. }) => {
                *op = Op::Staged(staged);
                Ok(())
            }
            _ => Err(CANCELLED.into()),
        }
    }
    /// Forgets a read that failed.
    fn end(&self, id: &str) {
        let mut state = self.lock();
        if matches!(state.ops.get(id), Some(Op::Fetching { .. })) {
            state.ops.remove(id);
        }
    }
    /// Drops `id`'s read or body; one not seen yet is refused when it comes.
    pub(crate) fn discard(&self, id: &str) {
        let mut state = self.lock();
        let now = Instant::now();
        state.prune(now);
        if matches!(state.ops.get(id), Some(Op::Publishing { .. })) {
            return;
        }
        if let Some(op) = state.ops.remove(id) {
            if let Op::Fetching {
                cancel: Some(cancel),
                ..
            } = op
            {
                let _ = cancel.send(());
            }
            return;
        }
        if state.cancelled.len() >= TOMBSTONES && !state.cancelled.contains_key(id) {
            // As `Uploads`: retire the oldest so a new discard still wins.
            if let Some(old) = state
                .cancelled
                .iter()
                .min_by_key(|(_, at)| **at)
                .map(|(key, _)| key.clone())
            {
                state.cancelled.remove(&old);
            }
        }
        state.cancelled.insert(id.into(), now);
    }
    /// Who `id`'s staged body was read for, without taking it.
    fn peek(&self, id: &str, agent: &str, relay: &str) -> Result<(String, Stamp, u64), String> {
        let mut state = self.lock();
        state.prune(Instant::now());
        match state.ops.get(id) {
            Some(Op::Staged(staged)) if staged.agent == agent && staged.relay == relay => {
                Ok((staged.owner.clone(), staged.stamp, staged.retirements))
            }
            _ => Err(NOTHING.into()),
        }
    }
    /// Takes `id`'s staged body for `agent` in `relay`; it can be taken once.
    /// It stays counted until [`OwnerMedia::published`].
    fn take(&self, id: &str, agent: &str, relay: &str) -> Result<Staged, String> {
        let mut state = self.lock();
        state.prune(Instant::now());
        let Some(op) = state.ops.get_mut(id) else {
            return Err(NOTHING.into());
        };
        match op {
            Op::Staged(staged) if staged.agent == agent && staged.relay == relay => {
                let reserved = op.reserved();
                match std::mem::replace(op, Op::Publishing { reserved }) {
                    Op::Staged(staged) => Ok(staged),
                    _ => unreachable!(),
                }
            }
            _ => Err(NOTHING.into()),
        }
    }
    /// Releases what `id`'s publication held, once its body is dropped.
    fn published(&self, id: &str) {
        let mut state = self.lock();
        if matches!(state.ops.get(id), Some(Op::Publishing { .. })) {
            state.ops.remove(id);
        }
    }
    /// Drops every read and body, as a new page or a closed window starts none.
    pub(crate) fn clear(&self) {
        let mut state = self.lock();
        for (_, op) in state.ops.drain() {
            if let Op::Fetching {
                cancel: Some(cancel),
                ..
            } = op
            {
                let _ = cancel.send(());
            }
        }
        state.cancelled.clear();
    }
    #[cfg(test)]
    fn held(&self) -> (usize, u64) {
        let state = self.lock();
        (state.ops.len(), state.ops.values().map(Op::reserved).sum())
    }
}

/// Owner media read and held for review; nothing is at `path` yet.
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct OwnerMediaStaged {
    path: String,
    #[serde(rename = "type")]
    mime: String,
    size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

fn dir() -> PathBuf {
    std::env::temp_dir().join("buzz-agent-media")
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid owner media request".into());
    }
    Ok(())
}

/// Reads one of the agent's community media blobs (its URL or `sha256[.ext]`)
/// with its owner's access, into memory, as request `id`.
#[tauri::command]
pub(crate) async fn app_agent_owner_media_stage(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    pubkey: String,
    relay: String,
    id: String,
    url: String,
) -> Result<OwnerMediaStaged, String> {
    stage(&state, &identity, Some(&fi), &dir(), pubkey, relay, id, url).await
}

#[allow(clippy::too_many_arguments)]
async fn stage(
    host: &AppAgentHost,
    identity: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    dir: &Path,
    pubkey: String,
    relay: String,
    id: String,
    url: String,
) -> Result<OwnerMediaStaged, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    valid_id(&id)?;
    let media = host.owner_media.clone();
    let cancelled = media.begin(&id)?;
    let read = async {
        // As a local caller's token: retirements, then the stamp, then the row.
        let retirements = host.caller_retirements();
        let (agent, stamp) = host.caller_stamp(pubkey.clone(), relay.clone()).await?;
        if host.caller_closed() {
            return Err("Your owner signed out of Buzz here".to_owned());
        }
        let url = agent.media_url(&url)?;
        let target = url::Url::parse(&url).map_err(|_| "Invalid media URL")?;
        let (kind, body) = crate::relay::owner_media(
            identity,
            fi,
            &agent.owner,
            target,
            MEDIA_FILE_LIMIT,
            |bytes| media.reserve(&id, bytes),
        )
        .await?;
        agent.verify_media_hash(&url, &format!("{:x}", Sha256::digest(&body)))?;
        let mime = kind
            .as_deref()
            .and_then(mime_type)
            .unwrap_or_else(|| "application/octet-stream".into());
        let shown = SHOWN_TYPES.contains(&mime.as_str()) && body.len() as u64 <= MEDIA_LIMIT;
        let name = media_name(&url, &mime);
        let reply = OwnerMediaStaged {
            path: dir.join(&name).to_string_lossy().into_owned(),
            data: shown.then(|| base64::engine::general_purpose::STANDARD.encode(&body)),
            size: body.len() as u64,
            mime,
        };
        media.stage(
            &id,
            Staged {
                agent: agent.pubkey,
                relay: relay.clone(),
                owner: agent.owner,
                stamp,
                retirements,
                name,
                body,
                at: Instant::now(),
            },
        )?;
        Ok(reply)
    };
    let result = tokio::select! {
        biased;
        _ = cancelled => Err(CANCELLED.to_owned()),
        result = read => result,
    };
    if result.is_err() {
        media.end(&id);
    }
    result
}

/// Writes request `id`'s reviewed media to its path. Refused, with nothing
/// written, unless it is still held and its owner and agent still act.
#[tauri::command]
pub(crate) async fn app_agent_owner_media_publish(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, IdentityHost>,
    pubkey: String,
    relay: String,
    id: String,
) -> Result<(), String> {
    let (host, identity) = (state.inner().clone(), identity.inner().clone());
    super::blocking(move || publish(&host, &identity, &dir(), &pubkey, &relay, &id)).await
}

fn publish(
    host: &AppAgentHost,
    identity: &IdentityHost,
    dir: &Path,
    pubkey: &str,
    relay: &str,
    id: &str,
) -> Result<(), String> {
    valid_id(id)?;
    let (owner, stamp, retirements) = host.owner_media.peek(id, pubkey, relay)?;
    // Declared first, so dropped after the body it keeps counted.
    let _published = Published(&host.owner_media, id);
    // The order every credential owner takes: identity, then the agent tokens'
    // locks, then this request's. Sign-out, deletion and a change of account
    // either refuse this or wait for its first bytes.
    let held = identity.hold_owner(&owner);
    let (staged, mut file) = match held {
        Err(error) => {
            host.owner_media.discard(id);
            return Err(format!("{error}; nothing was saved"));
        }
        Ok(_held) => host
            .tokens
            .commit_caller(pubkey, relay, stamp, retirements, || {
                let staged = host.owner_media.take(id, pubkey, relay)?;
                std::fs::create_dir_all(dir).map_err(|_| "Media storage unavailable")?;
                let mut file = tempfile::NamedTempFile::new_in(dir)
                    .map_err(|_| "Media storage unavailable")?;
                let first = staged.body.len().min(FIRST_WRITE);
                file.write_all(&staged.body[..first])
                    .map_err(|_| "Media storage unavailable")?;
                Ok((staged, file))
            })
            .inspect_err(|_| host.owner_media.discard(id))?,
    };
    let path = dir.join(&staged.name);
    let first = staged.body.len().min(FIRST_WRITE);
    file.write_all(&staged.body[first..])
        .and_then(|()| file.flush())
        .map_err(drop)
        .and_then(|()| file.persist(&path).map(drop).map_err(drop))
        .map_err(|()| format!("Saving {} failed; nothing was saved", path.display()))
}

struct Published<'a>(&'a OwnerMedia, &'a str);
impl Drop for Published<'_> {
    fn drop(&mut self) {
        self.0.published(self.1);
    }
}

/// Drops request `id`'s read or held media; one still to come is refused.
#[tauri::command]
pub(crate) fn app_agent_owner_media_discard(state: tauri::State<'_, AppAgentHost>, id: String) {
    if valid_id(&id).is_ok() {
        state.owner_media.discard(&id);
    }
}

#[cfg(test)]
mod tests;
