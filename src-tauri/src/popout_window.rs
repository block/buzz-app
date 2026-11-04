//! Pop-out conversation windows: presentation-only companions of the main
//! window, as the Huddle window is. Identity, relay, signing, the outbox and
//! read state stay in main; each companion receives one bounded `View` and
//! sends bounded actions back. A window is bound to one conversation target in
//! one session incarnation; watch, action and download calls are checked
//! against the caller's own label and binding.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, WebviewWindow};

use crate::huddle_window::DiscussionRow;

type Result<T> = std::result::Result<T, String>;
const PREFIX: &str = "popout-";

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    scope: String,
    viewer: String,
    channel_id: String,
    /// The thread root; a whole conversation (S2) leaves it empty.
    #[serde(default)]
    thread_root_id: Option<String>,
    /// Owner session incarnation. Actions from an earlier incarnation are
    /// dropped: a reloaded main renderer never replays a stale send.
    incarnation: u64,
}
impl Binding {
    fn target(&self) -> (String, String, String, Option<String>) {
        (
            self.scope.clone(),
            self.viewer.clone(),
            self.channel_id.clone(),
            self.thread_root_id.clone(),
        )
    }
    fn valid(&self) -> bool {
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        self.scope.len() <= 4096
            && !self.scope.is_empty()
            && hex(&self.viewer)
            && !self.channel_id.is_empty()
            && self.channel_id.len() <= 256
            && self.thread_root_id.as_deref().is_none_or(hex)
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct View {
    title: String,
    dark: bool,
    status: String,
    #[serde(default)]
    error: Option<String>,
    writable: bool,
    can_load_more: bool,
    limited: bool,
    loading_older: bool,
    /// Main publishes reading intent for this window when true.
    reading: bool,
    #[serde(default)]
    composer: Option<String>,
    version: u64,
    /// Native-owned: increments when the OS asked to close while the companion
    /// holds unsaved work, so it can confirm. Never set by main.
    #[serde(default)]
    close_requested: u64,
    /// Native-owned: the owner is gone (main reload); the companion shows its
    /// cached rows read-only until main retires or re-adopts it.
    #[serde(default)]
    detached: bool,
    #[serde(default)]
    root: Option<DiscussionRow>,
    replies: Vec<DiscussionRow>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    OpenLink,
    OpenInMain,
    Send,
    Older,
    Retry,
    RetryMessage,
    DiscardMessage,
    /// Companion holds unsaved/pending work (text "1") or not ("0"); native
    /// close requests then ask before destroying the window.
    Guard,
    /// Companion confirmed a guarded close.
    Close,
    /// Reading observation: text is a bounded JSON lease message for main.
    Reading,
    Closed,
}
#[derive(Clone, Serialize)]
pub(crate) struct Control {
    label: String,
    incarnation: u64,
    action: Action,
    text: Option<String>,
}
struct Session {
    binding: Binding,
    view: View,
    guarded: bool,
    actions: Channel<Control>,
    updates: Option<Channel<View>>,
}
#[derive(Default)]
pub(crate) struct Popouts(Mutex<HashMap<String, Session>>);

impl Popouts {
    /// Downloads are limited to attachment sources in this window's own projection.
    pub(crate) fn permits_download(&self, label: &str, source: &str, name: &str) -> bool {
        self.0.lock().ok().is_some_and(|map| {
            map.get(label).is_some_and(|session| {
                session
                    .view
                    .root
                    .iter()
                    .chain(&session.view.replies)
                    .flat_map(|row| &row.attachments)
                    .any(|attachment| {
                        attachment.source.as_deref() == Some(source)
                            && attachment.name.as_deref().unwrap_or("") == name
                    })
            })
        })
    }
}

pub(crate) fn is_popout(label: &str) -> bool {
    label.starts_with(PREFIX)
}
fn require_main<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the main window owns pop-out windows".into())
    }
}
fn require_popout<R: tauri::Runtime>(window: &WebviewWindow<R>) -> Result<String> {
    if is_popout(window.label()) {
        Ok(window.label().to_owned())
    } else {
        Err("Not a pop-out window".into())
    }
}
fn validate(view: &View) -> Result<()> {
    if view.title.len() > 4096
        || view.error.as_ref().is_some_and(|e| e.len() > 8192)
        || !matches!(view.status.as_str(), "loading" | "ready" | "error")
        || view
            .composer
            .as_ref()
            .is_some_and(|t| uuid::Uuid::parse_str(t).is_err())
        || view.replies.len() > 500
        || view
            .root
            .iter()
            .chain(&view.replies)
            .any(|row| !row.valid())
    {
        return Err("Invalid pop-out presentation".into());
    }
    Ok(())
}
fn closed_notice(
    actions: Channel<Control>,
    label: String,
    incarnation: u64,
) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    let actions = Mutex::new(Some(actions));
    move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let Some(actions) = actions.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let label = label.clone();
        // Channel send AND final drop evaluate JavaScript. Neither may reenter
        // Wry while it destroys its window map under a mutable RefCell borrow.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = actions.send(Control {
                label,
                incarnation,
                action: Action::Closed,
                text: None,
            });
        });
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened {
    label: String,
    /// The target already had a window; it was focused and keeps its owner.
    existing: bool,
}

