//! Adapted from Thomas Petersen's crates/community-compute/src/usage.rs at b4a910e7.
//! Allowlisted routing-observed session counters, not proof of local contribution.
use serde::Serialize;
use serde_json::Value;

/// Nullable, independently available counters from the app-owned SDK status.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub tokens_served: Option<u64>,
    pub inflight: Option<u64>,
    pub tokens_per_second: Option<f64>,
    pub peers: Option<usize>,
}
impl Usage {
    /// Missing counters remain unknown; raw endpoints and credentials never leave the owner.
    pub fn from_payload(payload: &Value) -> Self {
        Self {
            tokens_served: payload
                .pointer("/routing_metrics/completion_tokens_observed")
                .and_then(Value::as_u64),
            inflight: payload
                .pointer("/routing_metrics/local_node/current_inflight_requests")
                .or_else(|| payload.get("inflight_requests"))
                .and_then(Value::as_u64),
            tokens_per_second: payload
                .pointer("/routing_metrics/avg_tokens_per_second")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0),
            peers: payload.get("peers").and_then(Value::as_array).map(Vec::len),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn projects_local_counters_without_inventing_missing_usage() {
        let empty = serde_json::to_value(Usage::from_payload(&json!({}))).unwrap();
        assert_eq!(
            empty,
            json!({"tokensServed":null,"inflight":null,"tokensPerSecond":null,"peers":null})
        );
        let payload = json!({"routing_metrics":{"completion_tokens_observed":123,"avg_tokens_per_second":-1,"local_node":{"current_inflight_requests":2}},"peers":[{},{}],"private":"not projected"});
        let usage = Usage::from_payload(&payload);
        assert_eq!(usage.tokens_served, Some(123));
        assert_eq!(usage.inflight, Some(2));
        assert_eq!(usage.peers, Some(2));
        assert_eq!(usage.tokens_per_second, None);
        assert!(serde_json::to_value(usage)
            .unwrap()
            .get("private")
            .is_none());
        let partial = Usage::from_payload(&json!({"peers":[],"inflight_requests":0}));
        assert_eq!(partial.tokens_served, None);
        assert_eq!(partial.inflight, Some(0));
        assert_eq!(partial.peers, Some(0));
    }
}
