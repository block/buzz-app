//! Loopback MCP servers a plugin serves to the agents it runs, over MCP's
//! Streamable HTTP transport. The listener and its token live here; each
//! JSON-RPC message is handed to the page that started the server, which
//! answers it. So a tool that signs with an agent's key runs in the app, and
//! the agent is given only the server's address and token.
//!
//! - It binds only `127.0.0.1`, on a port the OS picks. A random 256-bit token
//!   per server authorizes every request as `Authorization: Bearer <token>`.
//!   `Host` must name the bound address, and a request that sends `Origin`
//!   (a web page) is refused. Nothing is logged.
//! - A refused request gets 404, never 401 or 403: MCP clients answer those
//!   by starting an OAuth sign-in.
//! - It is stateless and answers in JSON, never SSE. `POST /mcp` carries one
//!   message: a request is answered with the page's reply, and a notification
//!   or response with 202. `GET` and `DELETE` get 405, since there is no
//!   server stream or session to end.
//! - Each connection answers one request and closes. A client that closes
//!   before its answer drops the request; the page's late reply is refused.
//! - A server belongs to the plugin and the page that started it. It stops
//!   when the plugin closes it, when the page reloads, or when the app exits.
use crate::{with_manager, PluginManager};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpListener, TcpStream};
use tokio::sync::{oneshot, Semaphore};
use tokio_util::sync::CancellationToken;

/// Servers running at once across all plugins.
const MAX_SERVERS: usize = 64;
/// Open connections per server: an agent may call several tools at once.
const CONNECTIONS: usize = 32;
const HEAD_LIMIT: usize = 8192;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_LIMIT: usize = 4 * 1024 * 1024;
const BODY_TIMEOUT: Duration = Duration::from_secs(30);
const REPLY_LIMIT: usize = 16 * 1024 * 1024;
const ENDPOINT: &str = "/mcp";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum McpEvent {
    /// One JSON-RPC message, answered with `plugin_host_mcp_reply` naming
    /// `request`.
    Message { request: u64, body: String },
    /// The last event: the server stopped.
    Closed,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerInfo {
    handle: u64,
    /// `http://127.0.0.1:<port>/mcp`
    url: String,
    /// Sent by the agent as `Authorization: Bearer <token>`.
    token: String,
}

struct Shared {
    authority: String,
    token: String,
    events: Channel<McpEvent>,
    stop: CancellationToken,
    pending: Mutex<Pending>,
}
#[derive(Default)]
struct Pending {
    next: u64,
    replies: HashMap<u64, oneshot::Sender<Option<String>>>,
}
impl Shared {
    fn pending(&self) -> MutexGuard<'_, Pending> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

struct Entry {
    plugin: String,
    shared: Arc<Shared>,
}

#[derive(Clone, Default)]
pub(crate) struct HostMcpServers {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    /// Counts page loads, so a server the page asked for before it reloaded
    /// is refused rather than left running with nobody answering.
    page: u64,
    entries: HashMap<u64, Entry>,
}
impl HostMcpServers {
    fn registry(&self) -> MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }
    fn owned(&self, plugin: &str, handle: u64) -> Result<Arc<Shared>, String> {
        match self.registry().entries.get(&handle) {
            Some(entry) if entry.plugin == plugin => Ok(entry.shared.clone()),
            _ => Err("No such MCP server".into()),
        }
    }
    /// The current page load, for `serve`.
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }
    /// Starts a server owned by `plugin` whose messages go to `events`, unless
    /// the page that asked during `page` has since gone.
    fn serve(
        &self,
        page: u64,
        plugin: String,
        events: Channel<McpEvent>,
    ) -> Result<McpServerInfo, String> {
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        if registry.entries.len() >= MAX_SERVERS {
            return Err("Too many MCP servers are running".into());
        }
        let failed = |_| "Could not start the MCP server".to_owned();
        // Bound synchronously, so the address is known before any agent connects.
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(failed)?;
        listener.set_nonblocking(true).map_err(failed)?;
        let authority = listener.local_addr().map_err(failed)?.to_string();
        let mut secret = [0; 32];
        getrandom::fill(&mut secret).map_err(|_| "Could not start the MCP server")?;
        let token = URL_SAFE_NO_PAD.encode(secret);
        let shared = Arc::new(Shared {
            authority: authority.clone(),
            token: token.clone(),
            events,
            stop: CancellationToken::new(),
            pending: Mutex::default(),
        });
        let handle = registry.next;
        registry.next += 1;
        registry.entries.insert(
            handle,
            Entry {
                plugin,
                shared: shared.clone(),
            },
        );
        drop(registry);
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            accept(listener, shared.clone()).await;
            state.registry().entries.remove(&handle);
            // Requests still waiting are answered 503 as their senders drop.
            shared.pending().replies.clear();
            let _ = shared.events.send(McpEvent::Closed);
        });
        Ok(McpServerInfo {
            handle,
            url: format!("http://{authority}{ENDPOINT}"),
            token,
        })
    }
    /// Answers `request` with `body`, or with 202 when there is none.
    fn reply(
        &self,
        plugin: &str,
        handle: u64,
        request: u64,
        body: Option<String>,
    ) -> Result<(), String> {
        if body.as_ref().is_some_and(|body| body.len() > REPLY_LIMIT) {
            return Err("Reply is too large".into());
        }
        let shared = self.owned(plugin, handle)?;
        let sender = shared.pending().replies.remove(&request);
        sender
            .ok_or("The request is no longer waiting")?
            .send(body)
            .map_err(|_| "The request is no longer waiting".into())
    }
    fn close(&self, plugin: &str, handle: u64) -> Result<(), String> {
        self.owned(plugin, handle)?.stop.cancel();
        Ok(())
    }
    /// Stops every server: the page that answered them is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for entry in registry.entries.values() {
            entry.shared.stop.cancel();
        }
    }
}

