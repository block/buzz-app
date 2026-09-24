//! OS deep-link ingress. The shell holds raw URL strings in a small queue until the
//! webview drains them, so a link that launched the app is not lost. Every parse and
//! every authorization decision stays in TypeScript: a valid address is not
//! authorization, and the navigation target parser remains the single gate.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::utils::config::PluginConfig;
use tauri::{ipc::Channel, Manager};

/// The scheme in-app links use, and the only one the webview ever sees. Which
/// scheme the OS routes here is a configuration question: `tauri.conf.json`
/// declares it and a launcher's `--scheme` may overlay another
/// (`scripts/desktop-config.mjs`), so an accepted link is rewritten to this scheme
/// before it is queued and nothing downstream learns how it arrived.
const CANONICAL_SCHEME: &str = "buzz";

/// A cold start can receive links before the webview exists. The newest are kept so
/// a late reader still sees the user's latest intent. The OS bounds each URL's size.
const MAX_PENDING: usize = 32;

/// Sent to the webview when the queue grows. It carries no URL; the webview drains.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub(crate) struct Pending {
    pending: usize,
}

#[derive(Default)]
struct Queue {
    urls: VecDeque<String>,
    watcher: Option<Channel<Pending>>,
    /// Empty until `setup` reads the compiled config. An unconfigured shell refuses
    /// every link, which is also all the OS would have routed to it.
    schemes: Vec<String>,
}

#[derive(Clone, Default)]
pub(crate) struct DeepLinks(Arc<Mutex<Queue>>);

fn scheme(raw: &str) -> Option<&str> {
    raw.split_once(':').map(|(scheme, _)| scheme)
}

/// RFC 3986 scheme syntax, lower case. An invalid scheme registers nowhere and
/// fails silently on every platform, so it is not worth admitting links under.
fn is_scheme(candidate: &str) -> bool {
    let mut chars = candidate.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "+-.".contains(c))
}

/// The schemes the OS may route here, as the compiled config declares them. The
/// plugin reads the same value for `register_all` and its argv filter, so this gate
/// cannot drift from what the OS actually delivers. `desktop` is one protocol object
/// or a list of them; anything syntactically invalid is left out.
fn configured_schemes(plugins: &PluginConfig) -> Vec<String> {
    let desktop = plugins.0.get("deep-link").and_then(|c| c.get("desktop"));
    let protocols = match desktop {
        Some(serde_json::Value::Array(list)) => list.iter().collect(),
        Some(value) => vec![value],
        None => Vec::new(),
    };
    protocols
        .iter()
        .filter_map(|protocol| protocol.get("schemes")?.as_array())
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .filter(|candidate| is_scheme(candidate))
        .map(str::to_owned)
        .collect()
}

/// Exactly one of the registered schemes, compared before any URL normalization, and
/// then rewritten to `buzz:`. A wrongly routed `http:` link or an upper-case variant
/// never reaches the webview from here; past this gate the link is an ordinary in-app
/// link whichever scheme the OS used to deliver it.
fn normalize(raw: &str, schemes: &[String]) -> Option<String> {
    let scheme = scheme(raw)?;
    schemes
        .iter()
        .any(|registered| registered == scheme)
        .then(|| format!("{CANONICAL_SCHEME}:{}", &raw[scheme.len() + 1..]))
}

impl DeepLinks {
    /// Record which schemes the OS may route here, before any link can arrive.
    fn configure(&self, schemes: &[String]) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "Deep link state unavailable")?;
        queue.schemes = schemes.to_vec();
        Ok(())
    }
    /// Hold one OS-delivered URL for the webview.
    fn push(&self, raw: &str) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "Deep link state unavailable")?;
        let Some(url) = normalize(raw, &queue.schemes) else {
            return Err("Not a registered deep-link scheme".to_owned());
        };
        if queue.urls.len() >= MAX_PENDING {
            queue.urls.pop_front();
        }
        queue.urls.push_back(url);
        let pending = Pending {
            pending: queue.urls.len(),
        };
        if let Some(watcher) = &queue.watcher {
            // A stale channel from a reloaded webview drops the ping; the new page
            // drains on startup anyway.
            let _ = watcher.send(pending);
        }
        Ok(())
    }
    /// Everything held so far, oldest first. The queue is empty afterwards.
    fn drain(&self) -> Result<Vec<String>, String> {
        let mut queue = self.0.lock().map_err(|_| "Deep link state unavailable")?;
        Ok(queue.urls.drain(..).collect())
    }
    fn watch(&self, channel: Channel<Pending>) -> Result<(), String> {
        let mut queue = self.0.lock().map_err(|_| "Deep link state unavailable")?;
        queue.watcher = Some(channel);
        Ok(())
    }
}

