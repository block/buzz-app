use serde::Serialize;
use std::collections::BTreeMap;
#[derive(Serialize)]
pub(super) struct MeshModelOption {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}
pub fn models_from_status_payload(payload: Option<&serde_json::Value>) -> Vec<MeshModelOption> {
    let mut out = Vec::new();
    if let Some(payload) = payload {
        // The SDK's raw status uses `hosted_models` plus ready entries under
        // `runtime.models`. Buzz-authored status reports use `models`. Do not
        // use `serving_models`: MeshLLM fills it with the requested model while
        // the runtime is still in standby, before inference is available.
        for key in ["models", "hosted_models"] {
            if let Some(value) = payload.get(key) {
                collect_model_options(value, &mut out);
            }
        }
        if let Some(runtime_models) = payload
            .get("runtime")
            .and_then(|runtime| runtime.get("models"))
            .and_then(serde_json::Value::as_array)
        {
            for model in runtime_models {
                if model.get("status").and_then(serde_json::Value::as_str) == Some("ready") {
                    collect_model_options(model, &mut out);
                }
            }
        }
    }
    dedupe_models(out)
}

fn collect_model_options(value: &serde_json::Value, out: &mut Vec<MeshModelOption>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(id) = map
                .get("model_id")
                .or_else(|| map.get("modelId"))
                .or_else(|| map.get("model_ref"))
                .or_else(|| map.get("modelRef"))
                .or_else(|| map.get("id"))
                .or_else(|| map.get("name"))
                .and_then(serde_json::Value::as_str)
            {
                let name = map
                    .get("display_name")
                    .or_else(|| map.get("displayName"))
                    .and_then(serde_json::Value::as_str)
                    .map(ToString::to_string);
                push_model(out, id, name);
            } else {
                for child in map.values().filter(|child| {
                    matches!(
                        child,
                        serde_json::Value::Array(_) | serde_json::Value::Object(_)
                    )
                }) {
                    collect_model_options(child, out);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for child in values {
                collect_model_options(child, out);
            }
        }
        serde_json::Value::String(value) => {
            push_model(out, value, None);
        }
        _ => {}
    }
}

fn push_model(out: &mut Vec<MeshModelOption>, id: &str, name: Option<String>) {
    let id = id.trim();
    if id.is_empty() || id.starts_with("http://") || id.starts_with("https://") {
        return;
    }
    out.push(MeshModelOption {
        id: id.to_string(),
        name,
    });
}

/// Canonical model id for equality/dedup. A serving node advertises the same
/// model under two strings — `org/model@main:Q4` (serveTargets[].modelId) and
/// `org/model:Q4` (available_models) — so keying on the raw string leaves BOTH
/// in the picker. Strip the `@main` ref-qualifier (matching the selection-time
/// rule in `pick_serve_target_for_model`) so the two collapse to one entry.
pub(super) fn canonical_model_id(value: &str) -> String {
    value.trim().replace("@main", "")
}

pub(super) fn dedupe_models(models: Vec<MeshModelOption>) -> Vec<MeshModelOption> {
    // Key by canonical id so `@main` / non-`@main` forms of the same model
    // dedup together. Display the canonical (stripped) id so the UI shows one
    // stable label; selection still matches because the picker canonicalizes
    // both sides too.
    let mut by_id = BTreeMap::<String, Option<String>>::new();
    for model in models {
        by_id
            .entry(canonical_model_id(&model.id))
            .and_modify(|name| {
                if name.is_none() {
                    *name = model.name.clone();
                }
            })
            .or_insert(model.name);
    }
    by_id
        .into_iter()
        .map(|(id, name)| MeshModelOption { id, name })
        .collect()
}
