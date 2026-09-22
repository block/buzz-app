//! Remote website content embedded in the main window without a Tauri bridge.

mod platform;
mod policy;

use std::{cell::RefCell, rc::Rc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

pub use policy::BrowserBounds;
use policy::NavigationPolicy;

thread_local! {
    // Wry and its delegates must be created, used, and dropped on the UI thread.
    static BROWSER: RefCell<Option<BrowserSession>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BrowserSnapshot {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BrowserAction {
    Back,
    Forward,
    Reload,
}

struct BrowserSession {
    instance: String,
    host: Webview,
    guest: WebView,
    // WKWebView's UI delegate reference is weak.
    _permissions: platform::Permissions,
    snapshot: Rc<RefCell<BrowserSnapshot>>,
    policy: NavigationPolicy,
}

impl BrowserSession {
    fn navigate(&self, target: &str) -> Result<(), String> {
        let url = self.policy.validate(target)?;
        self.guest
            .load_url(url.as_str())
            .map_err(|error| error.to_string())?;
        let mut snapshot = self.snapshot.borrow_mut();
        snapshot.url = url.to_string();
        snapshot.loading = true;
        snapshot.error = None;
        Ok(())
    }

    fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        let mut snapshot = self.snapshot.borrow().clone();
        if let Some(url) = platform::current_url(&self.guest)? {
            snapshot.url = url;
        }
        #[cfg(target_os = "macos")]
        {
            snapshot.loading = platform::loading(&self.guest);
        }
        Ok(snapshot)
    }

    fn set_bounds(&self, bounds: BrowserBounds, visible: bool) -> Result<(), String> {
        self.guest
            .set_visible(false)
            .map_err(|error| error.to_string())?;
        if !visible {
            return Ok(());
        }
        platform::resize_guest(&self.guest, &self.host, bounds)?;
        self.guest
            .set_visible(true)
            .map_err(|error| error.to_string())
    }
}

async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.try_send(operation());
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "Browser stopped before the request completed".to_string())?
}

fn with_browser<T>(
    session_id: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String>,
) -> Result<T, String> {
    BROWSER.with(|browser| {
        let browser = browser.borrow();
        let browser = browser
            .as_ref()
            .filter(|browser| browser.instance == session_id)
            .ok_or_else(|| "Browser session is closed or replaced".to_string())?;
        operation(browser)
    })
}

pub(crate) fn shutdown() {
    BROWSER.with(|browser| {
        browser.borrow_mut().take();
    });
}

pub(crate) fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            BROWSER.with(|browser| {
                if let Some(browser) = browser.borrow().as_ref() {
                    if let Err(error) = browser.guest.set_visible(false) {
                        browser.snapshot.borrow_mut().error = Some(error.to_string());
                    }
                }
            });
        }
        tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. } => shutdown(),
        _ => {}
    }
}

fn build_contents(
    app: &AppHandle,
    target: &str,
    bounds: BrowserBounds,
) -> Result<BrowserSession, String> {
    let policy = NavigationPolicy::new(app.config().build.dev_url.clone());
    let target = policy.validate(target)?;
    bounds.validate()?;
    let host = app
        .get_webview("main")
        .ok_or("Buzz main webview is unavailable")?;
    let snapshot = Rc::new(RefCell::new(BrowserSnapshot::default()));
    let navigation_policy = policy.clone();
    let title_snapshot = snapshot.clone();
    let load_snapshot = snapshot.clone();
    let download_snapshot = snapshot.clone();
    let popup_snapshot = snapshot.clone();
    // No URL is loaded until native permission handlers replace Wry's defaults.
    // In particular, this builder receives no IPC handler or host initialization scripts.
    let builder = WebViewBuilder::new()
        .with_visible(false)
        .with_incognito(true)
        .with_clipboard(false)
        .with_devtools(false)
        .with_autoplay(false)
        .with_bounds(Rect {
            position: LogicalPosition::new(0.0, 0.0).into(),
            size: LogicalSize::new(1.0, 1.0).into(),
        })
        // Wry also reports subframe URLs here. A blocked iframe must not label
        // the successfully loaded top-level website as a navigation failure.
        .with_navigation_handler(move |target| navigation_policy.validate(&target).is_ok())
        .with_document_title_changed_handler(move |title| {
            title_snapshot.borrow_mut().title = title;
        })
        .with_on_page_load_handler(move |event, url| {
            let mut snapshot = load_snapshot.borrow_mut();
            snapshot.url = url;
            snapshot.loading = matches!(event, PageLoadEvent::Started);
        })
        .with_download_started_handler(move |_, _| {
            download_snapshot.borrow_mut().error =
                Some("Downloads are not supported in Buzz Browser".into());
            false
        })
        .with_new_window_req_handler(move |_, _| {
            popup_snapshot.borrow_mut().error =
                Some("Pop-up windows are blocked in Buzz Browser".into());
            wry::NewWindowResponse::Deny
        });
    let guest = platform::build_guest(builder, &host.window())?;
    let permissions = platform::deny_permissions(&guest)?;
    let browser = BrowserSession {
        instance: uuid::Uuid::new_v4().to_string(),
        host,
        guest,
        _permissions: permissions,
        snapshot,
        policy,
    };
    platform::resize_guest(&browser.guest, &browser.host, bounds)?;
    browser.navigate(target.as_str())?;
    Ok(browser)
}

#[tauri::command]
pub async fn browser_attach(
    app: AppHandle,
    url: String,
    bounds: BrowserBounds,
) -> Result<String, String> {
    let handle = app.clone();
    on_main_thread(&app, move || {
        // Drop the previous guest before creating another private browsing session.
        shutdown();
        let browser = build_contents(&handle, &url, bounds)?;
        let session_id = browser.instance.clone();
        BROWSER.with(|current| *current.borrow_mut() = Some(browser));
        Ok(session_id)
    })
    .await
}

#[tauri::command]
pub async fn browser_set_bounds(
    app: AppHandle,
    session_id: String,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| browser.set_bounds(bounds, visible))
    })
    .await
}

#[tauri::command]
pub async fn browser_detach(app: AppHandle, session_id: String) -> Result<(), String> {
    on_main_thread(&app, move || {
        BROWSER.with(|browser| {
            let mut browser = browser.borrow_mut();
            if browser
                .as_ref()
                .is_some_and(|browser| browser.instance == session_id)
            {
                browser.take();
            }
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn browser_navigate(
    app: AppHandle,
    session_id: String,
    url: String,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| browser.navigate(&url))
    })
    .await
}

#[tauri::command]
pub async fn browser_action(
    app: AppHandle,
    session_id: String,
    action: BrowserAction,
) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.snapshot.borrow_mut().error = None;
            match action {
                BrowserAction::Reload => browser.guest.reload().map_err(|error| error.to_string()),
                BrowserAction::Back => platform::back(&browser.guest),
                BrowserAction::Forward => platform::forward(&browser.guest),
            }
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_status(app: AppHandle, session_id: String) -> Result<BrowserSnapshot, String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, BrowserSession::snapshot)
    })
    .await
}
