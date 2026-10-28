use std::path::{Path, PathBuf};

#[path = "../build_env.rs"]
mod build_env;

#[path = "../../src-tauri/src/federated_identity/config.rs"]
#[allow(dead_code)]
mod federated_identity_config;

const BUILDERLAB_URL_KEY: &str = "BUZZ_BUILDERLAB_URL";
const BUILDERLAB_APPS_DOMAIN_KEY: &str = "BUZZ_BUILDERLAB_APPS_DOMAIN";
const BUILDERLAB_API_BASE_PATH_KEY: &str = "BUZZ_BUILDERLAB_API_BASE_PATH";
const BUILDERLAB_TENANTS_KEY: &str = "BUZZ_BUILDERLAB_TENANTS";
/// `Manifest::validate` refuses more than 16 network origins; one is kept for
/// the build URL's Apps Platform control plane (`apps_control_plane`).
const MAX_ORIGINS: usize = 15;

fn secure_origin(raw: &str, error: &'static str) -> Result<url::Url, &'static str> {
    let url = url::Url::parse(raw).map_err(|_| error)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error);
    }
    Ok(url)
}

fn builderlab_target(
    local: &Path,
    process: Option<String>,
) -> Result<(String, String), &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_URL_KEY], |_| process.clone())?;
    let raw = values
        .get(BUILDERLAB_URL_KEY)
        .map(String::as_str)
        .unwrap_or("https://app.builderlab.xyz");
    if raw.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let url = secure_origin(
        raw,
        "Builderlab build URL must use HTTPS without credentials, query, or fragment",
    )?;
    // Native backup handoff trusts Builderlab credentials only for this API
    // path, and decisions call under it. Drop one terminal slash, exactly as
    // sign-in's `oauthTarget` does, so all three share the same path.
    let path = url.path();
    let api_base_path = format!("{}/api/goose/", path.strip_suffix('/').unwrap_or(path));
    Ok((url.origin().ascii_serialization(), api_base_path))
}

fn builderlab_apps_domain(
    local: &Path,
    origin: &str,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_APPS_DOMAIN_KEY], |_| process.clone())?;
    let domain = values
        .get(BUILDERLAB_APPS_DOMAIN_KEY)
        .map(String::as_str)
        .unwrap_or(if origin == "https://app.builderlab.xyz" {
            "apps.builderlab.xyz"
        } else {
            ""
        });
    if domain.is_empty() {
        return Ok(String::new());
    }
    let url = url::Url::parse(&format!("https://{domain}"))
        .map_err(|_| "Invalid Builderlab Apps build domain")?;
    if origin.is_empty()
        || !domain.contains('.')
        || domain.len() > 253
        || url.domain() != Some(domain)
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
    {
        return Err("Builderlab Apps build domain must be an exact DNS domain with a login origin");
    }
    Ok(domain.into())
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// The distinct login origins of the `BUZZ_BUILDERLAB_TENANTS` rows, in order.
/// Rows follow the frontend parser's rules (`src/features/identity/builderlab-tenants.ts`):
/// `{relayHost, self?, loginOrigin}`, a lowercase hostname, an optional 64-hex
/// relay key, and a login origin that is exactly its own canonical https origin.
fn tenant_origins(raw: &str) -> Result<Vec<String>, &'static str> {
    const ERROR: &str = "Builderlab tenant table must be a JSON array of {relayHost, self?, loginOrigin} rows with unique hostnames, unique 64-hex relay keys and canonical HTTPS login origins";
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    let rows: serde_json::Value = serde_json::from_str(raw).map_err(|_| ERROR)?;
    let rows = rows.as_array().ok_or(ERROR)?;
    let mut hosts = std::collections::HashSet::new();
    let mut keys = std::collections::HashSet::new();
    let mut origins = Vec::new();
    for row in rows {
        let row = row.as_object().ok_or(ERROR)?;
        if !row
            .keys()
            .all(|key| matches!(key.as_str(), "relayHost" | "self" | "loginOrigin"))
        {
            return Err(ERROR);
        }
        let host = row.get("relayHost").and_then(|v| v.as_str()).ok_or(ERROR)?;
        let host = host.trim().to_ascii_lowercase();
        let host = host.strip_suffix('.').unwrap_or(&host);
        if !valid_hostname(host) || !hosts.insert(host.to_owned()) {
            return Err(ERROR);
        }
        if let Some(key) = row.get("self") {
            let key = key.as_str().ok_or(ERROR)?;
            if key.len() != 64
                || !key
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                || !keys.insert(key.to_owned())
            {
                return Err(ERROR);
            }
        }
        let login = row
            .get("loginOrigin")
            .and_then(|v| v.as_str())
            .ok_or(ERROR)?;
        let origin = secure_origin(login, ERROR)?.origin().ascii_serialization();
        if origin != login {
            return Err(ERROR);
        }
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}

