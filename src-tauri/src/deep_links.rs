//! OS `buzz://` ingress. The shell holds raw URL strings in a small queue until the
//! webview drains them, so a link that launched the app is not lost. Every parse and
//! every authorization decision stays in TypeScript: a valid address is not
//! authorization, and the navigation target parser remains the single gate.
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tauri::{ipc::Channel, Manager};

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
}

#[derive(Clone, Default)]
pub(crate) struct DeepLinks(Arc<Mutex<Queue>>);

fn scheme(raw: &str) -> Option<&str> {
    raw.split_once(':').map(|(scheme, _)| scheme)
}

/// Exactly the registered scheme, compared before any URL normalization. A wrongly
/// routed `http:` link or a `BUZZ:` variant never reaches the webview from here.
pub(crate) fn accepts(raw: &str) -> bool {
    scheme(raw) == Some("buzz")
}

impl DeepLinks {
    /// Hold one OS-delivered URL for the webview.
    fn push(&self, raw: &str) -> Result<(), String> {
        if !accepts(raw) {
            return Err("Only buzz: links are accepted".into());
        }
        let mut queue = self.0.lock().map_err(|_| "Deep link state unavailable")?;
        if queue.urls.len() >= MAX_PENDING {
            queue.urls.pop_front();
        }
        queue.urls.push_back(raw.to_owned());
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

/// Subscribe to the plugin and pick up a launch URL it already parsed.
pub(crate) fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
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
            eprintln!("Could not register the buzz:// scheme for this binary: {error}");
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

    #[test]
    fn only_the_exact_buzz_scheme_is_accepted() {
        for raw in [
            "buzz://channel/general",
            "buzz://open?target=%7B%7D",
            "buzz://join?relay=example",
            "buzz:agent-activity?agent=x",
            "buzz:",
        ] {
            assert!(accepts(raw), "{raw}");
        }
        for raw in [
            "BUZZ://channel/general",
            "Buzz://channel/general",
            "http://example.com",
            "https://buzz",
            "buzz",
            "",
            " buzz://channel/general",
            "javascript:alert(1)",
            "xbuzz://channel/general",
        ] {
            assert!(!accepts(raw), "{raw}");
        }
    }

    #[test]
    fn held_links_drain_oldest_first_and_only_once() {
        let links = DeepLinks::default();
        for id in ["a", "b", "c"] {
            links.push(&format!("buzz://channel/{id}")).unwrap();
        }
        assert_eq!(
            links.drain().unwrap(),
            vec![
                "buzz://channel/a".to_owned(),
                "buzz://channel/b".to_owned(),
                "buzz://channel/c".to_owned(),
            ]
        );
        assert_eq!(links.drain().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn the_bound_keeps_the_newest_links() {
        let links = DeepLinks::default();
        for index in 0..MAX_PENDING + 2 {
            links.push(&format!("buzz://channel/{index}")).unwrap();
        }
        let held = links.drain().unwrap();
        assert_eq!(held.len(), MAX_PENDING);
        assert_eq!(held.first().map(String::as_str), Some("buzz://channel/2"));
        assert_eq!(
            held.last().cloned(),
            Some(format!("buzz://channel/{}", MAX_PENDING + 1))
        );
    }

    #[test]
    fn rejected_schemes_are_never_held() {
        let links = DeepLinks::default();
        assert!(links
            .push("https://example.com/?next=buzz://channel/general")
            .is_err());
        assert!(links.push("BUZZ://channel/general").is_err());
        assert!(links.drain().unwrap().is_empty());
    }

    #[test]
    fn a_watcher_learns_the_queue_depth_without_receiving_urls() {
        let links = DeepLinks::default();
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
        links.push("buzz://channel/a").unwrap();
        links.push("buzz://channel/b").unwrap();
        assert!(links.push("http://example.com").is_err());
        assert_eq!(
            *seen.lock().unwrap(),
            vec![r#"{"pending":1}"#.to_owned(), r#"{"pending":2}"#.to_owned()]
        );
        assert_eq!(links.drain().unwrap().len(), 2);
    }
}
