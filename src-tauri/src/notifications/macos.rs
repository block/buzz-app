//! One process-lifetime notification delegate owns click routing. Submission
//! completion only reports errors; it does not prove a notification was displayed.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};

use block2::{Block, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObjectProtocol, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{NSError, NSObject, NSString};
use objc2_user_notifications::{
    UNAuthorizationStatus, UNMutableNotificationContent, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};

use super::{Outcome, Pending};

static REGISTRY: OnceLock<Arc<Registry>> = OnceLock::new();

#[derive(Default)]
struct Registry(Mutex<HashMap<String, Arc<Pending>>>);

impl Registry {
    fn insert(&self, id: String, pending: Arc<Pending>) {
        if let Ok(mut entries) = self.0.lock() {
            entries.insert(id, pending);
        } else {
            pending.finish(Outcome::Failed("Notification state unavailable".into()));
        }
    }
    fn finish(&self, id: &str, outcome: Outcome) {
        let pending = self
            .0
            .lock()
            .ok()
            .and_then(|mut entries| entries.remove(id));
        if let Some(pending) = pending {
            pending.finish(outcome);
        }
    }
}

struct DelegateIvars {
    registry: Arc<Registry>,
}

define_class!(
    // SAFETY: NSObject permits AnyThread subclasses. Registry is synchronized,
    // and Apple's delegate callback queue is unspecified.
    #[unsafe(super(NSObject))]
    #[name = "BuzzFoundationNotificationDelegate"]
    #[thread_kind = AnyThread]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present_notification(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &objc2_user_notifications::UNNotification,
            completion: &Block<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Notification Center list only, never a foreground banner.
            completion.call((UNNotificationPresentationOptions::List,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive_response(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &Block<dyn Fn()>,
        ) {
            let id = response.notification().request().identifier().to_string();
            let outcome = if &*response.actionIdentifier()
                == unsafe { UNNotificationDefaultActionIdentifier }
            {
                Outcome::Activated
            } else {
                Outcome::Closed
            };
            self.ivars().registry.finish(&id, outcome);
            // Required for every response, including unknown/old requests.
            completion.call(());
        }
    }
);

impl Delegate {
    fn new(registry: Arc<Registry>) -> Retained<Self> {
        let delegate = Self::alloc().set_ivars(DelegateIvars { registry });
        unsafe { msg_send![super(delegate), init] }
    }
}

/// Install once during setup. UNUserNotificationCenter.delegate is weak.
pub(crate) fn init() {
    if !crate::dock::bundled() {
        return;
    }
    REGISTRY.get_or_init(|| {
        let registry = Arc::new(Registry::default());
        let delegate: Retained<ProtocolObject<dyn UNUserNotificationCenterDelegate>> =
            ProtocolObject::from_retained(Delegate::new(registry.clone()));
        UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(&delegate));
        std::mem::forget(delegate);
        registry
    });
}

pub(super) fn show(id: String, title: String, body: String, pending: Arc<Pending>) {
    if !crate::dock::bundled() {
        pending.finish(Outcome::Failed(
            "macOS notifications are unavailable when Buzz is not running from an app bundle"
                .into(),
        ));
        return;
    }
    let Some(registry) = REGISTRY.get().cloned() else {
        pending.finish(Outcome::Failed(
            "macOS notification delegate unavailable".into(),
        ));
        return;
    };
    tauri::async_runtime::spawn_blocking(move || {
        match crate::dock::notification_permission() {
            Ok(
                UNAuthorizationStatus::Authorized
                | UNAuthorizationStatus::Provisional
                | UNAuthorizationStatus::Ephemeral,
            ) => {}
            Ok(_) => {
                pending.finish(Outcome::Failed(
                    "macOS notification permission is not granted".into(),
                ));
                return;
            }
            Err(error) => {
                pending.finish(Outcome::Failed(error));
                return;
            }
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );
        registry.insert(id.clone(), pending);
        let completion = RcBlock::new(move |error: *mut NSError| {
            if let Some(error) = unsafe { error.as_ref() } {
                registry.finish(
                    &id,
                    Outcome::Failed(format!("failed to submit macOS notification: {error}")),
                );
            }
            // A successful submission remains registered for a later click.
        });
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unbundled_process_never_initializes_center() {
        assert!(!crate::dock::bundled());
        init();
        assert!(REGISTRY.get().is_none());
    }
    #[test]
    fn unsuccessful_submission_reports_failure_without_click() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let output = seen.clone();
        registry.insert(
            "failed".into(),
            notifications
                .reserve(Box::new(move |outcome| {
                    output.lock().unwrap().push(outcome);
                }))
                .unwrap(),
        );
        registry.finish("failed", Outcome::Failed("native error".into()));
        registry.finish("failed", Outcome::Activated);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Outcome::Failed("native error".into())]
        );
        assert_eq!(*notifications.0.lock().unwrap(), 0);
    }
    #[test]
    fn registry_routes_once_and_releases_capacity() {
        let registry = Registry::default();
        let notifications = super::super::Notifications::default();
        let seen = Arc::new(Mutex::new(Vec::new()));
        for id in ["first", "second"] {
            let seen = seen.clone();
            registry.insert(
                id.into(),
                notifications
                    .reserve(Box::new(move |outcome| {
                        seen.lock().unwrap().push(outcome);
                    }))
                    .unwrap(),
            );
        }
        registry.finish("second", Outcome::Activated);
        registry.finish("second", Outcome::Closed);
        registry.finish("first", Outcome::Closed);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Outcome::Activated, Outcome::Closed]
        );
        assert_eq!(*notifications.0.lock().unwrap(), 0);
    }
}
