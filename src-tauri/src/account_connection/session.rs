//! A single explicit native account/origin lease. No background credential restore.
use super::{caller_allowed, AccountConnection, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, Tag, Timestamp};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) struct Session {
    pub id: String,
    pub origin: String,
    pub(super) keys: Keys,
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
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "lowercase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Query(Value),
    Sign(Template),
    Publish(Value),
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Template {
    kind: u64,
    created_at: u64,
    content: String,
    tags: Vec<Vec<String>>,
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
    Signed(Value),
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
    pub fn new(origin: String, keys: Keys) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            origin,
            keys,
            revoked: watch::channel(false).0,
            socket: Mutex::new(None),
            operations: Mutex::new(BTreeMap::new()),
            dispatch: Mutex::new(()),
            history: super::history::History::new(String::new(), None),
        }
    }
    pub fn with_history(
        origin: String,
        keys: Keys,
        authority: String,
        archive: Option<Arc<super::archive::Archive>>,
    ) -> Self {
        let mut session = Self::new(origin, keys);
        session.history = super::history::History::new(authority, archive);
        session
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
    pub(super) fn current(&self) -> std::result::Result<(), Failure> {
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
            Request::Sign(template) => {
                validate_message(&template)?;
                if template.created_at.abs_diff(Timestamp::now().as_secs()) > 300 {
                    return Err(Failure::unsent(INVALID));
                }
                current()?;
                let tags = template
                    .tags
                    .into_iter()
                    .map(Tag::parse)
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|_| Failure::unsent(INVALID))?;
                let event = EventBuilder::new(Kind::from(9), template.content)
                    .tags(tags)
                    .custom_created_at(Timestamp::from(template.created_at))
                    .sign_with_keys(&self.keys)
                    .map_err(|_| Failure::unsent("Could not sign message"))?;
                current()?;
                return Ok(Output::Signed(
                    serde_json::to_value(event).map_err(|_| Failure::unsent(INVALID))?,
                ));
            }
            Request::Query(filters) => {
                validate_filters(&filters)?;
                ("query", filters, 16 * 1024 * 1024)
            }
            Request::Publish(raw) => {
                let event = verify_message(raw, &self.keys)?;
                (
                    "events",
                    serde_json::to_value(event).map_err(|_| Failure::unsent(INVALID))?,
                    4096,
                )
            }
        };
        let body = serde_json::to_vec(&body).map_err(|_| Failure::unsent(INVALID))?;
        let url = format!("{}/{route}", self.origin);
        current()?;
        let auth = EventBuilder::new(Kind::from(27235), "")
            .tags(
                [
                    Tag::parse(["u", &url]),
                    Tag::parse(["method", "POST"]),
                    Tag::parse(["payload", &format!("{:x}", Sha256::digest(&body))]),
                    Tag::parse(["nonce", &uuid::Uuid::new_v4().to_string()]),
                ]
                .into_iter()
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|_| Failure::unsent(INVALID))?,
            )
            .sign_with_keys(&self.keys)
            .map_err(|_| Failure::unsent("Could not authorize relay request"))?;
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
                format!("Nostr {}", STANDARD.encode(auth.as_json())),
            )
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|_| Failure::unknown())?;
        let result = read_response(response, max).await?;
        if route == "query" && result.status == 200 {
            if let Ok(events) = serde_json::from_str::<Vec<Value>>(&result.body) {
                self.history.accept_rosters(
                    &events,
                    &self.keys.public_key().to_hex(),
                    &self.origin,
                );
            }
        }
        self.current().map_err(|_| Failure::unknown())?;
        Ok(Output::Response(result))
    }
}
fn verify_message(raw: Value, keys: &Keys) -> std::result::Result<Event, Failure> {
    if raw.get("kind").and_then(Value::as_u64) != Some(9)
        || serde_json::to_vec(&raw).map_or(true, |v| v.len() > 65536)
    {
        return Err(Failure::unsent(INVALID));
    }
    let template:Template=serde_json::from_value(json!({"kind":raw["kind"],"created_at":raw["created_at"],"content":raw["content"],"tags":raw["tags"]})).map_err(|_|Failure::unsent(INVALID))?;
    validate_message(&template)?;
    let event: Event = serde_json::from_value(raw).map_err(|_| Failure::unsent(INVALID))?;
    event
        .verify()
        .map_err(|_| Failure::unsent("Invalid signed message"))?;
    if event.pubkey != keys.public_key() {
        return Err(Failure::unsent("Signed message belongs to another account"));
    }
    Ok(event)
}
fn canonical_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn channel(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
fn validate_message(t: &Template) -> std::result::Result<(), Failure> {
    let bad = || Failure::unsent(INVALID);
    if t.kind != 9
        || t.created_at > 9_007_199_254_740_991
        || t.content.trim().is_empty()
        || t.content.len() > 32000
        || t.tags.len() > 128
    {
        return Err(bad());
    }
    let mut channels = 0;
    let mut mentions = 0;
    let mut references = 0;
    let mut replies = Vec::new();
    for tag in &t.tags {
        if tag.iter().any(|v| v.len() > 4096) || tag.len() > 12 {
            return Err(bad());
        }
        match tag.first().map(String::as_str) {
            Some("h") if tag.len() == 2 && channel(&tag[1]) => channels += 1,
            Some("p") if tag.len() == 2 && canonical_key(&tag[1]) => mentions += 1,
            Some("mention") if tag.len() == 2 && canonical_key(&tag[1]) => references += 1,
            Some("e")
                if tag.len() == 4
                    && canonical_key(&tag[1])
                    && tag[2].is_empty()
                    && matches!(tag[3].as_str(), "root" | "reply") =>
            {
                replies.push(tag)
            }
            Some("emoji") if tag.len() == 3 => {}
            Some("imeta") if tag.len() >= 2 => {}
            _ => return Err(bad()),
        }
    }
    let valid_replies = match replies.as_slice() {
        [] => true,
        [one] => one[3] == "reply",
        [root, reply] => root[3] == "root" && reply[3] == "reply" && root[1] != reply[1],
        _ => false,
    };
    if channels != 1
        || mentions > 32
        || references > 32
        || !valid_replies
        || serde_json::to_vec(t).map_or(true, |v| v.len() > 65536)
    {
        return Err(bad());
    }
    Ok(())
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
impl AccountConnection {
    pub(super) fn session(
        &self,
        caller: &str,
        lease: &str,
    ) -> std::result::Result<Arc<Session>, Failure> {
        caller_allowed(caller).map_err(|_| Failure::unsent(CLOSED))?;
        let state = self.state.lock().map_err(|_| Failure::unsent(CLOSED))?;
        let session = state
            .session
            .as_ref()
            .filter(|s| s.id == lease)
            .ok_or(Failure::unsent(CLOSED))?;
        session.current()?;
        Ok(session.clone())
    }
    pub(super) fn close_session(&self, caller: &str, lease: &str) -> Result<()> {
        caller_allowed(caller)?;
        let mut state = self.state.lock().map_err(|_| CLOSED)?;
        if state.session.as_ref().is_some_and(|s| s.id == lease) {
            if let Some(session) = state.session.take() {
                session.close();
            }
        }
        Ok(())
    }
}
#[tauri::command]
pub(crate) fn account_relay_begin<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
) -> std::result::Result<String, Failure> {
    host.session(webview.label(), &lease)?.begin()
}
#[tauri::command]
pub(crate) async fn account_relay_run<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    operation: String,
    request: Request,
) -> std::result::Result<Output, Failure> {
    host.session(webview.label(), &lease)?
        .run(operation, request)
        .await
}
#[tauri::command]
pub(crate) fn account_relay_cancel<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    operation: String,
) -> std::result::Result<(), Failure> {
    host.session(webview.label(), &lease)?.cancel(&operation);
    Ok(())
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