/// Every origin the bundled Builderlab plugin may reach: the build URL's, then
/// each `BUZZ_BUILDERLAB_TENANTS` login origin, deduplicated and comma-joined
/// for `env!`.
fn builderlab_origins(
    local: &Path,
    origin: &str,
    process: Option<String>,
) -> Result<String, &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_TENANTS_KEY], |_| process.clone())?;
    let tenants = values
        .get(BUILDERLAB_TENANTS_KEY)
        .map(String::as_str)
        .unwrap_or("");
    let mut origins: Vec<String> = if origin.is_empty() {
        vec![]
    } else {
        vec![origin.to_owned()]
    };
    for tenant in tenant_origins(tenants)? {
        if !origins.contains(&tenant) {
            origins.push(tenant);
        }
    }
    if origins.len() > MAX_ORIGINS {
        return Err("Too many Builderlab login origins");
    }
    Ok(origins.join(","))
}

#[cfg_attr(test, allow(dead_code))]
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let local = root.join(".env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-env-changed={BUILDERLAB_URL_KEY}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_APPS_DOMAIN_KEY}");
    println!("cargo:rerun-if-env-changed={BUILDERLAB_TENANTS_KEY}");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/build_env.rs").display()
    );
    let process = |key| match std::env::var(key) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    };
    const FI: &str = "BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG";
    println!("cargo:rerun-if-env-changed={FI}");
    let fi = std::env::var(FI)
        .ok()
        .filter(|raw| !raw.is_empty())
        .map(|raw| {
            federated_identity_config::Config::parse(&raw)
                .expect("Invalid FI deployment descriptor")
        });
    println!(
        "cargo:rustc-env={FI}={}",
        fi.as_ref()
            .map(|config| serde_json::to_string(config).expect("public FI descriptor"))
            .unwrap_or_default()
    );
    // An FI build signs in to Builderlab through its NIP-FI identity origin.
    let (origin, api_base_path) = match &fi {
        Some(config) => {
            let legacy = build_env::load(&local, &[BUILDERLAB_URL_KEY], |_| {
                process(BUILDERLAB_URL_KEY)
            })
            .expect("Invalid Builderlab build configuration");
            if legacy
                .get(BUILDERLAB_URL_KEY)
                .is_some_and(|url| !url.is_empty())
            {
                panic!("BUZZ_BUILDERLAB_URL must be removed when FI is configured");
            }
            (config.identity_origin.clone(), config.api_base_path.clone())
        }
        None => builderlab_target(&local, process(BUILDERLAB_URL_KEY))
            .expect("Invalid Builderlab build configuration"),
    };
    let apps_domain = builderlab_apps_domain(&local, &origin, process(BUILDERLAB_APPS_DOMAIN_KEY))
        .expect("Invalid Builderlab Apps build configuration");
    let origins = builderlab_origins(&local, &origin, process(BUILDERLAB_TENANTS_KEY))
        .expect("Invalid Builderlab build configuration");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGIN={origin}");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGINS={origins}");
    println!("cargo:rustc-env={BUILDERLAB_API_BASE_PATH_KEY}={api_base_path}");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_APPS_DOMAIN={apps_domain}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_apps_domain_uses_trusted_build_input_and_public_default() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", None).unwrap(),
            "apps.builderlab.xyz"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            ""
        );
        std::fs::write(&local, "BUZZ_BUILDERLAB_APPS_DOMAIN=apps.example\n").unwrap();
        assert_eq!(
            builderlab_apps_domain(&local, "https://login.example", None).unwrap(),
            "apps.example"
        );
        assert_eq!(
            builderlab_apps_domain(
                &local,
                "https://login.example",
                Some("apps.other.example".into())
            )
            .unwrap(),
            "apps.other.example"
        );
        assert_eq!(
            builderlab_apps_domain(&local, "https://app.builderlab.xyz", Some(String::new()))
                .unwrap(),
            ""
        );
        for domain in [
            "com",
            "https://apps.example",
            "apps.example:443",
            "apps.example/path",
            "apps.example?query",
            "apps.example#part",
            "user@apps.example",
            "127.0.0.1",
            ".apps.example",
        ] {
            assert!(
                builderlab_apps_domain(&local, "https://login.example", Some(domain.into()))
                    .is_err()
            );
        }
        assert!(builderlab_apps_domain(&local, "", Some("apps.example".into())).is_err());
    }

    #[test]
    fn defaults_to_production_unless_explicitly_disabled() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );
        assert_eq!(
            builderlab_apps_domain(&local, &builderlab_target(&local, None).unwrap().0, None)
                .unwrap(),
            "apps.builderlab.xyz"
        );
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL=\n").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (String::new(), String::new())
        );
        assert_eq!(
            builderlab_apps_domain(&local, &builderlab_target(&local, None).unwrap().0, None)
                .unwrap(),
            ""
        );
    }

    #[test]
    fn local_url_and_process_overrides_produce_an_exact_origin_and_api_path() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );
        std::fs::write(
            &local,
            "\u{feff}export BUZZ_BUILDERLAB_URL=\"https://OVERRIDE.EXAMPLE:443/deployment/\" # comment\n",
        )
        .unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (
                "https://override.example".into(),
                "/deployment/api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some("https://login.example:8443/path/".into())).unwrap(),
            (
                "https://login.example:8443".into(),
                "/path/api/goose/".into()
            )
        );
        // Only one slash goes, as in sign-in, so an empty segment is kept.
        assert_eq!(
            builderlab_target(
                &local,
                Some("https://login.example:8443/deployment//".into())
            )
            .unwrap(),
            (
                "https://login.example:8443".into(),
                "/deployment//api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn invalid_configuration_fails_without_echoing_its_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        for configured in [
            "http://localhost:4318",
            "https://user:secret@login.example",
            "https://login.example?",
            "https://login.example#",
            "invalid",
        ] {
            let error = builderlab_target(&local, Some(configured.into())).unwrap_err();
            assert!(!error.contains(configured));
        }
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap_err(),
            "Invalid native build .env.local"
        );
        // Explicit process input also overrides malformed same-key assignments.
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn unrelated_syntax_is_ignored_without_promoting_multiline_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        std::fs::write(&local, "PRIVATE_VALUE='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            ("https://app.builderlab.xyz".into(), "/api/goose/".into())
        );

        for quote in ["'", "\"", "`"] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}multiline\nBUZZ_BUILDERLAB_URL=https://hidden.example\n{quote}\nINVALID=unquoted value\nexport BUZZ_BUILDERLAB_URL=https://after-multiline.example/\nTRAILING='unfinished\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                (
                    "https://after-multiline.example".into(),
                    "/api/goose/".into()
                )
            );
        }
        for quote in ["'", "\""] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}unfinished\nBUZZ_BUILDERLAB_URL=https://hidden.example\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                ("https://app.builderlab.xyz".into(), "/api/goose/".into())
            );
        }
    }

    const TENANTS: &str = r#"[
      {"relayHost":"communities.buzz.xyz","self":"12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3","loginOrigin":"https://app.builderlab.xyz"},
      {"relayHost":"block.builderlab.xyz","self":"76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01","loginOrigin":"https://block.builderlab.xyz"},
      {"relayHost":"test.blockstaging.build","self":"f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1","loginOrigin":"https://test.blockstaging.build"}
    ]"#;

    #[test]
    fn tenant_table_widens_the_grant_to_every_distinct_login_origin() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_origins(&local, "https://app.builderlab.xyz", Some(TENANTS.into())).unwrap(),
            "https://app.builderlab.xyz,https://block.builderlab.xyz,https://test.blockstaging.build"
        );
        // Without the build URL the tenants alone are granted; without rows nothing changes.
        assert_eq!(
            builderlab_origins(
                &local,
                "",
                Some(
                    r#"[{"relayHost":"Relay.Example.","loginOrigin":"https://login.example"}]"#
                        .into()
                )
            )
            .unwrap(),
            "https://login.example"
        );
        assert_eq!(
            builderlab_origins(&local, "", Some(" ".into())).unwrap(),
            ""
        );
        assert_eq!(
            builderlab_origins(&local, "https://login.example", None).unwrap(),
            "https://login.example"
        );
        // The file supplies the table when the process does not.
        std::fs::write(
            &local,
            format!("BUZZ_BUILDERLAB_TENANTS='{}'\n", TENANTS.replace('\n', "")),
        )
        .unwrap();
        assert_eq!(
            builderlab_origins(&local, "https://app.builderlab.xyz", None).unwrap(),
            "https://app.builderlab.xyz,https://block.builderlab.xyz,https://test.blockstaging.build"
        );
        // The manifest keeps one origin for the Apps control plane.
        let rows: Vec<String> = (0..MAX_ORIGINS)
            .map(|i| {
                format!(
                    r#"{{"relayHost":"relay{i}.example","loginOrigin":"https://login{i}.example"}}"#
                )
            })
            .collect();
        let many = format!("[{}]", rows.join(","));
        assert!(builderlab_origins(&local, "", Some(many.clone())).is_ok());
        assert_eq!(
            builderlab_origins(&local, "https://login.example", Some(many)).unwrap_err(),
            "Too many Builderlab login origins"
        );
    }

    #[test]
    fn malformed_tenant_rows_fail_without_echoing_their_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        for tenants in [
            "{",
            r#"{"relayHost":"a.example","loginOrigin":"https://a.example"}"#,
            r#"[{"relayHost":"a.example","loginOrigin":"http://secret.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://user:secret@a.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example/path"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example:443"}]"#,
            r#"[{"relayHost":"https://a.example","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"*.a.example","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example:8443","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example","self":"ABCD","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example","extra":1}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example"},{"relayHost":"A.example","loginOrigin":"https://b.example"}]"#,
        ] {
            let error = builderlab_origins(&local, "", Some(tenants.into())).unwrap_err();
            assert!(!error.contains("secret"), "{error}");
            assert!(!error.contains("a.example"), "{error}");
        }
    }
}
