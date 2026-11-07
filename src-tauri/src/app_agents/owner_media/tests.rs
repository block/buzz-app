use super::*;
use crate::federated_identity::agent::{tests::response_fixture, AgentTokens};
use crate::federated_identity::testing::{community, Community};
use buzz_agent_controller::{AppAgent, Secret};
use sha2::{Digest, Sha256};
use std::sync::Arc;

const PNG: &str = "\u{89}PNG fixture body";

fn reply(headers: &str, body: &str) -> String {
    format!("HTTP/1.1 200 OK\r\n{headers}Connection: close\r\n\r\n{body}")
}
fn sha(body: &str) -> String {
    format!("{:x}", Sha256::digest(body.as_bytes()))
}

/// An agent of the community's signed-in viewer (or of `owner`), held by a host.
async fn agent_of(
    community: &Community,
    owner: Option<String>,
    tokens: AgentTokens,
) -> (AppAgentHost, AppAgent, tempfile::TempDir) {
    let key = Secret::generate().unwrap();
    let owner = match owner {
        Some(owner) => owner,
        None => community.host.viewer().await.unwrap(),
    };
    let agent: AppAgent = serde_json::from_value(serde_json::json!({
        "pubkey": key.pubkey(),
        "relay": format!("wss://{}", community.origin.authority()),
        "owner": owner,
        "auth": r#"["auth","owner","conditions","sig"]"#, "type": "p/t", "name": "Ada"
    }))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let host = AppAgentHost::holding(dir.path().join("identities.json"), &agent, key, tokens);
    (host, agent, dir)
}

async fn stage_at(
    host: &AppAgentHost,
    community: &Community,
    agent: &AppAgent,
    dir: &Path,
    id: &str,
    url: &str,
) -> Result<OwnerMediaStaged, String> {
    stage(
        host,
        &community.host,
        Some(&community.fi),
        dir,
        agent.pubkey.clone(),
        agent.relay.clone(),
        id.into(),
        url.into(),
    )
    .await
}

#[tokio::test]
async fn owner_media_is_read_as_the_owner_and_written_only_when_published() {
    use base64::Engine;
    for required in [false, true] {
        let community = community(required).await;
        let (host, agent, _store) = agent_of(&community, None, AgentTokens::unconfigured()).await;
        let served = community.serve(vec![reply(
            &format!(
                "Content-Type: image/png\r\nContent-Length: {}\r\n",
                PNG.len()
            ),
            PNG,
        )]);
        let dir = tempfile::tempdir().unwrap();
        let name = format!("{}.png", sha(PNG));
        let staged = stage_at(&host, &community, &agent, dir.path(), "one", &name)
            .await
            .unwrap();
        let head = &served.heads().await[0];
        community.assert_carried(head);
        let auth = head
            .lines()
            .find_map(|line| line.strip_prefix("authorization: Nostr "))
            .expect(head);
        let event: serde_json::Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(auth.trim())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            event["pubkey"], agent.owner,
            "signed as the owner, not the agent"
        );
        assert_eq!(event["kind"], 24242);
        assert_eq!(staged.mime, "image/png");
        assert_eq!(staged.size, PNG.len() as u64);
        assert!(staged.data.is_some(), "a small image is shown");
        assert_eq!(staged.path, dir.path().join(&name).to_string_lossy());
        assert_eq!(
            std::fs::read_dir(dir.path()).map_or(0, Iterator::count),
            0,
            "nothing is on disk before publication"
        );
        publish(
            &host,
            &community.host,
            dir.path(),
            &agent.pubkey,
            &agent.relay,
            "one",
        )
        .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(&name)).unwrap(),
            PNG.as_bytes()
        );
        assert_eq!(
            publish(
                &host,
                &community.host,
                dir.path(),
                &agent.pubkey,
                &agent.relay,
                "one"
            )
            .unwrap_err(),
            NOTHING,
            "published once"
        );
        assert_eq!(host.owner_media.held(), (0, 0));
    }
}