/// Open or focus the window for a target. A binding that is already open keeps
/// its current session; the caller then updates that label instead.
#[tauri::command]
pub(crate) async fn popout_window_open<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, Popouts>,
    binding: Binding,
    view: View,
    actions: Channel<Control>,
) -> Result<Opened> {
    require_main(&window)?;
    if !binding.valid() {
        return Err("Invalid pop-out target".into());
    }
    validate(&view)?;
    let app = window.app_handle();
    let label = {
        let mut map = host.0.lock().map_err(|_| "Pop-out windows unavailable")?;
        if map.len() >= 16 {
            return Err("Too many pop-out windows are open".into());
        }
        let target = binding.target();
        if let Some((label, _)) = map.iter().find(|(_, s)| s.binding.target() == target) {
            let label = label.clone();
            if let Some(existing) = app.get_webview_window(&label) {
                existing.show().map_err(|e| e.to_string())?;
                existing.set_focus().map_err(|e| e.to_string())?;
                return Ok(Opened {
                    label,
                    existing: true,
                });
            }
            // The window is gone but its session lingered: replace it.
            map.remove(&label);
        }
        let label = format!("{PREFIX}{}", uuid::Uuid::new_v4());
        map.insert(
            label.clone(),
            Session {
                binding: binding.clone(),
                view: View {
                    close_requested: 0,
                    detached: false,
                    ..view
                },
                guarded: false,
                actions: actions.clone(),
                updates: None,
            },
        );
        label
    };
    let on_closed = closed_notice(actions, label.clone(), binding.incarnation);
    let built =
        tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App("popout.html".into()))
            .title("Buzz")
            .inner_size(520.0, 640.0)
            .min_inner_size(360.0, 400.0)
            .center()
            .disable_drag_drop_handler()
            .build();
    let companion = match built {
        Ok(companion) => companion,
        Err(error) => {
            if let Ok(mut map) = host.0.lock() {
                map.remove(&label);
            }
            return Err(error.to_string());
        }
    };
    companion.on_window_event(on_closed);
    companion.show().map_err(|e| e.to_string())?;
    companion.set_focus().map_err(|e| e.to_string())?;
    Ok(Opened {
        label,
        existing: false,
    })
}

