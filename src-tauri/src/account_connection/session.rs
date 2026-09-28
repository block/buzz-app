//! A single explicit native account/origin lease. No background credential restore.
use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::Timestamp;
#[cfg(test)]
use nostr::{Event, Keys, Kind};
use serde::Serialize;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(crate) struct Session {
    #[cfg_attr(not(test), allow(dead_code))]
    pub id: String,
    pub origin: String,
    pub(super) viewer: String,
    pub(super) identity: IdentityHost,
    pub(super) revoked: watch::Sender<bool>,
    pub(super) socket: Mutex<Option<super::socket::SocketControl>>,
    operations: Mutex<BTreeMap<String, Operation>>,
    dispatch: Mutex<()>,
    pub(super) history: super::history::History,
}
struct Operation {
    running: bool,
    created: Instant,
    cancelled: watch::Sender<bool>,
}
pub(super) enum Request {
    Query(Value),
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpResult {
    pub(super) status: u16,
    pub(super) body: String,
}
#[derive(Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "lowercase")]
pub(crate) enum Output {
    Response(HttpResult),
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    message: &'static str,
    sent: bool,
}
impl Failure {
    fn unsent(message: &'static str) -> Self {
        Self {
            message,
            sent: false,
        }
    }
    fn unknown() -> Self {
        Self {
            message: "Relay result unavailable; delivery may be unconfirmed",
            sent: true,
        }
    }
}
const INVALID: &str = "This operation is unavailable on the native connection";
const CLOSED: &str = "Native account connection closed; connect explicitly to retry";
impl Session {
    pub(super) fn with_identity(
        id: String,
        origin: String,
        viewer: String,
        identity: IdentityHost,
        authority: String,
        archive: Option<Arc<super::archive::Archive>>,
    ) -> Self {
        Self {
            id,
            origin,
            viewer,
            identity,
            revoked: watch::channel(false).0,
            socket: Mutex::new(None),
            operations: Mutex::new(BTreeMap::new()),
            dispatch: Mutex::new(()),
            history: super::history::History::new(authority, archive),
        }
    }
    #[cfg(test)]
    pub fn new(origin: String, keys: Keys) -> Self {
        Self::with_history(origin, keys, String::new(), None)
    }
    #[cfg(test)]
    pub(super) fn with_history(
        origin: String,
        keys: Keys,
        authority: String,
        archive: Option<Arc<super::archive::Archive>>,
    ) -> Self {
        Self::with_identity(
            uuid::Uuid::new_v4().to_string(),
            origin,
            keys.public_key().to_hex(),
            IdentityHost::fixture_key(keys),
            authority,
            archive,
        )
    }
    pub(crate) fn accept_rosters(&self, values: &[Value]) {
        if self.current().is_ok() {
            self.history
                .accept_rosters(values, &self.viewer, &self.origin);
        }
    }
    pub fn close(&self) {
        let Ok(_dispatch) = self.dispatch.lock() else {
            self.revoked.send_replace(true);
            return;
        };
        self.revoked.send_replace(true);
        self.close_socket(None);
        if let Ok(mut ops) = self.operations.lock() {
            for (_, op) in std::mem::take(&mut *ops) {
                op.cancelled.send_replace(true);
            }
        }
    }
    pub(crate) fn current(&self) -> std::result::Result<(), Failure> {
        if *self.revoked.borrow() {
            Err(Failure::unsent(CLOSED))
        } else {
            Ok(())
        }
    }
    pub(super) fn begin(&self) -> std::result::Result<String, Failure> {
        self.current()?;
        let mut ops = self
            .operations
            .lock()
            .map_err(|_| Failure::unsent(CLOSED))?;
        ops.retain(|_, op| op.running || op.created.elapsed() < Duration::from_secs(15));
        if ops.len() >= 6 {
            return Err(Failure::unsent("Native relay request capacity reached"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        ops.insert(
            id.clone(),
            Operation {
                running: false,
                created: Instant::now(),
                cancelled: watch::channel(false).0,
            },
        );
        Ok(id)
    }
    #[cfg(test)]
    fn cancel(&self, id: &str) {
        let Ok(_dispatch) = self.dispatch.lock() else {
            return;
        };
        if let Ok(mut ops) = self.operations.lock() {
            if let Some(op) = ops.get(id) {
                op.cancelled.send_replace(true);
                if !op.running {
                    ops.remove(id);
                }
            }
        }
    }
    pub(super) async fn run(
        &self,
        id: String,
        request: Request,
    ) -> std::result::Result<Output, Failure> {
        self.current()?;
        let mut cancel = {
            let mut ops = self
                .operations
                .lock()
                .map_err(|_| Failure::unsent(CLOSED))?;
            let op = ops
                .get_mut(&id)
                .filter(|op| {
                    !op.running
                        && op.created.elapsed() < Duration::from_secs(15)
                        && !*op.cancelled.borrow()
                })
                .ok_or(Failure::unsent(INVALID))?;
            op.running = true;
            op.cancelled.subscribe()
        };
        struct Remove<'a>(&'a Session, String);
        impl Drop for Remove<'_> {
            fn drop(&mut self) {
                if let Ok(mut ops) = self.0.operations.lock() {
                    ops.remove(&self.1);
                }
            }
        }
        let _remove = Remove(self, id);
        let mut revoked = self.revoked.subscribe();
        self.current()?;
        if *cancel.borrow() {
            return Err(Failure::unsent("Native request cancelled"));
        }
        let dispatched = std::sync::atomic::AtomicBool::new(false);
        let cancellation = cancel.clone();
        let result = tokio::select! {
            biased;
            _=revoked.changed()=>Err(Failure{message:CLOSED,sent:dispatched.load(std::sync::atomic::Ordering::SeqCst)}),
            _=cancel.changed()=>Err(Failure{message:"Native request cancelled",sent:dispatched.load(std::sync::atomic::Ordering::SeqCst)}),
            value=tokio::time::timeout(Duration::from_secs(10),self.execute(request,&dispatched,&cancellation))=>value.unwrap_or_else(|_|Err(Failure{message:"Native relay request timed out",sent:dispatched.load(std::sync::atomic::Ordering::SeqCst)})),
        };
        self.current().map_err(|_| Failure {
            message: CLOSED,
            sent: dispatched.load(std::sync::atomic::Ordering::SeqCst),
        })?;
        if *cancel.borrow() {
            return Err(Failure {
                message: "Native request cancelled",
                sent: dispatched.load(std::sync::atomic::Ordering::SeqCst),
            });
        }
        result
    }
    // Linearization point shared with close/cancel. Once admitted, the network
    // may observe the request even if revocation arrives before its first poll.
    fn admit_dispatch(
        &self,
        cancel: &watch::Receiver<bool>,
        dispatched: &std::sync::atomic::AtomicBool,
    ) -> std::result::Result<(), Failure> {
        let _guard = self.dispatch.lock().map_err(|_| Failure::unsent(CLOSED))?;
        self.current()?;
        if *cancel.borrow() {
            return Err(Failure::unsent("Native request cancelled"));
        }
        dispatched.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
    async fn execute(
        &self,
        request: Request,
        dispatched: &std::sync::atomic::AtomicBool,
        cancel: &watch::Receiver<bool>,
    ) -> std::result::Result<Output, Failure> {
        let current = || {
            self.current()?;
            if *cancel.borrow() {
                return Err(Failure::unsent("Native request cancelled"));
            }
            Ok(())
        };
        current()?;
        let (route, body, max) = match request {
            Request::Query(filters) => {
                validate_filters(&filters)?;
                ("query", filters, 16 * 1024 * 1024)
            }
        };
        let body = serde_json::to_vec(&body).map_err(|_| Failure::unsent(INVALID))?;
        let url = format!("{}/{route}", self.origin);
        current()?;
        let auth = self
            .identity
            .sign_activity(
                &self.viewer,
                EventTemplate {
                    kind: 27235,
                    created_at: Timestamp::now().as_secs(),
                    content: String::new(),
                    tags: vec![
                        vec!["u".into(), url.clone()],
                        vec!["method".into(), "POST".into()],
                        vec!["payload".into(), format!("{:x}", Sha256::digest(&body))],
                        vec!["nonce".into(), uuid::Uuid::new_v4().to_string()],
                    ],
                },
            )
            .map_err(|_| Failure::unsent("Could not authorize history read"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| Failure::unsent("Native relay transport unavailable"))?;
        self.admit_dispatch(cancel, dispatched)?;
        let response = client
            .post(url)
            .header(
                "Authorization",
                format!(
                    "Nostr {}",
                    STANDARD
                        .encode(serde_json::to_vec(&auth).map_err(|_| Failure::unsent(INVALID))?)
                ),
            )
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| Failure::unknown())?;
        let result = read_response(response, max).await?;
        if route == "query" && result.status == 200 {
            if let Ok(events) = serde_json::from_str::<Vec<Value>>(&result.body) {
                self.history
                    .accept_rosters(&events, &self.viewer, &self.origin);
            }
        }
        self.current().map_err(|_| Failure::unknown())?;
        Ok(Output::Response(result))
    }
}
fn canonical_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn validate_filters(input: &Value) -> std::result::Result<(), Failure> {
    let bad = || Failure::unsent(INVALID);
    let filters = input
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 4)
        .ok_or_else(bad)?;
    if serde_json::to_vec(input).map_or(true, |v| v.len() > 65536) {
        return Err(bad());
    }
    for filter in filters {
        let map = filter.as_object().ok_or_else(bad)?;
        if !map
            .get("limit")
            .and_then(Value::as_u64)
            .is_some_and(|v| (1..=500).contains(&v))
        {
            return Err(bad());
        }
        if !map.contains_key("kinds") && !map.contains_key("ids") {
            return Err(bad());
        }
        for (key, value) in map {
            let valid = match key.as_str() {
                "kinds" => value.as_array().is_some_and(|v| {
                    !v.is_empty()
                        && v.len() <= 32
                        && v.iter().all(|n| {
                            n.as_u64().is_some_and(|n| {
                                matches!(
                                    n,
                                    0 | 5
                                        | 7
                                        | 9
                                        | 10002
                                        | 10100
                                        | 13535
                                        | 20001
                                        | 30030
                                        | 30078
                                        | 30177
                                        | 30315
                                        | 39000
                                        | 39001
                                        | 39002
                                        | 39003
                                        | 39004
                                        | 39005
                                        | 39006
                                        | 40002
                                        | 40003
                                        | 40008
                                        | 40099
                                        | 40100
                                        | 44100
                                        | 44101
                                        | 45001
                                        | 45003
                                        | 9005
                                )
                            })
                        })
                }),
                "authors" | "ids" => value.as_array().is_some_and(|v| {
                    !v.is_empty()
                        && v.len() <= 500
                        && v.iter().all(|k| k.as_str().is_some_and(canonical_key))
                }),
                "#h" | "#d" | "#e" | "#p" | "#a" | "#t" | "feed_types" => {
                    value.as_array().is_some_and(|v| {
                        v.len() <= 500
                            && v.iter().all(|k| {
                                k.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 2048)
                            })
                    })
                }
                "limit" | "since" | "until" | "thread_cursor" | "page" => {
                    value.as_u64().is_some_and(|n| n <= 9_007_199_254_740_991)
                }
                "depth_limit" => value.as_u64().is_some_and(|n| (1..=64).contains(&n)),
                "before_id" | "thread_cursor_id" => value.as_str().is_some_and(canonical_key),
                "top_level" | "include_aux" | "include_summaries" => value.is_boolean(),
                "search" => value.as_str().is_some_and(|s| s.len() <= 1024),
                "search_mode" => {
                    value.as_str() == Some("prefix") || value.as_str() == Some("fulltext")
                }
                _ => false,
            };
            if !valid {
                return Err(bad());
            }
        }
    }
    Ok(())
}
async fn read_response(
    mut response: reqwest::Response,
    max: usize,
) -> std::result::Result<HttpResult, Failure> {
    if response.content_length().is_some_and(|n| n > max as u64) {
        return Err(Failure::unknown());
    }
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::unknown())? {
        if bytes.len() + chunk.len() > max {
            return Err(Failure::unknown());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(HttpResult {
        status,
        body: String::from_utf8(bytes).map_err(|_| Failure::unknown())?,
    })
}
#[cfg(test)]
mod tests;
