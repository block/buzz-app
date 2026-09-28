//! Per-community Activity leases subordinate to the app's single IdentityHost.
//! No credential lookup, import, export, account selection or fallback lives here.
pub(crate) mod archive;
pub(crate) mod history;
pub(crate) mod session;
pub(crate) mod socket;
use crate::identity::IdentityHost;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
type Result<T> = std::result::Result<T, String>;
const CLOSED: &str = "Activity connection closed; reconnect the community";
#[derive(Default)]
struct State {
    sessions: BTreeMap<String, Option<Arc<session::Session>>>,
    closed: bool,
    origins: BTreeMap<String, String>,
}
#[derive(Clone, Default)]
pub(crate) struct AccountConnection {
    state: Arc<Mutex<State>>,
    archive: Option<Arc<archive::Archive>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lease {
    lease: String,
    viewer: String,
    origin: String,
    relay_author: String,
}
impl AccountConnection {
    pub(crate) fn with_archive(root: std::path::PathBuf) -> Self {
        let archive = Arc::new(archive::Archive::new(root));
        let maintenance = archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _ = maintenance.maintain();
        });
        Self {
            archive: Some(archive),
            ..Self::default()
        }
    }
    async fn open(
        &self,
        caller: &str,
        identity: IdentityHost,
        origin: String,
        viewer: String,
    ) -> Result<Lease> {
        self.open_with(caller, identity, origin, viewer, |origin| async move {
            discover(&origin).await
        })
        .await
    }
    async fn open_with<F: std::future::Future<Output = Result<String>>>(
        &self,
        caller: &str,
        identity: IdentityHost,
        origin: String,
        viewer: String,
        discovery: impl FnOnce(String) -> F,
    ) -> Result<Lease> {
        caller_allowed(caller)?;
        let origin = relay_origin(&origin)?;
        if identity.ready_viewer()? != viewer {
            return Err("Activity identity changed".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        {
            let mut state = self.state.lock().map_err(|_| CLOSED)?;
            if state.closed || state.origins.contains_key(&origin) || state.sessions.len() >= 32 {
                return Err("Activity connection capacity reached".into());
            }
            state.origins.insert(origin.clone(), id.clone());
            state.sessions.insert(id.clone(), None);
        }
        // Cancellation of the IPC future must also release its pending reservation.
        struct Reservation {
            host: AccountConnection,
            id: String,
        }
        impl Drop for Reservation {
            fn drop(&mut self) {
                let _ = self.host.close_pending(&self.id);
            }
        }
        let _reservation = Reservation {
            host: self.clone(),
            id: id.clone(),
        };
        let authority = discovery(origin.clone()).await;
        let mut state = self.state.lock().map_err(|_| CLOSED)?;
        if state.closed || !state.sessions.contains_key(&id) {
            return Err(CLOSED.into());
        }
        let authority = match authority {
            Ok(v) => v,
            Err(e) => {
                state.sessions.remove(&id);
                state.origins.remove(&origin);
                return Err(e);
            }
        };
        if identity.ready_viewer()? != viewer {
            state.sessions.remove(&id);
            state.origins.remove(&origin);
            return Err(CLOSED.into());
        }
        let session = Arc::new(session::Session::with_identity(
            id.clone(),
            origin.clone(),
            viewer.clone(),
            identity,
            authority.clone(),
            self.archive.clone(),
        ));
        state.sessions.insert(id.clone(), Some(session));
        Ok(Lease {
            lease: id,
            origin,
            viewer,
            relay_author: authority,
        })
    }
    pub(super) fn session(&self, caller: &str, id: &str) -> Result<Arc<session::Session>> {
        caller_allowed(caller)?;
        let state = self.state.lock().map_err(|_| CLOSED)?;
        let session = state
            .sessions
            .get(id)
            .and_then(Option::as_ref)
            .ok_or(CLOSED)?;
        session.current().map_err(|_| CLOSED)?;
        Ok(session.clone())
    }
    fn close_pending(&self, id: &str) -> Result<()> {
        let mut state = self.state.lock().map_err(|_| CLOSED)?;
        if state.sessions.get(id).is_some_and(Option::is_none) {
            state.sessions.remove(id);
            state.origins.retain(|_, owner| owner != id);
        }
        Ok(())
    }
    fn close_session(&self, caller: &str, id: &str) -> Result<()> {
        caller_allowed(caller)?;
        let mut state = self.state.lock().map_err(|_| CLOSED)?;
        state.origins.retain(|_, owner| owner != id);
        if let Some(Some(session)) = state.sessions.remove(id) {
            session.close();
        }
        Ok(())
    }
    // Capture leases BEFORE an HTTP query. A late response cannot seed a replacement.
    pub(crate) fn matching(&self, origin: &str) -> Vec<Arc<session::Session>> {
        self.state
            .lock()
            .map(|state| {
                state
                    .sessions
                    .values()
                    .filter_map(Option::as_ref)
                    .filter(|s| s.origin == origin && s.current().is_ok())
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(crate) fn revoke(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.origins.clear();
            for (_, session) in std::mem::take(&mut state.sessions) {
                if let Some(session) = session {
                    session.close();
                }
            }
        }
    }
    pub(crate) fn shutdown(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
        }
        self.revoke();
    }
}
fn caller_allowed(caller: &str) -> Result<()> {
    if caller == "main" {
        Ok(())
    } else {
        Err("Activity is unavailable in this view".into())
    }
}
fn relay_origin(origin: &str) -> Result<String> {
    let url = url::Url::parse(origin).map_err(|_| "Invalid community")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || origin.len() > 2048
    {
        return Err("Invalid community".into());
    }
    Ok(url.origin().ascii_serialization())
}
async fn discover(origin: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| CLOSED)?;
    let mut response = client
        .get(origin)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| CLOSED)?;
    if !response.status().is_success() {
        return Err("Activity relay discovery failed".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| CLOSED)? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("Activity relay discovery too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| CLOSED)?;
    let author = value["self"]
        .as_str()
        .filter(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        })
        .ok_or("Relay did not advertise its identity")?;
    Ok(author.into())
}
#[tauri::command]
pub(crate) async fn account_activity_open<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    identity: tauri::State<'_, IdentityHost>,
    community: String,
    viewer: String,
) -> Result<Lease> {
    host.open(webview.label(), identity.inner().clone(), community, viewer)
        .await
}
#[tauri::command]
pub(crate) fn account_connection_close<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
) -> Result<()> {
    host.close_session(webview.label(), &lease)
}
#[cfg(test)]
mod tests;
