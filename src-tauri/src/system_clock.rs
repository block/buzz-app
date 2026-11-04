/// The macOS 24-hour time setting as an `Intl` hour cycle. The webview's
/// locale ignores it, so en-US with 24-hour time still formats "2:05 PM".
#[tauri::command]
pub fn system_hour_cycle() -> Option<&'static str> {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{ns_string, NSDateFormatter, NSLocale};

        let pattern = NSDateFormatter::dateFormatFromTemplate_options_locale(
            ns_string!("j"),
            0,
            Some(&NSLocale::autoupdatingCurrentLocale()),
        )?;
        hour_cycle(&pattern.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Reads the hour symbol of a date pattern, skipping quoted literals.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn hour_cycle(pattern: &str) -> Option<&'static str> {
    let mut quoted = false;
    for symbol in pattern.chars() {
        match symbol {
            '\'' => quoted = !quoted,
            'h' | 'K' if !quoted => return Some("h12"),
            'H' | 'k' if !quoted => return Some("h23"),
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::hour_cycle;

    #[test]
    fn reads_the_unquoted_hour_symbol() {
        assert_eq!(hour_cycle("h a"), Some("h12"));
        assert_eq!(hour_cycle("HH"), Some("h23"));
        assert_eq!(hour_cycle("'h'H"), Some("h23"));
        assert_eq!(hour_cycle("a"), None);
    }
}