async fn accept(listener: std::net::TcpListener, shared: Arc<Shared>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    let connections = Arc::new(Semaphore::new(CONNECTIONS));
    loop {
        let accepted = tokio::select! {
            accepted = async {
                let permit = connections.clone().acquire_owned().await.ok()?;
                Some((permit, listener.accept().await))
            } => accepted,
            () = shared.stop.cancelled() => return,
        };
        let Some((permit, accepted)) = accepted else {
            return;
        };
        let Ok((socket, _)) = accepted else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let shared = shared.clone();
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                () = connection(&shared, socket) => {}
                () = shared.stop.cancelled() => {}
            }
            drop(permit);
        });
    }
}

async fn connection(shared: &Shared, socket: TcpStream) {
    let (mut reader, mut writer) = socket.into_split();
    let Ok(Some((head, start))) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut reader)).await
    else {
        return;
    };
    let length = match parse(shared, &head) {
        Ok(length) => length,
        Err(status) => return write_reply(&mut writer, status, None).await,
    };
    let Ok(Some(body)) =
        tokio::time::timeout(BODY_TIMEOUT, read_body(&mut reader, start, length)).await
    else {
        return write_reply(&mut writer, 400, None).await;
    };
    let Ok(body) = String::from_utf8(body) else {
        return write_reply(&mut writer, 400, None).await;
    };
    // The page's answer is dropped once the client closes.
    let (status, reply) = tokio::select! {
        answer = forward(shared, body) => answer,
        () = closed(&mut reader) => return,
    };
    write_reply(&mut writer, status, reply.as_deref()).await;
}

/// Hands `body` to the page and waits for its answer.
async fn forward(shared: &Shared, body: String) -> (u16, Option<String>) {
    struct Waiting<'a>(&'a Shared, u64);
    impl Drop for Waiting<'_> {
        fn drop(&mut self) {
            self.0.pending().replies.remove(&self.1);
        }
    }
    let (sender, receiver) = oneshot::channel();
    let request = {
        let mut pending = shared.pending();
        let request = pending.next;
        pending.next += 1;
        pending.replies.insert(request, sender);
        request
    };
    let _waiting = Waiting(shared, request);
    if shared
        .events
        .send(McpEvent::Message { request, body })
        .is_err()
    {
        // Nobody is listening: the page that started it is gone.
        shared.stop.cancel();
        return (503, None);
    }
    match receiver.await {
        Ok(Some(reply)) => (200, Some(reply)),
        Ok(None) => (202, None),
        Err(_) => (503, None),
    }
}

/// The request head, without its blank line, and any body bytes read with it.
async fn read_head(reader: &mut OwnedReadHalf) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut head = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        if let Some(end) = head.windows(4).position(|part| part == b"\r\n\r\n") {
            if end + 4 > HEAD_LIMIT {
                return None;
            }
            let start = head.split_off(end + 4);
            head.truncate(end);
            return Some((head, start));
        }
        if head.len() >= HEAD_LIMIT {
            return None;
        }
        let count = reader.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        head.extend_from_slice(&chunk[..count]);
    }
}

