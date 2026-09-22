//! Worker-owned authenticated reads. Destination is the native app's configured
//! loopback development server, never an arbitrary URL supplied by a plugin.
use crate::{discovery, worker::StartRequest};
use anyhow::{bail, Context};
use nostr::Event;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::BTreeSet, time::Duration};

#[derive(Clone)]
pub(crate) struct Broker {
    client: reqwest::Client,
    origin: String,
    endpoint: String,
    pub viewer: String,
    pub authority: String,
    pub relay: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    viewer: String,
    archive_authority: Option<String>,
    relay_url: String,
    compute_status: bool,
}
impl Broker {
    pub async fn connect(origin: &str, request: &StartRequest) -> anyhow::Result<Self> {
        let url = url::Url::parse(origin)?;
        if url.scheme() != "http"
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
            || url.port().is_none()
            || url.path() != "/"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Compute requires the configured local development broker");
        }
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()?;
        let origin = url.origin().ascii_serialization();
        let encoded: String =
            url::form_urlencoded::byte_serialize(request.community.as_bytes()).collect();
        let mut broker = Self {
            client,
            endpoint: format!("{origin}/api/relay/{encoded}"),
            origin,
            viewer: request.viewer.clone(),
            authority: String::new(),
            relay: String::new(),
        };
        // Restoring a saved explicit opt-in also restores its exact community registration.
        broker
            .post_url(
                &format!("{}/api/relay/register", broker.origin),
                &json!({"url":request.community}),
            )
            .await?;
        let session = broker.session().await?;
        if session.viewer != request.viewer || !session.compute_status {
            bail!("The development broker identity changed; select your community and try again");
        }
        broker.authority = session
            .archive_authority
            .context("Community has no explicit membership authority")?;
        nostr::PublicKey::from_hex(&broker.authority)?;
        broker.relay = session.relay_url;
        Ok(broker)
    }
    async fn value(response: reqwest::Response) -> anyhow::Result<Value> {
        if !response.status().is_success() {
            bail!("Compute broker request failed ({})", response.status());
        }
        if response
            .content_length()
            .is_some_and(|n| n > 8 * 1024 * 1024)
        {
            bail!("Compute response too large");
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
                bail!("Compute response too large");
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&bytes)?)
    }
    async fn session(&self) -> anyhow::Result<Session> {
        Ok(serde_json::from_value(
            Self::value(
                self.client
                    .get(format!("{}/session", self.endpoint))
                    .send()
                    .await?,
            )
            .await?,
        )?)
    }
    async fn post_url(&self, url: &str, body: &Value) -> anyhow::Result<Value> {
        Self::value(
            self.client
                .post(url)
                .header("Origin", &self.origin)
                .header("X-Buzz-Read-Priority", "background")
                .json(body)
                .send()
                .await?,
        )
        .await
    }
    async fn query(&self, filter: Value) -> anyhow::Result<Vec<Event>> {
        let events: Vec<Event> = serde_json::from_value(
            self.post_url(&format!("{}/query", self.endpoint), &json!([filter]))
                .await?,
        )?;
        for event in &events {
            event.verify().context("Invalid signed compute evidence")?;
        }
        Ok(events)
    }
    async fn roster(&self) -> anyhow::Result<Event> {
        self.query(json!({"kinds":[13534],"authors":[self.authority],"limit":1}))
            .await?
            .into_iter()
            .filter(|e| {
                e.kind.as_u16() == 13534
                    && e.pubkey.to_hex() == self.authority
                    && e.created_at <= nostr::Timestamp::now()
            })
            .max_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| b.id.cmp(&a.id))
            })
            .context("Current community membership is unavailable")
    }
    pub async fn evidence(&self) -> anyhow::Result<Vec<Event>> {
        let session = self.session().await?;
        if session.viewer != self.viewer
            || session.archive_authority.as_deref() != Some(&self.authority)
            || session.relay_url != self.relay
        {
            bail!("Compute account or community changed");
        }
        let roster = self.roster().await?;
        let members =
            discovery::latest_membership_list(std::slice::from_ref(&roster)).unwrap_or_default();
        if !members.contains(&self.viewer) {
            bail!("You are no longer a member of this community");
        }
        let members: Vec<_> = members.into_iter().collect();
        let mut events = vec![roster.clone()];
        let mut bytes = roster.as_json().len();
        for authors in members.chunks(100) {
            let mut filter =
                json!({"kinds":[30003],"authors":authors,"#k":["buzz-mesh-status"],"limit":100});
            let mut seen = BTreeSet::new();
            loop {
                let mut page = self.query(filter.clone()).await?;
                if page.len() > 100 {
                    bail!("Invalid compute page");
                }
                for e in &page {
                    let id = e.id.to_hex();
                    if e.kind.as_u16() != 30003
                        || !authors.contains(&e.pubkey.to_hex())
                        || !seen.insert(id.clone())
                        || !e
                            .tags
                            .iter()
                            .any(|t| t.as_slice() == ["k", "buzz-mesh-status"])
                        || filter["until"].as_u64().is_some_and(|until| {
                            e.created_at.as_secs() > until
                                || (e.created_at.as_secs() == until
                                    && id.as_str() <= filter["before_id"].as_str().unwrap_or(""))
                        })
                    {
                        bail!("Invalid compute pagination");
                    }
                    bytes += e.as_json().len();
                }
                if bytes > 8 * 1024 * 1024 || events.len() + page.len() > 10000 {
                    bail!("Compute evidence exceeds limit");
                }
                let done = page.len() < 100;
                page.sort_by(|a, b| {
                    b.created_at
                        .cmp(&a.created_at)
                        .then_with(|| a.id.cmp(&b.id))
                });
                if let Some(last) = page.last() {
                    filter["until"] = json!(last.created_at.as_secs());
                    filter["before_id"] = json!(last.id.to_hex());
                }
                events.extend(page);
                if done {
                    break;
                }
            }
        }
        if self.roster().await?.id != roster.id {
            bail!("Community membership changed during discovery; retry sharing");
        }
        Ok(events)
    }
    pub async fn publish(&self, payload: Value) -> anyhow::Result<()> {
        let receipt = self
            .post_url(&format!("{}/compute-status", self.endpoint), &payload)
            .await?;
        // The broker validates the exact event id before returning this receipt.
        let accepted = receipt.get("accepted").and_then(Value::as_bool) == Some(true);
        if !accepted {
            bail!("Community did not acknowledge compute status");
        }
        Ok(())
    }
}
use nostr::JsonUtil;

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::{EventBuilder, Keys, Kind, Tag};
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };
    struct Fixture {
        origin: String,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            let _ = TcpStream::connect(self.origin.trim_start_matches("http://"));
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }
    fn server(handler: impl Fn(&str, Value) -> Value + Send + 'static) -> Fixture {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            for socket in listener.incoming() {
                if stopped.load(Ordering::SeqCst) {
                    break;
                }
                let mut socket = socket.unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let route = line.split_whitespace().nth(1).unwrap().to_string();
                let mut length = 0;
                loop {
                    line.clear();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse::<usize>().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let value = handler(&route, serde_json::from_slice(&body).unwrap_or(Value::Null))
                    .to_string();
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",value.len(),value).unwrap();
            }
        });
        Fixture {
            origin,
            stop,
            thread: Some(thread),
        }
    }
    fn request(viewer: &Keys) -> StartRequest {
        StartRequest {
            mode: crate::worker::Mode::Serve,
            community: "https://community.example".into(),
            viewer: viewer.public_key().to_hex(),
            model_id: "test-model".into(),
            max_vram_gb: None,
        }
    }
    #[tokio::test]
    async fn worker_uses_broker_identity_and_signed_member_evidence_not_renderer_rosters() {
        let viewer = Keys::generate();
        let authority = Keys::generate();
        let roster = EventBuilder::new(Kind::Custom(13534), "")
            .tags([Tag::parse(["member".to_string(), viewer.public_key().to_hex()]).unwrap()])
            .sign_with_keys(&authority)
            .unwrap();
        let viewer_key = viewer.public_key().to_hex();
        let authority_key = authority.public_key().to_hex();
        let expected = roster.id;
        let fixture = server(move |route, body| {
            if route.ends_with("/register") {
                return json!({"url":"https://community.example"});
            }
            if route.ends_with("/session") {
                return json!({"viewer":viewer_key,"archiveAuthority":authority_key,"relayUrl":"https://community.example","computeStatus":true});
            }
            assert!(route.ends_with("/query"));
            if body[0]["kinds"][0] == 13534 {
                json!([roster])
            } else {
                json!([])
            }
        });
        let broker = Broker::connect(&fixture.origin, &request(&viewer))
            .await
            .unwrap();
        let events = broker.evidence().await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, expected);
        assert!(
            Broker::connect(&fixture.origin, &request(&Keys::generate()))
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn rejects_signed_roster_from_wrong_author_and_unlisted_viewer() {
        for wrong_author in [true, false] {
            let viewer = Keys::generate();
            let authority = Keys::generate();
            let roster = EventBuilder::new(Kind::Custom(13534), "")
                .sign_with_keys(if wrong_author { &viewer } else { &authority })
                .unwrap();
            let viewer_key = viewer.public_key().to_hex();
            let authority_key = authority.public_key().to_hex();
            let fixture = server(move |route, _body| {
                if route.ends_with("/register") {
                    json!({})
                } else if route.ends_with("/session") {
                    json!({"viewer":viewer_key,"archiveAuthority":authority_key,"relayUrl":"https://community.example","computeStatus":true})
                } else {
                    json!([roster])
                }
            });
            let broker = Broker::connect(&fixture.origin, &request(&viewer))
                .await
                .unwrap();
            assert!(broker.evidence().await.is_err());
        }
    }
    #[tokio::test]
    async fn rejects_remote_or_credential_bearing_broker_origins_before_network() {
        let req = request(&Keys::generate());
        for origin in [
            "http://example.com:1430",
            "https://localhost:1430",
            "http://user@localhost:1430",
            "http://localhost:1430/path",
            "http://localhost:1430/?secret=value",
        ] {
            assert!(Broker::connect(origin, &req).await.is_err());
        }
    }
}
