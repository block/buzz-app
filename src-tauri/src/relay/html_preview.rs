//! Authenticated relay HTML documents served over isolated loopback HTTP origins.
//!
//! Relay `/media/*.html` uploads require signed Blossom `Authorization` headers
//! and serve `Content-Disposition: attachment` with `CSP: default-src 'none'` on
//! the relay origin. A browser panel or external browser cannot attach Blossom
//! credentials directly, and untrusted HTML JavaScript must never receive
//! `media_stream`'s process-wide token.
//!
//! Each previewed HTML blob receives its own loopback `127.0.0.1:<port>`
//! listener and 256-bit capability path, isolating storage and scripts per
//! document while authenticating every upstream relay read through `IdentityHost`.

use super::{download_name, download_target, fetch_html_media, media_url};
use crate::federated_identity::FederatedIdentity;
use crate::identity::IdentityHost;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{
        tcp::{OwnedReadHalf, OwnedWriteHalf},
        TcpListener, TcpStream,
    },
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
use url::Url;

/// Active HTML preview listeners kept at once; matches the guest webview cap.
const MAX_PREVIEWS: usize = 8;
const CONNECTIONS: usize = 8;
const HEAD_LIMIT: usize = 8192;
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FRAGMENT_BYTES: usize = 512;

/// RFC 3986 unreserved characters stay literal in the preview path segment.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

struct Entry {
    key: (Url, String),
    base_url: String,
    stop: CancellationToken,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

pub(crate) struct HtmlPreview {
    host: IdentityHost,
    fi: Option<FederatedIdentity>,
    target: fn(&str) -> Option<Url>,
    entries: Mutex<Vec<Entry>>,
}

impl HtmlPreview {
    pub(crate) fn new(host: IdentityHost, fi: FederatedIdentity) -> Self {
        Self::with_target(host, Some(fi), media_url)
    }

    fn with_target(
        host: IdentityHost,
        fi: Option<FederatedIdentity>,
        target: fn(&str) -> Option<Url>,
    ) -> Self {
        Self {
            host,
            fi,
            target,
            entries: Mutex::new(Vec::new()),
        }
    }

    fn resolve(&self, source: &str, name: &str) -> super::Result<String> {
        let (url, fragment) =
            preview_target(source, self.target).ok_or("Invalid HTML media URL")?;
        let filename = preview_filename(name, &url);
        let mut entries = self
            .entries
            .lock()
            .map_err(|_| "HTML preview state is unavailable".to_string())?;
        let key = (url.clone(), filename.clone());
        if let Some(index) = entries.iter().position(|entry| entry.key == key) {
            let entry = entries.remove(index);
            let resolved = format!("{}{fragment}", entry.base_url);
            entries.push(entry);
            return Ok(resolved);
        }
        let entry = spawn_entry(self.host.clone(), self.fi.clone(), url, filename)
            .map_err(|error| format!("Could not start HTML preview: {error}"))?;
        let resolved = format!("{}{fragment}", entry.base_url);
        entries.push(entry);
        let excess = entries.len().saturating_sub(MAX_PREVIEWS);
        entries.drain(..excess);
        Ok(resolved)
    }
}

#[tauri::command]
pub(crate) async fn media_html_preview_url<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    preview: tauri::State<'_, HtmlPreview>,
    source: String,
    name: String,
) -> super::Result<String> {
    if webview.label() != "main" {
        return Err("HTML preview is unavailable in this window".into());
    }
    preview.resolve(&source, &name)
}

/// Accepts either a `buzz-media` source (for an HTML file attachment card) or
/// a direct relay `/media/<sha256>.html` / `.htm` URL with an optional `#fragment`.
fn preview_target(source: &str, parse_media: fn(&str) -> Option<Url>) -> Option<(Url, String)> {
    if let Some(url) = download_target(source) {
        return Some((url, String::new()));
    }
    let (base, fragment) = match source.split_once('#') {
        Some((base, fragment)) => {
            if fragment.len() > MAX_FRAGMENT_BYTES
                || fragment.bytes().any(|byte| byte.is_ascii_control())
            {
                return None;
            }
            let suffix = if fragment.is_empty() {
                String::new()
            } else {
                format!("#{fragment}")
            };
            (base, suffix)
        }
        None => (source, String::new()),
    };
    let url = parse_media(base)?;
    let path = url.path();
    (path.ends_with(".html") || path.ends_with(".htm")).then_some((url, fragment))
}

fn preview_filename(name: &str, url: &Url) -> String {
    let raw = download_name(name, url);
    let lower = raw.to_ascii_lowercase();
    let complete = if lower.ends_with(".html") || lower.ends_with(".htm") {
        raw.to_owned()
    } else {
        format!("{raw}.html")
    };
    utf8_percent_encode(&complete, PATH_SEGMENT).to_string()
}

struct Server {
    host: IdentityHost,
    fi: Option<FederatedIdentity>,
    authority: String,
    expected_path: String,
    url: Url,
}

