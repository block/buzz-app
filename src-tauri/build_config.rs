// Only nonsecret connection defaults may enter an internal binary. Never forward
// the arbitrary agent environment wholesale or emit its raw contents in errors.
pub fn parse(raw: &str) -> Result<(String, String), &'static str> {
    if raw.len() > 16 * 1024 {
        return Err("Agent build configuration is too large");
    }
    let mut host = None;
    let mut filter = None;
    for line in raw.lines().map(str::trim).filter(|s| !s.is_empty()) {
        let (key, value) = line
            .split_once('=')
            .ok_or("Invalid agent build configuration")?;
        let target =
            match key {
                "DATABRICKS_HOST" => &mut host,
                "DATABRICKS_MODEL_FILTER" => &mut filter,
                // Existing private build convention; not a selected-model rewrite.
                "DATABRICKS_MODEL" => continue,
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
    Ok((host, filter.unwrap_or_default()))
}
