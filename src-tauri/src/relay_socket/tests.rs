use super::*;
use std::time::Instant;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::handshake::server::{Request as Upgrade, Response};

/// A local relay on 127.0.0.1. `serve` runs on the accepted socket; the
/// returned channel reports the upgrade's badge header.
// tungstenite's handshake callback signature fixes the large error type.
#[allow(clippy::result_large_err)]
async fn relay<F, Fut>(
    serve: F,
) -> (
    Request,
    oneshot::Receiver<Option<String>>,
    tokio::task::JoinHandle<()>,
)
where
    F: FnOnce(WebSocketStream<tokio::net::TcpStream>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (header, seen) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let ws =
            tokio_tungstenite::accept_hdr_async(tcp, |request: &Upgrade, response: Response| {
                let _ = header.send(
                    request
                        .headers()
                        .get(HEADER)
                        .map(|value| value.to_str().unwrap().to_owned()),
                );
                Ok(response)
            })
            .await
            .unwrap();
        serve(ws).await;
    });
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert(HEADER, HeaderValue::from_static("Bearer badge"));
    (request, seen, task)
}

async fn open(request: Request) -> (RelaySockets, u64, mpsc::UnboundedReceiver<SocketEvent>) {
    let sockets = RelaySockets::default();
    let (events, received) = mpsc::unbounded_channel();
    let stream = connect(request, CONNECT_DEADLINE).await.unwrap();
    let id = sockets.own(stream, move |event| {
        let _ = events.send(event);
    });
    (sockets, id, received)
}

async fn released(sockets: &RelaySockets, within: Duration) {
    tokio::time::timeout(within, async {
        while !sockets.lock().is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connection still held");
}

#[tokio::test]
async fn sends_the_badge_delivers_nothing_before_start_and_releases_on_echoed_close() {
    let (request, header, relay) = relay(|mut ws| async move {
        ws.send(Message::text(r#"["AUTH","challenge"]"#))
            .await
            .unwrap();
        // Reading answers the client's Close; the stream then ends.
        while ws.next().await.is_some() {}
    })
    .await;
    let (sockets, id, mut events) = open(request).await;
    assert_eq!(header.await.unwrap().as_deref(), Some("Bearer badge"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(events.try_recv().is_err(), "frame delivered before start");
    sockets.command(id, Command::Start).unwrap();
    assert_eq!(
        events.recv().await,
        Some(SocketEvent::Text {
            data: r#"["AUTH","challenge"]"#.into()
        })
    );
    let started = Instant::now();
    sockets.close(id);
    released(&sockets, CLOSE_GRACE).await;
    tokio::time::timeout(CLOSE_GRACE, relay)
        .await
        .unwrap()
        .unwrap();
    assert!(
        started.elapsed() < CLOSE_GRACE,
        "waited out the grace period"
    );
    assert_eq!(events.recv().await, None, "explicit close reports nothing");
}

#[tokio::test]
async fn an_abrupt_reset_reports_one_error_and_releases_the_stream() {
    // Dropping the accepted stream ends TCP without a Close frame.
    let (request, _, relay) = relay(|ws| async move { drop(ws) }).await;
    let (sockets, id, mut events) = open(request).await;
    sockets.command(id, Command::Start).unwrap();
    assert_eq!(events.recv().await, Some(SocketEvent::Error));
    released(&sockets, Duration::from_secs(1)).await;
    assert_eq!(events.recv().await, None);
    relay.await.unwrap();
}

#[tokio::test]
async fn a_relay_close_is_reported_with_its_code() {
    let (request, _, relay) = relay(|mut ws| async move {
        ws.close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
            code: 4001u16.into(),
            reason: "".into(),
        }))
        .await
        .unwrap();
        while ws.next().await.is_some() {}
    })
    .await;
    let (sockets, id, mut events) = open(request).await;
    sockets.command(id, Command::Start).unwrap();
    assert_eq!(events.recv().await, Some(SocketEvent::Close { code: 4001 }));
    released(&sockets, Duration::from_secs(1)).await;
    relay.await.unwrap();
}

#[tokio::test]
async fn a_relay_that_never_acknowledges_close_is_dropped_after_the_grace_period() {
    let (request, _, relay) = relay(|mut ws| async move {
        // Do not read (and so never echo Close) until the client gives up.
        tokio::time::sleep(CLOSE_GRACE + Duration::from_secs(1)).await;
        // The client's Close is queued, then the connection is gone.
        while let Some(Ok(_)) = ws.next().await {}
    })
    .await;
    let (sockets, id, _events) = open(request).await;
    sockets.command(id, Command::Start).unwrap();
    let started = Instant::now();
    sockets.close(id);
    released(&sockets, CLOSE_GRACE + Duration::from_secs(1)).await;
    assert!(started.elapsed() >= CLOSE_GRACE - Duration::from_millis(100));
    tokio::time::timeout(Duration::from_secs(3), relay)
        .await
        .expect("client stream was not dropped")
        .unwrap();
    assert!(sockets.command(id, Command::Start).is_err());
}

/// Queues a send and returns its outcome, as `relay_socket_send` does.
fn send(sockets: &RelaySockets, id: u64, data: String) -> oneshot::Receiver<bool> {
    let (sent, done) = oneshot::channel();
    sockets.command(id, Command::Send(data, sent)).unwrap();
    done
}

/// Enough to fill the loopback socket buffers of a relay that never reads.
fn large() -> String {
    "x".repeat(16 << 20)
}

#[tokio::test]
async fn a_wss_connect_without_a_default_provider_fails_cleanly_on_an_untrusted_certificate() {
    // Both production providers are compiled in (reqwest enables AWS-LC, the
    // updater Ring) and nothing has installed a process default, which is
    // where an implicit `ClientConfig::builder()` panics.
    assert!(rustls::crypto::CryptoProvider::get_default().is_none());
    let _ = rustls::crypto::ring::default_provider();
    let server = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![include_bytes!("self-signed.der").to_vec().into()],
        rustls::pki_types::PrivateKeyDer::Pkcs8(
            include_bytes!("self-signed.key.der").to_vec().into(),
        ),
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let relay = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        tokio_rustls::TlsAcceptor::from(Arc::new(server))
            .accept(tcp)
            .await
            .is_err()
    });
    let request = format!("wss://localhost:{port}")
        .into_client_request()
        .unwrap();
    let error = connect(request, CONNECT_DEADLINE).await.unwrap_err();
    assert_eq!(error, "Relay connection failed");
    // The relay saw the handshake fail, so the client checked the certificate.
    assert!(relay.await.unwrap(), "untrusted certificate was accepted");
}

#[tokio::test]
async fn a_stalled_connect_fails_within_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    // Accept TCP, then never answer the upgrade.
    let relay = tokio::spawn(async move {
        let held = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(held);
    });
    let started = Instant::now();
    let deadline = Duration::from_millis(300);
    let result = connect(url.into_client_request().unwrap(), deadline).await;
    assert!(result.is_err());
    assert!(started.elapsed() < deadline + Duration::from_millis(500));
    relay.abort();
}

