//! macOS spell checking defaults for the app's webviews.
//!
//! WKWebView underlines misspellings only when the app's
//! `WebContinuousSpellCheckingEnabled` default is YES, and WebKit reads a
//! missing key as NO (`TextCheckerMac.mm`). Without this, `spellcheck="true"`
//! on the composer does nothing until someone finds the context-menu toggle.

use objc2::runtime::AnyObject;
use objc2_foundation::{ns_string, NSDictionary, NSNumber, NSString, NSUserDefaults};

const CONTINUOUS_SPELL_CHECKING: &str = "WebContinuousSpellCheckingEnabled";

/// Turns continuous spell checking on unless the person chose otherwise.
///
/// The registration domain is per-process and sits below the persisted app
/// domain, so the context-menu toggle still wins and survives relaunch. WebKit
/// reads the default once per process, so call this before creating a webview.
pub(crate) fn register_defaults() {
    let enabled = NSNumber::new_bool(true);
    let value: &AnyObject = &enabled;
    let defaults = NSDictionary::<NSString, AnyObject>::from_slices(
        &[ns_string!(CONTINUOUS_SPELL_CHECKING)],
        &[value],
    );
    // SAFETY: keys are NSString and the value is an NSNumber, both property-list types.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&defaults) };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Removes the test process's saved value, including when an assertion fails.
    struct ClearSaved;

    impl ClearSaved {
        fn new() -> Self {
            Self.clear();
            Self
        }

        fn clear(&self) {
            NSUserDefaults::standardUserDefaults()
                .removeObjectForKey(ns_string!(CONTINUOUS_SPELL_CHECKING));
        }
    }

    impl Drop for ClearSaved {
        fn drop(&mut self) {
            self.clear();
        }
    }

    // One test, because both phases share the process-wide defaults.
    #[test]
    fn registered_default_is_on_and_a_saved_choice_wins() {
        let _saved = ClearSaved::new();
        register_defaults();
        let defaults = NSUserDefaults::standardUserDefaults();
        let key = ns_string!(CONTINUOUS_SPELL_CHECKING);
        assert!(defaults.boolForKey(key), "unset should read as on");

        defaults.setBool_forKey(false, key);
        assert!(!defaults.boolForKey(key), "a saved off should win");
    }
}
