use std::{collections::BTreeMap, path::Path};

// Parse without mutating the process environment. Never propagate dotenv errors:
// they can contain complete lines, including unrelated local credentials.
pub fn load(
    path: &Path,
    keys: &[&str],
    process: impl Fn(&str) -> Option<String>,
) -> Result<BTreeMap<String, String>, &'static str> {
    let mut values: BTreeMap<_, _> = keys
        .iter()
        .copied()
        .filter_map(|key| process(key).map(|value| (key.to_owned(), value)))
        .collect();
    if values.len() == keys.len() {
        return Ok(values);
    }
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(values),
        Err(_) => return Err("Could not read native build .env.local"),
    };
    let mut local = BTreeMap::new();
    let mut rest = text.trim_start_matches('\u{feff}');
    while !rest.is_empty() {
        let line_end = rest.find('\n').map_or(rest.len(), |end| end + 1);
        let line = rest[..line_end].trim_start();
        if line.is_empty() || line.starts_with('#') {
            rest = &rest[line_end..];
            continue;
        }
        let assignment = line
            .strip_prefix("export")
            .filter(|tail| tail.starts_with(char::is_whitespace))
            .unwrap_or(line)
            .trim_start();
        let key = assignment
            .split(|c: char| c == '=' || c.is_whitespace())
            .next()
            .unwrap_or("");
        let selected = keys.contains(&key) && !values.contains_key(key);
        // Only a value starting with a backtick uses alternate-loader framing.
        // Mid-value backticks are literal characters in dotenvy.
        let backtick_start = assignment
            .strip_prefix(key)
            .and_then(|tail| tail.trim_start().strip_prefix('='))
            .map(str::trim_start)
            .filter(|value| value.starts_with('`'))
            .map(|value| line_end - value.len());
        // Follow dotenvy's whole-record quote/escape/comment boundaries, not
        // just the first quoted segment. Also conservatively contain backtick
        // records used by other dev loaders (dotenvy does not decode them).
        let mut end = rest.len();
        let mut quote = None;
        let mut escaped = false;
        let mut whitespace = false;
        let mut backtick = false;
        let mut comment = false;
        for (i, c) in rest.char_indices() {
            // Backtick containment must never mask dotenvy's quote state.
            // A comment can block opening a frame, never closing an existing one.
            if c == '`' && !escaped && (backtick || (!comment && backtick_start == Some(i))) {
                backtick = !backtick;
            }
            if comment {
                comment = c != '\n';
            } else if escaped {
                escaped = false;
                whitespace = false;
            } else if c == '\\' {
                escaped = true;
                whitespace = false;
            } else if let Some(open) = quote {
                if c == open {
                    quote = None;
                }
            } else if whitespace && c == '#' {
                comment = true;
                whitespace = false;
            } else if matches!(c, '\'' | '"') {
                quote = Some(c);
                whitespace = false;
            } else {
                // Match dotenvy's one-character WhiteSpace state.
                whitespace = !whitespace && c.is_whitespace() && !matches!(c, '\n' | '\r');
            }
            if c == '\n' && quote.is_none() && !escaped && !backtick {
                end = i + 1;
                break;
            }
        }
        if backtick {
            return Err("Invalid native build .env.local");
        }
        if selected {
            for entry in dotenvy::from_read_iter(&rest.as_bytes()[..end]) {
                let (key, value) = entry.map_err(|_| "Invalid native build .env.local")?;
                if keys.contains(&key.as_str()) {
                    local.insert(key, value);
                }
            }
        }
        rest = &rest[end..];
    }
    for (key, value) in local {
        values.entry(key).or_insert(value);
    }
    Ok(values)
}
