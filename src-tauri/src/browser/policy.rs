use url::Url;

const MAXIMUM_URL_BYTES: usize = 2048;
pub(super) const CONTROLS_HEIGHT: f64 = 56.0;

#[derive(Clone)]
pub(super) struct NavigationPolicy {
    development_url: Option<Url>,
}

impl NavigationPolicy {
    pub(super) fn new(development_url: Option<Url>) -> Self {
        Self { development_url }
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
        Ok(url)
    }
}

pub(super) fn is_controls_navigation(main_url: &Url, target: &Url) -> bool {
    main_url.scheme() == target.scheme()
        && main_url.host_str() == target.host_str()
        && main_url.port_or_known_default() == target.port_or_known_default()
        && target.path() == "/browser.html"
        && target.username().is_empty()
        && target.password().is_none()
}

#[derive(Debug, PartialEq)]
pub(super) struct BrowserLayout {
    pub width: f64,
    pub controls_height: f64,
    pub content_height: f64,
}

pub(super) fn browser_layout(width: f64, height: f64) -> BrowserLayout {
    let controls_height = height.clamp(0.0, CONTROLS_HEIGHT);
    BrowserLayout {
        width: width.max(0.0),
        controls_height,
        content_height: (height - controls_height).max(0.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn controls_navigation_accepts_only_its_exact_application_origin_and_page() {
        for main in [
            "tauri://localhost/index.html",
            "http://tauri.localhost",
            "http://localhost:1430/",
        ] {
            let main_url = Url::parse(main).unwrap();
            let controls_url = main_url.join("/browser.html").unwrap();
            assert!(is_controls_navigation(&main_url, &controls_url));
            for denied in [
                "https://example.com/browser.html",
                "http://localhost:1431/browser.html",
                "tauri://untrusted/browser.html",
                "file:///browser.html",
            ] {
                assert!(!is_controls_navigation(
                    &main_url,
                    &Url::parse(denied).unwrap()
                ));
            }
            assert!(!is_controls_navigation(
                &main_url,
                &main_url.join("/index.html").unwrap()
            ));
        }
    }

    #[test]
    fn controls_keep_their_height_when_content_resizes() {
        assert_eq!(
            browser_layout(1200.0, 800.0),
            BrowserLayout {
                width: 1200.0,
                controls_height: 56.0,
                content_height: 744.0
            }
        );
        assert_eq!(
            browser_layout(480.0, 320.0),
            BrowserLayout {
                width: 480.0,
                controls_height: 56.0,
                content_height: 264.0
            }
        );
        assert_eq!(
            browser_layout(0.0, 10.0),
            BrowserLayout {
                width: 0.0,
                controls_height: 10.0,
                content_height: 0.0
            }
        );
    }
}
