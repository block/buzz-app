//! Private kgoose returnTo receiver, adapted from Jarrod Sibbison's #581
//! (5d84bb9174515aa8a50c5a0075c538633c7024c9). No code or token crosses IPC.
use crate::session::{BrowserOpener, Config, CANCELED, LOGIN_TIMEOUT, TIMED_OUT};
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
};

pub(crate) async fn await_callback(
    config: &Config,
    opener: &dyn BrowserOpener,
    canceled: &mut oneshot::Receiver<()>,
) -> Result<String, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not start the sign-in listener")?;
    let authority = listener
        .local_addr()
        .map_err(|_| "Could not start the sign-in listener")?
        .to_string();
    let path = format!("/callback/{}", uuid::Uuid::new_v4().simple());
    // kgoose echoes returnTo, not OAuth state or a client-held PKCE verifier.
    // The random path correlates this one attempt; never accept caller-chosen paths.
    opener.open(
        config
            .login_url(&format!("http://{authority}{path}"))
            .as_str(),
    )?;
    // Owning the listener in this future closes it and any accepted connection
    // on cancellation, timeout, opener error or dropped IPC. No detached server.
    tokio::select! {
        result = tokio::time::timeout(LOGIN_TIMEOUT, receive_callback(listener, &authority, &path)) =>
            result.unwrap_or_else(|_| Err(TIMED_OUT.into())),
        Ok(()) = canceled => Err(CANCELED.into()),
    }
}

async fn receive_callback(
    listener: TcpListener,
    authority: &str,
    path: &str,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "Sign-in listener failed")?;
        // Bound slow/oversize requests; malformed callbacks do not consume the attempt.
        if let Some(response) = callback(&mut stream, authority, path).await {
            // Release the socket before publishing completion to the waiting caller.
            drop(listener);
            return response;
        }
    }
}

async fn callback(
    stream: &mut TcpStream,
    authority: &str,
    path: &str,
) -> Option<Result<String, String>> {
    tokio::time::timeout(
        Duration::from_secs(5),
        read_callback(stream, authority, path),
    )
    .await
    .ok()
    .flatten()
}

async fn read_callback(
    stream: &mut TcpStream,
    authority: &str,
    path: &str,
) -> Option<Result<String, String>> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 1024];
    while !bytes.windows(4).any(|part| part == b"\r\n\r\n") {
        let count = stream.read(&mut chunk).await.ok()?;
        if count == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..count]);
        if bytes.len() > 8192 {
            reply(stream, 400, "Invalid callback").await;
            return None;
        }
    }
    let (status, message, result) = parse_callback(&bytes, authority, path);
    reply(stream, status, message).await;
    result
}

fn parse_callback(
    bytes: &[u8],
    authority: &str,
    path: &str,
) -> (u16, &'static str, Option<Result<String, String>>) {
    let invalid = (400, "Invalid callback", None);
    let Ok(text) = std::str::from_utf8(bytes) else {
        return invalid;
    };
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split_whitespace();
    let (Some("GET"), Some(target), Some("HTTP/1.1" | "HTTP/1.0"), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return invalid;
    };
    if !target.starts_with('/') || target.starts_with("//") {
        return invalid;
    }
    let mut hosts = Vec::new();
    for line in lines.take_while(|line| !line.is_empty()) {
        let Some((name, value)) = line.split_once(':') else {
            return invalid;
        };
        if name.eq_ignore_ascii_case("origin") {
            return invalid;
        }
        if name.eq_ignore_ascii_case("host") {
            hosts.push(value.trim());
        }
    }
    if hosts != [authority] {
        return invalid;
    }
    let Ok(url) = url::Url::parse(&format!("http://{authority}{target}")) else {
        return invalid;
    };
    if target.split('?').next() != Some(path) || url.path() != path {
        return (404, "Not found", None);
    }
    if url.fragment().is_some() {
        return invalid;
    }
    let fields: Vec<_> = url.query_pairs().into_owned().collect();
    if fields.iter().any(|(name, _)| name == "error") {
        return (
            400,
            "Sign-in could not complete. Return to the app to retry.",
            Some(Err("Browser sign-in could not complete. Try again.".into())),
        );
    }
    let codes: Vec<_> = fields.iter().filter(|(name, _)| name == "code").collect();
    if codes.len() != 1
        || codes[0].1.is_empty()
        || codes[0].1.len() > 4096
        || codes[0]
            .1
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return invalid;
    }
    (
        200,
        "Sign-in received. Return to the app to finish verification.",
        Some(Ok(codes[0].1.clone())),
    )
}

