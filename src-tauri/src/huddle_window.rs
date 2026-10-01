//! A presentation-only companion. Microphone, identity and call ownership stay in main.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, Manager, WebviewWindow};

type Result<T> = std::result::Result<T, String>;
const LABEL: &str = "huddle";
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct View {
    id: String,
    title: String,
    phase: String,
    muted: bool,
    level: f32,
    dark: bool,
    participants: Vec<Person>,
    #[serde(default)]
    discussion: Option<Discussion>,
    #[serde(default)]
    discussion_open: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Discussion {
    version: u64,
    history_limited: bool,
    status: String,
    error: Option<String>,
    writable: bool,
    sending: bool,
    sent: u64,
    has_more: bool,
    rows: Vec<DiscussionRow>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DiscussionRow {
    id: String,
    author: String,
    picture: Option<String>,
    text: String,
    time: u64,
    failed: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Person {
    key: String,
    name: String,
    picture: Option<String>,
    own: bool,
    #[serde(default)]
    level: f32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Mute,
    Leave,
    Minimize,
    Thread,
    Send,
    Older,
    Retry,
    RetryMessage,
    DiscardMessage,
    Closed,
}
#[derive(Clone, Serialize)]
pub(crate) struct Control {
    id: String,
    action: Action,
    text: Option<String>,
}
struct Session {
    view: View,
    actions: Channel<Control>,
    updates: Option<Channel<View>>,
}
#[derive(Default)]
pub(crate) struct HuddleWindow(Mutex<Option<Session>>);
fn require<R: tauri::Runtime>(window: &WebviewWindow<R>, label: &str) -> Result<()> {
    if window.label() == label {
        Ok(())
    } else {
        Err("Wrong Huddle window".into())
    }
}
fn validate(view: &View) -> Result<()> {
    if uuid::Uuid::parse_str(&view.id).is_err()
        || view.title.len() > 4096
        || !matches!(view.phase.as_str(), "connecting" | "connected" | "leaving")
        || !view.level.is_finite()
        || !(0.0..=1.0).contains(&view.level)
        || view.participants.len() > 256
        || view.discussion.as_ref().is_some_and(|d| {
            !matches!(d.status.as_str(), "loading" | "ready" | "error")
                || d.error.as_ref().is_some_and(|e| e.len() > 8192)
                || d.rows.len() > 200
                || d.rows.iter().any(|r| {
                    r.id.len() > 128
                        || r.author.len() > 4096
                        || r.text.len() > 65536
                        || r.picture.as_ref().is_some_and(|p| p.len() > 8192)
                })
        })
        || view.participants.iter().any(|p| {
            !p.level.is_finite()
                || !(0.0..=1.0).contains(&p.level)
                || p.key.len() > 128
                || p.name.len() > 4096
                || p.picture.as_ref().is_some_and(|s| s.len() > 8192)
        })
    {
        return Err("Invalid Huddle presentation".into());
    }
    Ok(())
}
fn closed_notice(
    actions: Channel<Control>,
    id: String,
) -> impl Fn(&tauri::WindowEvent) + Send + Sync + 'static {
    let actions = Mutex::new(Some(actions));
    move |event| {
        if !matches!(event, tauri::WindowEvent::Destroyed) {
            return;
        }
        let Some(actions) = actions.lock().ok().and_then(|mut slot| slot.take()) else {
            return;
        };
        let id = id.clone();
        // Channel send AND final drop evaluate JavaScript. Neither may reenter
        // Wry while it destroys its window map under a mutable RefCell borrow.
        tauri::async_runtime::spawn_blocking(move || {
            let _ = actions.send(Control {
                id,
                action: Action::Closed,
                text: None,
            });
        });
    }
}
#[tauri::command]
pub(crate) async fn huddle_window_open<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    view: View,
    actions: Channel<Control>,
) -> Result<()> {
    require(&window, "main")?;
    validate(&view)?;
    let id = view.id.clone();
    let on_closed = closed_notice(actions.clone(), id.clone());
    {
        let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
        let updates = slot.as_mut().and_then(|s| s.updates.take());
        if let Some(updates) = &updates {
            let _ = updates.send(view.clone());
        }
        *slot = Some(Session {
            view,
            actions,
            updates,
        });
    }
    let app = window.app_handle();
    let companion = match app.get_webview_window(LABEL) {
        Some(existing) => existing,
        None => tauri::WebviewWindowBuilder::new(
            app,
            LABEL,
            tauri::WebviewUrl::App("huddle.html".into()),
        )
        .title("Huddle — Buzz")
        .inner_size(520.0, 560.0)
        .min_inner_size(360.0, 400.0)
        .center()
        .disable_drag_drop_handler()
        .build()
        .map_err(|e| e.to_string())?,
    };
    companion.on_window_event(on_closed);
    // Call completion may race native window creation. It retires the session;
    // this post-build check also removes a window created after that retirement.
    if !app.state::<crate::relay::Huddles>().contains(&id) {
        retire(app, &id);
        return Err("This Huddle has ended".into());
    }
    companion.show().map_err(|e| e.to_string())?;
    companion.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub(crate) fn huddle_window_update<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    id: String,
    view: Option<View>,
) -> Result<()> {
    require(&window, "main")?;
    if let Some(view) = &view {
        validate(view)?;
        if view.id != id {
            return Err("Huddle presentation changed".into());
        }
    }
    let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let Some(session) = slot.as_mut().filter(|s| s.view.id == id) else {
        return Ok(());
    };
    if let Some(mut view) = view {
        // Activity-only patches omit the unchanged message list. Watch still
        // receives the complete cached presentation after a renderer reload.
        let patch = view.clone();
        if view.discussion_open && view.discussion.is_none() {
            view.discussion = session.view.discussion.clone();
        } else if !view.discussion_open {
            view.discussion = None;
        }
        if session.view.discussion.is_some() != view.discussion.is_some() {
            if let Some(companion) = window.app_handle().get_webview_window(LABEL) {
                let scale = companion.scale_factor().map_err(|e| e.to_string())?;
                let size = companion
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                let opening = view.discussion.is_some();
                companion
                    .set_min_size(Some(tauri::LogicalSize::new(
                        if opening { 720.0 } else { 360.0 },
                        400.0,
                    )))
                    .map_err(|e| e.to_string())?;
                companion
                    .set_size(tauri::LogicalSize::new(
                        (size.width + if opening { 360.0 } else { -360.0 }).max(if opening {
                            720.0
                        } else {
                            360.0
                        }),
                        size.height,
                    ))
                    .map_err(|e| e.to_string())?;
            }
        }
        if let Some(updates) = &session.updates {
            let _ = updates.send(patch);
        }
        session.view = view;
    } else {
        *slot = None;
        // Serialize teardown against open. JS also fences pending opens by call ID.
        if let Some(companion) = window.app_handle().get_webview_window(LABEL) {
            companion.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn huddle_window_watch<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    updates: Channel<View>,
) -> Result<()> {
    require(&window, LABEL)?;
    let mut slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let session = slot.as_mut().ok_or("This Huddle has ended")?;
    updates
        .send(session.view.clone())
        .map_err(|e| e.to_string())?;
    session.updates = Some(updates);
    Ok(())
}
#[tauri::command]
pub(crate) fn huddle_window_action<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    host: tauri::State<'_, HuddleWindow>,
    id: String,
    action: Action,
    text: Option<String>,
) -> Result<()> {
    require(&window, LABEL)?;
    if matches!(action, Action::Closed) {
        return Err("Window closure is native-owned".into());
    }
    if matches!(
        action,
        Action::Send | Action::RetryMessage | Action::DiscardMessage
    ) {
        if text
            .as_ref()
            .map_or(true, |t| t.trim().is_empty() || t.len() > 65536)
        {
            return Err("Invalid Huddle message".into());
        }
    } else if text.is_some() {
        return Err("Unexpected Huddle message".into());
    }
    let slot = host.0.lock().map_err(|_| "Huddle window unavailable")?;
    let session = slot
        .as_ref()
        .filter(|s| s.view.id == id)
        .ok_or("This Huddle has ended")?;
    session
        .actions
        .send(Control { id, action, text })
        .map_err(|e| e.to_string())
}

/// Called by native call completion too, including expiry after a renderer crash.
pub(crate) fn retire<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let Some(host) = app.try_state::<HuddleWindow>() else {
        return;
    };
    let Ok(mut slot) = host.0.lock() else {
        return;
    };
    if slot.as_ref().map_or(true, |s| s.view.id == id) {
        *slot = None;
        if let Some(window) = app.get_webview_window(LABEL) {
            let _ = window.destroy();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn window_destruction_sends_and_drops_channel_off_the_event_thread() {
        use std::sync::mpsc;
        use std::thread;
        use std::time::Duration;

        struct DropThread(mpsc::Sender<(&'static str, thread::ThreadId)>);
        impl Drop for DropThread {
            fn drop(&mut self) {
                let _ = self.0.send(("drop", thread::current().id()));
            }
        }
        let (sender, receiver) = mpsc::channel();
        let dropped = DropThread(sender.clone());
        let actions = Channel::new(move |_| {
            let _keep_until_channel_drop = &dropped;
            sender.send(("send", thread::current().id())).unwrap();
            Ok(())
        });
        let notice = closed_notice(actions, "call".into());
        notice(&tauri::WindowEvent::Destroyed);
        notice(&tauri::WindowEvent::Destroyed);
        drop(notice);
        for expected in ["send", "drop"] {
            let (event, thread) = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(event, expected);
            assert_ne!(thread, thread::current().id());
        }
        assert!(receiver.recv().is_err());
    }
    fn view(id: &str) -> View {
        View {
            id: id.into(),
            title: "Design".into(),
            phase: "connected".into(),
            muted: false,
            level: 0.0,
            dark: false,
            participants: vec![],
            discussion: None,
            discussion_open: false,
        }
    }
    #[test]
    fn native_completion_retires_only_its_own_presentation() {
        let app = tauri::test::mock_builder()
            .manage(HuddleWindow::default())
            .build(crate::app_context())
            .unwrap();
        tauri::WebviewWindowBuilder::new(&app, LABEL, tauri::WebviewUrl::default())
            .build()
            .unwrap();
        let current = "00000000-0000-4000-8000-000000000001";
        let host = app.state::<HuddleWindow>();
        *host.0.lock().unwrap() = Some(Session {
            view: view(current),
            actions: Channel::new(|_| Ok(())),
            updates: None,
        });
        retire(app.handle(), "old-call");
        assert!(host.0.lock().unwrap().is_some());
        assert!(app.get_webview_window(LABEL).is_some());
        retire(app.handle(), current);
        assert!(host.0.lock().unwrap().is_none());
    }
    #[test]
    fn companion_has_no_call_or_identity_authority() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/huddle.json")).unwrap();
        assert_eq!(capability["webviews"], serde_json::json!(["huddle"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-huddle-window-watch", "allow-huddle-window-action"])
        );
        assert!(serde_json::from_str::<Action>("\"start\"").is_err());
        assert!(validate(&view("bad-id")).is_err());
    }
}
