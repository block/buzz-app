//! Build-owned relay trust. User preferences and process runtime cannot override it.
use crate::enterprise_relay_url::canonical_enterprise_relay_url;

#[derive(Debug)]
pub(crate) struct RelayPolicy {
    pinned: String,
    allowlist: Vec<String>,
    /// `*.suffix` entries as suffix origins: each permits one more DNS label.
    wildcards: Vec<String>,
}

/// A policy entry is `host` or `host:port`; it matches both `wss://` and `https://`.
fn host_origin(entry: &serde_json::Value) -> Option<String> {
    let host = entry.as_str()?;
    if host.contains(['/', '*']) {
        return None;
    }
    canonical_enterprise_relay_url(&format!("wss://{host}")).ok()
}

/// `*.suffix[:port]`: the suffix must have at least two labels, so `*.com` fails.
fn wildcard_origin(entry: &str) -> Option<String> {
    let origin = host_origin(&serde_json::Value::from(entry.strip_prefix("*.")?))?;
    let url = url::Url::parse(&origin).ok()?;
    let Some(url::Host::Domain(host)) = url.host() else {
        return None;
    };
    host.contains('.').then_some(origin)
}

/// True when `origin` is exactly one DNS label under a wildcard suffix origin.
fn matches_wildcard(origin: &str, wildcard: &str) -> bool {
    let host = &origin["wss://".len()..];
    let suffix = format!(".{}", &wildcard["wss://".len()..]);
    host.strip_suffix(&suffix)
        .is_some_and(|label| !label.is_empty() && !label.contains('.'))
}

impl RelayPolicy {
    pub(crate) fn parse(raw: Option<&str>) -> Result<Option<Self>, String> {
        let Some(raw) = raw else { return Ok(None) };
        let parse = || -> Option<Self> {
            let value: serde_json::Value = serde_json::from_str(raw).ok()?;
            let object = value.as_object()?;
            if object.len() != 2 {
                return None;
            }
            let pinned = host_origin(object.get("pinned")?)?;
            let entries = object.get("allowlist")?.as_array()?;
            let wild =
                |entry: &serde_json::Value| entry.as_str().is_some_and(|e| e.starts_with("*."));
            let allowlist = entries
                .iter()
                .filter(|entry| !wild(entry))
                .map(host_origin)
                .collect::<Option<Vec<_>>>()?;
            let wildcards = entries
                .iter()
                .filter(|entry| wild(entry))
                .map(|entry| wildcard_origin(entry.as_str()?))
                .collect::<Option<Vec<_>>>()?;
            Some(Self {
                pinned,
                allowlist,
                wildcards,
            })
        };
        parse().map(Some).ok_or_else(|| "BUZZ_BUILD_RELAY_POLICY must be a JSON object with a pinned relay host and an allowlist array of relay hosts, each as host, host:port or *.host.".into())
    }

    pub(crate) fn check(&self, value: &str) -> Result<(), String> {
        let origin = canonical_enterprise_relay_url(value)?;
        if origin == self.pinned
            || self.allowlist.contains(&origin)
            || self
                .wildcards
                .iter()
                .any(|wildcard| matches_wildcard(&origin, wildcard))
        {
            Ok(())
        } else {
            Err("This relay is not allowed by this build's relay policy.".into())
        }
    }

    pub(crate) fn removable(&self, value: &str) -> Result<(), String> {
        self.check(value)?;
        if canonical_enterprise_relay_url(value)? == self.pinned {
            Err("The pinned relay cannot be removed from this build.".into())
        } else {
            Ok(())
        }
    }
}

fn configured() -> &'static Option<RelayPolicy> {
    static POLICY: std::sync::OnceLock<Option<RelayPolicy>> = std::sync::OnceLock::new();
    POLICY.get_or_init(|| {
        RelayPolicy::parse(option_env!("BUZZ_BUILD_RELAY_POLICY"))
            .expect("Invalid compiled relay policy")
    })
}

pub(crate) fn allowed(value: &str) -> Result<(), String> {
    configured()
        .as_ref()
        .map_or(Ok(()), |policy| policy.check(value))
}

pub(crate) fn removable(value: &str) -> Result<(), String> {
    configured()
        .as_ref()
        .map_or(Ok(()), |policy| policy.removable(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_policy_is_unrestricted_and_malformed_policy_fails() {
        assert!(RelayPolicy::parse(None).unwrap().is_none());
        for raw in [
            "",
            "{}",
            r#"{"pinned":"relay.example"}"#,
            r#"{"pinned":"relay.example","allowlist":[42]}"#,
            r#"{"pinned":"wss://relay.example","allowlist":[]}"#,
            r#"{"pinned":"relay.example","allowlist":["other.example/path"]}"#,
            r#"{"pinned":"*.relay.example","allowlist":[]}"#,
            r#"{"pinned":"relay.example","allowlist":["*.example"]}"#,
            r#"{"pinned":"relay.example","allowlist":["a.*.example"]}"#,
            r#"{"pinned":"relay.example","allowlist":["*.*.relay.example"]}"#,
            r#"{"pinned":"relay.example","allowlist":["*.1.2.3.4"]}"#,
        ] {
            assert!(RelayPolicy::parse(Some(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn matches_hosts_on_either_scheme_and_exact_port() {
        let policy = RelayPolicy::parse(Some(
            r#"{"pinned":"relay.example","allowlist":["other.example:8443"]}"#,
        ))
        .unwrap()
        .unwrap();
        for allowed in [
            "wss://relay.example",
            "https://RELAY.example:443/",
            "wss://other.example:8443",
            "https://other.example:8443",
        ] {
            assert!(policy.check(allowed).is_ok(), "{allowed}");
        }
        for blocked in [
            "wss://other.example",
            "wss://relay.example:8443",
            "wss://sub.relay.example",
            "wss://relay.example.evil",
        ] {
            assert!(policy.check(blocked).is_err(), "{blocked}");
        }
        assert!(policy.removable("wss://other.example:8443").is_ok());
        assert!(policy
            .removable("https://relay.example")
            .unwrap_err()
            .contains("pinned relay"));
    }

    #[test]
    fn matches_wildcard_entries_for_exactly_one_label_on_their_port() {
        let policy = RelayPolicy::parse(Some(
            r#"{"pinned":"relay.example","allowlist":["*.communities.example","*.staging.example:8443"]}"#,
        ))
        .unwrap()
        .unwrap();
        for allowed in [
            "wss://a.communities.example",
            "https://B.Communities.Example:443/",
            "wss://c.staging.example:8443",
        ] {
            assert!(policy.check(allowed).is_ok(), "{allowed}");
        }
        for blocked in [
            "wss://communities.example",
            "wss://a.b.communities.example",
            "wss://a.communities.example:8443",
            "wss://acommunities.example",
            "wss://a.communities.example.evil",
            "wss://c.staging.example",
        ] {
            assert!(policy.check(blocked).is_err(), "{blocked}");
        }
    }
}
