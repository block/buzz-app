use url::Url;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_https_or_loopback_http() {
        for value in [
            "http://localhost:4318/",
            "http://127.0.0.1:4318",
            "http://[::1]:4318",
            "https://adapter.example",
        ] {
            assert!(validate_enterprise_adapter_url(value).is_ok(), "{value}");
        }
    }

    #[test]
    fn rejects_non_secure_or_credentialed_values() {
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
}
