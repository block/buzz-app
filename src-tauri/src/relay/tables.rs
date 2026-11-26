//! Sharing an agent table: the owner's key reaches only people the relay
//! currently lists in the table's channel.

use super::{origin, request_url, send, verify_signature, Result};
use crate::federated_identity::FederatedIdentity;
use crate::identity::IdentityHost;
use serde_json::{json, Value};

/// The owner's key for the table at `head`, sealed to `member`, once the
/// relay's signed roster for the table's channel shows the owner as its
/// owner and `member` in it. Without that roster nothing is sealed.
#[tauri::command]
pub(crate) async fn relay_table_key_reseal(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    head: Value,
    grants: Vec<Value>,
    member: String,
) -> Result<String> {
    reseal_for_member(&host, Some(&fi), &community, head, grants, member).await
}

async fn reseal_for_member(
    host: &IdentityHost,
    fi: Option<&FederatedIdentity>,
    community: &str,
    head: Value,
    grants: Vec<Value>,
    member: String,
) -> Result<String> {
    let channel = tag(&head, "h").ok_or("Invalid table")?.to_owned();
    if !grants
        .iter()
        .all(|grant| tag(grant, "h") == Some(channel.as_str()))
    {
        return Err("Invalid table key grant".into());
    }
    let parse = |event: Value| serde_json::from_value(event).map_err(|_| "Invalid table key grant");
    let grants = grants
        .into_iter()
        .map(parse)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let head = parse(head)?;
    let owner = host.viewer().await?;
    let info = send(host, fi, origin(community)?, "GET", None, false, 65536).await?;
    let info: Value =
        serde_json::from_str(&info.body).map_err(|_| "Could not read the community's identity")?;
    let authority = info["self"]
        .as_str()
        .or(info["pubkey"].as_str())
        .filter(|key| super::hex_key(key))
        .ok_or("Could not read the community's identity")?;
    let filter = json!([{"kinds":[39002], "authors":[authority], "#d":[channel], "limit":1, "consistency":"strong"}]);
    let reply = send(
        host,
        fi,
        request_url(community, "/query", "POST")?,
        "POST",
        Some(filter.to_string()),
        true,
        1024 * 1024,
    )
    .await?;
    if !(200..300).contains(&reply.status) {
        return Err(format!(
            "Could not read the table's members ({})",
            reply.status
        ));
    }
    let rosters: Vec<Value> =
        serde_json::from_str(&reply.body).map_err(|_| "Could not confirm the table's members")?;
    if !roster_allows(&rosters, authority, &channel, &owner, &member) {
        return Err("They are not a member of this table's channel".into());
    }
    host.table_key_reseal(head, grants, member).await
}

/// Whether the relay's newest signed roster of `channel` lists `owner` as
/// its owner and `member` in it.
fn roster_allows(
    rosters: &[Value],
    authority: &str,
    channel: &str,
    owner: &str,
    member: &str,
) -> bool {
    let Some(roster) = rosters
        .iter()
        .filter(|event| {
            verify_signature(event).is_ok()
                && event["kind"] == 39002
                && event["pubkey"] == authority
                && tag(event, "d") == Some(channel)
        })
        .max_by(|a, b| {
            a["created_at"]
                .as_u64()
                .cmp(&b["created_at"].as_u64())
                .then_with(|| b["id"].as_str().cmp(&a["id"].as_str()))
        })
    else {
        return false;
    };
    let listed = |key: &str| {
        roster["tags"].as_array().and_then(|tags| {
            tags.iter()
                .find(|t| t[0] == "p" && t[1] == key)
                .map(|t| t[3].as_str().unwrap_or("member").to_owned())
        })
    };
    listed(owner).as_deref() == Some("owner") && listed(member).is_some()
}

