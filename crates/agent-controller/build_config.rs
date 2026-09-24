use std::{collections::BTreeMap, path::Path};

pub const KEYS: [&str; 3] = [
    "BUZZ_BUILD_AGENT_ENV",
    "BUZZ_BUILD_BUZZ_AGENT_PROVIDER",
    "BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY",
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
        let mut end = line_end;
        // Skip whole quoted records, including unrelated multiline values. A
        // build-looking line inside another value must never become a setting.
        if let Some((_, value)) = rest[..line_end].split_once('=') {
            let value = value.trim_start();
            if let Some(quote @ ('\'' | '"' | '`')) = value.chars().next() {
                let offset = rest[..line_end].len() - value.len();
                let mut escaped = false;
                let close = rest[offset + 1..].char_indices().find_map(|(i, c)| {
                    if escaped {
                        escaped = false;
                        return None;
                    }
                    if c == '\\' {
                        escaped = true;
                        return None;
                    }
                    (c == quote).then_some(offset + 1 + i)
                });
                if let Some(close) = close {
                    end = rest[close..]
                        .find('\n')
                        .map_or(rest.len(), |i| close + i + 1);
                } else if selected {
                    return Err("Invalid native build .env.local");
                } else {
                    end = rest.len();
                }
            }
        }
        if selected {
            for entry in dotenvy::from_read_iter(rest[..end].as_bytes()) {
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
