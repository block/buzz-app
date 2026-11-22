use super::*;
use std::io::{Read as _, Write as _};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

fn any_media_url(target: &str) -> Option<Url> {
    let url = Url::parse(target).ok()?;
    url.path().starts_with("/media/").then_some(url)
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

async fn exchange(authority: &str, head: &str) -> Reply {
    let mut socket = TcpStream::connect(authority).await.unwrap();
    socket.write_all(head.as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await.unwrap();
    let end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .expect("complete HTTP response head");
    let head_text = std::str::from_utf8(&bytes[..end]).unwrap();
    let mut lines = head_text.split("\r\n");
    let status = lines
        .next()
        .unwrap()
        .split(' ')
        .nth(1)
        .unwrap()
        .parse()
        .unwrap();
    let headers = lines
        .map(|line| {
            let (name, value) = line.split_once(": ").unwrap();
            (name.to_owned(), value.to_owned())
        })
        .collect();
    Reply {
        status,
        headers,
        body: bytes[end + 4..].to_vec(),
    }
}

/// Mock relay serving signed `/media/*` uploads with the relay's attachment headers.
fn relay_html_server(content_type: &'static str, body: &'static [u8]) -> (Url, Arc<AtomicUsize>) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let authorized = Arc::new(AtomicUsize::new(0));
    let count = authorized.clone();
    std::thread::spawn(move || {
        for socket in listener.incoming() {
            let Ok(mut socket) = socket else { break };
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let Ok(read) = socket.read(&mut chunk) else {
                    break;
                };
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
            if !text.contains("\r\nauthorization: nostr ") {
                let _ = socket.write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 33\r\nConnection: close\r\n\r\n{\"error\":\"authentication failed\"}",
                );
                continue;
            }
            count.fetch_add(1, Ordering::SeqCst);
            let head = format!(
                "HTTP/1.1 200 OK\r\n\
Content-Type: {content_type}\r\n\
Content-Disposition: attachment\r\n\
Content-Security-Policy: default-src 'none'\r\n\
X-Content-Type-Options: nosniff\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n",
                body.len()
            );
            let _ = socket
                .write_all(head.as_bytes())
                .and_then(|()| socket.write_all(body));
        }
    });
    (base, authorized)
}

#[tokio::test]
async fn serves_authenticated_html_inline_without_relay_attachment_disposition() {
    let html = b"<!doctype html><title>Board</title><h1>Visual index</h1>";
    let (origin, authorized) = relay_html_server("text/html; charset=utf-8", html);
    let media = origin
        .join(&format!("/media/{}.html#section-2", "a".repeat(64)))
        .unwrap();
    let preview = HtmlPreview::with_target(IdentityHost::fixture(), None, any_media_url);
    let resolved = preview
        .resolve(media.as_str(), "Visual Board.html")
        .unwrap();
    assert!(
        resolved.ends_with("/Visual%20Board.html#section-2"),
        "{resolved}"
    );

    let parsed = Url::parse(&resolved).unwrap();
    let authority = format!("127.0.0.1:{}", parsed.port().unwrap());
    let path = parsed.path();

    let reply = exchange(
        &authority,
        &format!("GET {path} HTTP/1.1\r\nHost: {authority}\r\n\r\n"),
    )
    .await;
    assert_eq!(reply.status, 200);
    assert_eq!(reply.body, html);
    assert_eq!(
        reply.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(reply.header("referrer-policy"), Some("no-referrer"));
    assert_eq!(reply.header("cache-control"), Some("no-store"));
    assert_eq!(reply.header("content-disposition"), None);
    assert_eq!(reply.header("content-security-policy"), None);
    assert_eq!(authorized.load(Ordering::SeqCst), 1);

    // Rejects wrong tokens, paths, DNS rebinding hosts, cross-origin reads, and non-GET/HEAD.
    let wrong_token = path.replacen('/', "/x", 1);
    for (head, expected) in [
        (
            format!("GET {wrong_token} HTTP/1.1\r\nHost: {authority}\r\n\r\n"),
            404,
        ),
        (format!("GET / HTTP/1.1\r\nHost: {authority}\r\n\r\n"), 404),
        (
            format!("GET {path} HTTP/1.1\r\nHost: rebind.example\r\n\r\n"),
            403,
        ),
        (
            format!(
                "GET {path} HTTP/1.1\r\nHost: {authority}\r\nOrigin: https://evil.example\r\n\r\n"
            ),
            403,
        ),
        (
            format!("POST {path} HTTP/1.1\r\nHost: {authority}\r\n\r\n"),
            405,
        ),
    ] {
        let rejected = exchange(&authority, &head).await;
        assert_eq!(rejected.status, expected, "{head}");
        assert!(rejected.body.is_empty());
    }
}

#[tokio::test]
async fn isolates_distinct_documents_by_port_and_evicts_oldest_listener() {
    let (origin, _) = relay_html_server("text/html", b"<h1>Doc</h1>");
    let preview = HtmlPreview::with_target(IdentityHost::fixture(), None, any_media_url);

    let first_media = origin
        .join(&format!("/media/{}.html", "0".repeat(64)))
        .unwrap();
    let first = Url::parse(&preview.resolve(first_media.as_str(), "doc.html").unwrap()).unwrap();
    // Opening the same document again reuses its listener and capability URL.
    let same_again =
        Url::parse(&preview.resolve(first_media.as_str(), "doc.html").unwrap()).unwrap();
    assert_eq!(first, same_again);

    let mut ports = std::collections::HashSet::from([first.port().unwrap()]);
    for index in 1..=MAX_PREVIEWS {
        let hex = format!("{index:x}").repeat(64);
        let url = origin.join(&format!("/media/{hex}.html")).unwrap();
        let next = Url::parse(&preview.resolve(url.as_str(), "doc.html").unwrap()).unwrap();
        assert!(ports.insert(next.port().unwrap()));
    }

    // First listener was evicted once the ninth distinct document opened.
    let evicted_authority = format!("127.0.0.1:{}", first.port().unwrap());
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if TcpStream::connect(&evicted_authority).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("evicted preview listener stops accepting connections");
}

#[tokio::test]
async fn rejects_non_html_upstream_types_and_untrusted_sources() {
    let (origin, _) = relay_html_server("image/png", b"\x89PNG\r\n\x1a\n");
    let media = origin
        .join(&format!("/media/{}.html", "b".repeat(64)))
        .unwrap();
    let preview = HtmlPreview::with_target(IdentityHost::fixture(), None, any_media_url);
    let resolved = Url::parse(&preview.resolve(media.as_str(), "not-html.html").unwrap()).unwrap();
    let authority = format!("127.0.0.1:{}", resolved.port().unwrap());
    let reply = exchange(
        &authority,
        &format!(
            "GET {} HTTP/1.1\r\nHost: {authority}\r\n\r\n",
            resolved.path()
        ),
    )
    .await;
    assert_eq!(reply.status, 415);
    assert!(reply.body.is_empty());

    let strict = HtmlPreview::with_target(IdentityHost::fixture(), None, media_url);
    for invalid in [
        format!("https://relay.example/media/{}.pdf", "c".repeat(64)),
        format!("http://relay.example/media/{}.html", "c".repeat(64)),
        format!(
            "https://relay.example/media/{}.html?token=1",
            "c".repeat(64)
        ),
        format!(
            "https://relay.example/media/{}.html#bad\nfrag",
            "c".repeat(64)
        ),
        "buzz-media://evil.example/https%3A%2F%2Frelay.example%2Fmedia%2F".to_owned(),
    ] {
        assert!(strict.resolve(&invalid, "").is_err(), "{invalid}");
    }

    // Valid `buzz-media://` attachment sources work even when the blob URL has no extension.
    let blob_only = format!("https://relay.example/media/{}", "d".repeat(64));
    let native_source = format!(
        "buzz-media://localhost/{}",
        utf8_percent_encode(&blob_only, NON_ALPHANUMERIC)
    );
    let card_preview = strict.resolve(&native_source, "report").unwrap();
    assert!(card_preview.ends_with("/report.html"), "{card_preview}");
}
