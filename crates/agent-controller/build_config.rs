use std::{collections::BTreeMap, path::Path};

pub const KEYS: [&str; 4] = [
    "BUZZ_BUILD_AGENT_ENV",
    "BUZZ_BUILD_BUZZ_AGENT_PROVIDER",
    "BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY",
    "BUZZ_BUILD_ACP_SESSION_POLICY",
];

// Parse without mutating the process environment. Never propagate dotenv errors:
// they can contain complete lines, including unrelated local credentials.
pub fn load(
    path: &Path,
    process: impl Fn(&str) -> Option<String>,
) -> Result<BTreeMap<String, String>, &'static str> {
    let mut values: BTreeMap<_, _> = KEYS
        .into_iter()
        .filter_map(|key| process(key).map(|value| (key.to_owned(), value)))
        .collect();
    if values.len() == KEYS.len() {
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
        let selected = KEYS.contains(&key) && !values.contains_key(key);
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
                if KEYS.contains(&key.as_str()) {
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

pub fn selector(value: &str, limit: usize) -> Result<(), &'static str> {
    if value.len() > limit || value.chars().any(char::is_control) {
        Err("Invalid native build provider/model default")
    } else {
        Ok(())
    }
}

pub fn session_policy(value: &str) -> Result<(), &'static str> {
    if matches!(value, "" | "channel" | "thread") {
        Ok(())
    } else {
        Err("Invalid ACP session policy default")
    }
}

// Only nonsecret connection defaults may enter an internal binary. Never forward
// the arbitrary agent environment wholesale or emit its raw contents in errors.
pub fn parse(raw: &str) -> Result<(String, String, String), &'static str> {
    if raw.len() > 16 * 1024 {
        return Err("Agent build configuration is too large");
    }
    let mut host = None;
    let mut filter = None;
    let mut model = None;
    for line in raw.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let (key, value) = line
            .split_once('=')
            .ok_or("Invalid agent build configuration")?;
        let target =
            match key {
                "DATABRICKS_HOST" => &mut host,
                "DATABRICKS_MODEL_FILTER" => &mut filter,
                "DATABRICKS_MODEL" => &mut model,
                _ => return Err(
                    "Unsupported agent build key; only nonsecret Databricks defaults are permitted",
                ),
            };
        if target.is_some() || value.len() > 4096 || value.chars().any(char::is_control) {
            return Err("Invalid or duplicate agent build default");
        }
        *target = Some(value.to_owned());
    }
    let host = host.unwrap_or_default();
    if !host.is_empty() {
        let rest = host
            .strip_prefix("https://")
            .ok_or("Invalid build workspace origin")?;
        let url = url::Url::parse(&host).map_err(|_| "Invalid build workspace origin")?;
        if rest.strip_suffix('/').unwrap_or(rest).contains(['/', '@'])
            || host.contains('\\')
            || url.host_str().is_none()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err("Invalid build workspace origin");
        }
    }
    let model = model.unwrap_or_default();
    selector(&model, 512)?;
    Ok((host, filter.unwrap_or_default(), model))
}