/// Replace a window's presentation; `None` retires the window.
#[tauri::command]
pub(crate) fn popout_window_update<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, Popouts>,
    label: String,
    view: Option<View>,
) -> Result<()> {
    require_main(&window)?;
    if let Some(view) = &view {
        validate(view)?;
    }
    let mut map = host.0.lock().map_err(|_| "Pop-out windows unavailable")?;
    let Some(session) = map.get_mut(&label) else {
        return Ok(());
    };
    if let Some(view) = view {
        let next = View {
            close_requested: session.view.close_requested,
            detached: false,
            ..view
        };
        if let Some(updates) = &session.updates {
            let _ = updates.send(next.clone());
        }
        session.view = next;
        if let Some(companion) = window.app_handle().get_webview_window(&label) {
            let _ = companion.set_title(&format!("{} — Buzz", session.view.title));
        }
    } else {
        map.remove(&label);
        drop(map);
        if let Some(companion) = window.app_handle().get_webview_window(&label) {
            companion.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The main renderer is reloading or gone: every companion keeps its cached
/// rows but can no longer act. Main retires or re-adopts them when it returns.
pub(crate) fn detach_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(host) = app.try_state::<Popouts>() else {
        return;
    };
    let Ok(mut map) = host.0.lock() else {
        return;
    };
    for session in map.values_mut() {
        if session.view.detached {
            continue;
        }
        session.view.detached = true;
        session.view.composer = None;
        session.view.writable = false;
        if let Some(updates) = &session.updates {
            let _ = updates.send(session.view.clone());
        }
    }
}

/// Labels of windows opened before the main renderer reloaded.
#[tauri::command]
pub(crate) fn popout_window_detached<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, Popouts>,
) -> Result<Vec<String>> {
    require_main(&window)?;
    let map = host.0.lock().map_err(|_| "Pop-out windows unavailable")?;
    Ok(map
        .iter()
        .filter(|(_, s)| s.view.detached)
        .map(|(label, _)| label.clone())
        .collect())
}

#[tauri::command]
pub(crate) fn popout_window_watch<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, Popouts>,
    updates: Channel<View>,
) -> Result<()> {
    let label = require_popout(&window)?;
    let mut map = host.0.lock().map_err(|_| "Pop-out windows unavailable")?;
    let session = map
        .get_mut(&label)
        .ok_or("This pop-out window has closed")?;
    updates
        .send(session.view.clone())
        .map_err(|e| e.to_string())?;
    session.updates = Some(updates);
    Ok(())
}

#[tauri::command]
pub(crate) fn popout_window_action<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, Popouts>,
    action: Action,
    text: Option<String>,
) -> Result<()> {
    let label = require_popout(&window)?;
    match action {
        Action::Closed => return Err("Window closure is native-owned".into()),
        Action::Send | Action::RetryMessage | Action::DiscardMessage | Action::Reading => {
            if text
                .as_ref()
                .is_none_or(|t| t.trim().is_empty() || t.len() > 65536)
            {
                return Err("Invalid pop-out message".into());
            }
        }
        Action::OpenLink => {
            if text.as_ref().is_none_or(|url| {
                !url.get(..5)
                    .is_some_and(|scheme| scheme.eq_ignore_ascii_case("buzz:"))
                    || url.len() > 8192
            }) {
                return Err("Invalid pop-out link".into());
            }
        }
        Action::Guard => {
            if !matches!(text.as_deref(), Some("0") | Some("1")) {
                return Err("Invalid pop-out guard".into());
            }
        }
        _ => {
            if text.is_some() {
                return Err("Unexpected pop-out message".into());
            }
        }
    }
    let app = window.app_handle();
    let mut map = host.0.lock().map_err(|_| "Pop-out windows unavailable")?;
    let session = map
        .get_mut(&label)
        .ok_or("This pop-out window has closed")?;
    match action {
        Action::Guard => {
            session.guarded = text.as_deref() == Some("1");
            return Ok(());
        }
        Action::Close => {
            drop(map);
            if let Some(companion) = app.get_webview_window(&label) {
                companion.destroy().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        // Both continue in the main window, which may be hidden on macOS.
        Action::OpenInMain | Action::OpenLink => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
        }
        _ => {}
    }
    if session.view.detached {
        return Err("Buzz is reconnecting. Try again from the main window.".into());
    }
    let incarnation = session.binding.incarnation;
    session
        .actions
        .send(Control {
            label,
            incarnation,
            action,
            text,
        })
        .map_err(|e| e.to_string())
}

/// OS or menu close: an unguarded window closes; a guarded one asks its
/// companion to confirm. Returns true when the close was intercepted.
pub(crate) fn close_requested<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    api: &tauri::CloseRequestApi,
) -> bool {
    if !is_popout(window.label()) {
        return false;
    }
    let Some(host) = window.try_state::<Popouts>() else {
        return false;
    };
    let Ok(mut map) = host.0.lock() else {
        return false;
    };
    let Some(session) = map.get_mut(window.label()) else {
        return false;
    };
    if !session.guarded {
        return false;
    }
    api.prevent_close();
    session.view.close_requested += 1;
    if let Some(updates) = &session.updates {
        let _ = updates.send(session.view.clone());
    }
    true
}