async fn reply(stream: &mut TcpStream, status: u16, message: &str) {
    let body = format!("<!doctype html><title>Sign-in callback</title><p>{message}</p>");
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Bad Request",
    };
    let response = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'; base-uri 'none'; frame-ancestors 'none'\r\nReferrer-Policy: no-referrer\r\n\r\n{body}", body.len());
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_foreign_hosts_origins_paths_and_ambiguous_codes() {
        let host = "127.0.0.1:1234";
        for (target, headers) in [
            ("/cb?code=c", "Host: localhost:1234"),
            ("/cb?code=c", "Host: 127.0.0.1"),
            ("/cb?code=c", "Host: 127.0.0.1:1234\r\nHost: 127.0.0.1:1234"),
            ("/cb?code=c", "Host: 127.0.0.1:1234\r\nOrigin: null"),
            (
                "/cb?code=c",
                "Host: 127.0.0.1:1234\r\nOrigin: https://example.org",
            ),
            ("//cb?code=c", "Host: 127.0.0.1:1234"),
            ("/x/../cb?code=c", "Host: 127.0.0.1:1234"),
            ("/cb?code=c#fragment", "Host: 127.0.0.1:1234"),
            ("/cb?code=", "Host: 127.0.0.1:1234"),
            ("/cb?code=a&code=b", "Host: 127.0.0.1:1234"),
            ("/cb?code=a%0Ab", "Host: 127.0.0.1:1234"),
            ("/cb?code=a+b", "Host: 127.0.0.1:1234"),
        ] {
            let bytes = format!("GET {target} HTTP/1.1\r\n{headers}\r\n\r\n");
            assert!(
                parse_callback(bytes.as_bytes(), host, "/cb").2.is_none(),
                "{target} {headers}"
            );
        }
        for method in ["POST", "HEAD", "OPTIONS"] {
            let bytes = format!("{method} /cb?code=c HTTP/1.1\r\nHost: {host}\r\n\r\n");
            assert!(parse_callback(bytes.as_bytes(), host, "/cb").2.is_none());
        }
        let bytes = format!(
            "GET /cb?code={} HTTP/1.1\r\nHost: {host}\r\n\r\n",
            "x".repeat(4097)
        );
        assert!(parse_callback(bytes.as_bytes(), host, "/cb").2.is_none());
        let bytes = format!("GET /cb?code=a%2Bb HTTP/1.1\r\nHost: {host}\r\n\r\n");
        assert_eq!(
            parse_callback(bytes.as_bytes(), host, "/cb").2,
            Some(Ok("a+b".into()))
        );
    }

    #[tokio::test]
    async fn oversized_and_stalled_connections_do_not_consume_the_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let task =
            tokio::spawn(
                async move { receive_callback(listener, &address.to_string(), "/cb").await },
            );
        let mut oversized = TcpStream::connect(address).await.unwrap();
        oversized.write_all(&vec![b'x'; 8193]).await.unwrap();
        let mut response = String::new();
        oversized.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 400"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("Content-Security-Policy: default-src 'none'"));
        assert!(response.contains("Referrer-Policy: no-referrer"));

        // A private callback fixture holds the accepted connection so its exact
        // deadline can be advanced without racing accept on the real listener.
        let bounded = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let mut stalled = TcpStream::connect(bounded.local_addr().unwrap())
            .await
            .unwrap();
        let (mut accepted, _) = bounded.accept().await.unwrap();
        stalled.write_all(b"GET /cb").await.unwrap();
        tokio::time::pause();
        let mut pending = Box::pin(callback(&mut accepted, "127.0.0.1:1", "/cb"));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(pending.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        tokio::time::advance(Duration::from_millis(4_999)).await;
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(pending.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        // Tokio's timer wheel rounds to milliseconds: cross the deadline's tick.
        tokio::time::advance(Duration::from_millis(2)).await;
        assert!(pending.await.is_none());
        tokio::time::resume();

        let mut valid = TcpStream::connect(address).await.unwrap();
        valid
            .write_all(format!("GET /cb?code=c HTTP/1.1\r\nHost: {address}\r\n\r\n").as_bytes())
            .await
            .unwrap();
        response.clear();
        valid.read_to_string(&mut response).await.unwrap();
        assert!(response.contains("Sign-in received."));
        assert_eq!(task.await.unwrap().unwrap(), "c");
        assert!(TcpStream::connect(address).await.is_err());
    }
}