fn spawn_entry(
    host: IdentityHost,
    fi: Option<FederatedIdentity>,
    url: Url,
    encoded_filename: String,
) -> std::io::Result<Entry> {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let authority = listener.local_addr()?.to_string();
    let mut secret = [0; 32];
    getrandom::fill(&mut secret).map_err(std::io::Error::other)?;
    let token = URL_SAFE_NO_PAD.encode(secret);
    let expected_path = format!("/{token}/{encoded_filename}");
    let base_url = format!("http://{authority}{expected_path}");
    let stop = CancellationToken::new();
    let server = Arc::new(Server {
        host,
        fi,
        authority,
        expected_path,
        url: url.clone(),
    });
    tauri::async_runtime::spawn(accept(listener, server, stop.clone()));
    Ok(Entry {
        key: (url, encoded_filename),
        base_url,
        stop,
    })
}

async fn accept(listener: std::net::TcpListener, server: Arc<Server>, stop: CancellationToken) {
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
            () = stop.cancelled() => return,
        };
        let Some((permit, accepted)) = accepted else {
            return;
        };
        let Ok((socket, _)) = accepted else {
            drop(permit);
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        };
        let (server, stop) = (server.clone(), stop.clone());
        tauri::async_runtime::spawn(async move {
            tokio::select! {
                () = connection(&server, socket) => {}
                () = stop.cancelled() => {}
            }
            drop(permit);
        });
    }
}

async fn connection(server: &Server, socket: TcpStream) {
    let (mut reader, mut writer) = socket.into_split();
    let Ok(Some(head)) = tokio::time::timeout(HEAD_TIMEOUT, read_head(&mut reader)).await else {
        return;
    };
    let reply = async {
        match parse(server, &head) {
            Ok(head_only) => respond(server, &mut writer, head_only).await,
            Err(status) => write_status(&mut writer, status).await,
        }
    };
    tokio::select! {
        _ = reply => {}
        () = closed(&mut reader) => {}
    }
}

async fn read_head(reader: &mut OwnedReadHalf) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    let mut chunk = [0; 1024];
    loop {
        if let Some(end) = head.windows(4).position(|part| part == b"\r\n\r\n") {
            if end + 4 > HEAD_LIMIT {
                return None;
            }
            head.truncate(end);
            return Some(head);
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

fn allowed_origin(origin: &str, authority: &str) -> bool {
    origin == format!("http://{authority}")
        || matches!(origin, "tauri://localhost" | "http://tauri.localhost")
        || (cfg!(debug_assertions) && origin == "http://localhost:1430")
}

/// Constant-time comparison so path probes learn nothing about the capability token.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0, |diff, (x, y)| diff | (x ^ y)) == 0
}

fn parse(server: &Server, head: &[u8]) -> std::result::Result<bool, u16> {
    let text = std::str::from_utf8(head).map_err(|_| 400u16)?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next().unwrap_or_default().split(' ');
    let (Some(method), Some(target), Some("HTTP/1.1"), None) =
        (first.next(), first.next(), first.next(), first.next())
    else {
        return Err(400);
    };
    let head_only = match method {
        "GET" => false,
        "HEAD" => true,
        _ => return Err(405),
    };
    let mut host = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(400u16)?;
        if name.is_empty() || name.ends_with([' ', '\t']) || line.starts_with([' ', '\t']) {
            return Err(400);
        }
        let value = value.trim_matches([' ', '\t']);
        match name.to_ascii_lowercase().as_str() {
            "host" if host.replace(value).is_some() => return Err(400),
            "origin" if !allowed_origin(value, &server.authority) => return Err(403),
            "content-length" if value != "0" => return Err(400),
            "transfer-encoding" => return Err(400),
            _ => {}
        }
    }
    if host != Some(server.authority.as_str()) {
        return Err(403);
    }
    let path = target.split('?').next().unwrap_or(target);
    if !same(path.as_bytes(), server.expected_path.as_bytes()) {
        return Err(404);
    }
    Ok(head_only)
}

async fn respond(
    server: &Server,
    writer: &mut OwnedWriteHalf,
    head_only: bool,
) -> std::io::Result<()> {
    let (content_type, body) =
        match fetch_html_media(&server.host, server.fi.as_ref(), server.url.clone()).await {
            Ok(result) => result,
            Err(status) => return write_status(writer, status).await,
        };
    let head = format!(
        "{}\
Content-Type: {content_type}\r\n\
X-Content-Type-Options: nosniff\r\n\
Referrer-Policy: no-referrer\r\n\
Cache-Control: no-store\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n",
        status_line(200),
        body.len(),
    );
    writer.write_all(head.as_bytes()).await?;
    if !head_only {
        writer.write_all(&body).await?;
    }
    Ok(())
}

async fn write_status(writer: &mut OwnedWriteHalf, status: u16) -> std::io::Result<()> {
    let head = format!(
        "{}Content-Length: 0\r\nConnection: close\r\n\r\n",
        status_line(status)
    );
    writer.write_all(head.as_bytes()).await
}

fn status_line(status: u16) -> String {
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or_default();
    format!("HTTP/1.1 {status} {reason}\r\n")
}

#[cfg(test)]
#[path = "html_preview_tests.rs"]
mod tests;