fn tag<'a>(event: &'a Value, name: &str) -> Option<&'a str> {
    event["tags"]
        .as_array()?
        .iter()
        .find(|t| t[0] == name)
        .and_then(|t| t[1].as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::event::{EventBuilder, FinalizeEvent, Kind, Tag};
    use nostr::key::Keys;

    fn roster(relay: &Keys, channel: &str, members: &[(&str, &str)], at: u64) -> Value {
        let mut tags = vec![Tag::parse(["d", channel]).unwrap()];
        for (key, role) in members {
            tags.push(Tag::parse(["p", key, "", role]).unwrap());
        }
        let event = EventBuilder::new(Kind::Custom(39002), "")
            .tags(tags)
            .custom_created_at(nostr::types::Timestamp::from(at))
            .finalize(relay)
            .unwrap();
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn only_the_newest_signed_roster_with_the_owner_as_owner_admits_a_member() {
        let relay = Keys::generate();
        let authority = relay.public_key().to_hex();
        let (owner, member) = ("a".repeat(64), "b".repeat(64));
        let allows = |rosters: &[Value]| roster_allows(rosters, &authority, "c", &owner, &member);
        let listed = roster(&relay, "c", &[(&owner, "owner"), (&member, "guest")], 10);
        assert!(allows(std::slice::from_ref(&listed)));
        let removed = roster(&relay, "c", &[(&owner, "owner")], 20);
        assert!(!allows(&[listed.clone(), removed]));
        assert!(!allows(&[roster(
            &relay,
            "c",
            &[(&owner, "member"), (&member, "member")],
            10
        )]));
        assert!(!allows(&[roster(
            &relay,
            "other",
            &[(&owner, "owner"), (&member, "member")],
            10
        )]));
        assert!(!allows(&[roster(
            &Keys::generate(),
            "c",
            &[(&owner, "owner"), (&member, "member")],
            10
        )]));
        let mut forged = listed;
        forged["created_at"] = json!(30);
        assert!(!allows(&[forged]));
        assert!(!allows(&[]));
    }
}

/// Against a real relay behind a test-trusted TLS proxy: run with
/// `BUZZ_TABLE_SCENARIO=<file> cargo test --lib relay::tables::live -- --ignored`
/// after `share.rust.setup` writes the scenario.
#[cfg(test)]
mod live {
    use super::*;
    use nostr::nips::nip44;

    async fn proxy(upstream: String) -> String {
        let at = std::env::var("BUZZ_TABLE_PROXY").unwrap_or("127.0.0.1:0".into());
        let listener = tokio::net::TcpListener::bind(at).await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = crate::federated_identity::testing::trusted_acceptor();
        tokio::spawn(async move {
            loop {
                let (tcp, _) = listener.accept().await.unwrap();
                let (acceptor, upstream) = (acceptor.clone(), upstream.clone());
                tokio::spawn(async move {
                    let mut client = acceptor.accept(tcp).await.unwrap();
                    let mut relay = tokio::net::TcpStream::connect(upstream).await.unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut relay).await;
                });
            }
        });
        format!("https://{address}/")
    }

    #[tokio::test]
    #[ignore]
    async fn owner_reseals_only_for_current_members_of_a_live_relay() {
        let scenario: Value = serde_json::from_str(
            &std::fs::read_to_string(std::env::var("BUZZ_TABLE_SCENARIO").unwrap()).unwrap(),
        )
        .unwrap();
        let host = IdentityHost::fixture();
        assert_eq!(host.viewer().await.unwrap(), scenario["owner"]);
        let community = proxy(scenario["relay"].as_str().unwrap().to_owned()).await;
        let grants: Vec<Value> = scenario["grants"].as_array().unwrap().clone();
        let reseal = |member: &str| {
            reseal_for_member(
                &host,
                None,
                &community,
                scenario["head"].clone(),
                grants.clone(),
                member.to_owned(),
            )
        };
        let sealed = reseal(scenario["member"].as_str().unwrap()).await.unwrap();
        let member_key =
            nostr::key::SecretKey::from_hex(scenario["member_secret"].as_str().unwrap()).unwrap();
        let owner = nostr::key::PublicKey::from_hex(scenario["owner"].as_str().unwrap()).unwrap();
        let key = nip44::decrypt(&member_key, &owner, &sealed).unwrap();
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(&key, &mut bytes).unwrap();
        let file = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            scenario["head"]["content"].as_str().unwrap(),
        )
        .unwrap();
        assert!(
            nip44::v2::decrypt_to_bytes(&nip44::v2::ConversationKey::new(bytes), &file).is_ok()
        );
        std::fs::write(std::env::var("BUZZ_TABLE_SEALED").unwrap(), &sealed).unwrap();
        println!("LIVE member resealed: {} bytes, opens head", sealed.len());
        let removed = reseal(scenario["removed"].as_str().unwrap())
            .await
            .unwrap_err();
        println!("LIVE removed member: {removed}");
        assert_eq!(removed, "They are not a member of this table's channel");
    }
}