#[tokio::test]
async fn close_during_a_blocked_write_drops_the_stream_within_the_grace_period() {
    let (dropped, saw_drop) = oneshot::channel();
    let (request, _, relay) = relay(|ws| async move {
        // Never read until the client has given up, then see the stream end.
        tokio::time::sleep(CLOSE_GRACE + Duration::from_secs(1)).await;
        let (_, mut source) = ws.split();
        while let Some(Ok(_)) = source.next().await {}
        let _ = dropped.send(());
    })
    .await;
    let (sockets, id, mut events) = open(request).await;
    sockets.command(id, Command::Start).unwrap();
    let blocked = send(&sockets, id, large());
    let queued = send(&sockets, id, "behind".into());
    tokio::time::sleep(Duration::from_millis(300)).await;
    let started = Instant::now();
    sockets.close(id);
    released(&sockets, CLOSE_GRACE + Duration::from_secs(1)).await;
    assert!(started.elapsed() < CLOSE_GRACE + Duration::from_millis(500));
    // Neither the interrupted nor the queued send reports success.
    assert!(!matches!(blocked.await, Ok(true)));
    assert!(queued.await.is_err(), "queued send outlived the close");
    assert_eq!(events.recv().await, None, "explicit close reports nothing");
    tokio::time::timeout(Duration::from_secs(10), saw_drop)
        .await
        .expect("client stream was not dropped")
        .unwrap();
    relay.await.unwrap();
}

#[tokio::test]
async fn a_send_the_relay_never_accepts_fails_the_connection() {
    let (request, _, relay) = relay(|ws| async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        drop(ws);
    })
    .await;
    let (sockets, id, mut events) = open(request).await;
    sockets.command(id, Command::Start).unwrap();
    // Pause only after connecting, so the connect deadline cannot fire.
    tokio::time::pause();
    let blocked = send(&sockets, id, large());
    let queued = send(&sockets, id, "behind".into());
    // Paused time jumps to the send deadline once the write stalls.
    assert_eq!(blocked.await, Ok(false));
    assert!(queued.await.is_err(), "queued send outlived the failure");
    assert_eq!(events.recv().await, Some(SocketEvent::Error));
    released(&sockets, Duration::from_secs(1)).await;
    assert!(sockets.command(id, Command::Start).is_err());
    relay.abort();
}

#[tokio::test]
async fn a_connection_javascript_never_starts_is_closed() {
    let (ended, saw_end) = oneshot::channel();
    let (request, _, relay) = relay(|mut ws| async move {
        ws.send(Message::text(r#"["AUTH","challenge"]"#))
            .await
            .unwrap();
        // Reading answers the client's Close; the stream then ends.
        while ws.next().await.is_some() {}
        let _ = ended.send(());
    })
    .await;
    let (sockets, _, mut events) = open(request).await;
    tokio::time::pause();
    released(
        &sockets,
        START_DEADLINE + CLOSE_GRACE + Duration::from_secs(1),
    )
    .await;
    tokio::time::resume();
    tokio::time::timeout(Duration::from_secs(3), saw_end)
        .await
        .expect("relay did not see the connection end")
        .unwrap();
    assert_eq!(
        events.recv().await,
        None,
        "unstarted socket delivered a frame"
    );
    relay.await.unwrap();
}
