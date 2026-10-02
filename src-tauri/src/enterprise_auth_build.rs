use crate::enterprise_relay_url::{
    parse_enterprise_relay_allowlist, validate_enterprise_adapter_url,
};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct EnterpriseAuthBuildConfig {
    pub(crate) relays: Option<String>,
    pub(crate) adapter: Option<String>,
}

pub(crate) fn validate_enterprise_auth_build_config(
    relays: Option<&str>,
    adapter: Option<&str>,
) -> Result<EnterpriseAuthBuildConfig, String> {
    let relays = relays.map(|value| value.trim().to_owned());
    let adapter = adapter.map(|value| value.trim().trim_end_matches('/').to_owned());

    if relays.as_deref() == Some("") {
        return Err("BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS must not be empty when set".into());
    }
    if adapter.as_deref() == Some("") {
        return Err(
            "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL must not be empty when set".into(),
        );
    }
    if relays.is_some() && adapter.is_none() {
        return Err(
            "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL is required when BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS is configured".into(),
        );
    }
    if let Some(relays) = relays.as_deref() {
        parse_enterprise_relay_allowlist(relays).map_err(|_| {
            "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS contains an unsupported or unsafe URL"
        })?;
    }
    if let Some(adapter) = adapter.as_deref() {
        validate_enterprise_adapter_url(adapter).map_err(|_| {
            "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL contains an unsupported or unsafe URL"
        })?;
    }

    Ok(EnterpriseAuthBuildConfig { relays, adapter })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_configuration_leaves_enterprise_auth_disabled() {
        assert_eq!(
            validate_enterprise_auth_build_config(None, None).unwrap(),
            EnterpriseAuthBuildConfig {
                relays: None,
                adapter: None,
            }
        );
    }

    #[test]
    fn explicit_empty_configuration_fails_at_the_build_boundary() {
        for relays in [Some(""), Some(" \t\n ")] {
            assert_eq!(
                validate_enterprise_auth_build_config(relays, None).unwrap_err(),
                "BUZZ_BUILD_ENTERPRISE_AUTH_RELAYS must not be empty when set"
            );
        }
        for adapter in [Some(""), Some(" \t\n ")] {
            assert_eq!(
                validate_enterprise_auth_build_config(None, adapter).unwrap_err(),
                "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL must not be empty when set"
            );
        }
    }

    #[test]
    fn paired_empty_adapter_is_not_treated_as_unset() {
        assert_eq!(
            validate_enterprise_auth_build_config(Some("https://relay.example"), Some("  "))
                .unwrap_err(),
            "BUZZ_BUILD_ENTERPRISE_AUTH_ADAPTER_BASE_URL must not be empty when set"
        );
    }

    #[test]
    fn valid_configuration_is_normalized_after_validation() {
        assert_eq!(
            validate_enterprise_auth_build_config(
                Some(" https://relay.example "),
                Some(" https://adapter.example/ ")
            )
            .unwrap(),
            EnterpriseAuthBuildConfig {
                relays: Some("https://relay.example".into()),
                adapter: Some("https://adapter.example".into()),
            }
        );
    }
}
