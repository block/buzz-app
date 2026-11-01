//! Purpose-bound, self-encrypted thread visits and personal pin choices.
use serde_json::Value;
use sha2::{Digest, Sha256};

const VISIT: &str = "buzz-thread-visit-v1";
const PIN: &str = "buzz-thread-pin-v1";
const MAX_SAFE: u64 = 9_007_199_254_740_991;

pub(super) fn tag(coordinate: &str) -> Option<&'static str> {
    [VISIT, PIN].into_iter().find(|prefix| {
        coordinate
            .strip_prefix(&format!("{prefix}:"))
            .is_some_and(|hash| {
                hash.len() == 64
                    && hash
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
    })
}

pub(super) fn validate(coordinate: &str, value: &Value) -> Result<(), String> {
    let invalid = || "Invalid thread navigation record".to_owned();
    let data = value.as_object().ok_or_else(invalid)?;
    let channel = data
        .get("channelId")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let root = data
        .get("rootId")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let title = data
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let prefix = match data.get("type").and_then(Value::as_str) {
        Some("visit") if data.len() == 6 => VISIT,
        Some("pin") if data.len() == 7 && data.get("pinned").is_some_and(Value::is_boolean) => PIN,
        _ => return Err(invalid()),
    };
    if data.get("version").and_then(Value::as_u64) != Some(1)
        || !data
            .get("at")
            .and_then(Value::as_u64)
            .is_some_and(|at| at > 0 && at <= MAX_SAFE)
        || channel.is_empty()
        || channel.len() > 256
        || !channel
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        || !channel
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || root.len() != 64
        || !root
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || title.trim().is_empty()
        || title.encode_utf16().count() > 160
        || coordinate
            != format!(
                "{prefix}:{:x}",
                Sha256::digest(format!("{channel}:{root}").as_bytes())
            )
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn binds_purpose_and_thread_and_rejects_unbounded_or_extra_fields() {
        let root = "a".repeat(64);
        let coordinate = format!(
            "{VISIT}:{:x}",
            Sha256::digest(format!("general:{root}").as_bytes())
        );
        let valid = json!({"version":1,"type":"visit","channelId":"general","rootId":root,"title":"Planning","at":123});
        assert_eq!(tag(&coordinate), Some(VISIT));
        assert!(validate(&coordinate, &valid).is_ok());
        for (field, value) in [
            ("channelId", json!("other")),
            ("rootId", json!("bad")),
            ("title", json!("x".repeat(161))),
            ("at", json!(0)),
            ("at", json!(MAX_SAFE + 1)),
            ("type", json!("pin")),
            ("extra", json!("arbitrary data")),
        ] {
            let mut invalid = valid.clone();
            invalid[field] = value;
            assert!(validate(&coordinate, &invalid).is_err(), "accepted {field}");
        }
        let pin_coordinate = coordinate.replacen(VISIT, PIN, 1);
        let mut pin = valid;
        pin["type"] = json!("pin");
        pin["pinned"] = json!(false);
        assert!(validate(&pin_coordinate, &pin).is_ok());
        assert!(validate(&coordinate, &pin).is_err());
        pin["pinned"] = json!("false");
        assert!(validate(&pin_coordinate, &pin).is_err());
    }
}
