//! A trusted toolbar and a remote webview with no Tauri bridge.

mod platform;
mod policy;

use std::{cell::RefCell, rc::Rc};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, Window};
use wry::{PageLoadEvent, Rect, WebView, WebViewBuilder};

use policy::{browser_layout, is_controls_navigation, NavigationPolicy};

const WINDOW_LABEL: &str = "browser";
const CONTROLS_LABEL: &str = "browser-controls";

thread_local! {
    // Wry and its delegates must be created, used, and dropped on the UI thread.
    static BROWSER: RefCell<Option<BrowserWindow>> = const { RefCell::new(None) };
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

struct BrowserWindow {
    instance: uuid::Uuid,
    window: Window,
    controls: Webview,
    guest: WebView,
    // WKWebView's UI delegate reference is weak.
    _permissions: platform::Permissions,
    snapshot: Rc<RefCell<BrowserSnapshot>>,
    policy: NavigationPolicy,
}

impl BrowserWindow {
    fn navigate(&self, target: &str) -> Result<(), String> {
        let url = self.policy.validate(target)?;
        self.guest
            .load_url(url.as_str())
            .map_err(|error| error.to_string())?;
        let mut snapshot = self.snapshot.borrow_mut();
        snapshot.loading = true;
        snapshot.error = None;
        Ok(())
    }

    fn resize(&self) -> Result<(), String> {
        let scale = self
            .window
            .scale_factor()
            .map_err(|error| error.to_string())?;
        let size = self
            .window
            .inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale);
        let layout = browser_layout(size.width, size.height);
        self.controls
            .set_bounds(tauri::Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: LogicalSize::new(layout.width, layout.controls_height).into(),
            })
            .map_err(|error| error.to_string())?;
        platform::resize_guest(&self.guest, &self.controls, &layout)
    }

    fn snapshot(&self) -> Result<BrowserSnapshot, String> {
        let mut snapshot = self.snapshot.borrow().clone();
        snapshot.url = self.guest.url().map_err(|error| error.to_string())?;
        #[cfg(target_os = "macos")]
        {
            snapshot.loading = platform::loading(&self.guest);
        }
        Ok(snapshot)
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
        .ok_or_else(|| "Browser window stopped before the request completed".to_string())?
}

pub(crate) async fn open(app: AppHandle, target: String) -> Result<(), String> {
    let handle = app.clone();
    on_main_thread(&app, move || {
        let exists = BROWSER.with(|browser| browser.borrow().is_some());
        if !exists {
            let browser = create_window(&handle, &target)?;
            BROWSER.with(|current| *current.borrow_mut() = Some(browser));
        } else {
            with_browser(|browser| browser.navigate(&target))?;
        }
        with_browser(|browser| {
            browser.window.show().map_err(|error| error.to_string())?;
            browser
                .window
                .set_focus()
                .map_err(|error| error.to_string())
        })
    })
    .await
}

fn with_browser<T>(
    operation: impl FnOnce(&BrowserWindow) -> Result<T, String>,
) -> Result<T, String> {
    BROWSER.with(|browser| {
        let browser = browser.borrow();
        operation(
            browser
                .as_ref()
                .ok_or_else(|| "Browser window is closed".to_string())?,
        )
    })
}

fn create_window(app: &AppHandle, target: &str) -> Result<BrowserWindow, String> {
    let policy = NavigationPolicy::new(app.config().build.dev_url.clone());
    let url = policy.validate(target)?;
    let window = tauri::window::WindowBuilder::new(app, WINDOW_LABEL)
        .title("Buzz Browser")
        .inner_size(1120.0, 780.0)
        .min_inner_size(480.0, 320.0)
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    let result = build_contents(&window, policy, url.as_str());
    match result {
        Ok(browser) => {
            let instance = browser.instance;
            window.on_window_event(move |event| {
                let is_current = BROWSER.with(|browser| {
                    browser
                        .borrow()
                        .as_ref()
                        .is_some_and(|browser| browser.instance == instance)
                });
                if !is_current {
                    return;
                }
                match event {
                    tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        if let Err(error) = with_browser(BrowserWindow::resize) {
                            BROWSER.with(|browser| {
                                if let Some(browser) = browser.borrow().as_ref() {
                                    browser.snapshot.borrow_mut().error = Some(error);
                                }
                            });
                        }
                    }
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                        BROWSER.with(|browser| browser.borrow_mut().take());
                    }
                    _ => {}
                }
            });
            Ok(browser)
        }
        Err(error) => {
            let _ = window.close();
            Err(error)
        }
    }
}

fn build_contents(
    window: &Window,
    policy: NavigationPolicy,
    target: &str,
) -> Result<BrowserWindow, String> {
    let trusted_url = window
        .app_handle()
        .get_webview("main")
        .ok_or("Buzz main webview is unavailable")?
        .url()
        .map_err(|error| error.to_string())?;
    let controls = window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                CONTROLS_LABEL,
                WebviewUrl::App("browser.html".into()),
            )
            .on_navigation(move |url| is_controls_navigation(&trusted_url, url))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(1120.0, 56.0),
        )
        .map_err(|error| error.to_string())?;
    let snapshot = Rc::new(RefCell::new(BrowserSnapshot::default()));
    let navigation_policy = policy.clone();
    let navigation_snapshot = snapshot.clone();
    let title_snapshot = snapshot.clone();
    let load_snapshot = snapshot.clone();
    let download_snapshot = snapshot.clone();
    let popup_snapshot = snapshot.clone();
    // No URL is loaded until native permission handlers replace Wry's defaults.
    // In particular, this builder receives no IPC handler or host initialization scripts.
    let builder = WebViewBuilder::new()
        .with_incognito(true)
        .with_clipboard(false)
        .with_devtools(false)
        .with_autoplay(false)
        .with_bounds(Rect {
            position: LogicalPosition::new(0.0, 56.0).into(),
            size: LogicalSize::new(1120.0, 724.0).into(),
        })
        .with_navigation_handler(move |target| match navigation_policy.validate(&target) {
            Ok(_) => true,
            Err(error) => {
                navigation_snapshot.borrow_mut().error = Some(error);
                false
            }
        })
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
    let guest = platform::build_guest(builder, window)?;
    let permissions = platform::deny_permissions(&guest)?;
    let browser = BrowserWindow {
        instance: uuid::Uuid::new_v4(),
        window: window.clone(),
        controls,
        guest,
        _permissions: permissions,
        snapshot,
        policy,
    };
    browser.resize()?;
    browser.navigate(target)?;
    Ok(browser)
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String) -> Result<(), String> {
    open(app, url).await
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    on_main_thread(&app, move || with_browser(|browser| browser.navigate(&url))).await
}

#[tauri::command]
pub async fn browser_action(app: AppHandle, action: BrowserAction) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(|browser| {
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
pub async fn browser_status(app: AppHandle) -> Result<BrowserSnapshot, String> {
    on_main_thread(&app, || with_browser(BrowserWindow::snapshot)).await
}