async fn read_body(
    reader: &mut OwnedReadHalf,
    mut body: Vec<u8>,
    length: usize,
) -> Option<Vec<u8>> {
    if body.len() > length {
        return None;
    }
    body.reserve_exact(length - body.len());
    let mut chunk = [0; 16 * 1024];
    while body.len() < length {
        let want = (length - body.len()).min(chunk.len());
        let count = reader.read(&mut chunk[..want]).await.ok()?;
        if count == 0 {
            return None;
        }
        body.extend_from_slice(&chunk[..count]);
    }
    Some(body)
}

/// Resolves when the client closes its connection; it sends nothing else.
async fn closed(reader: &mut OwnedReadHalf) {
    let mut chunk = [0; 1024];
    let mut extra = 0;
    while extra <= HEAD_LIMIT {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(count) => extra += count,
        }
    }
}

/// The body length of an authorized `POST /mcp`, or the status that refuses it.
fn parse(shared: &Shared, head: &[u8]) -> Result<usize, u16> {
    let text = std::str::from_utf8(head).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some("HTTP/1.1"), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return Err(400);
    };
    let (mut host, mut authorization, mut length, mut json) = (None, None, None, false);
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || name.ends_with([' ', '\t']) || line.starts_with([' ', '\t']) {
            return Err(400);
        }
        let value = value.trim_matches([' ', '\t']);
        match name.to_ascii_lowercase().as_str() {
            "host" if host.replace(value).is_some() => return Err(400),
            "authorization" if authorization.replace(value).is_some() => return Err(400),
            // An agent never sends one; a web page always does.
            "origin" => return Err(404),
            "content-length" => {
                let parsed = value.parse::<usize>().map_err(|_| 400u16)?;
                if length.replace(parsed).is_some_and(|known| known != parsed) {
                    return Err(400);
                }
            }
            "transfer-encoding" => return Err(411),
            "content-type" => {
                json = value
                    .split(';')
                    .next()
                    .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("application/json"))
            }
            _ => {}
        }
    }
    if host != Some(shared.authority.as_str()) {
        return Err(404);
    }
    let path = target.split('?').next().unwrap_or_default();
    let token = authorization
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if path != ENDPOINT || !same(token.as_bytes(), shared.token.as_bytes()) {
        return Err(404);
    }
    // No server stream for `GET` and no session for `DELETE` to end.
    if method != "POST" {
        return Err(405);
    }
    if !json {
        return Err(415);
    }
    match length {
        None => Err(411),
        Some(length) if length > BODY_LIMIT => Err(413),
        Some(length) => Ok(length),
    }
}

/// Compares the token without exposing how much of it matched.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

async fn write_reply(writer: &mut OwnedWriteHalf, status: u16, body: Option<&str>) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        413 => "Content Too Large",
        415 => "Unsupported Media Type",
        _ => "Service Unavailable",
    };
    let body = body.unwrap_or_default();
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n",
        body.len()
    );
    if status == 200 {
        head.push_str("Content-Type: application/json\r\n");
    }
    if status == 405 {
        head.push_str("Allow: POST\r\n");
    }
    head.push_str("\r\n");
    let _ = writer.write_all(head.as_bytes()).await;
    let _ = writer.write_all(body.as_bytes()).await;
    let _ = writer.shutdown().await;
}

/// Starts a loopback MCP server for a plugin that declares `host.mcp`. Each
/// message arrives on `on_event` and is answered with `plugin_host_mcp_reply`.
#[tauri::command]
pub(crate) async fn plugin_host_mcp_serve(
    manager: tauri::State<'_, PluginManager>,
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    revision: String,
    on_event: Channel<McpEvent>,
) -> Result<McpServerInfo, String> {
    let page = servers.page();
    let plugin = id.clone();
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.mcp)
    })
    .await?;
    if !granted {
        return Err("MCP servers are not declared".into());
    }
    servers.serve(page, plugin, on_event)
}

/// Answers a message with the JSON-RPC `body`; without one, with 202.
#[tauri::command]
pub(crate) fn plugin_host_mcp_reply(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
    request: u64,
    body: Option<String>,
) -> Result<(), String> {
    servers.reply(&id, handle, request, body)
}

/// Stops the server. Its `closed` event follows.
#[tauri::command]
pub(crate) fn plugin_host_mcp_close(
    servers: tauri::State<'_, HostMcpServers>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    servers.close(&id, handle)
}

#[cfg(test)]
mod tests;
