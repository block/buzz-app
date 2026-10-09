use super::*;
use buzz_agent_controller::Secret;
use nostr::prelude::{EventBuilder, FinalizeEvent, Keys, Kind, Tag};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct Facts {
    key: Secret,
    owner: Keys,
    relay: Keys,
    other: Keys,
    channel: Uuid,
}
impl Facts {
    fn new() -> Self {
        Self {
            key: Secret::generate().unwrap(),
            owner: Keys::parse(&format!("{:064x}", 1)).unwrap(),
            relay: Keys::parse(&format!("{:064x}", 2)).unwrap(),
            other: Keys::parse(&format!("{:064x}", 3)).unwrap(),
            channel: Uuid::from_u128(1),
        }
    }
    fn event(&self, kind: u16, content: &str, tags: Vec<Vec<String>>, signer: &Keys) -> Event {
        EventBuilder::new(Kind::from(kind), content)
            .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
            .finalize(signer)
            .unwrap()
    }
    fn message(&self) -> Event {
        self.event(
            9,
            "hello",
            vec![vec!["h".into(), self.channel.to_string()]],
            &self.owner,
        )
    }
    fn policy(&self, topic: &str, expanded: bool) -> Value {
        let metadata = self.event(
            METADATA,
            topic,
            vec![
                vec!["d".into(), self.channel.to_string()],
                vec!["t".into(), "dm".into()],
                vec!["private".into()],
            ],
            &self.relay,
        );
        let mut members = vec![
            vec!["d".into(), self.channel.to_string()],
            vec!["p".into(), self.key.pubkey().into()],
            vec!["p".into(), self.owner.public_key().to_hex()],
        ];
        if expanded {
            members.push(vec!["p".into(), self.other.public_key().to_hex()]);
        }
        json!([metadata, self.event(MEMBERS, "", members, &self.relay)])
    }
    fn configured(&self, relay: String) -> (HistoryRead, AppAgent) {
        let config = Config {
            agent_pubkey: PublicKey::from_hex(self.key.pubkey()).unwrap(),
            relay: relay.clone(),
            community_id: Uuid::from_u128(2),
            channel_id: self.channel,
            relay_pubkey: self.relay.public_key(),
        };
        (
            HistoryRead {
                config: Ok(Some(config)),
                retained: Mutex::new(None),
            },
            AppAgent {
                pubkey: self.key.pubkey().into(),
                relay,
                owner: self.owner.public_key().to_hex(),
                auth: "[]".into(),
                agent_type: "claude-code/agent".into(),
                name: "test".into(),
                profile: None,
                deleted: false,
            },
        )
    }
}

// Actual signed HTTP query responses, exercising the production query helper.
async fn relay(responses: Vec<Value>) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut queries = Vec::new();
        for response in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0);
                request.extend_from_slice(&chunk[..count]);
                assert!(request.len() < 64 * 1024);
                let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
                    continue;
                };
                let header = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let length: usize = header
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .unwrap()
                    .parse()
                    .unwrap();
                if request.len() < end + 4 + length {
                    continue;
                }
                assert!(header.starts_with("post /query "));
                assert!(header.contains("authorization: nostr "));
                queries.push(serde_json::from_slice(&request[end + 4..end + 4 + length]).unwrap());
                break;
            }
            let body = serde_json::to_vec(&response).unwrap();
            stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        }
        queries
    });
    (format!("http://{address}"), task)
}

#[tokio::test]
async fn topic_edits_reuse_the_session_and_membership_changes_rotate_it() {
    let facts = Facts::new();
    let first = facts.policy("first", false);
    let edited = facts.policy("new topic", false);
    let expanded = facts.policy("new topic", true);
    let history = json!([facts.message()]);
    let (url, server) = relay(vec![
        first,
        history.clone(),
        edited.clone(),
        edited.clone(),
        history.clone(),
        edited,
        expanded.clone(),
        history,
        expanded,
    ])
    .await;
    let (hook, agent) = facts.configured(url);
    let config = hook.config.as_ref().unwrap().as_ref().unwrap();
    let trigger = facts.message();
    let first = hook
        .read_as(config, &agent, &facts.key, &trigger)
        .await
        .unwrap();
    assert_eq!(first.events.len(), 1);
    let edited = hook
        .read_as(config, &agent, &facts.key, &trigger)
        .await
        .unwrap();
    assert_eq!(first.generation, edited.generation);
    let expanded = hook
        .read_as(config, &agent, &facts.key, &trigger)
        .await
        .unwrap();
    assert_ne!(first.generation, expanded.generation);
    let queries = server.await.unwrap();
    assert_eq!(queries.len(), 9);
    assert_eq!(queries[0][0]["consistency"], "strong");
    assert_eq!(queries[1][0]["limit"], LIMIT);
    assert_eq!(queries[1][0]["#h"], json!([facts.channel.to_string()]));
}

