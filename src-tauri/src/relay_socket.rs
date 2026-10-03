//! The live WebSocket for trusted enterprise relays. Rust fetches the relay
//! badge, sends it in the upgrade request and owns the stream, so the badge
//! never reaches JavaScript and every connection is released when it ends.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest, handshake::client::Request, http::HeaderValue, Message,
    },
    WebSocketStream,
};
use url::Url;

use crate::{
    identity::IdentityHost,
    nip_fi_assertion::{RelayAssertions, HEADER},
};

/// How long a closing socket waits for the relay to echo Close before the
/// stream is dropped anyway.
const CLOSE_GRACE: Duration = Duration::from_secs(3);
/// A connection JavaScript never starts (for example, a reloaded webview) is
/// closed after this long.
const START_DEADLINE: Duration = Duration::from_secs(10);

type Result<T> = std::result::Result<T, String>;

/// What JavaScript receives. Exactly one `Close` or `Error` ends a connection,
/// except an explicit close, which reports nothing.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum SocketEvent {
    Text { data: String },
    Close { code: u16 },
    Error,
}

enum Command {
    Start,
    Send(String, oneshot::Sender<bool>),
    Close,
}

/// Open connections. An entry exists exactly while its task owns a stream.
#[derive(Clone, Default)]
pub(crate) struct RelaySockets {
    next: Arc<AtomicU64>,
    open: Arc<Mutex<HashMap<u64, mpsc::UnboundedSender<Command>>>>,
}

impl RelaySockets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, mpsc::UnboundedSender<Command>>> {
        self.open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    async fn open(
        &self,
        request: Request,
        emit: impl Fn(SocketEvent) + Send + 'static,
    ) -> Result<u64> {
        let (stream, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|_| "Relay connection failed")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (commands, received) = mpsc::unbounded_channel();
        self.lock().insert(id, commands);
        let sockets = self.clone();
        tokio::spawn(async move {
            run(stream, received, emit).await;
            sockets.lock().remove(&id);
        });
        Ok(id)
    }

    fn command(&self, id: u64, command: Command) -> Result<()> {
        self.lock()
            .get(&id)
            .and_then(|commands| commands.send(command).ok())
            .ok_or_else(|| "Relay socket is closed".into())
    }
}

/// Owns one stream until it ends; returning drops it. Nothing is read until
/// JavaScript sends `Start`, so no frame (such as the relay's immediate
/// `AUTH`) can arrive before JavaScript is able to answer it.
async fn run<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: WebSocketStream<S>,
    mut commands: mpsc::UnboundedReceiver<Command>,
    emit: impl Fn(SocketEvent),
) {
    if !matches!(
        tokio::time::timeout(START_DEADLINE, commands.recv()).await,
        Ok(Some(Command::Start))
    ) {
        return close(&mut stream).await;
    }
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Send(data, sent)) => {
                    let ok = stream.send(Message::text(data)).await.is_ok();
                    let _ = sent.send(ok);
                    if !ok {
                        return emit(SocketEvent::Error);
                    }
                }
                Some(Command::Start) => {}
                Some(Command::Close) | None => return close(&mut stream).await,
            },
            frame = stream.next() => match frame {
                Some(Ok(Message::Text(data))) => emit(SocketEvent::Text { data: data.to_string() }),
                Some(Ok(Message::Close(frame))) => {
                    emit(SocketEvent::Close { code: frame.map_or(1005, |frame| frame.code.into()) });
                    // Let tungstenite flush its Close reply, briefly.
                    return drain(&mut stream).await;
                }
                // Pings are answered by tungstenite; nothing else carries relay traffic.
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return emit(SocketEvent::Error),
            },
        }
    }
}

/// Sends Close and waits a bounded time for the echo.
async fn close<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut WebSocketStream<S>) {
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        let _ = stream.close(None).await;
        while stream.next().await.is_some() {}
    })
    .await;
}

async fn drain<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut WebSocketStream<S>) {
    let _ = tokio::time::timeout(CLOSE_GRACE, async {
        while stream.next().await.is_some() {}
    })
    .await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenSocket {
    id: u64,
    /// Badge expiry in Unix seconds, so the socket can rotate in time.
    expires_at: u64,
}

/// Connects to a trusted enterprise relay with a fresh badge. `None` means the
/// relay needs no badge and the webview socket should be used.
#[tauri::command]
pub(crate) async fn relay_socket_connect(
    identity: tauri::State<'_, IdentityHost>,
    assertions: tauri::State<'_, RelayAssertions>,
    sockets: tauri::State<'_, RelaySockets>,
    url: String,
    on_event: tauri::ipc::Channel<SocketEvent>,
) -> Result<Option<OpenSocket>> {
    let url = Url::parse(&url).map_err(|_| "Invalid relay URL")?;
    if url.scheme() != "wss" {
        return Ok(None);
    }
    let Some(assertion) = assertions.get(identity.inner(), &url, true).await? else {
        return Ok(None);
    };
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid relay URL")?;
    let mut badge =
        HeaderValue::from_str(&assertion.header).map_err(|_| "Relay badge was invalid")?;
    badge.set_sensitive(true);
    request.headers_mut().insert(HEADER, badge);
    let id = sockets
        .open(request, move |event| {
            let _ = on_event.send(event);
        })
        .await?;
    Ok(Some(OpenSocket {
        id,
        expires_at: assertion.expires_at,
    }))
}

/// Starts delivering frames, once JavaScript can send.
#[tauri::command]
pub(crate) fn relay_socket_start(sockets: tauri::State<'_, RelaySockets>, id: u64) -> Result<()> {
    sockets.command(id, Command::Start)
}

#[tauri::command]
pub(crate) async fn relay_socket_send(
    sockets: tauri::State<'_, RelaySockets>,
    id: u64,
    data: String,
) -> Result<()> {
    let (sent, done) = oneshot::channel();
    sockets.command(id, Command::Send(data, sent))?;
    match done.await {
        Ok(true) => Ok(()),
        _ => Err("Relay socket send failed".into()),
    }
}

/// Closes the connection; an already-ended connection is not an error.
#[tauri::command]
pub(crate) fn relay_socket_close(sockets: tauri::State<'_, RelaySockets>, id: u64) {
    let _ = sockets.command(id, Command::Close);
}

#[cfg(test)]
mod tests;
