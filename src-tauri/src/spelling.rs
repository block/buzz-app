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

    #[test]
    fn registers_continuous_spell_checking_on() {
        register_defaults();

        let defaults = NSUserDefaults::standardUserDefaults();
        assert!(defaults.boolForKey(ns_string!(CONTINUOUS_SPELL_CHECKING)));
    }
}
