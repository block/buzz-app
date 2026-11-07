//! Compact discovery uses a host-built filter and the identity of its own HTTP attempt.
use super::*;

const TYPES: [&str; 5] = ["dm", "forum", "stream", "system", "workflow"];
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
pub(crate) struct MembershipResponse {
    request_id: String,
    signer_pubkey: String,
    origin: String,
    status: u16,
    body: String,
}

#[tauri::command]
pub(crate) async fn relay_membership_snapshot(
    host: tauri::State<'_, IdentityHost>,
    fi: tauri::State<'_, FederatedIdentity>,
    community: String,
    types: Vec<String>,
    id: String,
) -> Result<MembershipResponse> {
    snapshot(host.inner(), fi.inner(), &community, &types, &id).await
}

async fn snapshot(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    community: &str,
    types: &[String],
    id: &str,
) -> Result<MembershipResponse> {
    let url = request_url(community, "/query", "POST")?;
    let cancelled = || MembershipResponse {
        request_id: String::new(),
        signer_pubkey: String::new(),
        origin: url.origin().ascii_serialization(),
        status: CANCELLED_READ,
        body: String::new(),
    };
    cancellable_result(
        Some(id),
        "POST",
        "/query",
        async {
            let viewer = host.viewer().await?;
            let body = filter(&viewer, types)?;
            let assertion = evidence(host, Some(fi), &url).await?;
            let (response, identity) = send_correlated(
                host,
                AuthorizationContext {
                    fi: Some(fi),
                    assertion: assertion.as_ref(),
                },
                url.clone(),
                "POST",
                Some(body),
                true,
                MAX_BYTES,
            )
            .await?;
            let identity = identity.ok_or("Missing request identity")?;
            Ok(MembershipResponse {
                request_id: identity.request_id,
                signer_pubkey: identity.signer_pubkey,
                origin: identity.origin,
                status: response.status,
                body: response.body,
            })
        },
        cancelled,
    )
    .await
}

fn filter(viewer: &str, types: &[String]) -> Result<String> {
    if !hex_key(viewer)
        || types.is_empty()
        || types.len() > TYPES.len()
        || types.iter().any(|value| !TYPES.contains(&value.as_str()))
        || types.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err("Invalid membership types".into());
    }
    serde_json::to_string(&serde_json::json!([{
        "kinds": [39008], "#p": [viewer], "#t": types, "membership_snapshot": 1
    }]))
    .map_err(|_| "Invalid membership request".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_is_host_scoped_and_bounded() {
        let viewer = "ab".repeat(32);
        let body: serde_json::Value =
            serde_json::from_str(&filter(&viewer, &["dm".into(), "stream".into()]).unwrap())
                .unwrap();
        assert_eq!(
            body,
            serde_json::json!([{"kinds":[39008], "#p":[viewer], "#t":["dm","stream"], "membership_snapshot":1}])
        );
        for types in [
            vec![],
            vec!["bogus".into()],
            vec!["dm".into(), "dm".into()],
            vec!["stream".into(), "dm".into()],
        ] {
            assert!(filter(&viewer, &types).is_err());
        }
    }

    #[tokio::test]
    async fn actual_auth_identity_is_correlated_and_disabled_body_survives() {
        use crate::federated_identity::testing::{community, reply};
        let community = community(false).await;
        let body = r#"{"error":"membership_snapshot unsupported"}"#;
        let server = community.serve(vec![reply("404 Not Found", body), reply("200 OK", "[]")]);
        let mut results = Vec::new();
        for _ in 0..2 {
            let result = snapshot(
                &community.host,
                &community.fi,
                community.origin.as_str(),
                &["stream".into()],
                &uuid::Uuid::new_v4().to_string(),
            )
            .await
            .unwrap();
            assert_eq!(result.signer_pubkey, community.host.viewer().await.unwrap());
            assert_eq!(
                result.origin,
                community.origin.origin().ascii_serialization()
            );
            results.push(result);
        }
        assert_eq!(results[0].status, 404);
        assert_eq!(results[0].body, body);
        assert_ne!(results[0].request_id, results[1].request_id);
        for (head, result) in server.heads().await.iter().zip(results) {
            let header = head
                .lines()
                .find_map(|line| {
                    line.split_once(":")
                        .filter(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value.trim())
                })
                .unwrap();
            let auth: serde_json::Value = serde_json::from_slice(
                &STANDARD
                    .decode(header.strip_prefix("Nostr ").unwrap())
                    .unwrap(),
            )
            .unwrap();
            verify_signature(&auth).unwrap();
            assert_eq!(auth["id"], result.request_id);
            assert_eq!(auth["pubkey"], result.signer_pubkey);
            let body = filter(&result.signer_pubkey, &["stream".into()]).unwrap();
            assert!(auth["tags"]
                .as_array()
                .unwrap()
                .contains(&serde_json::json!([
                    "payload",
                    format!("{:x}", Sha256::digest(body.as_bytes()))
                ])));
        }
    }
}
