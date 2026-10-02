//! Bounded host-owned archive. Only encrypted signed envelopes reach SQLite.
mod store;
use crate::{
    identity::IdentityHost,
    relay::agent::{decode_archive, AgentEvent},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Manager;

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Default)]
pub(crate) struct ArchiveHost(Arc<Mutex<Option<store::Store>>>);
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub(crate) enum Request {
    Settings,
    Configure {
        observer: bool,
        metrics: bool,
        #[serde(rename = "observerDays")]
        observer_days: u32,
        revision: i64,
    },
    Read {
        kind: u16,
        agent: Option<String>,
        before: Option<i64>,
    },
    Clear {
        kind: Option<u16>,
    },
    Ingest {
        event: AgentEvent,
        revision: i64,
    },
}
#[tauri::command]
pub(crate) async fn relay_archive<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    identity: tauri::State<'_, IdentityHost>,
    archive: tauri::State<'_, ArchiveHost>,
    community: String,
    viewer: String,
    request: Request,
) -> Result<Value> {
    let community = crate::relay::origin(&community)?
        .origin()
        .ascii_serialization();
    // Initialization failure stays retryable and cannot disable unrelated app startup.
    let path = app
        .path()
        .app_data_dir()
        .map_err(|_| "Archive location unavailable")?
        .join(if cfg!(debug_assertions) {
            "archive-debug"
        } else {
            "archive"
        })
        .join("events.sqlite3");
    execute(
        identity.inner(),
        archive.inner().clone(),
        path,
        community,
        viewer,
        request,
    )
    .await
}
async fn execute(
    identity: &IdentityHost,
    archive: ArchiveHost,
    path: std::path::PathBuf,
    community: String,
    viewer: String,
    request: Request,
) -> Result<Value> {
    identity.with_key(move |secret, current| {
        if current != viewer { return Err("Archive viewer changed".into()); }
        let mut guard = archive.0.lock().map_err(|_| "Archive unavailable")?;
        if guard.is_none() { *guard = Some(store::Store::open(path)?); }
        let store = guard.as_mut().ok_or("Archive unavailable")?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "Invalid clock")?.as_secs() as i64;
        store.seed(current, &community)?;
        store.prune(now)?;
        match request {
            Request::Settings => store.settings(current, &community),
            Request::Configure {observer, metrics, observer_days, revision} => store.configure(current, &community, observer, metrics, observer_days, revision, now),
            Request::Clear {kind} => { store.clear(current, &community, kind)?; Ok(json!({"cleared":true})) },
            Request::Ingest {event, revision} => {
                // Re-validate fresh envelopes in the key owner; never persist unverified IPC input.
                decode_archive(secret, current, &event, false)?;
                store.ingest(current, &community, &event, revision, now)?;
                Ok(json!({"saved":true}))
            },
            Request::Read {kind, agent, before} => {
                let (rows, revision) = store.read(current, &community, kind, agent.as_deref(), before)?;
                let cursor = if rows.len() == 100 { rows.last().map(|row| row.0) } else { None };
                let mut records = Vec::new();
                let mut skipped = 0;
                for (_, received, raw) in rows {
                    let decoded = serde_json::from_str(&raw)
                        .map_err(|_| "Invalid saved archive record".into())
                        .and_then(|event| decode_archive(secret, current, &event, true));
                    match decoded {
                        Ok(mut frame) => {
                            frame["receivedAt"] = json!(received * 1000);
                            records.push(frame);
                        }
                        Err(_) => skipped += 1,
                    }
                }
                Ok(json!({"records":records,"skipped":skipped,"agents":store.agents(current,&community,kind)?,"before":cursor,"revision":revision}))
            }
        }
    }).await
}

#[cfg(test)]
pub(crate) mod tests;
