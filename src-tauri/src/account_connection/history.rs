//! Archive authority and lifecycle, independent from live turn/typing projections.
use super::{
    archive::{Archive, SavedRow},
    session::{Output, Request, Session},
    AccountConnection, Result,
};
use nostr::{Event, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::atomic::{AtomicU64, Ordering},
    sync::{Arc, Mutex},
};
const ERROR: &str = "Saved Activity is unavailable for this account or channel";
struct Membership {
    event: Event,
    allowed: bool,
}
struct State {
    epoch: u64,
    rosters: BTreeMap<String, Membership>,
    highest: BTreeMap<String, (u64, String)>,
    capture_epoch: u64,
    deleting: bool,
}
#[derive(Default)]
struct Purge {
    pending: BTreeSet<String>,
    running: bool,
    error: bool,
}
pub(super) struct History {
    authority: String,
    archive: Option<Arc<Archive>>,
    state: Mutex<State>,
    fence: AtomicU64,
    gaps: AtomicU64,
    persisted_gap: AtomicU64,
    deleted_gap: AtomicU64,
    gap_write: Mutex<()>,
    purge: Arc<Mutex<Purge>>,
    pub(super) admission: std::sync::Arc<tokio::sync::Semaphore>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Read {
    agent: String,
    channel: String,
    before: Option<i64>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    records: Vec<SavedRow>,
    more: bool,
    before: Option<i64>,
    trimmed: bool,
    epoch: u64,
    revision: i64,
    channels: Vec<String>,
}
fn channels(plaintext: &str) -> Result<Vec<String>> {
    let value: Value = serde_json::from_str(plaintext).map_err(|_| ERROR)?;
    let mut channels = BTreeSet::new();
    let items = if value["kind"] == "batch" {
        value["payload"]["events"].as_array().ok_or(ERROR)?.clone()
    } else {
        vec![value.clone()]
    };
    if value["kind"] == "batch"
        && items
            .iter()
            .any(|item| !item.is_object() || item["kind"] == "batch")
    {
        return Err("Unsupported nested Activity batch".into());
    }
    for item in std::iter::once(&value).chain(items.iter()) {
        if let Some(channel) = item.get("channelId").filter(|v| !v.is_null()) {
            let channel = channel
                .as_str()
                .filter(|c| {
                    !c.is_empty()
                        && c.len() <= 128
                        && c.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
                })
                .ok_or(ERROR)?;
            channels.insert(channel.to_owned());
        }
    }
    if channels.len() > 128 {
        return Err(ERROR.into());
    }
    Ok(channels.into_iter().collect())
}
impl History {
    pub fn new(authority: String, archive: Option<Arc<Archive>>) -> Self {
        Self {
            authority,
            archive,
            fence: AtomicU64::new(0),
            gaps: AtomicU64::new(0),
            persisted_gap: AtomicU64::new(0),
            deleted_gap: AtomicU64::new(0),
            gap_write: Mutex::new(()),
            purge: Arc::new(Mutex::new(Purge::default())),
            admission: Arc::new(tokio::sync::Semaphore::new(2)),
            state: Mutex::new(State {
                epoch: 0,
                rosters: BTreeMap::new(),
                highest: BTreeMap::new(),
                capture_epoch: 0,
                deleting: false,
            }),
        }
    }
    pub fn epoch(&self) -> u64 {
        self.fence.load(Ordering::SeqCst)
    }
    pub fn capture_epoch(&self) -> u64 {
        self.state
            .lock()
            .map(|s| s.capture_epoch)
            .unwrap_or(u64::MAX)
    }
    pub fn stop_capture(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.capture_epoch += 1;
        }
    }
    pub fn disconnect(&self) {
        self.fence.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            state.epoch += 1;
            state.rosters.clear();
            state.capture_epoch += 1;
        }
    }
    pub fn accept_rosters(&self, values: &[Value], viewer: &str, origin: &str) {
        for value in values {
            if value["kind"].as_u64() != Some(39002)
                || !value["created_at"]
                    .as_u64()
                    .is_some_and(|t| t <= Timestamp::now().as_secs() + 300)
            {
                continue;
            }
            let Ok(event) = serde_json::from_value::<Event>(value.clone()) else {
                continue;
            };
            if event.pubkey.to_hex() != self.authority || event.verify().is_err() {
                continue;
            }
            let ds: Vec<_> = event
                .tags
                .iter()
                .filter(|t| t.as_slice().first().is_some_and(|s| s == "d"))
                .collect();
            if ds.len() != 1 || ds[0].as_slice().len() != 2 {
                continue;
            }
            let channel = ds[0].as_slice()[1].clone();
            let allowed = event.tags.iter().any(|tag| {
                tag.as_slice().first().is_some_and(|s| s == "p")
                    && tag.as_slice().get(1).is_some_and(|s| s == viewer)
            });
            if let Ok(mut state) = self.state.lock() {
                let stamp = (event.created_at.as_secs(), event.id.to_hex());
                if state.highest.get(&channel).is_some_and(|(time, id)| {
                    *time > stamp.0 || (*time == stamp.0 && *id < stamp.1)
                }) {
                    continue;
                }
                if state.highest.len() >= 2048 && !state.highest.contains_key(&channel) {
                    state.rosters.clear();
                    self.fence.fetch_add(1, Ordering::SeqCst);
                    return;
                }
                state.highest.insert(channel.clone(), stamp);
                if !allowed {
                    state.epoch += 1;
                    self.fence.fetch_add(1, Ordering::SeqCst);
                    self.queue_purge(viewer, origin, &channel);
                }
                state.rosters.insert(channel, Membership { event, allowed });
                if state.rosters.len() > 2048 {
                    state.rosters.clear();
                    self.fence.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
    }
    fn queue_purge(&self, viewer: &str, origin: &str, channel: &str) {
        let Some(archive) = self.archive.clone() else {
            return;
        };
        let Ok(mut purge) = self.purge.lock() else {
            return;
        };
        purge.pending.insert(channel.to_owned());
        if purge.running {
            return;
        }
        purge.running = true;
        let owner = self.purge.clone();
        let viewer = viewer.to_owned();
        let origin = origin.to_owned();
        tauri::async_runtime::spawn_blocking(move || loop {
            let next = owner.lock().ok().and_then(|mut p| {
                let next = p.pending.pop_first();
                if next.is_none() {
                    p.running = false;
                }
                next
            });
            let Some(channel) = next else {
                break;
            };
            if archive.purge_channel(&viewer, &origin, &channel).is_err() {
                if let Ok(mut p) = owner.lock() {
                    p.pending.insert(channel);
                    p.error = true;
                    p.running = false;
                }
                break;
            }
            if let Ok(mut p) = owner.lock() {
                p.error = false;
            }
        });
    }
    fn purge_ready(&self) -> bool {
        self.purge
            .lock()
            .is_ok_and(|p| !p.running && !p.error && p.pending.is_empty())
    }
    pub fn gap_pending(&self) {
        self.gaps.fetch_add(1, Ordering::SeqCst);
    }
    fn has_gap(&self) -> bool {
        self.gaps.load(Ordering::SeqCst) > self.deleted_gap.load(Ordering::SeqCst)
    }
    pub fn flush_gap(&self, session: &Session) {
        let Ok(_write) = self.gap_write.lock() else {
            return;
        };
        self.flush_gap_locked(session);
    }
    fn flush_gap_locked(&self, session: &Session) {
        let count = self.gaps.load(Ordering::SeqCst);
        if count > self.persisted_gap.load(Ordering::SeqCst)
            && count > self.deleted_gap.load(Ordering::SeqCst)
        {
            if let Some(archive) = &self.archive {
                if archive.mark_gap(&session.viewer, &session.origin).is_ok() {
                    self.persisted_gap.fetch_max(count, Ordering::SeqCst);
                }
            }
        }
    }
    pub fn mark_gap(&self, session: &Session) {
        self.gap_pending();
        self.flush_gap(session);
    }
    pub fn capture(&self, session: &Session, raw: &Value, dto: &Value, epoch: u64) -> Result<()> {
        if !self.purge_ready() {
            return Err("Saved Activity access cleanup is pending or failed".into());
        }
        let archive = self
            .archive
            .as_ref()
            .ok_or("Saved Activity storage unavailable")?;
        let scope = channels(dto["plaintext"].as_str().ok_or(ERROR)?)?;
        let state = self.state.lock().map_err(|_| ERROR)?;
        if state.deleting
            || state.capture_epoch != epoch
            || scope
                .iter()
                .any(|c| !state.rosters.get(c).is_some_and(|r| r.allowed))
        {
            return Err(ERROR.into());
        }
        let access = self.epoch();
        drop(state);
        session.current().map_err(|_| ERROR)?;
        archive.append_checked(
            (&session.viewer, &session.origin),
            dto["id"].as_str().ok_or(ERROR)?,
            dto["agent"].as_str().ok_or(ERROR)?,
            &raw.to_string(),
            &scope,
            (now_ms(), || {
                self.epoch() == access && self.capture_epoch() == epoch && session.current().is_ok()
            }),
        )
    }
    async fn authorize(&self, session: &Session, channel: &str, epoch: u64) -> Result<()> {
        let filters =
            json!([{"kinds":[39002],"authors":[self.authority],"#d":[channel],"limit":1}]);
        let op = session.begin().map_err(|_| ERROR)?;
        let Output::Response(response) = session
            .run(op, Request::Query(filters))
            .await
            .map_err(|_| ERROR)?;
        if response.status != 200 {
            return Err(ERROR.into());
        }
        let events: Vec<Value> = serde_json::from_str(&response.body).map_err(|_| ERROR)?;
        if events.len() != 1 {
            return Err(ERROR.into());
        }
        let event: Event = serde_json::from_value(events[0].clone()).map_err(|_| ERROR)?;
        if event.verify().is_err()
            || event.pubkey.to_hex() != self.authority
            || event.kind.as_u16() != 39002
        {
            return Err(ERROR.into());
        }
        let state = self.state.lock().map_err(|_| ERROR)?;
        if epoch != self.epoch()
            || !state
                .rosters
                .get(channel)
                .is_some_and(|r| r.allowed && r.event.id == event.id)
        {
            return Err(ERROR.into());
        }
        Ok(())
    }
    async fn read(&self, session: &Arc<Session>, read: Read) -> Result<Page> {
        if read.agent.len() != 64
            || !read
                .agent
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || read.channel.len() > 128
        {
            return Err(ERROR.into());
        }
        if !self.purge_ready() {
            return Err("Saved Activity access cleanup is pending or failed".into());
        }
        let archive = self.archive.as_ref().ok_or(ERROR)?;
        let epoch = self.epoch();
        if !read.channel.is_empty() {
            self.authorize(session, &read.channel, epoch).await?;
        }
        let storage = archive.clone();
        let viewer = session.viewer.clone();
        let origin = session.origin.clone();
        let agent = read.agent.clone();
        let channel = read.channel.clone();
        let before = read.before;
        let page = tauri::async_runtime::spawn_blocking(move || {
            storage.page(
                &viewer,
                &origin,
                &agent,
                (!channel.is_empty()).then_some(channel.as_str()),
                before,
                now_ms(),
            )
        })
        .await
        .map_err(|_| ERROR)??;
        // Decryption may only expose batches after every indexed scope is freshly admitted.
        let extra: BTreeSet<_> = page
            .rows
            .iter()
            .flat_map(|row| row.channels.iter().cloned())
            .filter(|c| *c != read.channel)
            .collect();
        if extra.len() > 32 {
            return Err("Saved Activity spans too many scopes for this bounded read".into());
        }
        for channel in extra {
            self.authorize(session, &channel, epoch).await?;
        }
        let before = page.rows.last().map(|r| r.sequence);
        let mut records = Vec::new();
        for row in page.rows {
            let raw: Value = serde_json::from_str(&row.raw).map_err(|_| ERROR)?;
            let dto = decode_history(&raw, session)?;
            let scope = channels(dto["plaintext"].as_str().ok_or(ERROR)?)?;
            if scope
                != row
                    .channels
                    .iter()
                    .cloned()
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect::<Vec<_>>()
                || (!read.channel.is_empty() && !scope.contains(&read.channel))
                || dto["agent"] != read.agent
                || dto["id"] != row.id
            {
                return Err(ERROR.into());
            }
            records.push(SavedRow {
                id: row.id,
                agent: read.agent.clone(),
                received_at: row.received_at,
                plaintext: dto["plaintext"].as_str().ok_or(ERROR)?.into(),
                kind: serde_json::from_str::<Value>(dto["plaintext"].as_str().ok_or(ERROR)?)
                    .map_err(|_| ERROR)?["kind"]
                    .as_str()
                    .unwrap_or("unknown")
                    .into(),
            });
        }
        session.current().map_err(|_| ERROR)?;
        if self.epoch() != epoch {
            return Err(ERROR.into());
        }
        let channels = records
            .iter()
            .flat_map(|row| channels(&row.plaintext).unwrap_or_default())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        // Final native access/delete fence immediately before returning plaintext.
        let _state = self.state.lock().map_err(|_| ERROR)?;
        if self.epoch() != epoch || !self.purge_ready() {
            return Err(ERROR.into());
        }
        Ok(Page {
            records,
            more: page.more,
            before,
            trimmed: page.trimmed || self.has_gap(),
            epoch,
            revision: page.revision,
            channels,
        })
    }
    fn delete(&self, session: &Session) -> Result<()> {
        session.current().map_err(|_| ERROR)?;
        // Pair DB gap persistence and its acknowledgement with deletion: an old
        // flusher cannot publish its counter after deletion erased that marker.
        let _gap_write = self.gap_write.lock().map_err(|_| ERROR)?;
        let clearing_gaps = self.gaps.load(Ordering::SeqCst);
        let epoch = {
            let mut state = self.state.lock().map_err(|_| ERROR)?;
            if state.deleting {
                return Err("Saved Activity deletion already in progress".into());
            }
            state.deleting = true;
            state.epoch += 1;
            self.fence.fetch_add(1, Ordering::SeqCst);
            let old = state.capture_epoch;
            state.capture_epoch += 1;
            old
        };
        let result = self.archive.as_ref().ok_or(ERROR).and_then(|archive| {
            archive
                .delete(&session.viewer, &session.origin, now_ms())
                .map_err(|_| ERROR)
        });
        let mut state = self.state.lock().map_err(|_| ERROR)?;
        state.deleting = false;
        if result.is_err() && state.capture_epoch == epoch + 1 {
            state.capture_epoch = epoch;
        }
        if result.is_ok() {
            self.deleted_gap.store(clearing_gaps, Ordering::SeqCst);
            // SQLite deletion may have cleared a concurrently flushed newer gap.
            // Force any newer in-memory marker to be persisted again after delete.
            self.persisted_gap.store(clearing_gaps, Ordering::SeqCst);
        }
        drop(state);
        if result.is_ok() {
            self.flush_gap_locked(session);
        }
        result.map_err(str::to_owned)
    }
}
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
fn decode_history(raw: &Value, session: &Session) -> Result<Value> {
    if raw["kind"].as_u64() != Some(24200) {
        return Err(ERROR.into());
    }
    let event: Event = serde_json::from_value(raw.clone()).map_err(|_| ERROR)?;
    event.verify().map_err(|_| ERROR)?;
    let exact = |name: &str, value: &str| {
        let tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().is_some_and(|s| s == name))
            .collect();
        tags.len() == 1 && tags[0].as_slice() == [name, value]
    };
    if !exact("p", &session.viewer)
        || !exact("agent", &event.pubkey.to_hex())
        || !exact("frame", "telemetry")
        || !(132..=87472).contains(&event.content.len())
    {
        return Err(ERROR.into());
    }
    let bytes = session
        .identity
        .decrypt_activity(&session.viewer, &event)
        .map_err(|_| ERROR)?;
    if bytes.len() > 65535 {
        return Err(ERROR.into());
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| ERROR)?;
    serde_json::from_str::<Value>(text).map_err(|_| ERROR)?;
    Ok(json!({"id":event.id.to_hex(),"agent":event.pubkey.to_hex(),"plaintext":text}))
}
#[tauri::command]
pub(crate) async fn account_history_read<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    read: Read,
) -> Result<Page> {
    let session = host.session(webview.label(), &lease).map_err(|_| ERROR)?;
    let _permit = session
        .history
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Saved Activity busy; retry")?;
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        session.history.read(&session, read),
    )
    .await
    .map_err(|_| "Saved Activity read timed out")?
}
#[tauri::command]
pub(crate) async fn account_history_delete<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
) -> Result<()> {
    let session = host.session(webview.label(), &lease).map_err(|_| ERROR)?;
    let _permit = session
        .history
        .admission
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Saved Activity busy; retry")?;
    tauri::async_runtime::spawn_blocking(move || session.history.delete(&session))
        .await
        .map_err(|_| ERROR)?
}
#[cfg(test)]
mod tests;
