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
    /// The owner's persistence scope, for message links the companion copies.
    #[serde(default)]
    scope: String,
    dark: bool,
    /// The main window's applied appearance (mode, accent, contrast, text scale).
    #[serde(default)]
    appearance: Option<crate::huddle_window::Appearance>,
    status: String,
    #[serde(default)]
    error: Option<String>,
    writable: bool,
    can_load_more: bool,
    limited: bool,
    loading_older: bool,
    /// Reading bridge token: main publishes reading intent for this window.
    #[serde(default)]
    reading: Option<String>,
    reading_revision: u64,
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
    /// Main's outbox operations in this channel: reactions, removals, edits
    /// and sent-to-channel copies, in every delivery state.
    #[serde(default)]
    operations: Vec<MainOperation>,
    /// The viewer follows this thread.
    #[serde(default)]
    following: bool,
    /// A DM or Solo chat: no `#`, no thread following offered.
    #[serde(default)]
    is_dm: bool,
    /// What kind of conversation: `channel`, `private`, `dm` or `solo`.
    #[serde(default = "default_kind")]
    kind: String,
    /// A DM's other person's picture (authorized media source).
    #[serde(default)]
    picture: Option<String>,
    /// The conversation's members as main's header previews them.
    #[serde(default)]
    members: Option<Members>,
    /// A thread (root + replies) rather than a conversation timeline.
    #[serde(default)]
    thread: bool,
    /// The frame was opened from the previous one; `back` returns there.
    #[serde(default)]
    can_go_back: bool,
    /// People typing and agents working here, as names.
    #[serde(default)]
    typing: Option<Typing>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Typing {
    humans: Vec<String>,
    more: u32,
    agents: Vec<String>,
}
impl Typing {
    fn valid(&self) -> bool {
        self.humans.len() <= 2
            && self.agents.len() <= 8
            && self
                .humans
                .iter()
                .chain(&self.agents)
                .all(|n| n.len() <= 1024)
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MainOperation {
    id: String,
    #[serde(default)]
    message_id: Option<String>,
    kind: u32,
    delivery: String,
    #[serde(default)]
    error: Option<String>,
}
impl MainOperation {
    fn valid(&self) -> bool {
        let hex = |s: &str| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit());
        hex(&self.id)
            && self.message_id.as_deref().is_none_or(hex)
            && matches!(self.kind, 7 | 5 | 40003 | 9)
            && matches!(
                self.delivery.as_str(),
                "sending" | "accepted" | "unknown" | "failed" | "seen"
            )
            && self.error.as_ref().is_none_or(|e| e.len() <= 2048)
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    OpenLink,
    OpenInMain,
    /// Open the conversation's members/access in the main window.
    OpenMembers,
    /// Bring the main window forward after a handoff admitted through the
    /// composer bridge; nothing is forwarded to main.
    FocusMain,
    /// A conversation window drills into one of its shown threads (text: root id).
    OpenThread,
    /// Return to the frame this one was opened from.
    Back,
    Older,
    Retry,
    RetryMessage,
    DiscardMessage,
    /// Companion holds unsaved/pending work (text "1") or not ("0"); native
    /// close requests then ask before destroying the window.
    Guard,
    /// Companion confirmed a guarded close.
    Close,
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
impl View {
    /// The OS title bar names what the window is, as Slack does: "Thread in
    /// #channel" (a DM has no `#`).
    /// Names the conversation and its kind where no icon can: "#design",
    /// "Ada (DM)", "Planning (Solo chat)"; a thread frame says so first.
    fn window_title(&self) -> String {
        let conversation = match self.kind.as_str() {
            "dm" => format!("{} (DM)", self.title),
            "solo" => format!("{} (Solo chat)", self.title),
            "private" => self.title.clone(),
            _ => format!("#{}", self.title),
        };
        if self.thread {
            format!("Thread in {conversation} — Buzz")
        } else {
            format!("{conversation} — Buzz")
        }
    }
}
fn default_kind() -> String {
    "channel".into()
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Members {
    count: u64,
    solo: bool,
    preview: Vec<MemberPreview>,
}
#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct MemberPreview {
    id: String,
    name: String,
    picture: Option<String>,
}
impl Members {
    fn valid(&self) -> bool {
        self.count <= 1_000_000
            && self.preview.len() <= 3
            && self.preview.iter().all(|p| {
                p.id.len() <= 128
                    && p.name.len() <= 4096
                    && p.picture.as_ref().is_none_or(|s| s.len() <= 8192)
            })
    }
}
fn validate(view: &View) -> Result<()> {
    if view.title.len() > 4096
        || !matches!(view.kind.as_str(), "channel" | "private" | "dm" | "solo")
        || view.picture.as_ref().is_some_and(|p| p.len() > 8192)
        || view.members.as_ref().is_some_and(|m| !m.valid())
        || view.scope.len() > 4096
        || view.appearance.as_ref().is_some_and(|a| !a.valid())
        || view.typing.as_ref().is_some_and(|t| !t.valid())
        || view.error.as_ref().is_some_and(|e| e.len() > 8192)
        || !matches!(view.status.as_str(), "loading" | "ready" | "error")
        || [&view.composer, &view.reading].iter().any(|t| {
            t.as_ref()
                .is_some_and(|t| uuid::Uuid::parse_str(t).is_err())
        })
        || view.replies.len() > 500
        || view.operations.len() > 64
        || view.operations.iter().any(|op| !op.valid())
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
    // Painted before the page: a dark window opens dark, not white.
    let background = view
        .appearance
        .as_ref()
        .map(crate::huddle_window::Appearance::background)
        .unwrap_or_else(|| crate::huddle_window::Appearance::mode(view.dark).background());
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
            .background_color(background)
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
            let _ = companion.set_title(&session.view.window_title());
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
        Action::RetryMessage | Action::DiscardMessage => {
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
        Action::OpenThread => {
            if !text
                .as_deref()
                .is_some_and(|id| id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return Err("Invalid pop-out thread".into());
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
        // Native keeps the close guard; main also hears it, so a voluntary
        // community exit can name the window's unsent work before discarding it.
        Action::Guard => session.guarded = text.as_deref() == Some("1"),
        Action::Close => {
            drop(map);
            if let Some(companion) = app.get_webview_window(&label) {
                companion.destroy().map_err(|e| e.to_string())?;
            }
            return Ok(());
        }
        // All continue in the main window, which may be hidden on macOS.
        Action::OpenInMain | Action::OpenMembers | Action::OpenLink | Action::FocusMain => {
            if let Some(main) = app.get_webview_window("main") {
                let _ = main.show();
                let _ = main.unminimize();
                let _ = main.set_focus();
            }
            if action == Action::FocusMain {
                return Ok(());
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
    if !host.intercept_close(window.label()) {
        return false;
    }
    api.prevent_close();
    true
}
impl Popouts {
    /// A guarded window's close is intercepted: the companion is asked.
    fn intercept_close(&self, label: &str) -> bool {
        let Ok(mut map) = self.0.lock() else {
            return false;
        };
        let Some(session) = map.get_mut(label) else {
            return false;
        };
        if !session.guarded {
            return false;
        }
        session.view.close_requested += 1;
        if let Some(updates) = &session.updates {
            let _ = updates.send(session.view.clone());
        }
        true
    }
}

/// Main is closing where that destroys the owner (Linux, Windows): unguarded
/// companions close with it; a companion holding unsaved work asks first and
/// keeps main open until it is resolved. Returns true when main must stay.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn main_closing<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    api: &tauri::CloseRequestApi,
) -> bool {
    let Some(host) = app.try_state::<Popouts>() else {
        return false;
    };
    let Ok(mut map) = host.0.lock() else {
        return false;
    };
    let guarded: Vec<String> = map
        .iter()
        .filter(|(_, s)| s.guarded)
        .map(|(label, _)| label.clone())
        .collect();
    if guarded.is_empty() {
        // Nothing to ask: every companion closes with its owner.
        for label in map.keys() {
            if let Some(window) = app.get_webview_window(label) {
                let _ = window.destroy();
            }
        }
        return false;
    }
    // Ask first; nothing else closes until main's close is accepted, so
    // Keep editing leaves every window as it was.
    for label in &guarded {
        if let Some(session) = map.get_mut(label) {
            session.view.close_requested += 1;
            if let Some(updates) = &session.updates {
                let _ = updates.send(session.view.clone());
            }
        }
    }
    api.prevent_close();
    if let Some(window) = guarded
        .first()
        .and_then(|label| app.get_webview_window(label))
    {
        let _ = window.show();
        let _ = window.set_focus();
    }
    true
}

/// Main is gone: no companion can act without its owner.
pub(crate) fn main_destroyed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let labels: Vec<String> = app
        .try_state::<Popouts>()
        .and_then(|host| host.0.lock().ok().map(|map| map.keys().cloned().collect()))
        .unwrap_or_default();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
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
            scope: String::new(),
            dark: false,
            appearance: None,
            status: "ready".into(),
            error: None,
            writable: true,
            can_load_more: false,
            limited: false,
            loading_older: false,
            reading: None,
            reading_revision: 0,
            composer: None,
            version: 1,
            close_requested: 0,
            detached: false,
            root: None,
            replies: vec![],
            operations: vec![],
            following: false,
            is_dm: false,
            kind: "channel".into(),
            picture: None,
            members: None,
            thread: true,
            can_go_back: false,
            typing: None,
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
    fn reactions_are_bounded_per_row() {
        let mut r = row("r1", "https://media/a", "a.pdf");
        assert!(r.valid());
        let group = |content: &str, n: usize| {
            serde_json::from_value::<crate::huddle_window::ReactionGroup>(serde_json::json!({
                "content": content, "emoji": null,
                "events": (0..n).map(|i| serde_json::json!({
                    "id": format!("{:0>64x}", i), "authorId": "a".repeat(64)
                })).collect::<Vec<_>>()
            }))
            .unwrap()
        };
        r.reactions = vec![group("👍", 128), group(":party_blob:", 1)];
        assert!(r.valid());
        r.reactions = vec![group("👍", 129)];
        assert!(!r.valid());
        r.reactions = vec![group(&"x".repeat(67), 1)];
        assert!(!r.valid());
        r.reactions = (0..65).map(|_| group("👍", 1)).collect();
        assert!(!r.valid());
        r.reactions = vec![group("👍", 0)];
        assert!(!r.valid());
    }
    #[test]
    fn native_background_matches_the_applied_color_mode_tokens() {
        let tokens = include_str!("../../src/shared/design-system/styles/tokens.css");
        let hex = |c: tauri::window::Color| format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2);
        let appearance = |mode: &str| -> crate::huddle_window::Appearance {
            serde_json::from_value(serde_json::json!({ "colorMode": mode })).unwrap()
        };
        // Resolve `--bg-app` as the stylesheet does for each mode. Mode-paired
        // tokens are declared twice in `tokens.css`: the light (`:root`) value
        // first, the dark (`[data-color-mode="dark"]`) value second; the role
        // block may alias a palette step that differs per mode.
        let declared = |mode: &str, name: &str| -> String {
            let needle = format!("{name}: ");
            let mut found = tokens.match_indices(&needle).map(|(at, _)| {
                let value = &tokens[at + needle.len()..];
                value[..value.find(';').unwrap()].trim().to_string()
            });
            let light = found
                .next()
                .unwrap_or_else(|| panic!("{name} not declared"));
            if mode == "dark" {
                found
                    .next()
                    .unwrap_or_else(|| panic!("{name} has no dark value"))
            } else {
                light
            }
        };
        let resolve = |mode: &str| -> String {
            let mut value = declared(mode, "--bg-app");
            while let Some(alias) = value.strip_prefix("var(").and_then(|v| v.strip_suffix(')')) {
                value = declared(mode, alias);
            }
            value
        };
        assert_eq!(hex(appearance("dark").background()), resolve("dark"));
        assert_eq!(hex(appearance("light").background()), resolve("light"));
        assert_ne!(resolve("dark"), resolve("light"));
    }
    #[test]
    fn link_labels_are_bounded_per_row() {
        let mut r = row("r1", "https://media/a", "a.pdf");
        let link = |n: usize| format!("buzz://message?channel=c&id={:0>64x}", n);
        r.link_labels = (0..64)
            .map(|i| (link(i), "Ada in #design".into()))
            .collect();
        assert!(r.valid());
        r.link_labels = (0..65)
            .map(|i| (link(i), "Ada in #design".into()))
            .collect();
        assert!(!r.valid());
        r.link_labels = [(link(0), "x".repeat(1001))].into();
        assert!(!r.valid());
        r.link_labels = [("u".repeat(8193), "Ada in #design".into())].into();
        assert!(!r.valid());
        let decoded: DiscussionRow = serde_json::from_value(serde_json::json!({
            "id": "r", "authorId": "a", "channelId": "c", "author": "Ada", "picture": null,
            "text": "see", "time": 1, "delivery": "seen", "attachments": [],
            "linkLabels": { "buzz://message?channel=c&id=1": "Ada in #design" }
        }))
        .unwrap();
        assert_eq!(
            decoded.link_labels["buzz://message?channel=c&id=1"],
            "Ada in #design"
        );
    }
    #[test]
    fn labels_are_recognized_by_prefix() {
        assert!(is_popout("popout-1234"));
        assert!(!is_popout("main"));
        assert!(!is_popout("huddle"));
    }
    fn row(id: &str, source: &str, name: &str) -> DiscussionRow {
        serde_json::from_value(serde_json::json!({
            "id": id, "authorId": "a", "channelId": "channel", "author": "Ada",
            "picture": null, "text": "see file", "time": 1, "delivery": "seen",
            "attachments": [{
                "url": "https://relay.example/media/1", "kind": "file", "mime": null,
                "size": null, "name": name, "duration": null, "voiceNote": null,
                "waveform": null, "dimensions": null, "blurhash": null,
                "previewUrl": null, "source": source, "previewSource": null
            }]
        }))
        .unwrap()
    }
    fn session(binding: Binding, view: View, guarded: bool) -> Session {
        Session {
            binding,
            view,
            guarded,
            actions: Channel::new(|_| Ok(())),
            updates: None,
        }
    }
    #[test]
    fn window_title_names_the_thread_and_its_conversation() {
        let mut view = view();
        view.title = "design".into();
        view.thread = true;
        assert_eq!(view.window_title(), "Thread in #design — Buzz");
        view.is_dm = true;
        view.kind = "dm".into();
        view.title = "Ada".into();
        assert_eq!(view.window_title(), "Thread in Ada (DM) — Buzz");
        view.thread = false;
        assert_eq!(view.window_title(), "Ada (DM) — Buzz");
        view.kind = "solo".into();
        view.title = "Planning".into();
        assert_eq!(view.window_title(), "Planning (Solo chat) — Buzz");
        view.is_dm = false;
        view.kind = "private".into();
        view.title = "leads".into();
        assert_eq!(view.window_title(), "leads — Buzz");
        view.kind = "channel".into();
        view.title = "design".into();
        assert_eq!(view.window_title(), "#design — Buzz");
        // The kind is a closed set; a picture is bounded.
        view.kind = "other".into();
        assert!(validate(&view).is_err());
        view.kind = "dm".into();
        view.picture = Some("x".repeat(8193));
        assert!(validate(&view).is_err());
        view.picture = Some("http://buzz-media.localhost/avatar".into());
        assert!(validate(&view).is_ok());
        // Members: a bounded preview of at most three.
        let person = |n: usize| MemberPreview {
            id: format!("{n:0>64}"),
            name: "Ada".into(),
            picture: None,
        };
        view.members = Some(Members {
            count: 12,
            solo: false,
            preview: (0..3).map(person).collect(),
        });
        assert!(validate(&view).is_ok());
        view.members = Some(Members {
            count: 12,
            solo: false,
            preview: (0..4).map(person).collect(),
        });
        assert!(validate(&view).is_err());
        view.members = Some(Members {
            count: 1_000_001,
            solo: false,
            preview: vec![],
        });
        assert!(validate(&view).is_err());
        let action: Action = serde_json::from_str("\"openMembers\"").unwrap();
        assert!(action == Action::OpenMembers);
    }
    #[test]
    fn focus_main_is_a_companion_action_with_no_payload() {
        let action: Action = serde_json::from_str("\"focusMain\"").unwrap();
        assert!(action == Action::FocusMain);
        assert_eq!(serde_json::to_string(&action).unwrap(), "\"focusMain\"");
    }
    #[test]
    fn commands_are_gated_by_caller_label() {
        let app = tauri::test::mock_builder()
            .manage(Popouts::default())
            .build(crate::app_context())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let popout =
            tauri::WebviewWindowBuilder::new(&app, "popout-a", tauri::WebviewUrl::default())
                .build()
                .unwrap();
        let huddle = tauri::WebviewWindowBuilder::new(&app, "huddle", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        assert!(require_main(&main).is_ok());
        assert!(require_main(&popout).is_err());
        assert_eq!(require_popout(&popout).unwrap(), "popout-a");
        assert!(require_popout(&main).is_err());
        assert!(require_popout(&huddle).is_err());
    }
    #[test]
    fn downloads_are_isolated_to_the_calling_window_projection() {
        let host = Popouts::default();
        let mut a = view();
        a.root = Some(row("r1", "https://media/a", "a.pdf"));
        let mut b = view();
        b.replies = vec![row("r2", "https://media/b", "b.pdf")];
        {
            let mut map = host.0.lock().unwrap();
            map.insert("popout-a".into(), session(binding(), a, false));
            map.insert("popout-b".into(), session(binding(), b, false));
        }
        assert!(host.permits_download("popout-a", "https://media/a", "a.pdf"));
        assert!(!host.permits_download("popout-a", "https://media/b", "b.pdf"));
        assert!(host.permits_download("popout-b", "https://media/b", "b.pdf"));
        assert!(!host.permits_download("popout-b", "https://media/a", "a.pdf"));
        assert!(!host.permits_download("popout-a", "https://media/a", "other.pdf"));
        assert!(!host.permits_download("popout-zzz", "https://media/a", "a.pdf"));
    }
    #[test]
    fn guarded_close_is_intercepted_and_asks_the_companion() {
        let host = Popouts::default();
        host.0
            .lock()
            .unwrap()
            .insert("popout-a".into(), session(binding(), view(), true));
        assert!(host.intercept_close("popout-a"));
        assert_eq!(host.0.lock().unwrap()["popout-a"].view.close_requested, 1);
        assert!(host.intercept_close("popout-a"));
        assert_eq!(host.0.lock().unwrap()["popout-a"].view.close_requested, 2);
        host.0.lock().unwrap().get_mut("popout-a").unwrap().guarded = false;
        assert!(
            !host.intercept_close("popout-a"),
            "an unguarded close proceeds"
        );
        assert!(!host.intercept_close("popout-unknown"));
    }
    #[test]
    fn companion_has_no_identity_relay_or_signing_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/popout.json")).unwrap();
        assert_eq!(capability["webviews"], serde_json::json!(["popout-*"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "allow-popout-window-watch",
                "allow-popout-window-action",
                "allow-media-download",
                "allow-clipboard-write-text",
                { "identifier": "opener:allow-open-url", "allow": [{ "url": "https://*" }, { "url": "http://*" }] }
            ])
        );
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
