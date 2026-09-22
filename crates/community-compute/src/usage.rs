//! Local session counters adapted from block/buzz mesh_llm/usage.rs.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub tokens_served: u64,
    pub inflight: u64,
    pub tokens_per_second: Option<f64>,
    pub peers: Option<usize>,
}
impl Usage {
    // Missing counters mean unavailable, not a fabricated zero-token session.
    pub fn from_payload(payload: &Value) -> Option<Self> {
        let metrics = payload.get("routing_metrics")?;
        Some(Self {
            tokens_served: metrics.get("completion_tokens_observed")?.as_u64()?,
            inflight: metrics
                .pointer("/local_node/current_inflight_requests")
                .or_else(|| payload.get("inflight_requests"))?
                .as_u64()?,
            tokens_per_second: metrics
                .get("avg_tokens_per_second")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.0),
            peers: payload.get("peers").and_then(Value::as_array).map(Vec::len),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn projects_local_counters_without_inventing_missing_usage() {
        assert!(Usage::from_payload(&json!({})).is_none());
        let payload = json!({"routing_metrics":{"completion_tokens_observed":123,"avg_tokens_per_second":-1,"local_node":{"current_inflight_requests":2}},"peers":[{},{}],"private":"not projected"});
        let usage = Usage::from_payload(&payload).unwrap();
        assert_eq!(usage.tokens_served, 123);
        assert_eq!(usage.inflight, 2);
        assert_eq!(usage.peers, Some(2));
        assert_eq!(usage.tokens_per_second, None);
        assert!(serde_json::to_value(usage)
            .unwrap()
            .get("private")
            .is_none());
    }
}
