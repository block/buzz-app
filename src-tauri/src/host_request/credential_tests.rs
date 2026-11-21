//! Observed loopback TLS only. No OS credential store, provider or trust bypass.
use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

fn clients() -> &'static Mutex<BTreeMap<String, reqwest::Client>> {
    static CLIENTS: OnceLock<Mutex<BTreeMap<String, reqwest::Client>>> = OnceLock::new();
    CLIENTS.get_or_init(Default::default)
}
pub(super) fn client(url: &str) -> Option<reqwest::Client> {
    clients().lock().unwrap().get(url).cloned()
}

/// A public-looking name tests resolve to a peer through `public_https`.
pub(crate) const RESULT_HOST: &str = "result.example.test";

pub(crate) struct Peer {
    pub(crate) url: reqwest::Url,
    /// Trusts the peer as itself or as `RESULT_HOST`, for a pinned client.
    pub(crate) root: reqwest::Certificate,
    pub(crate) requests: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    release: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
    watch: Arc<super::secret_tests::Watch>,
}
impl Peer {
    pub(crate) async fn new() -> Self {
        Self::serving(1).await
    }
    /// Answers `connections` sequential requests, each with one `respond`.
    pub(crate) async fn serving(connections: usize) -> Self {
        let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into(), RESULT_HOST.into()])
            .unwrap();
        let root = reqwest::Certificate::from_der(cert.cert.der()).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.cert.der().clone()],
            rustls::pki_types::PrivateKeyDer::Pkcs8(cert.signing_key.serialize_der().into()),
        )
        .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = reqwest::Url::parse(&format!(
            "https://{}/{}",
            listener.local_addr().unwrap(),
            uuid::Uuid::new_v4()
        ))
        .unwrap();
        let sender = reqwest::Client::builder()
            .no_proxy()
            .add_root_certificate(root.clone())
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .pool_max_idle_per_host(0)
            .build()
            .unwrap();
        assert!(clients()
            .lock()
            .unwrap()
            .insert(url.to_string(), sender)
            .is_none());
        let watch = super::secret_tests::Watch::new(&url).unwrap();
        let (send, requests) = tokio::sync::mpsc::unbounded_channel();
        let (release, mut responses) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let task = tokio::spawn(async move {
            for _ in 0..connections {
                let (tcp, _) = listener.accept().await.unwrap();
                let mut tls = acceptor.accept(tcp).await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = tls.read(&mut chunk).await.unwrap();
                    assert!(count > 0 && request.len() + count <= 48 * 1024);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let head = std::str::from_utf8(&request[..end]).unwrap();
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                send.send(request).unwrap();
                if let Some(bytes) = responses.recv().await {
                    // Retirement can close the socket before a held response is released.
                    let _ = tls.write_all(&bytes).await;
                    let _ = tls.shutdown().await;
                }
            }
        });
        Self {
            url,
            root,
            requests,
            release,
            task,
            watch,
        }
    }
    pub(crate) fn respond(&mut self, status: u16, headers: &str, body: &[u8]) {
        let mut response = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        self.release.send(response).unwrap();
    }
    /// Releases exact response bytes, for dishonest framing.
    pub(crate) fn respond_raw(&mut self, response: &[u8]) {
        self.release.send(response.to_vec()).unwrap();
    }
    pub(crate) fn sends(&self) -> usize {
        self.watch.count()
    }
    pub(crate) async fn finish(&mut self) {
        tokio::time::timeout(Duration::from_secs(5), &mut self.task)
            .await
            .unwrap()
            .unwrap();
    }
}
impl Drop for Peer {
    fn drop(&mut self) {
        self.task.abort();
        assert!(clients()
            .lock()
            .unwrap()
            .remove(self.url.as_str())
            .is_some());
    }
}
