use std::{sync::OnceLock, time::Duration};

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use crate::enterprise_relay_url::{
    canonical_enterprise_relay_url, enterprise_relay_http_url, parse_enterprise_relay_allowlist,
};

const MAX_DISCOVERY_BODY: usize = 128 * 1024;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "status")]
pub(crate) enum EnterpriseLoginGateStatus {
    NotRequired,
    Required,
}

#[tauri::command]
pub(crate) async fn enterprise_login_gate(
    relay_url: String,
) -> Result<EnterpriseLoginGateStatus, String> {
    let trusted = configured_trusted_relays()?;
    if trusted.is_empty() {
        return Ok(EnterpriseLoginGateStatus::NotRequired);
    }
    if !trusted_relay_matches(&relay_url, &trusted)? {
        return Ok(EnterpriseLoginGateStatus::NotRequired);
    }
    let relay = canonical_enterprise_relay_url(&relay_url)?;

    let response = client()?
        .get(enterprise_relay_http_url(&relay)?)
        .header("Accept", "application/nostr+json")
        .send()
        .await
        .map_err(|_| "Enterprise community discovery failed".to_owned())?;
    if !response.status().is_success() {
        return Err("Enterprise community discovery failed".into());
    }
    let body = read_bounded(response).await?;
    let document: Value = serde_json::from_slice(&body)
        .map_err(|_| "Enterprise community discovery was invalid".to_owned())?;
    evaluate_trusted_enterprise_login_gate(&document)
}

fn trusted_relay_matches(relay_url: &str, trusted: &[String]) -> Result<bool, String> {
    if trusted.is_empty() {
        return Ok(false);
    }
    let relay = canonical_enterprise_relay_url(relay_url)?;
    Ok(trusted.iter().any(|trusted| trusted == &relay))
}

fn configured_trusted_relays() -> Result<Vec<String>, String> {
    option_env!("BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS")
        .map(parse_enterprise_relay_allowlist)
        .transpose()
        .map(|relays| relays.unwrap_or_default())
}

fn evaluate_trusted_enterprise_login_gate(
    document: &Value,
) -> Result<EnterpriseLoginGateStatus, String> {
    let limitation_requires = match document
        .get("limitation")
        .and_then(|limitation| limitation.get("federated_identity"))
    {
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err("Enterprise identity discovery was invalid".into()),
        None => false,
    };
    let Some(discovery) = document.get("federated_identity") else {
        return Err(if limitation_requires {
            "Enterprise identity discovery was incomplete".into()
        } else {
            "This trusted community did not advertise supported enterprise login".into()
        });
    };
    if !limitation_requires {
        return Err("Enterprise identity discovery was inconsistent".into());
    }
    let Some(discovery) = discovery.as_object() else {
        return Err("Enterprise identity discovery was invalid".into());
    };
    if discovery.get("core").and_then(Value::as_str) != Some("client-attached") {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    let Some(freshness) = discovery
        .get("assertion_freshness")
        .and_then(Value::as_object)
    else {
        return Err("Enterprise identity discovery was incomplete".into());
    };
    if freshness.get("class").and_then(Value::as_str) != Some("offline-jwt") {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    if !matches!(
        freshness.get("maximum_residual_upstream_revocation_seconds"),
        None | Some(Value::Null)
    ) {
        return Err("This community advertised an unsupported enterprise login".into());
    }
    Ok(EnterpriseLoginGateStatus::Required)
}

fn client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Enterprise network client is unavailable".into())
}

async fn read_bounded(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DISCOVERY_BODY as u64)
    {
        return Err("Enterprise community discovery was too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Enterprise community discovery failed".to_owned())?
    {
        if chunk.len() > MAX_DISCOVERY_BODY - body.len() {
            return Err("Enterprise community discovery was too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn discovery_document() -> Value {
        serde_json::json!({
            "limitation": { "federated_identity": true },
            "federated_identity": {
                "core": "client-attached",
                "assertion_freshness": {
                    "class": "offline-jwt",
                    "maximum_residual_upstream_revocation_seconds": null
                }
            }
        })
    }

    #[test]
    fn matching_advertisement_requires_login() {
        assert_eq!(
            evaluate_trusted_enterprise_login_gate(&discovery_document()).unwrap(),
            EnterpriseLoginGateStatus::Required
        );
    }

    #[test]
    fn missing_or_inconsistent_advertisement_fails_closed() {
        for document in [
            serde_json::json!({}),
            serde_json::json!({
                "limitation": { "federated_identity": false },
                "federated_identity": {}
            }),
        ] {
            assert!(evaluate_trusted_enterprise_login_gate(&document).is_err());
        }
    }

    #[test]
    fn unsupported_freshness_is_rejected() {
        let mut document = discovery_document();
        document["federated_identity"]["assertion_freshness"]["class"] =
            Value::String("current-status".into());
        assert!(evaluate_trusted_enterprise_login_gate(&document).is_err());
    }

    #[test]
    fn ordinary_relays_bypass_the_trusted_gate() {
        let trusted = vec!["wss://enterprise.example/".to_owned()];
        assert!(!trusted_relay_matches("https://ordinary.example/", &trusted).unwrap());
        assert!(!trusted_relay_matches("https://ordinary.example/", &[]).unwrap());
    }
}
