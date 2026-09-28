use super::*;
use crate::store::tests::fixture;

fn defaults(harness: &str) -> AgentDefaults {
    AgentDefaults {
        harness: harness.into(),
        provider: "global-provider".into(),
        model: "global-model".into(),
        effort: "high".into(),
        environment: BTreeMap::from([
            ("SHARED".into(), "global".into()),
            ("GLOBAL_ONLY".into(), "global".into()),
        ]),
    }
}
fn edit(harness: &str, model: &str, effort: &str) -> AgentDefaultsEdit {
    AgentDefaultsEdit {
        harness: harness.into(),
        provider: "p".into(),
        model: model.into(),
        effort: effort.into(),
        environment: BTreeMap::new(),
    }
}

#[test]
fn blank_fields_inherit_for_the_same_harness_and_agent_values_win() {
    let mut agent = fixture();
    agent.harness.command = "buzz-agent".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported = Value::Null;
    agent.environment = BTreeMap::from([("SHARED".into(), "agent".into())]);
    let saved = serde_json::to_value(&agent).unwrap();
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.provider, "global-provider");
    assert_eq!(out.harness.model, "global-model");
    assert_eq!(effort(&out), Some("high"));
    // Per-key merge: the agent's key wins; other default keys are added.
    assert_eq!(out.environment["SHARED"], "agent");
    assert_eq!(out.environment["GLOBAL_ONLY"], "global");
    // A launch copy only; the saved agent is untouched.
    assert_eq!(serde_json::to_value(&agent).unwrap(), saved);

    agent.harness.model = "agent-model".into();
    agent.imported = serde_json::json!({"record":{"effort_level":"low"}});
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.model, "agent-model");
    assert_eq!(effort(&out), Some("low"));
}

#[test]
fn selectors_do_not_cross_harnesses_but_environment_does() {
    let mut agent = fixture();
    agent.harness.command = "/opt/tools/goose".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported = Value::Null;
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.provider, "");
    assert_eq!(out.harness.model, "");
    assert_eq!(effort(&out), None);
    assert_eq!(out.environment["GLOBAL_ONLY"], "global");
    let out = effective(&agent, &defaults("goose"));
    assert_eq!(out.harness.model, "global-model");
    agent.harness.command = "/opt/tools/buzz-pi-acp".into();
    assert_eq!(
        effective(&agent, &defaults("pi")).harness.provider,
        "global-provider"
    );
}

#[test]
fn changing_the_harness_clears_carried_model_and_effort() {
    let mut saved = defaults("buzz-agent");
    saved.apply(edit("goose", "global-model", "high")).unwrap();
    assert_eq!((saved.model.as_str(), saved.effort.as_str()), ("", ""));
    // Values chosen together with the new harness are kept.
    saved.apply(edit("pi", "pi-model", "medium")).unwrap();
    assert_eq!(
        (saved.model.as_str(), saved.effort.as_str()),
        ("pi-model", "medium")
    );
    // Same harness: nothing is cleared.
    saved.apply(edit("pi", "pi-model", "medium")).unwrap();
    assert_eq!(saved.model, "pi-model");
    assert!(saved.clone().apply(edit("claude", "", "")).is_err());
}

#[test]
fn environment_patch_is_write_only_and_validated() {
    let mut saved = defaults("buzz-agent");
    let mut patch = edit("buzz-agent", "", "");
    patch.environment = BTreeMap::from([
        ("SHARED".into(), None),
        ("API_TOKEN".into(), Some("secret-value".into())),
    ]);
    saved.apply(patch).unwrap();
    assert!(!saved.environment.contains_key("SHARED"));
    assert_eq!(saved.environment["GLOBAL_ONLY"], "global");
    let view = serde_json::to_string(&saved.view()).unwrap();
    assert!(!view.contains("secret-value") && !view.contains("\"global\""));
    assert_eq!(saved.view().environment_keys, ["API_TOKEN", "GLOBAL_ONLY"]);
    let mut reserved = edit("buzz-agent", "", "");
    reserved.environment = BTreeMap::from([("BUZZ_PRIVATE_KEY".into(), Some("x".into()))]);
    assert!(saved.apply(reserved).is_err());
}
