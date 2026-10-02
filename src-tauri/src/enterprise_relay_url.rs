use url::Url;

pub(crate) fn parse_enterprise_relay_allowlist(raw: &str) -> Result<Vec<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS must not be empty when set".into());
    }
    raw.split(',')
        .enumerate()
        .map(|(index, value)| {
            let value = value.trim();
            if value.is_empty() {
                return Err(format!(
                    "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS entry {} must not be empty",
                    index + 1
                ));
            }
            canonical_enterprise_relay_url(value)
        })
        .collect()
}

pub(crate) fn validate_enterprise_adapter_url(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|_| "Enterprise authentication adapter is invalid")?;
    let loopback_host = matches!(
        url.host(),
        Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost")
    ) || matches!(
        url.host(),
        Some(url::Host::Ipv4(address)) if address.is_loopback()
    ) || matches!(
        url.host(),
        Some(url::Host::Ipv6(address)) if address.is_loopback()
    );
    let loopback_http = url.scheme() == "http" && loopback_host;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || loopback_http)
    {
        return Err("Enterprise authentication adapter is invalid".into());
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

pub(crate) fn canonical_enterprise_relay_url(raw: &str) -> Result<String, String> {
    let mut url = Url::parse(raw.trim()).map_err(|_| "Invalid enterprise relay URL")?;
    let scheme = match url.scheme() {
        "ws" | "http" => "ws",
        "wss" | "https" => "wss",
        _ => return Err("Enterprise relay URL has an unsupported scheme".into()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not normalize enterprise relay URL")?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Enterprise relay URL must not contain credentials or query data".into());
    }
    if matches!((scheme, url.port()), ("ws", Some(80)) | ("wss", Some(443))) {
        url.set_port(None)
            .map_err(|_| "Could not normalize enterprise relay URL")?;
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.to_string())
}

pub(crate) fn enterprise_relay_http_url(relay: &str) -> Result<Url, String> {
    let mut url = Url::parse(relay).map_err(|_| "Invalid enterprise relay URL")?;
    let scheme = match url.scheme() {
        "wss" => "https",
        "ws" => "http",
        _ => return Err("Invalid enterprise relay URL".into()),
    };
    url.set_scheme(scheme)
        .map_err(|_| "Could not normalize enterprise relay URL")?;
    let path = format!("{}/info", url.path().trim_end_matches('/'));
    url.set_path(&path);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_relay_scheme_and_default_port() {
        assert_eq!(
            canonical_enterprise_relay_url(" https://relay.example:443/ ").unwrap(),
            "wss://relay.example/"
        );
        assert_eq!(
            canonical_enterprise_relay_url("ws://localhost:80").unwrap(),
            "ws://localhost/"
        );
    }

    #[test]
    fn rejects_credentials_query_fragment_and_unsupported_schemes() {
        for value in [
            "wss://user@relay.example",
            "wss://relay.example?tenant=one",
            "wss://relay.example#tenant",
            "file://relay.example",
        ] {
            assert!(canonical_enterprise_relay_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn rejects_empty_allowlist_entries() {
        assert!(parse_enterprise_relay_allowlist("wss://relay.example,").is_err());
    }

    #[test]
    fn build_adapter_validation_accepts_only_loopback_http() {
        for value in [
            "http://localhost:4318/",
            "http://127.0.0.1:4318",
            "http://[::1]:4318",
            "https://adapter.example",
        ] {
            assert!(validate_enterprise_adapter_url(value).is_ok(), "{value}");
        }
        for value in [
            "http://adapter.example",
            "ws://127.0.0.1:4318",
            "https://user:password@adapter.example",
            "https://adapter.example?tenant=one",
            "https://adapter.example#tenant",
        ] {
            assert!(validate_enterprise_adapter_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn maps_websocket_discovery_to_http_info() {
        assert_eq!(
            enterprise_relay_http_url("wss://relay.example/")
                .unwrap()
                .as_str(),
            "https://relay.example/info"
        );
    }
}
