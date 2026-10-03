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
use rustls_platform_verifier::BuilderVerifierExt;
use serde::Serialize;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    sync::{mpsc, oneshot, Notify},
};
use tokio_tungstenite::{
    tungstenite::{
        client::IntoClientRequest, handshake::client::Request, http::HeaderValue, Message,
    },
    Connector, MaybeTlsStream, WebSocketStream,
};
use url::Url;

use crate::{
    identity::IdentityHost,
    nip_fi_assertion::{RelayAssertions, HEADER},
};

/// Bounds the whole connect: DNS, TCP, TLS and the WebSocket upgrade.
const CONNECT_DEADLINE: Duration = Duration::from_secs(15);
/// A send the relay does not accept in this long fails the connection.
const SEND_DEADLINE: Duration = Duration::from_secs(10);
/// How long a closing socket waits for the relay to echo Close before the
/// stream is dropped anyway.
const CLOSE_GRACE: Duration = Duration::from_secs(3);
/// A connection JavaScript never starts (for example, a reloaded webview) is
/// closed after this long.
const START_DEADLINE: Duration = Duration::from_secs(10);
/// Sends that may wait behind the one in flight; beyond this a send fails at
/// once rather than piling up behind a slow relay.
const SEND_QUEUE: usize = 64;

type Result<T> = std::result::Result<T, String>;
type Stream = WebSocketStream<MaybeTlsStream<TcpStream>>;

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
}

/// One open connection's handles. Closing is a separate signal so it takes
/// effect ahead of queued sends and during one in flight; it also drops
/// `commands`, so nothing is admitted once closing begins.
struct Handle {
    commands: Option<mpsc::Sender<Command>>,
    closing: Arc<Notify>,
}

/// Open connections. An entry exists exactly while its task owns a stream.
#[derive(Clone, Default)]
pub(crate) struct RelaySockets {
    next: Arc<AtomicU64>,
    open: Arc<Mutex<HashMap<u64, Handle>>>,
}

/// TLS for relay sockets: an explicit AWS-LC provider (as `reqwest` uses) and
/// the platform verifier, so certificate trust matches relay HTTP and no
/// process-default provider is needed.
fn tls() -> Result<Connector> {
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .and_then(|builder| builder.with_platform_verifier())
    .map_err(|_| "Relay TLS is unavailable")?
    .with_no_client_auth();
    Ok(Connector::Rustls(Arc::new(config)))
}

async fn connect(request: Request, deadline: Duration) -> Result<Stream> {
    let connector = tls()?;
    match tokio::time::timeout(
        deadline,
        tokio_tungstenite::connect_async_tls_with_config(request, None, false, Some(connector)),
    )
    .await
    {
        Ok(Ok((stream, _))) => Ok(stream),
        _ => Err("Relay connection failed".into()),
    }
}

impl RelaySockets {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u64, Handle>> {
        self.open
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn own<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        &self,
        stream: WebSocketStream<S>,
        emit: impl Fn(SocketEvent) + Send + 'static,
    ) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (commands, received) = mpsc::channel(SEND_QUEUE);
        let closing = Arc::new(Notify::new());
        self.lock().insert(
            id,
            Handle {
                commands: Some(commands),
                closing: closing.clone(),
            },
        );
        let sockets = self.clone();
        tokio::spawn(async move {
            run(stream, received, &closing, emit).await;
            sockets.lock().remove(&id);
        });
        id
    }

    fn command(&self, id: u64, command: Command) -> Result<()> {
        let open = self.lock();
        let commands = open
            .get(&id)
            .and_then(|handle| handle.commands.as_ref())
            .ok_or("Relay socket is closed")?;
        commands.try_send(command).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => "Relay socket send queue is full".into(),
            mpsc::error::TrySendError::Closed(_) => "Relay socket is closed".into(),
        })
    }

    fn close(&self, id: u64) {
        if let Some(handle) = self.lock().get_mut(&id) {
            handle.commands = None;
            handle.closing.notify_one();
        }
    }
}

/// Owns one stream until it ends; returning drops it, and with it every
/// queued send. Nothing is read until JavaScript sends `Start`, so no frame
/// (such as the relay's immediate `AUTH`) can arrive before JavaScript is able
/// to answer it.
async fn run<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: WebSocketStream<S>,
    mut commands: mpsc::Receiver<Command>,
    closing: &Notify,
    emit: impl Fn(SocketEvent),
) {
    let started = tokio::select! {
        biased;
        _ = closing.notified() => false,
        command = tokio::time::timeout(START_DEADLINE, commands.recv()) =>
            matches!(command, Ok(Some(Command::Start))),
    };
    if !started {
        return close(&mut stream).await;
    }
    loop {
        tokio::select! {
            biased;
            _ = closing.notified() => return close(&mut stream).await,
            command = commands.recv() => match command {
                Some(Command::Send(data, sent)) => {
                    let ok = tokio::select! {
                        biased;
                        _ = closing.notified() => return close(&mut stream).await,
                        result = tokio::time::timeout(SEND_DEADLINE, stream.send(Message::text(data))) =>
                            matches!(result, Ok(Ok(()))),
                    };
                    let _ = sent.send(ok);
                    if !ok {
                        return emit(SocketEvent::Error);
                    }
                }
                Some(Command::Start) => {}
                None => return close(&mut stream).await,
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

/// Sends Close and waits a bounded time for the echo. The grace also bounds
/// flushing a write that a close interrupted.
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
    let stream = connect(request, CONNECT_DEADLINE).await?;
    let id = sockets.own(stream, move |event| {
        let _ = on_event.send(event);
    });
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
    sockets.close(id);
}

#[cfg(test)]
mod tests;
