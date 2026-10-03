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
    let id = sockets
        .open(request, move |event| {
            let _ = events.send(event);
        })
        .await
        .unwrap();
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
    sockets.command(id, Command::Close).unwrap();
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
    sockets.command(id, Command::Close).unwrap();
    released(&sockets, CLOSE_GRACE + Duration::from_secs(1)).await;
    assert!(started.elapsed() >= CLOSE_GRACE - Duration::from_millis(100));
    tokio::time::timeout(Duration::from_secs(3), relay)
        .await
        .expect("client stream was not dropped")
        .unwrap();
    assert!(sockets.command(id, Command::Start).is_err());
}