#[tokio::test]
async fn a_change_during_the_read_fails_closed_and_the_next_read_recovers() {
    let facts = Facts::new();
    let changed = facts.policy("", true);
    let history = json!([facts.message()]);
    let (url, server) = relay(vec![
        facts.policy("", false),
        history.clone(),
        changed.clone(),
        changed.clone(),
        history,
        changed,
    ])
    .await;
    let (hook, agent) = facts.configured(url);
    let config = hook.config.as_ref().unwrap().as_ref().unwrap();
    let trigger = facts.message();
    assert!(hook
        .read_as(config, &agent, &facts.key, &trigger)
        .await
        .err()
        .unwrap()
        .contains("domain changed"));
    assert_eq!(
        hook.read_as(config, &agent, &facts.key, &trigger)
            .await
            .unwrap()
            .events
            .len(),
        1
    );
    server.await.unwrap();
}

#[tokio::test]
async fn forged_or_out_of_scope_history_and_oversized_pages_are_rejected() {
    let facts = Facts::new();
    let mut forged = json!(facts.message());
    forged["content"] = json!("changed without signing");
    let elsewhere = facts.event(
        9,
        "other",
        vec![vec!["h".into(), Uuid::from_u128(9).to_string()]],
        &facts.owner,
    );
    for history in [
        json!([forged]),
        json!([elsewhere]),
        json!(vec![facts.message(); LIMIT + 1]),
    ] {
        let (url, server) = relay(vec![facts.policy("", false), history]).await;
        let (hook, agent) = facts.configured(url);
        let config = hook.config.as_ref().unwrap().as_ref().unwrap();
        assert!(hook
            .read_as(config, &agent, &facts.key, &facts.message())
            .await
            .is_err());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn a_non_member_trigger_is_rejected_before_history_is_read() {
    let facts = Facts::new();
    let (url, server) = relay(vec![facts.policy("", false)]).await;
    let (hook, agent) = facts.configured(url);
    let config = hook.config.as_ref().unwrap().as_ref().unwrap();
    let trigger = facts.event(
        9,
        "trigger",
        vec![vec!["h".into(), facts.channel.to_string()]],
        &facts.other,
    );
    assert!(hook
        .read_as(config, &agent, &facts.key, &trigger)
        .await
        .is_err());
    assert_eq!(server.await.unwrap().len(), 1);
}

#[tokio::test]
async fn policy_must_be_signed_by_the_pinned_relay_and_describe_one_private_dm() {
    let facts = Facts::new();
    let good = facts.policy("", false);
    let mut forged = good.clone();
    forged[0]["content"] = json!("unsigned change");
    let metadata: Event = serde_json::from_value(good[0].clone()).unwrap();
    let mut wrong_author = good.clone();
    wrong_author[0] = json!(facts.event(
        METADATA,
        "",
        metadata
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
        &facts.owner
    ));
    let mut public = good.clone();
    public[0] = json!(facts.event(
        METADATA,
        "",
        vec![
            vec!["d".into(), facts.channel.to_string()],
            vec!["t".into(), "dm".into()],
            vec!["public".into()],
        ],
        &facts.relay
    ));
    let duplicate = json!([good[0], good[0]]);
    for policy in [forged, wrong_author, public, duplicate] {
        let (url, server) = relay(vec![policy]).await;
        let (hook, agent) = facts.configured(url);
        let config = hook.config.as_ref().unwrap().as_ref().unwrap();
        assert!(hook
            .read_as(config, &agent, &facts.key, &facts.message())
            .await
            .is_err());
        assert_eq!(server.await.unwrap().len(), 1);
    }
}
