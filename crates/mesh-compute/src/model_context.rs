//! Context selection from the owned node's OpenAI model catalog, never guessed capacity.
use serde_json::Value;

/// Resolve the pinned router's automatic model and its advertised context budget.
/// Auto may use the smallest reported concrete budget when its own is absent.
pub fn resolve(catalog: &Value, selected: &str) -> Result<(String, u64), String> {
    let models = catalog["data"]
        .as_array()
        .ok_or("Invalid Mesh model catalog")?;
    let auto = matches!(selected.trim(), "" | "auto" | "mesh");
    let id = if auto { "mesh" } else { selected.trim() };
    let model = models.iter().find(|model| model["id"].as_str() == Some(id));
    if !auto && model.is_none() {
        return Err("Selected model is not advertised by the running Mesh node".into());
    }
    let context = |model: &Value| {
        model["metadata"]["context_length"]
            .as_u64()
            .filter(|n| *n > 0)
    };
    let limit = model
        .and_then(context)
        .or_else(|| {
            auto.then(|| {
                models
                    .iter()
                    .filter(|model| model["id"].as_str().is_some_and(|name| name != "mesh"))
                    .filter_map(context)
                    .min()
            })
            .flatten()
        })
        .ok_or("Mesh models do not advertise a usable context limit")?;
    Ok((id.into(), limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn auto_uses_virtual_budget_or_minimum_reported_concrete_budget() {
        let catalog = json!({"data":[{"id":"mesh"},{"id":"a","metadata":{"context_length":65536}}, {"id":"b","metadata":{"context_length":32768}}, {"id":"unknown"}]});
        assert_eq!(resolve(&catalog, "auto").unwrap(), ("mesh".into(), 32768));
        let mut explicit = catalog.clone();
        explicit["data"][0]["metadata"] = json!({"context_length":16384});
        assert_eq!(resolve(&explicit, "").unwrap().1, 16384);
        assert_eq!(resolve(&catalog, "a").unwrap().1, 65536);
        assert!(resolve(&catalog, "unknown").is_err());
        assert!(resolve(&catalog, "absent").is_err());
    }
    #[test]
    fn missing_and_invalid_capacity_fail_closed() {
        assert!(resolve(
            &json!({"data":[{"id":"mesh"},{"id":"a","metadata":{"context_length":0}}]}),
            "auto"
        )
        .is_err());
        assert!(resolve(&json!({}), "auto").is_err());
        // Mainline accepts the virtual route with just one concrete model.
        assert_eq!(
            resolve(
                &json!({"data":[{"id":"a","metadata":{"context_length":4096}}]}),
                "auto"
            )
            .unwrap(),
            ("mesh".into(), 4096)
        );
    }
}
