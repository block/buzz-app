use url::Url;

const MAXIMUM_URL_BYTES: usize = 2048;

/// `BUZZ_BUILD_BROWSER_INTERNAL_HOSTS`: comma-separated domains this build treats as
/// internal, each with its subdomains. Empty (the default) leaves websites unzoned.
const INTERNAL_HOSTS: &str = match option_env!("BUZZ_BUILD_BROWSER_INTERNAL_HOSTS") {
    Some(hosts) => hosts,
    None => "",
};

/// Which side of the build's internal hosts a zoned session is pinned to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Zone {
    Internal,
    External,
}

#[derive(Clone)]
pub(super) struct NavigationPolicy {
    development_url: Option<Url>,
    internal_hosts: Vec<String>,
    /// Set by `pin` when the build has internal hosts; never changes afterwards.
    zone: Option<Zone>,
}

impl NavigationPolicy {
    pub(super) fn new(development_url: Option<Url>) -> Self {
        Self::with_internal_hosts(development_url, INTERNAL_HOSTS)
    }

    /// `internal_hosts` is comma-separated, as build.rs validated it.
    fn with_internal_hosts(development_url: Option<Url>, internal_hosts: &str) -> Self {
        Self {
            development_url,
            internal_hosts: internal_hosts
                .split(',')
                .filter(|host| !host.is_empty())
                .map(String::from)
                .collect(),
            zone: None,
        }
    }

    /// Pins the session to `first`'s zone, when the build divides websites into
    /// zones. Every later navigation and, on macOS, every request stays in it.
    pub(super) fn pin(&mut self, first: &Url) {
        if !self.internal_hosts.is_empty() {
            self.zone = Some(self.zone_of(first));
        }
    }

    fn zone_of(&self, url: &Url) -> Zone {
        // `console.example.` names the same host as `console.example`.
        let host = url.host_str().unwrap_or_default().trim_end_matches('.');
        let internal = self.internal_hosts.iter().any(|domain| {
            host == domain
                || host
                    .strip_suffix(domain.as_str())
                    .is_some_and(|prefix| prefix.ends_with('.'))
        });
        if internal {
            Zone::Internal
        } else {
            Zone::External
        }
    }

    /// WebKit content rules that block the pinned session's requests outside its
    /// zone, so a page cannot reach the other zone with fetch, images or frames.
    pub(super) fn content_rules(&self) -> Option<String> {
        let zone = self.zone?;
        let block = |filter: &str| serde_json::json!({ "trigger": { "url-filter": filter }, "action": { "type": "block" } });
        let allow = |filter: &str| {
            serde_json::json!({
                "trigger": { "url-filter": filter },
                "action": { "type": "ignore-previous-rules" },
            })
        };
        // The scheme, optional user info, optional subdomains, the domain, and an
        // optional root dot and port, then the path.
        let internal = self.internal_hosts.iter().map(|domain| {
            format!(
                "^[^:]+://([^/?#@]*@)?([^/?#@:]*\\.)?{}\\.?(:[0-9]*)?/",
                domain.replace('.', "\\.")
            )
        });
        let rules: Vec<_> = match zone {
            Zone::External => internal.map(|filter| block(&filter)).collect(),
            Zone::Internal => std::iter::once(block(".*"))
                .chain(internal.map(|filter| allow(&filter)))
                .chain(["^data:", "^blob:", "^about:"].map(allow))
                .collect(),
        };
        Some(serde_json::Value::from(rules).to_string())
    }

    pub(super) fn validate(&self, target: &str) -> Result<Url, String> {
        if target.len() > MAXIMUM_URL_BYTES {
            return Err("Browser URLs cannot exceed 2048 bytes".into());
        }
        let url = Url::parse(target)
            .map_err(|_| "Enter a complete http:// or https:// URL".to_string())?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err("Buzz Browser supports HTTP and HTTPS websites only".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("URLs containing credentials are not supported".into());
        }
        if matches!(
            url.host_str(),
            Some("tauri.localhost" | "asset.localhost" | "ipc.localhost")
        ) || self
            .development_url
            .as_ref()
            .is_some_and(|development| development.origin() == url.origin())
        {
            return Err("Buzz application URLs cannot be opened as websites".into());
        }
        if url.as_str().len() > MAXIMUM_URL_BYTES {
            return Err("Browser URLs cannot exceed 2048 bytes after URL encoding".into());
        }
        match self.zone {
            Some(zone) if self.zone_of(&url) != zone => Err(match zone {
                Zone::Internal => "This view opens only internal websites".into(),
                Zone::External => "This view cannot open internal websites".into(),
            }),
            _ => Ok(url),
        }
    }

