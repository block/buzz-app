use tauri::Window;
use wry::{WebView, WebViewBuilder};

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;

    use block2::Block;
    use objc2::{
        define_class, msg_send,
        rc::Retained,
        runtime::{AnyObject, ProtocolObject, Sel},
        sel, DefinedClass, MainThreadOnly,
    };
    use objc2_foundation::{
        MainThreadMarker, NSError, NSObject, NSObjectProtocol, NSString, NSURLErrorCancelled,
        NSURLErrorDomain, NSURLRequest, NSURL,
    };
    use objc2_web_kit::{
        WKFrameInfo, WKMediaCaptureType, WKNavigation, WKNavigationDelegate, WKPermissionDecision,
        WKSecurityOrigin, WKUIDelegate, WKWebView,
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

    pub struct NavigationIvars {
        wry: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
        // The load that retries over http if it fails, and the http URL.
        fallback: RefCell<Option<(Retained<WKNavigation>, String)>>,
    }

    define_class!(
        // Wry's navigation delegate reports no failed loads. This one adds
        // that and forwards every message Wry's delegate handles to it.
        #[unsafe(super(NSObject))]
        #[name = "BuzzBrowserNavigationDelegate"]
        #[thread_kind = MainThreadOnly]
        #[ivars = NavigationIvars]
        pub struct NavigationDelegate;

        impl NavigationDelegate {
            #[unsafe(method(respondsToSelector:))]
            fn responds_to_selector(&self, selector: Sel) -> bool {
                let own: bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
                own || self.ivars().wry.respondsToSelector(selector)
            }

            #[unsafe(method(forwardingTargetForSelector:))]
            fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
                Retained::as_ptr(&self.ivars().wry) as *mut AnyObject
            }
        }

        unsafe impl NSObjectProtocol for NavigationDelegate {}

        unsafe impl WKNavigationDelegate for NavigationDelegate {
            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional_navigation(
                &self,
                webview: &WKWebView,
                navigation: Option<&WKNavigation>,
                error: &NSError,
            ) {
                let fallback = fallback_after(
                    &mut self.ivars().fallback.borrow_mut(),
                    |load| navigation.is_some_and(|navigation| std::ptr::eq(&**load, navigation)),
                    retries_over_http(error),
                );
                if let Some(url) =
                    fallback.and_then(|url| NSURL::URLWithString(&NSString::from_str(&url)))
                {
                    unsafe {
                        webview.loadRequest(&NSURLRequest::requestWithURL(&url));
                    }
                }
            }
        }
    );

    /// Uses up `pending`'s http URL when its own load fails with `retryable`.
    fn fallback_after<Load>(
        pending: &mut Option<(Load, String)>,
        is_failed_load: impl Fn(&Load) -> bool,
        retryable: bool,
    ) -> Option<String> {
        if !retryable
            || !pending
                .as_ref()
                .is_some_and(|(load, _)| is_failed_load(load))
        {
            return None;
        }
        pending.take().map(|(_, url)| url)
    }

    /// A cancelled load was replaced by another, which owns what loads next.
    fn retries_over_http(error: &NSError) -> bool {
        error.domain().isEqualToString(unsafe { NSURLErrorDomain })
            && error.code() != NSURLErrorCancelled
    }

    pub fn observe_navigation(guest: &WebView) -> Result<Retained<NavigationDelegate>, String> {
        let marker = MainThreadMarker::new()
            .ok_or("Browser navigation must be observed on the UI thread")?;
        let view = guest.webview();
        let wry = unsafe { view.navigationDelegate() }
            .ok_or("Browser navigation delegate is unavailable")?;
        let allocated = NavigationDelegate::alloc(marker).set_ivars(NavigationIvars {
            wry,
            fallback: RefCell::new(None),
        });
        let delegate: Retained<NavigationDelegate> = unsafe { msg_send![super(allocated), init] };
        // WebKit asks which messages a delegate handles only when it is set and
        // allows every navigation whose policy message goes unanswered.
        for selector in [
            sel!(webView:decidePolicyForNavigationAction:decisionHandler:),
            sel!(webView:decidePolicyForNavigationResponse:decisionHandler:),
            sel!(webView:didCommitNavigation:),
            sel!(webView:didFinishNavigation:),
        ] {
            if !delegate.respondsToSelector(selector) {
                return Err(format!(
                    "Browser navigation delegate does not forward {}",
                    selector.name().to_string_lossy()
                ));
            }
        }
        unsafe {
            view.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        Ok(delegate)
    }

    /// Loads `url` as Wry's `load_url` does, keeping the load to recognize its failure.
    pub fn load(
        guest: &WebView,
        navigation: &NavigationDelegate,
        url: &url::Url,
        http_fallback: Option<url::Url>,
    ) -> Result<(), String> {
        let target =
            NSURL::URLWithString(&NSString::from_str(url.as_str())).ok_or("Malformed URL")?;
        let load = unsafe {
            guest
                .webview()
                .loadRequest(&NSURLRequest::requestWithURL(&target))
        };
        *navigation.ivars().fallback.borrow_mut() = load
            .zip(http_fallback)
            .map(|(load, url)| (load, url.to_string()));
        Ok(())
    }

    /// Named website data stores exist from macOS 14. Earlier, Wry falls
    /// back to the default store, which the app's own webview also uses.
    pub fn named_stores() -> bool {
        objc2_foundation::NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 14
    }

    fn builderlab_viewer_cookie(
        bootstrap: &super::super::builderlab::Bootstrap,
    ) -> Result<Retained<objc2_foundation::NSHTTPCookie>, String> {
        use objc2_foundation::{ns_string, NSDictionary, NSHTTPCookie, NSString, NSURL};
        let origin = NSURL::URLWithString(&NSString::from_str(&bootstrap.app_origin))
            .ok_or("Invalid Builderlab app origin")?;
        let headers = NSDictionary::from_slices(
            &[ns_string!("Set-Cookie")],
            &[&*NSString::from_str(&bootstrap.cookie)],
        );
        let cookies = NSHTTPCookie::cookiesWithResponseHeaderFields_forURL(&headers, &origin);
        let cookie = cookies
            .firstObject()
            .ok_or("Builderlab viewer cookie is unavailable")?;
        let host =
            url::Url::parse(&bootstrap.app_origin).map_err(|_| "Invalid Builderlab app origin")?;
        if cookies.count() != 1
            || cookie.name().to_string() != "__Secure-bbidentity_hosted_site_session"
            || !cookie.isHTTPOnly()
            || !cookie.isSecure()
            || cookie.expiresDate().is_none()
            || cookie.domain().to_string().trim_start_matches('.') != bootstrap.cookie_domain
            || !host
                .host_str()
                .is_some_and(|value| value.ends_with(&format!(".{}", bootstrap.cookie_domain)))
            || cookie.path().to_string() != "/"
        {
            return Err("Builderlab viewer cookie is unavailable".into());
        }
        Ok(cookie)
    }

    /// Installs only the restricted native viewer cookie; never reads cookies or accepts caller cookie fields.
    pub fn install_builderlab_cookie(
        guest: &WebView,
        bootstrap: &super::super::builderlab::Bootstrap,
    ) -> Result<tokio::sync::mpsc::Receiver<()>, String> {
        let cookie = builderlab_viewer_cookie(bootstrap)?;
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let complete = block2::RcBlock::new(move || {
            let _ = sender.try_send(());
        });
        unsafe {
            guest
                .webview()
                .configuration()
                .websiteDataStore()
                .httpCookieStore()
                .setCookie_completionHandler(&cookie, Some(&complete));
        }
        Ok(receiver)
    }

    pub fn loading(guest: &WebView) -> bool {
        unsafe { guest.webview().isLoading() }
    }

    pub fn focused(guest: &WebView) -> bool {
        let view = guest.webview();
        let Some(responder) = view.window().and_then(|window| window.firstResponder()) else {
            return false;
        };
        responder
            .downcast_ref::<objc2_app_kit::NSView>()
            .is_some_and(|focused| focused.isDescendantOf(&view))
    }

    pub fn current_url(guest: &WebView) -> Result<Option<String>, String> {
        // WKWebView has no URL before its first navigation; Wry 0.55.1 unwraps it.
        Ok(unsafe {
            guest
                .webview()
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string())
        })
    }

    pub fn back(guest: &WebView) -> Result<(), String> {
        unsafe {
            guest.webview().goBack();
        }
        Ok(())
    }

    /// Also holds Web Audio, and blocks the page from playing again until resumed.
    pub fn set_media_suspended(guest: &WebView, suspended: bool) -> Result<(), String> {
        unsafe {
            guest
                .webview()
                .setAllMediaPlaybackSuspended_completionHandler(suspended, None);
        }
        Ok(())
    }

    pub fn forward(guest: &WebView) -> Result<(), String> {
        unsafe {
            guest.webview().goForward();
        }
        Ok(())
    }
    #[cfg(test)]
    mod binding_tests {
        use super::*;

        fn error(domain: &NSString, code: isize) -> Retained<NSError> {
            unsafe { NSError::errorWithDomain_code_userInfo(domain, code, None) }
        }

        #[test]
        fn only_the_failed_address_load_falls_back_once() {
            let is_load = |id: u32| move |load: &u32| *load == id;
            let mut pending = Some((1, "http://grugbrain.dev/".to_string()));
            assert_eq!(fallback_after(&mut pending, is_load(2), true), None);
            assert_eq!(fallback_after(&mut pending, is_load(1), false), None);
            assert_eq!(
                fallback_after(&mut pending, is_load(1), true).as_deref(),
                Some("http://grugbrain.dev/")
            );
            assert_eq!(pending, None);
            assert_eq!(fallback_after(&mut pending, is_load(1), true), None);
        }

        #[test]
        fn only_failed_connections_retry_over_http() {
            let url_errors = unsafe { NSURLErrorDomain };
            // Connection refused, TLS handshake failure and an untrusted certificate.
            for code in [-1004, -1200, -1202] {
                assert!(retries_over_http(&error(url_errors, code)));
            }
            assert!(!retries_over_http(&error(url_errors, NSURLErrorCancelled)));
            // WebKit's "frame load interrupted", as when the navigation policy refuses a URL.
            assert!(!retries_over_http(&error(
                &NSString::from_str("WebKitErrorDomain"),
                102
            )));
        }
        #[test]
        fn viewer_cookie_matches_existing_domain_http_only_secure_and_expiry() {
            // Foundation caps far-future cookies. Use a short future date while asserting exact parsing,
            // rather than testing the engine's unrelated long-term cookie retention policy.
            let expiry = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64
                + 60;
            let date = chrono::DateTime::<chrono::Utc>::from_timestamp(expiry, 0).unwrap();
            let date = date.format("%a, %d %b %Y %H:%M:%S GMT");
            let value = super::super::super::builderlab::Bootstrap {
                app_origin: "https://counter--bpsites.apps.example".into(),
                cookie_domain: "apps.example".into(),
                cookie: zeroize::Zeroizing::new(format!("__Secure-bbidentity_hosted_site_session=viewer; Domain=apps.example; Path=/; Expires={date}; Secure; HttpOnly; SameSite=Lax")),
            };
            let cookie = builderlab_viewer_cookie(&value).unwrap();
            assert_eq!(
                cookie.domain().to_string().trim_start_matches('.'),
                "apps.example"
            );
            assert_eq!(cookie.path().to_string(), "/");
            assert!(cookie.isHTTPOnly());
            assert!(cookie.isSecure());
            assert!(!cookie.isSessionOnly());
            assert_eq!(
                cookie.expiresDate().unwrap().timeIntervalSince1970(),
                expiry as f64
            );
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn resize_guest(
    guest: &WebView,
    host: &tauri::Webview,
    bounds: super::BrowserBounds,
    // macOS lays out in points, which equal the frontend's CSS pixels.
    _css_scale: Option<f64>,
) -> Result<(), String> {
    use objc2_web_kit::WKWebView;
    use wry::WebViewExtMacOS;
    let (sender, receiver) = std::sync::mpsc::channel();
    host.with_webview(move |webview| {
        // CSS coordinates start at the top left; AppKit views may be unflipped.
        let host = unsafe { &*webview.inner().cast::<WKWebView>() };
        let viewport = host.bounds();
        let result = bounds
            .clip(viewport.size.width, viewport.size.height)
            .map(|bounds| {
                let mut rectangle = viewport;
                rectangle.origin.x += bounds.x;
                rectangle.origin.y += if host.isFlipped() {
                    bounds.y
                } else {
                    viewport.size.height - bounds.y - bounds.height
                };
                rectangle.size.width = bounds.width;
                rectangle.size.height = bounds.height;
                host.convertRect_toView(rectangle, None)
            });
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    let rectangle = receiver
        .try_recv()
        .map_err(|_| "Browser layout must run on the UI thread")??;
    unsafe {
        let native_guest = guest.webview();
        let parent = native_guest
            .superview()
            .ok_or("Browser content has no parent view")?;
        native_guest.setFrame(parent.convertRect_fromView(rectangle, None));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(super) fn resize_guest(
    guest: &WebView,
    host: &tauri::Webview,
    bounds: super::BrowserBounds,
    // Windows logical pixels equal the frontend's CSS pixels.
    _css_scale: Option<f64>,
) -> Result<(), String> {
    let scale = host
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let size = host
        .size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let position = host
        .position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let bounds = bounds.clip(size.width, size.height)?;
    guest
        .set_bounds(wry::Rect {
            position: tauri::LogicalPosition::new(position.x + bounds.x, position.y + bounds.y)
                .into(),
            size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
mod linux {
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use wry::{WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

    thread_local! {
        static GUEST_LAYER: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
        static GUEST_RECTS: RefCell<HashMap<usize, gtk::Allocation>> =
            RefCell::new(HashMap::new());
    }

    /// The layer floating browser guests above the window's own content,
    /// created on first use.
    fn guest_layer(window: &gtk::ApplicationWindow) -> gtk::Overlay {
        GUEST_LAYER.with(|layer| {
            if let Some(overlay) = layer.borrow().as_ref() {
                return overlay.clone();
            }
            let overlay = gtk::Overlay::new();
            overlay.connect_get_child_position(|_, child| {
                GUEST_RECTS.with(|rects| rects.borrow().get(&(child.as_ptr() as usize)).copied())
            });
            if let Some(child) = window.child() {
                window.remove(&child);
                overlay.add(&child);
            }
            window.add(&overlay);
            overlay.show_all();
            layer.borrow_mut().replace(overlay.clone());
            overlay
        })
    }

    fn guest_frame(guest: &webkit2gtk::WebView) -> Option<gtk::Fixed> {
        guest
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Fixed>().ok())
    }

    /// Builds the guest's content into its own frame on the window's overlay.
    ///
    /// An overlay child receives events everywhere inside its allocation, so
    /// a window-spanning guest container would swallow every click meant for
    /// the app. Each guest instead gets a frame whose allocation resize_guest
    /// sets exactly to the guest's bounds through the overlay's
    /// get-child-position signal. The frame appears and disappears with its
    /// guest and is destroyed with it, leaving no event surface behind.
    pub fn build_guest(
        builder: WebViewBuilder<'_>,
        window: &gtk::ApplicationWindow,
    ) -> Result<WebView, String> {
        let overlay = guest_layer(window);
        let frame = gtk::Fixed::new();
        frame.set_no_show_all(true);
        overlay.add_overlay(&frame);
        let guest = builder
            .build_gtk(&frame)
            .map_err(|error| error.to_string())?;
        let widget = guest.webview();
        widget.connect_show(|widget| {
            if let Some(frame) = guest_frame(widget) {
                frame.show();
            }
        });
        widget.connect_hide(|widget| {
            if let Some(frame) = guest_frame(widget) {
                frame.hide();
            }
        });
        // A workspace switch or minimize unmaps the window's GdkWindow
        // without unmapping child widgets, so WebKit never learns the guest
        // went away and came back: it keeps showing its discarded frame and
        // the guest stays black. On every toplevel remap, cycle visible
        // guests through hide/show so WebKit's own visibility tracking
        // submits a fresh frame.
        window.add_events(gtk::gdk::EventMask::STRUCTURE_MASK);
        let remap = widget.downgrade();
        let remap_handler = window.connect_map_event(move |_, _| {
            if let Some(widget) = remap.upgrade() {
                if widget.is_visible() {
                    widget.hide();
                    widget.show();
                }
            }
            gtk::glib::Propagation::Proceed
        });
        widget.connect_destroy({
            let frame = frame.downgrade();
            let window = window.clone();
            let remap_handler = RefCell::new(Some(remap_handler));
            move |_| {
                if let Some(handler) = remap_handler.borrow_mut().take() {
                    window.disconnect(handler);
                }
                // GTK unparents a widget before emitting its destroy signal,
                // so the frame must be reached through the weak reference.
                if let Some(frame) = frame.upgrade() {
                    GUEST_RECTS.with(|rects| rects.borrow_mut().remove(&(frame.as_ptr() as usize)));
                    // Guest drops run on the UI thread; destroying the frame
                    // from its child's destroy signal is reentrancy-safe.
                    unsafe { frame.destroy() };
                }
            }
        });
        Ok(guest)
    }

    pub fn place_guest(
        guest: &webkit2gtk::WebView,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        let frame = guest_frame(guest).ok_or("Browser content has no guest frame")?;
        GUEST_RECTS.with(|rects| {
            rects.borrow_mut().insert(
                frame.as_ptr() as usize,
                gtk::Allocation::new(x, y, width, height),
            );
        });
        guest.set_size_request(width, height);
        // set_size_request queues no resize on a hidden widget, so its cached
        // requisition would stay stale and the next container pass would
        // reallocate the guest at its old size. Marking the resize makes the
        // direct allocation below clear that cache (gtk_widget_ensure_resize).
        guest.queue_resize();
        // The container pass does not reliably reallocate the guest inside
        // its frame, so allocate it directly, as wry's fixed-parent
        // set_bounds does.
        guest.size_allocate(&gtk::Allocation::new(0, 0, width, height));
        frame.queue_resize();
        Ok(())
    }

    /// CSS pixel to GTK unit ratio. The frontend measures in CSS pixels while
    /// GTK allocates in integer-scaled units; the two ratios differ under
    /// fractional display scaling, so a 1:1 mapping misplaces guests there.
    pub fn css_to_gtk(css_scale: Option<f64>, gtk_scale: f64) -> f64 {
        css_scale
            .filter(|scale| scale.is_finite() && *scale > 0.0)
            .unwrap_or(gtk_scale)
            / gtk_scale
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn css_to_gtk_differs_only_under_fractional_scaling() {
            assert_eq!(super::css_to_gtk(Some(2.0), 2.0), 1.0);
            assert_eq!(super::css_to_gtk(Some(1.0), 1.0), 1.0);
            assert!((super::css_to_gtk(Some(2.2331), 2.0) - 1.11655).abs() < 1e-4);
            // Absent or unusable ratios keep the historical 1:1 mapping.
            assert_eq!(super::css_to_gtk(None, 2.0), 1.0);
            assert_eq!(super::css_to_gtk(Some(0.0), 2.0), 1.0);
            assert_eq!(super::css_to_gtk(Some(-2.0), 2.0), 1.0);
            assert_eq!(super::css_to_gtk(Some(f64::NAN), 2.0), 1.0);
        }
    }
}

#[cfg(target_os = "linux")]
pub(super) fn resize_guest(
    guest: &WebView,
    host: &tauri::Webview,
    bounds: super::BrowserBounds,
    css_scale: Option<f64>,
) -> Result<(), String> {
    use gtk::prelude::*;
    use wry::WebViewExtUnix;
    // CSS coordinates start at the host webview's top left; guest frames are
    // positioned on the window's overlay, so the host's offset must be added.
    let (sender, receiver) = std::sync::mpsc::channel();
    host.with_webview(move |webview| {
        let widget = webview.inner();
        let allocation = widget.allocation();
        let offset = widget
            .toplevel()
            .and_then(|toplevel| widget.translate_coordinates(&toplevel, 0, 0))
            .unwrap_or((0, 0));
        let _ = sender.send((
            allocation.width() as f64,
            allocation.height() as f64,
            offset,
            f64::from(widget.scale_factor()),
        ));
    })
    .map_err(|error| error.to_string())?;
    let (width, height, (x, y), gtk_scale) = receiver
        .try_recv()
        .map_err(|_| "Browser layout must run on the UI thread")?;
    let factor = linux::css_to_gtk(css_scale, gtk_scale);
    let bounds = super::BrowserBounds {
        x: bounds.x * factor,
        y: bounds.y * factor,
        width: bounds.width * factor,
        height: bounds.height * factor,
    }
    .clip(width, height)?;
    linux::place_guest(
        &guest.webview(),
        x + bounds.x.round() as i32,
        y + bounds.y.round() as i32,
        bounds.width.round() as i32,
        bounds.height.round() as i32,
    )
}

#[cfg(target_os = "macos")]
pub(super) use macos::{
    back, current_url, deny_permissions, focused, forward, install_builderlab_cookie, load,
    loading, observe_navigation, set_media_suspended,
};
#[cfg(target_os = "macos")]
pub(super) type Permissions = objc2::rc::Retained<macos::PermissionDelegate>;
#[cfg(target_os = "macos")]
pub(super) type Navigation = objc2::rc::Retained<macos::NavigationDelegate>;

#[cfg(not(target_os = "macos"))]
pub(super) struct Permissions;

/// Elsewhere a failed load does not retry over http.
#[cfg(not(target_os = "macos"))]
pub(super) struct Navigation;

#[cfg(not(target_os = "macos"))]
pub(super) fn observe_navigation(_guest: &WebView) -> Result<Navigation, String> {
    Ok(Navigation)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn load(
    guest: &WebView,
    _navigation: &Navigation,
    url: &url::Url,
    _http_fallback: Option<url::Url>,
) -> Result<(), String> {
    guest
        .load_url(url.as_str())
        .map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(super) fn set_media_suspended(_guest: &WebView, _suspended: bool) -> Result<(), String> {
    Err("Suspending a page's media is supported only on macOS".into())
}

/// Reads the guest's URL from its own handlers, which the guest owns, so
/// this holds it weakly.
#[cfg(target_os = "macos")]
pub(super) fn location(guest: &WebView) -> Box<dyn Fn() -> Option<String>> {
    use wry::WebViewExtMacOS;
    let guest = objc2::rc::Weak::from_retained(&guest.webview());
    Box::new(move || {
        let guest = guest.load()?;
        unsafe { guest.URL() }
            .and_then(|url| url.absoluteString())
            .map(|url| url.to_string())
    })
}

/// Elsewhere the page-load URL stands in.
#[cfg(not(target_os = "macos"))]
pub(super) fn location(_guest: &WebView) -> Box<dyn Fn() -> Option<String>> {
    Box::new(|| None)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn current_url(guest: &WebView) -> Result<Option<String>, String> {
    guest.url().map(Some).map_err(|error| error.to_string())
}

/// Keeps the guest's website storage under `storage` between sessions where
/// the platform can hold it apart from the app's; otherwise it stays private.
#[cfg(target_os = "macos")]
pub(super) fn with_storage(
    builder: WebViewBuilder<'_>,
    storage: Option<[u8; 16]>,
) -> WebViewBuilder<'_> {
    use wry::WebViewBuilderExtDarwin;
    match storage {
        Some(identifier) if macos::named_stores() => builder
            .with_incognito(false)
            .with_data_store_identifier(identifier),
        _ => builder.with_incognito(true),
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn with_storage(
    builder: WebViewBuilder<'_>,
    _storage: Option<[u8; 16]>,
) -> WebViewBuilder<'_> {
    builder.with_incognito(true)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub(super) fn build_guest(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    builder
        .build_as_child(window)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
pub(super) fn build_guest(builder: WebViewBuilder<'_>, window: &Window) -> Result<WebView, String> {
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    linux::build_guest(builder, &gtk_window)
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

/// WebKitGTK has no suspend equivalent; muting keeps a hidden page silent
/// while its playback keeps running.
#[cfg(target_os = "linux")]
pub(super) fn set_media_suspended(guest: &WebView, suspended: bool) -> Result<(), String> {
    use webkit2gtk::WebViewExt;
    use wry::WebViewExtUnix;
    guest.webview().set_is_muted(suspended);
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

#[cfg(not(target_os = "macos"))]
pub(super) fn install_builderlab_cookie(
    _guest: &WebView,
    _bootstrap: &super::builderlab::Bootstrap,
) -> Result<tokio::sync::mpsc::Receiver<()>, String> {
    Err("Builderlab viewer sign-in is supported only on macOS".into())
}