/// Foreground Buzz on the main thread, as notification clicks already do.
pub(crate) fn focus_main<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("main") else {
            return;
        };
        if let Err(error) = crate::notifications::focus(&window) {
            eprintln!("Could not focus Buzz for a deep link: {error}");
        }
    }) {
        eprintln!("Could not focus Buzz for a deep link: {error}");
    }
}

fn accept<R: tauri::Runtime>(app: &tauri::AppHandle<R>, raw: &str) {
    match app.state::<DeepLinks>().push(raw) {
        Ok(()) => focus_main(app),
        // The URL itself is not logged; it may carry a message locator.
        Err(error) => eprintln!(
            "Ignored an OS link with scheme {:?}: {error}",
            scheme(raw).unwrap_or_default()
        ),
    }
}

/// Adopt the configured schemes, subscribe to the plugin, and pick up a launch URL
/// it already parsed.
pub(crate) fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let schemes = configured_schemes(&app.config().plugins);
    if schemes.is_empty() {
        eprintln!("No usable deep-link scheme is configured; OS links will be ignored");
    }
    if let Err(error) = app.state::<DeepLinks>().configure(&schemes) {
        eprintln!("Could not adopt the configured deep-link schemes: {error}");
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            accept(&handle, url.as_str());
        }
    });
    // Windows and Linux receive the launch URL as argv, which the plugin parsed
    // during its own setup before this listener existed. macOS delivers cold-start
    // URLs through the event above once the run loop starts.
    #[cfg(any(windows, target_os = "linux"))]
    {
        match app.deep_link().get_current() {
            Ok(Some(urls)) => {
                for url in urls {
                    accept(app, url.as_str());
                }
            }
            Ok(None) => {}
            Err(error) => eprintln!("Could not read the launch deep link: {error}"),
        }
        // Installers register the scheme; portable and development binaries do not.
        if let Err(error) = app.deep_link().register_all() {
            eprintln!(
                "Could not register {} for this binary: {error}",
                schemes
                    .iter()
                    .map(|scheme| format!("{scheme}://"))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
}

#[tauri::command]
pub(crate) fn deep_link_take<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, DeepLinks>,
) -> Result<Vec<String>, String> {
    if window.label() != "main" {
        return Err("Deep links belong to the main window".into());
    }
    state.drain()
}

#[tauri::command]
pub(crate) fn deep_link_watch<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    state: tauri::State<'_, DeepLinks>,
    on_event: Channel<Pending>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Deep links belong to the main window".into());
    }
    state.watch(on_event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;

    /// A launch given `--scheme` overlays a scheme like this one; none of the tests
    /// may depend on the committed value beyond the one test that reads it.
    const OVERLAID: &str = "buzz-dev-3fa9c1";

    /// A shell configured the way `setup` configures one from an overlaid config.
    fn overlaid() -> DeepLinks {
        let links = DeepLinks::default();
        links.configure(&[OVERLAID.to_owned()]).unwrap();
        links
    }

    /// An in-app style channel link as the OS delivers it, under the overlaid scheme.
    fn delivered(id: impl std::fmt::Display) -> String {
        format!("{OVERLAID}://channel/{id}")
    }

    /// What the webview must see for `delivered(id)`: the same address, canonical.
    fn queued(id: impl std::fmt::Display) -> String {
        format!("{CANONICAL_SCHEME}://channel/{id}")
    }

    fn plugins(value: serde_json::Value) -> PluginConfig {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_committed_config_declares_the_canonical_scheme_and_nothing_else() {
        // No build overlays a scheme unless its launcher was given `--scheme`, so
        // this value is what an installed Buzz Foundation and a plain `just desktop`
        // both claim, and it must be the scheme in-app links and **Copy link**
        // already use. Vitest checks the same file against the webview's `buzz:`
        // guard.
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["deep-link"]["desktop"]["schemes"],
            serde_json::json!([CANONICAL_SCHEME])
        );
        assert!(is_scheme(CANONICAL_SCHEME));
    }

    #[test]
    fn the_configured_schemes_come_from_the_merged_plugin_config() {
        assert_eq!(
            configured_schemes(&plugins(serde_json::json!({
                "deep-link": { "desktop": { "schemes": [OVERLAID] } }
            }))),
            vec![OVERLAID.to_owned()]
        );
        // The plugin also accepts a list of protocol objects.
        assert_eq!(
            configured_schemes(&plugins(serde_json::json!({
                "deep-link": { "desktop": [{ "schemes": ["buzz"] }, { "schemes": [OVERLAID] }] }
            }))),
            vec!["buzz".to_owned(), OVERLAID.to_owned()]
        );
        // Nothing registrable configured, in every shape it can take.
        for value in [
            serde_json::json!({}),
            serde_json::json!({ "deep-link": {} }),
            serde_json::json!({ "deep-link": { "desktop": {} } }),
            serde_json::json!({ "deep-link": { "desktop": { "schemes": [] } } }),
            serde_json::json!({ "deep-link": { "desktop": { "schemes": "buzz" } } }),
            serde_json::json!({ "deep-link": { "mobile": [{ "host": "example.com" }] } }),
            // Syntactically invalid schemes register nowhere, so they gate nothing.
            serde_json::json!({ "deep-link": { "desktop": { "schemes": ["Buzz", "1buzz", "bu zz", "", "buzz_app", 7] } } }),
        ] {
            assert_eq!(
                configured_schemes(&plugins(value.clone())),
                Vec::<String>::new(),
                "{value}"
            );
        }
    }

    #[test]
    fn an_unconfigured_shell_accepts_nothing() {
        let links = DeepLinks::default();
        for raw in [delivered("general"), queued("general")] {
            assert!(links.push(&raw).is_err(), "{raw}");
        }
        assert!(links.drain().unwrap().is_empty());
    }

    #[test]
    fn only_the_exact_configured_scheme_is_accepted_and_it_is_rewritten() {
        let links = overlaid();
        for (raw, expected) in [
            (delivered("general"), queued("general")),
            (
                format!("{OVERLAID}://message?channel=general&id={}", "a".repeat(64)),
                format!(
                    "{CANONICAL_SCHEME}://message?channel=general&id={}",
                    "a".repeat(64)
                ),
            ),
            (
                format!("{OVERLAID}://join?relay=example"),
                format!("{CANONICAL_SCHEME}://join?relay=example"),
            ),
            (
                format!("{OVERLAID}:agent-activity?agent=x"),
                format!("{CANONICAL_SCHEME}:agent-activity?agent=x"),
            ),
            (format!("{OVERLAID}:"), format!("{CANONICAL_SCHEME}:")),
        ] {
            assert_eq!(
                normalize(&raw, &[OVERLAID.to_owned()]),
                Some(expected),
                "{raw}"
            );
        }
        for raw in [
            format!("{}://channel/general", OVERLAID.to_uppercase()),
            "http://example.com".to_owned(),
            format!("https://{OVERLAID}"),
            OVERLAID.to_owned(),
            String::new(),
            format!(" {OVERLAID}://channel/general"),
            "javascript:alert(1)".to_owned(),
            format!("x{OVERLAID}://channel/general"),
            format!("{OVERLAID}x://channel/general"),
            // The canonical scheme is not registered unless the config says so.
            queued("general"),
        ] {
            assert_eq!(normalize(&raw, &[OVERLAID.to_owned()]), None, "{raw}");
            assert!(links.push(&raw).is_err(), "{raw}");
        }
        assert!(links.drain().unwrap().is_empty());
    }

    #[test]
    fn a_release_build_admits_its_own_canonical_links_unchanged() {
        let links = DeepLinks::default();
        links.configure(&[CANONICAL_SCHEME.to_owned()]).unwrap();
        links.push(&queued("general")).unwrap();
        assert!(links.push(&delivered("general")).is_err());
        assert_eq!(links.drain().unwrap(), vec![queued("general")]);
    }

    #[test]
    fn held_links_drain_oldest_first_and_only_once() {
        let links = overlaid();
        for id in ["a", "b", "c"] {
            links.push(&delivered(id)).unwrap();
        }
        assert_eq!(
            links.drain().unwrap(),
            vec![queued("a"), queued("b"), queued("c")]
        );
        assert_eq!(links.drain().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn the_bound_keeps_the_newest_links() {
        let links = overlaid();
        for index in 0..MAX_PENDING + 2 {
            links.push(&delivered(index)).unwrap();
        }
        let held = links.drain().unwrap();
        assert_eq!(held.len(), MAX_PENDING);
        assert_eq!(held.first().cloned(), Some(queued(2)));
        assert_eq!(held.last().cloned(), Some(queued(MAX_PENDING + 1)));
    }

    #[test]
    fn rejected_schemes_are_never_held() {
        let links = overlaid();
        assert!(links
            .push(&format!(
                "https://example.com/?next={}",
                delivered("general")
            ))
            .is_err());
        assert!(links
            .push(&format!("{}://channel/general", OVERLAID.to_uppercase()))
            .is_err());
        assert!(links.drain().unwrap().is_empty());
    }

    #[test]
    fn a_watcher_learns_the_queue_depth_without_receiving_urls() {
        let links = overlaid();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        links
            .watch(Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    output.lock().unwrap().push(json);
                }
                Ok(())
            }))
            .unwrap();
        links.push(&delivered("a")).unwrap();
        links.push(&delivered("b")).unwrap();
        assert!(links.push("http://example.com").is_err());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![r#"{"pending":1}"#.to_owned(), r#"{"pending":2}"#.to_owned()]
        );
        assert_eq!(links.drain().unwrap().len(), 2);
    }
}
