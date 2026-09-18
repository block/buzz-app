use tauri::Window;
use wry::{WebView, WebViewBuilder};

#[cfg(target_os = "macos")]
mod macos {
    use block2::Block;
    use objc2::{define_class, msg_send, rc::Retained, runtime::ProtocolObject, MainThreadOnly};
    use objc2_foundation::{MainThreadMarker, NSObject, NSObjectProtocol};
    use objc2_web_kit::{
        WKFrameInfo, WKMediaCaptureType, WKPermissionDecision, WKSecurityOrigin, WKUIDelegate,
        WKWebView,
    };
    use wry::{WebView, WebViewExtMacOS};

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "BuzzBrowserPermissionDelegate"]
        #[thread_kind = MainThreadOnly]
        #[ivars = ()]
        pub struct PermissionDelegate;

        unsafe impl NSObjectProtocol for PermissionDelegate {}

        unsafe impl WKUIDelegate for PermissionDelegate {
            #[unsafe(method(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:))]
            fn media_permission(
                &self,
                _webview: &WKWebView,
                _origin: &WKSecurityOrigin,
                _frame: &WKFrameInfo,
                _capture_type: WKMediaCaptureType,
                decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
            ) {
                decision_handler.call((WKPermissionDecision::Deny,));
            }

            #[unsafe(method(webView:requestDeviceOrientationAndMotionPermissionForOrigin:initiatedByFrame:decisionHandler:))]
            fn motion_permission(
                &self,
                _webview: &WKWebView,
                _origin: &WKSecurityOrigin,
                _frame: &WKFrameInfo,
                decision_handler: &Block<dyn Fn(WKPermissionDecision)>,
            ) {
                decision_handler.call((WKPermissionDecision::Deny,));
            }
        }
    );

    pub fn deny_permissions(guest: &WebView) -> Result<Retained<PermissionDelegate>, String> {
        let marker = MainThreadMarker::new()
            .ok_or("Browser permissions must be installed on the UI thread")?;
        let allocated = PermissionDelegate::alloc(marker).set_ivars(());
        let delegate: Retained<PermissionDelegate> = unsafe { msg_send![super(allocated), init] };
        // An absent createWebView/runOpenPanel implementation cancels popups/uploads.
        // Replacing Wry's delegate also removes its unconditional media grant.
        unsafe {
            guest
                .webview()
                .setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        Ok(delegate)
    }

    pub fn loading(guest: &WebView) -> bool {
        unsafe { guest.webview().isLoading() }
    }

    pub fn back(guest: &WebView) -> Result<(), String> {
        unsafe {
            guest.webview().goBack();
        }
        Ok(())
    }

    pub fn forward(guest: &WebView) -> Result<(), String> {
        unsafe {
            guest.webview().goForward();
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(super) fn resize_guest(
    guest: &WebView,
    controls: &tauri::Webview,
    layout: &super::policy::BrowserLayout,
) -> Result<(), String> {
    use objc2_web_kit::WKWebView;
    use wry::WebViewExtMacOS;
    let (sender, receiver) = std::sync::mpsc::channel();
    let controls_height = layout.controls_height;
    controls
        .with_webview(move |webview| {
            // Tauri owns the retained view throughout this UI-thread callback.
            let controls = unsafe { &*webview.inner().cast::<WKWebView>() };
            let Some(window) = controls.window() else {
                return;
            };
            let Some(parent) = (unsafe { controls.superview() }) else {
                return;
            };
            // A full-size macOS content view includes the native title bar. Use the
            // window's usable content rectangle so it cannot clip the web toolbar.
            let content_rectangle = window.contentLayoutRect();
            let mut toolbar_rectangle = parent.convertRect_fromView(content_rectangle, None);
            if !parent.isFlipped() {
                toolbar_rectangle.origin.y += toolbar_rectangle.size.height - controls_height;
            }
            toolbar_rectangle.size.height = controls_height;
            controls.setFrame(toolbar_rectangle);
            let rectangle = controls.convertRect_toView(controls.bounds(), None);
            let _ = sender.send((rectangle, content_rectangle));
        })
        .map_err(|error| error.to_string())?;
    let (controls_rectangle, content_rectangle) = receiver
        .try_recv()
        .map_err(|_| "Browser layout must run on the UI thread with an attached window")?;
    unsafe {
        let native_guest = guest.webview();
        let parent = native_guest
            .superview()
            .ok_or("Browser content has no parent view")?;
        let controls_rectangle = parent.convertRect_fromView(controls_rectangle, None);
        let content_rectangle = parent.convertRect_fromView(content_rectangle, None);
        let mut guest_rectangle = controls_rectangle;
        if parent.isFlipped() {
            guest_rectangle.origin.y = controls_rectangle.origin.y + controls_rectangle.size.height;
            guest_rectangle.size.height = (content_rectangle.origin.y
                + content_rectangle.size.height
                - guest_rectangle.origin.y)
                .max(0.0);
        } else {
            guest_rectangle.origin.y = content_rectangle.origin.y;
            guest_rectangle.size.height =
                (controls_rectangle.origin.y - content_rectangle.origin.y).max(0.0);
        }
        native_guest.setFrame(guest_rectangle);
        let actual = native_guest.frame();
        debug_assert_eq!(controls_rectangle.size.height, layout.controls_height);
        for rectangle in [controls_rectangle, actual] {
            debug_assert!(
                rectangle.origin.x >= content_rectangle.origin.x
                    && rectangle.origin.y >= content_rectangle.origin.y
                    && rectangle.origin.x + rectangle.size.width
                        <= content_rectangle.origin.x + content_rectangle.size.width
                    && rectangle.origin.y + rectangle.size.height
                        <= content_rectangle.origin.y + content_rectangle.size.height,
                "Browser child {rectangle:?} is outside visible content {content_rectangle:?}"
            );
        }
        debug_assert!(
            if parent.isFlipped() {
                actual.origin.y >= controls_rectangle.origin.y + controls_rectangle.size.height
            } else {
                actual.origin.y + actual.size.height <= controls_rectangle.origin.y
            },
            "Website content overlaps browser controls"
        );
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn resize_guest(
    guest: &WebView,
    _controls: &tauri::Webview,
    layout: &super::policy::BrowserLayout,
) -> Result<(), String> {
    guest
        .set_bounds(wry::Rect {
            position: tauri::LogicalPosition::new(0.0, layout.controls_height).into(),
            size: tauri::LogicalSize::new(layout.width, layout.content_height).into(),
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
pub(super) fn resize_guest(
    _guest: &WebView,
    controls: &tauri::Webview,
    layout: &super::policy::BrowserLayout,
) -> Result<(), String> {
    use gtk::prelude::WidgetExt;
    let controls_height = layout.controls_height as i32;
    // Wry's GtkBox child ignores set_bounds; Gtk size requests reserve the toolbar.
    controls
        .with_webview(move |webview| {
            webview.inner().set_size_request(-1, controls_height);
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub(super) use macos::{back, deny_permissions, forward, loading};
#[cfg(target_os = "macos")]
pub(super) type Permissions = objc2::rc::Retained<macos::PermissionDelegate>;

#[cfg(not(target_os = "macos"))]
pub(super) struct Permissions;

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) fn build_guest(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    builder
        .build_as_child(window)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
pub(super) fn build_guest(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    use gtk::prelude::*;
    use wry::WebViewBuilderExtUnix;
    let container = window.default_vbox().map_err(|error| error.to_string())?;
    // Tauri adds the toolbar to the box first. Only remote content expands vertically.
    if let Some(toolbar) = container.children().first() {
        toolbar.set_size_request(-1, super::policy::CONTROLS_HEIGHT as i32);
        container.set_child_packing(toolbar, false, false, 0, gtk::PackType::Start);
    }
    builder
        .build_gtk(&container)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
pub(super) fn deny_permissions(guest: &WebView) -> Result<Permissions, String> {
    use webkit2gtk::{FileChooserRequestExt, PermissionRequestExt, WebViewExt};
    use wry::WebViewExtUnix;
    let webview = guest.webview();
    webview.connect_enter_fullscreen(|_| true);
    webview.connect_permission_request(|_, request| {
        request.deny();
        true
    });
    webview.connect_run_file_chooser(|_, request| {
        request.cancel();
        true
    });
    Ok(Permissions)
}

#[cfg(target_os = "linux")]
pub(super) fn back(guest: &WebView) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    use wry::WebViewExtUnix;
    guest.webview().go_back();
    Ok(())
}

#[cfg(target_os = "linux")]
pub(super) fn forward(guest: &WebView) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    use wry::WebViewExtUnix;
    guest.webview().go_forward();
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn deny_permissions(guest: &WebView) -> Result<Permissions, String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, COREWEBVIEW2_PERMISSION_STATE_DENY},
        PermissionRequestedEventHandler,
    };
    use windows_core::Interface;
    use wry::WebViewExtWindows;
    let mut event_token = 0;
    unsafe {
        let profile = guest
            .webview()
            .cast::<ICoreWebView2_13>()
            .and_then(|webview| webview.Profile())
            .map_err(|_| {
                "Buzz Browser requires a WebView2 runtime with private browsing support"
            })?;
        let mut is_private = windows_core::BOOL::default();
        profile
            .IsInPrivateModeEnabled(&mut is_private)
            .map_err(|error| error.to_string())?;
        if !is_private.as_bool() {
            return Err("Buzz Browser could not create a private website session".into());
        }
        guest
            .webview()
            .add_PermissionRequested(
                &PermissionRequestedEventHandler::create(Box::new(|_, arguments| {
                    if let Some(arguments) = arguments {
                        arguments.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    }
                    Ok(())
                })),
                &mut event_token,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(Permissions)
}

#[cfg(target_os = "windows")]
pub(super) fn back(guest: &WebView) -> Result<(), String> {
    use wry::WebViewExtWindows;
    unsafe { guest.webview().GoBack().map_err(|error| error.to_string()) }
}

#[cfg(target_os = "windows")]
pub(super) fn forward(guest: &WebView) -> Result<(), String> {
    use wry::WebViewExtWindows;
    unsafe {
        guest
            .webview()
            .GoForward()
            .map_err(|error| error.to_string())
    }
}