    /// The http address to load when `url` fails over https, if this policy permits it.
    pub(super) fn http_fallback(&self, url: &Url) -> Option<Url> {
        if url.scheme() != "https" {
            return None;
        }
        let mut http = url.clone();
        http.set_scheme("http").ok()?;
        self.validate(http.as_str()).ok()
    }
}

/// The Builderlab portal's tool-app approval page. Approving needs the
/// portal's own web login, which a Buzz guest never has (it only holds an app
/// viewer cookie), so Buzz opens this page in the system browser instead.
#[derive(Clone)]
pub(super) struct ApprovalGate {
    url: Url,
    apps_domain: &'static str,
}

impl ApprovalGate {
    const SUFFIX: &'static str = "/v1/hosted-app-tools/gate";

    /// The gate of the portal whose API lives at `adapter_base`, for apps
    /// under `apps_domain`. A build without an Apps domain has none.
    pub(super) fn new(adapter_base: &str, apps_domain: &'static str) -> Option<Self> {
        if apps_domain.is_empty() {
            return None;
        }
        let url = Url::parse(&format!("{adapter_base}{}", Self::SUFFIX)).ok()?;
        Some(Self { url, apps_domain })
    }

    /// When `target` is this gate for a Builderlab app, the approval to hand
    /// off: the gate rebuilt with only its app, and the app's address to
    /// return to once approved.
    pub(super) fn approval(&self, target: &str) -> Option<Approval> {
        let target = Url::parse(target).ok()?;
        if target.origin() != self.url.origin()
            || target.path().trim_end_matches('/') != self.url.path()
        {
            return None;
        }
        let mut apps = target
            .query_pairs()
            .filter(|(name, _)| name == "app")
            .map(|(_, value)| value.into_owned());
        let app = apps.next().filter(|_| apps.next().is_none())?;
        let app_url = Url::parse(&format!("https://{app}/")).ok()?;
        let host = app_url.host_str()?;
        if host != app.to_ascii_lowercase() {
            return None;
        }
        let root = super::builderlab::app_root(self.apps_domain, app_url.as_str()).ok()?;
        let mut gate = self.url.clone();
        gate.query_pairs_mut().append_pair("app", host);
        Some(Approval {
            gate: gate.into(),
            app: root,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Approval {
    pub(super) gate: String,
    pub(super) app: String,
}

/// Coordinates relative to the main webview's CSS viewport.
#[derive(Clone, Copy, Debug, serde::Deserialize, PartialEq)]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl BrowserBounds {
    pub(super) fn validate(self) -> Result<(), String> {
        if ![self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
        {
            return Err(
                "Browser viewport must have finite, positive dimensions within the app".into(),
            );
        }
        Ok(())
    }

    #[cfg(any(target_os = "macos", target_os = "windows", test))]
    pub(super) fn clip(self, width: f64, height: f64) -> Result<Self, String> {
        self.validate()?;
        let clipped = Self {
            width: self.width.min(width - self.x),
            height: self.height.min(height - self.y),
            ..self
        };
        clipped.validate()?;
        Ok(clipped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_only_the_portal_approval_gate() {
        let gate = ApprovalGate::new(
            "https://app.builderlab.xyz/api/goose",
            "apps.builderlab.xyz",
        )
        .unwrap();
        assert!(ApprovalGate::new("https://app.builderlab.xyz/api/goose", "").is_none());
        let expected = Approval {
            gate: "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=eggy--bpsites.apps.builderlab.xyz".into(),
            app: "https://eggy--bpsites.apps.builderlab.xyz/".into(),
        };
        assert_eq!(
            gate.approval("https://APP.builderlab.xyz/api/goose/v1/hosted-app-tools/gate/?app=Eggy--bpsites.apps.builderlab.xyz&next=https://evil.example"),
            Some(expected)
        );
        for other in [
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz&app=b.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.example",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=localhost",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=127.0.0.1",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=tauri.localhost",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.b.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=login.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz.evil.example",
            "https://app.builderlab.xyz:8443/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz/path",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz:8443",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=user@a.apps.builderlab.xyz",
            "https://app.builderlab.xyz/api/goose/v1/hosted-app-tools/consent.js?app=a.apps.builderlab.xyz",
            "https://app.builderlabstaging.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "http://app.builderlab.xyz/api/goose/v1/hosted-app-tools/gate?app=a.apps.builderlab.xyz",
            "https://eggy--bpsites.apps.builderlab.xyz/",
            "not a url",
        ] {
            assert_eq!(gate.approval(other), None, "{other}");
        }
    }

    #[test]
    fn permits_websites_and_normalizes_host_names() {
        let policy = NavigationPolicy::new(None);
        assert_eq!(
            policy
                .validate("https://EXAMPLE.com/a?q=x#part")
                .unwrap()
                .as_str(),
            "https://example.com/a?q=x#part"
        );
        assert!(policy.validate("http://127.0.0.1:5123/page").is_ok());
    }

    #[test]
    fn http_fallback_keeps_the_address_and_explicit_port() {
        let policy = NavigationPolicy::new(Some(Url::parse("http://localhost:1430").unwrap()));
        let fallback = |target: &str| {
            policy
                .http_fallback(&Url::parse(target).unwrap())
                .map(String::from)
        };
        assert_eq!(
            fallback("https://grugbrain.dev/a?q=x#part").as_deref(),
            Some("http://grugbrain.dev/a?q=x#part")
        );
        assert_eq!(
            fallback("https://localhost:3000/").as_deref(),
            Some("http://localhost:3000/")
        );
        assert_eq!(
            fallback("https://example.com:443/").as_deref(),
            Some("http://example.com/")
        );
        assert_eq!(fallback("http://example.com/"), None);
        assert_eq!(fallback("https://localhost:1430/"), None);
    }

    #[test]
    fn denies_non_web_schemes_credentials_and_application_origins() {
        let policy = NavigationPolicy::new(Some(Url::parse("http://localhost:1430").unwrap()));
        for target in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,x",
            "tauri://localhost",
            "https://user@example.com",
            "https://user:password@example.com",
            "https://tauri.localhost/page",
            "http://ipc.localhost",
            "https://asset.localhost/private",
            "http://localhost:1430/browser.html",
        ] {
            assert!(policy.validate(target).is_err(), "{target}");
        }
        assert!(policy.validate("http://localhost:1431").is_ok());
    }

    #[test]
    fn enforces_url_limit_in_bytes() {
        let policy = NavigationPolicy::new(None);
        let prefix = "https://example.com/";
        assert!(policy
            .validate(&format!("{prefix}{}", "a".repeat(2048 - prefix.len())))
            .is_ok());
        assert!(policy
            .validate(&format!("{prefix}{}", "a".repeat(2049 - prefix.len())))
            .is_err());
        assert!(policy
            .validate(&format!("{prefix}{}", "🦀".repeat(600)))
            .is_err());
    }

    #[test]
    fn enforces_url_limit_after_percent_encoding() {
        let policy = NavigationPolicy::new(None);
        let target = format!("https://example.com/{}", "🦀".repeat(200));
        assert!(target.len() < MAXIMUM_URL_BYTES);
        assert!(policy.validate(&target).is_err());
    }

    #[test]
    fn viewport_rejects_invalid_or_offscreen_rectangles() {
        let bounds = BrowserBounds {
            x: 500.0,
            y: 80.0,
            width: 400.0,
            height: 600.0,
        };
        for invalid in [
            BrowserBounds { x: -1.0, ..bounds },
            BrowserBounds {
                y: f64::NAN,
                ..bounds
            },
            BrowserBounds {
                width: f64::INFINITY,
                ..bounds
            },
            BrowserBounds {
                height: 0.0,
                ..bounds
            },
        ] {
            assert!(invalid.validate().is_err());
        }
        assert!(bounds.clip(500.0, 800.0).is_err());
        assert!(bounds.clip(1200.0, 80.0).is_err());
    }

    #[test]
    fn viewport_clips_to_main_webview() {
        let bounds = BrowserBounds {
            x: 500.0,
            y: 80.0,
            width: 400.0,
            height: 600.0,
        };
        assert_eq!(
            bounds.clip(800.0, 600.0).unwrap(),
            BrowserBounds {
                width: 300.0,
                height: 520.0,
                ..bounds
            }
        );
        assert_eq!(bounds.clip(1200.0, 800.0).unwrap(), bounds);
    }

    fn pinned(first: &str) -> NavigationPolicy {
        let mut policy = NavigationPolicy::with_internal_hosts(None, "example.org,corp.example");
        policy.pin(&Url::parse(first).unwrap());
        policy
    }

    #[test]
    fn unzoned_builds_keep_every_website() {
        let mut policy = NavigationPolicy::with_internal_hosts(None, "");
        policy.pin(&Url::parse("https://example.org/").unwrap());
        assert!(policy.validate("https://example.org/").is_ok());
        assert!(policy.validate("https://example.com/").is_ok());
        assert_eq!(policy.content_rules(), None);
    }

    #[test]
    fn a_session_stays_in_its_first_websites_zone() {
        let internal = pinned("https://console.example.org/a");
        let external = pinned("https://example.com/");
        for target in [
            "https://example.org/",
            "https://CONSOLE.Example.org:8443/x",
            "https://a.b.corp.example/",
            "https://console.example.org./",
        ] {
            assert!(internal.validate(target).is_ok(), "{target}");
            assert_eq!(
                external.validate(target).unwrap_err(),
                "This view cannot open internal websites",
                "{target}"
            );
        }
        for target in [
            "https://example.com/",
            "https://notexample.org/",
            "https://example.org.example.com/",
            "https://example.organic/",
            "http://127.0.0.1:5123/",
        ] {
            assert!(external.validate(target).is_ok(), "{target}");
            assert_eq!(
                internal.validate(target).unwrap_err(),
                "This view opens only internal websites",
                "{target}"
            );
        }
        // The http fallback is a navigation like any other.
        let url = Url::parse("https://console.example.org/").unwrap();
        assert!(internal.http_fallback(&url).is_some());
        assert!(external.http_fallback(&url).is_none());
    }

    /// Whether WebKit would block `url` under `rules`. url-filter patterns are
    /// case-insensitive by default; the rules use only syntax common to both dialects.
    fn blocked(rules: &str, url: &str) -> bool {
        let rules: Vec<serde_json::Value> = serde_json::from_str(rules).unwrap();
        rules.iter().fold(false, |blocked, rule| {
            let filter = rule["trigger"]["url-filter"].as_str().unwrap();
            let matches = regex::RegexBuilder::new(filter)
                .case_insensitive(true)
                .build()
                .unwrap()
                .is_match(url);
            match (matches, rule["action"]["type"].as_str().unwrap()) {
                (true, "block") => true,
                (true, "ignore-previous-rules") => false,
                _ => blocked,
            }
        })
    }

    #[test]
    fn content_rules_block_requests_to_the_other_zone() {
        let internal = pinned("https://console.example.org/")
            .content_rules()
            .unwrap();
        let external = pinned("https://example.com/").content_rules().unwrap();
        for url in [
            "https://example.org/",
            "https://a.b.example.org:8443/x?y",
            "wss://console.example.org/socket",
            "https://console.example.org./",
            "https://user@console.example.org/",
            "https://user:secret@console.corp.example/",
        ] {
            assert!(!blocked(&internal, url), "{url}");
            assert!(blocked(&external, url), "{url}");
        }
        for url in [
            "https://example.com/",
            "https://evilexample.org/",
            "https://example.org.example.com/",
            "https://console.example.org@example.com/",
            "https://console.example.org:443@example.com/",
            "https://example.com/?next=https://console.example.org/",
            "https://example.com/#console.example.org/",
        ] {
            assert!(blocked(&internal, url), "{url}");
            assert!(!blocked(&external, url), "{url}");
        }
        for url in [
            "data:image/png;base64,AA==",
            "blob:https://console.example.org/1",
        ] {
            assert!(!blocked(&internal, url), "{url}");
        }
    }
}