/// Cmd+W with a pop-out focused closes that window through its guard.
pub(crate) fn close_focused<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let labels: Vec<String> = app
        .try_state::<Popouts>()
        .and_then(|host| host.0.lock().ok().map(|map| map.keys().cloned().collect()))
        .unwrap_or_default();
    for label in labels {
        let Some(window) = app.get_webview_window(&label) else {
            continue;
        };
        if window.is_focused().unwrap_or(false) {
            let _ = window.close();
            return true;
        }
    }
    false
}

/// Window destroyed by any path: forget its session.
pub(crate) fn destroyed<R: tauri::Runtime>(window: &tauri::Window<R>) {
    if !is_popout(window.label()) {
        return;
    }
    if let Some(host) = window.try_state::<Popouts>() {
        if let Ok(mut map) = host.0.lock() {
            map.remove(window.label());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            scope: "wss://relay.example".into(),
            viewer: "a".repeat(64),
            channel_id: "channel-1".into(),
            thread_root_id: Some("b".repeat(64)),
            incarnation: 1,
        }
    }
    fn view() -> View {
        View {
            title: "Design".into(),
            dark: false,
            status: "ready".into(),
            error: None,
            writable: true,
            can_load_more: false,
            limited: false,
            loading_older: false,
            reading: true,
            composer: None,
            version: 1,
            close_requested: 0,
            detached: false,
            root: None,
            replies: vec![],
        }
    }
    #[test]
    fn binding_requires_hex_identities_and_bounded_ids() {
        assert!(binding().valid());
        let mut b = binding();
        b.viewer = "nothex".into();
        assert!(!b.valid());
        let mut b = binding();
        b.thread_root_id = Some("short".into());
        assert!(!b.valid());
        let mut b = binding();
        b.channel_id = "x".repeat(257);
        assert!(!b.valid());
        let mut b = binding();
        b.thread_root_id = None;
        assert!(b.valid());
    }
    #[test]
    fn targets_ignore_incarnation_so_a_reloaded_owner_focuses_the_same_window() {
        let mut later = binding();
        later.incarnation = 7;
        assert_eq!(binding().target(), later.target());
    }
    #[test]
    fn presentation_is_bounded() {
        assert!(validate(&view()).is_ok());
        let mut v = view();
        v.status = "weird".into();
        assert!(validate(&v).is_err());
        let mut v = view();
        v.title = "x".repeat(4097);
        assert!(validate(&v).is_err());
        let mut v = view();
        v.composer = Some("not-a-uuid".into());
        assert!(validate(&v).is_err());
        let decoded: View = serde_json::from_value(serde_json::to_value(view()).unwrap()).unwrap();
        assert_eq!(decoded.title, "Design");
    }
    #[test]
    fn labels_are_recognized_by_prefix() {
        assert!(is_popout("popout-1234"));
        assert!(!is_popout("main"));
        assert!(!is_popout("huddle"));
    }
    #[test]
    fn destruction_sends_closed_off_the_event_thread_once() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;
        let (sender, receiver) = mpsc::channel();
        let actions = Channel::new(move |_| {
            sender.send(thread::current().id()).unwrap();
            Ok(())
        });
        let notice = closed_notice(actions, "popout-x".into(), 1);
        notice(&tauri::WindowEvent::Destroyed);
        notice(&tauri::WindowEvent::Destroyed);
        let thread = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_ne!(thread, thread::current().id());
        drop(notice);
        assert!(receiver.recv().is_err());
    }
}