#[tokio::test]
async fn owner_media_is_never_signed_or_sent_for_another_owner() {
    let community = community(true).await;
    let (host, agent, _store) = agent_of(
        &community,
        Some("b".repeat(64)),
        AgentTokens::unconfigured(),
    )
    .await;
    // Nothing answers: any request, discovery included, would hang here.
    let dir = tempfile::tempdir().unwrap();
    let refused = tokio::time::timeout(
        Duration::from_secs(5),
        stage_at(&host, &community, &agent, dir.path(), "one", &sha(PNG)),
    )
    .await
    .expect("refused before any request");
    assert_eq!(
        refused.unwrap_err(),
        "Your owner is not signed in to Buzz here now"
    );
    assert_eq!(host.owner_media.held(), (0, 0));
}

#[tokio::test]
async fn owner_media_is_only_the_agents_community_blob() {
    let community = community(false).await;
    let (host, agent, _store) = agent_of(&community, None, AgentTokens::unconfigured()).await;
    let dir = tempfile::tempdir().unwrap();
    for url in [
        "https://elsewhere.example.org/media/".to_owned() + &sha(PNG),
        format!("{}upload", community.origin),
        "../secret".into(),
    ] {
        assert_eq!(
            stage_at(&host, &community, &agent, dir.path(), "one", &url)
                .await
                .unwrap_err(),
            "Agents fetch only their community's media"
        );
    }
    // A body that is not the blob named is dropped.
    let served = community.serve(vec![reply("Content-Length: 5\r\n", "other")]);
    assert_eq!(
        stage_at(&host, &community, &agent, dir.path(), "two", &sha(PNG))
            .await
            .unwrap_err(),
        "Media did not match its SHA-256"
    );
    served.heads().await;
    assert_eq!(host.owner_media.held(), (0, 0));
    for id in ["", "a/b", &"x".repeat(65)] {
        assert!(
            stage_at(&host, &community, &agent, dir.path(), id, &sha(PNG))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn owner_media_bodies_are_bounded_by_what_was_reserved() {
    let community = community(false).await;
    let owner = community.host.viewer().await.unwrap();
    let url = community
        .origin
        .join(&format!("/media/{}", sha(PNG)))
        .unwrap();
    let read = |limit, reserved: Arc<Mutex<Vec<u64>>>| {
        crate::relay::owner_media(
            &community.host,
            Some(&community.fi),
            &owner,
            url.clone(),
            limit,
            move |bytes| {
                reserved.lock().unwrap().push(bytes);
                Ok(())
            },
        )
    };
    // No length: the limit is reserved and a longer body is refused.
    let reserved = Arc::default();
    let served = community.serve(vec![reply("", "0123456789")]);
    assert!(read(8, Arc::clone(&reserved)).await.is_err());
    served.heads().await;
    assert_eq!(*reserved.lock().unwrap(), [8]);
    // Nor does one within it grow its buffer past what was reserved.
    let served = community.serve(vec![reply("", "01234")]);
    let (_, body) = read(5, Arc::default()).await.unwrap();
    served.heads().await;
    assert_eq!((body.as_slice(), body.capacity()), (&b"01234"[..], 5));
    // A declared length over the limit reserves nothing.
    let reserved = Arc::default();
    let served = community.serve(vec![reply("Content-Length: 10\r\n", "0123456789")]);
    assert!(read(8, Arc::clone(&reserved)).await.is_err());
    served.heads().await;
    assert!(reserved.lock().unwrap().is_empty());
    // A declared length within it is what is reserved.
    let reserved = Arc::default();
    let served = community.serve(vec![reply("Content-Length: 4\r\n", "0123")]);
    let (_, body) = read(8, Arc::clone(&reserved)).await.unwrap();
    served.heads().await;
    assert_eq!(
        (body.as_slice(), reserved.lock().unwrap()[0]),
        (&b"0123"[..], 4)
    );
    // A refused reservation reads no body.
    let served = community.serve(vec![reply("Content-Length: 4\r\n", "0123")]);
    let refused = crate::relay::owner_media(
        &community.host,
        Some(&community.fi),
        &owner,
        url.clone(),
        8,
        |_| Err(BUSY.into()),
    )
    .await;
    served.heads().await;
    assert_eq!(refused.unwrap_err(), BUSY);
}

fn staged(agent: &str, relay: &str, owner: &str, stamp: Stamp, retirements: u64) -> Staged {
    Staged {
        agent: agent.into(),
        relay: relay.into(),
        owner: owner.into(),
        stamp,
        retirements,
        name: "blob.png".into(),
        body: PNG.as_bytes().to_vec(),
        at: Instant::now(),
    }
}

#[test]
fn reads_share_one_bounded_budget() {
    let media = OwnerMedia::default();
    let _a = media.begin("a").unwrap();
    let _b = media.begin("b").unwrap();
    media.reserve("a", BUDGET).unwrap();
    assert_eq!(media.reserve("b", 1).unwrap_err(), BUSY);
    media.end("a");
    media.reserve("b", 1).unwrap();
    assert_eq!(media.held(), (1, 1));
    let receivers: Vec<_> = (0..OPS - 1)
        .map(|n| media.begin(&format!("n{n}")).unwrap())
        .collect();
    assert_eq!(media.begin("over").unwrap_err(), BUSY);
    drop(receivers);
    media.clear();
    assert_eq!(media.held(), (0, 0));
}

#[tokio::test]
async fn a_discard_cancels_its_read_even_when_it_overtakes_the_stage() {
    let media = OwnerMedia::default();
    // During the read: it is told to stop, and cannot reserve or stage.
    let cancelled = media.begin("a").unwrap();
    media.discard("a");
    cancelled.await.unwrap();
    assert_eq!(media.reserve("a", 1).unwrap_err(), CANCELLED);
    let staged = || staged("agent", "wss://relay.example", "owner", Stamp::default(), 0);
    assert_eq!(media.stage("a", staged()).unwrap_err(), CANCELLED);
    // Before the read began: the read is refused once.
    media.discard("b");
    assert_eq!(media.begin("b").unwrap_err(), CANCELLED);
    let _b = media.begin("b").unwrap();
    // After staging: the body is gone.
    media.stage("b", staged()).unwrap();
    media.discard("b");
    assert_eq!(media.held(), (0, 0));
    // Tombstones are bounded, keeping the newest.
    for n in 0..TOMBSTONES + 8 {
        media.discard(&format!("t{n}"));
    }
    assert_eq!(media.lock().cancelled.len(), TOMBSTONES);
    assert!(media.begin(&format!("t{}", TOMBSTONES + 7)).is_err());
    // A reload drops them, and every read and body.
    let cancelled = media.begin("c").unwrap();
    media.clear();
    cancelled.await.unwrap();
    assert!(media.lock().cancelled.is_empty());
    assert_eq!(media.held(), (0, 0));
}

#[test]
fn a_staged_body_is_taken_once_by_its_own_agent_before_it_expires() {
    let media = OwnerMedia::default();
    let relay = "wss://relay.example";
    let _a = media.begin("a").unwrap();
    media
        .stage("a", staged("agent", relay, "owner", Stamp::default(), 0))
        .unwrap();
    assert_eq!(media.take("a", "other", relay).err().unwrap(), NOTHING);
    assert_eq!(
        media
            .take("a", "agent", "wss://other.example")
            .err()
            .unwrap(),
        NOTHING
    );
    assert_eq!(media.held().0, 1, "a foreign call leaves it held");
    assert_eq!(media.peek("a", "agent", relay).unwrap().0, "owner");
    let taken = media.take("a", "agent", relay).unwrap();
    assert_eq!(taken.body, PNG.as_bytes());
    assert_eq!(media.take("a", "agent", relay).err().unwrap(), NOTHING);
    // Until its publication drops it, the body still counts, even past a discard.
    media.discard("a");
    let counted = (1, taken.body.capacity() as u64);
    assert_eq!(media.held(), counted);
    drop(taken);
    media.published("a");
    let _b = media.begin("b").unwrap();
    let mut old = staged("agent", relay, "owner", Stamp::default(), 0);
    old.at = Instant::now().checked_sub(LIFETIME).unwrap();
    media.stage("b", old).unwrap();
    assert_eq!(
        media.peek("b", "agent", relay).err().as_deref(),
        Some(NOTHING)
    );
    assert_eq!(media.held(), (0, 0));
}

/// The agent of a fixture's tokens, owned by `IdentityHost::fixture`'s viewer,
/// with one body staged.
async fn staged_for() -> (
    crate::federated_identity::agent::tests::Fixture,
    AppAgentHost,
    AppAgent,
    tempfile::TempDir,
) {
    let f = response_fixture().await;
    let agent = AppAgent {
        owner: IdentityHost::fixture().viewer().await.unwrap(),
        ..f.agent.clone()
    };
    let store = tempfile::tempdir().unwrap();
    let host = AppAgentHost::holding(
        store.path().join("identities.json"),
        &agent,
        Secret::parse(&f.key.hex(), f.key.pubkey()).unwrap(),
        f.tokens.clone(),
    );
    let retirements = host.caller_retirements();
    let (_, stamp) = host
        .caller_stamp(agent.pubkey.clone(), agent.relay.clone())
        .await
        .unwrap();
    let _read = host.owner_media.begin("one").unwrap();
    host.owner_media
        .stage(
            "one",
            staged(
                &agent.pubkey,
                &agent.relay,
                &agent.owner,
                stamp,
                retirements,
            ),
        )
        .unwrap();
    (f, host, agent, store)
}

#[tokio::test]
async fn nothing_is_written_once_the_owner_or_agent_stops_acting() {
    for change in [
        "delete",
        "sign-out",
        "retirement-pending",
        "identity-closed",
        "none",
    ] {
        let identity = IdentityHost::fixture();
        let (f, host, agent, _store) = staged_for().await;
        match change {
            "delete" => f.tokens.forget(&agent.owner, &agent.pubkey).await.unwrap(),
            "sign-out" => drop(f.tokens.sign_out(None).await.unwrap()),
            "retirement-pending" => f.tokens.mark_retirement_pending(),
            "identity-closed" => identity.close(),
            _ => {}
        }
        let dir = tempfile::tempdir().unwrap();
        let published = publish(
            &host,
            &identity,
            dir.path(),
            &agent.pubkey,
            &agent.relay,
            "one",
        );
        let files = std::fs::read_dir(dir.path()).map_or(0, Iterator::count);
        if change == "none" {
            published.unwrap();
            assert_eq!(files, 1);
        } else {
            assert!(published.is_err(), "{change}");
            assert_eq!(files, 0, "{change}: no file, not even a temporary one");
        }
        assert_eq!(
            host.owner_media.held(),
            (0, 0),
            "{change}: the body is dropped"
        );
    }
    // Another owner signed in here now.
    let other = IdentityHost::fixture_signed_in_as(2);
    let (_f, host, agent, _store) = staged_for().await;
    let dir = tempfile::tempdir().unwrap();
    assert!(publish(
        &host,
        &other,
        dir.path(),
        &agent.pubkey,
        &agent.relay,
        "one"
    )
    .is_err());
    assert_eq!(std::fs::read_dir(dir.path()).map_or(0, Iterator::count), 0);
}

/// Publication takes the identity, then the agent tokens' locks; sign-out
/// and deletion take them in that order or unnested. Racing them all must
/// finish, each publication writing all of its file or none of it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn publication_keeps_the_credential_lock_order_under_sign_out_and_deletion() {
    for round in 0..8 {
        let identity = IdentityHost::fixture();
        let (f, host, agent, _store) = staged_for().await;
        let dir = tempfile::tempdir().unwrap();
        let publishing = {
            let (host, identity, path) = (host.clone(), identity.clone(), dir.path().to_owned());
            let (pubkey, relay) = (agent.pubkey.clone(), agent.relay.clone());
            tokio::task::spawn_blocking(move || {
                publish(&host, &identity, &path, &pubkey, &relay, "one")
            })
        };
        let stopping = {
            let (tokens, identity) = (f.tokens.clone(), identity.clone());
            let (owner, pubkey) = (agent.owner.clone(), agent.pubkey.clone());
            tokio::spawn(async move {
                if round % 2 == 0 {
                    tokens.forget(&owner, &pubkey).await.unwrap();
                } else {
                    tokens.sign_out(None).await.unwrap();
                    identity.close();
                }
            })
        };
        let (published, stopped) = tokio::time::timeout(Duration::from_secs(10), async {
            (publishing.await.unwrap(), stopping.await)
        })
        .await
        .expect("no lock-order deadlock");
        stopped.unwrap();
        let written = std::fs::read_dir(dir.path()).unwrap().count();
        match published {
            Ok(()) => assert_eq!(
                std::fs::read(dir.path().join("blob.png")).unwrap(),
                PNG.as_bytes()
            ),
            Err(_) => assert_eq!(written, 0),
        }
    }
}
