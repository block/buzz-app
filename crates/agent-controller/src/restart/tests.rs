use super::*;
use crate::store::tests::fixture;

#[test]
fn diff_is_empty_until_a_saved_start_setting_changes() {
    let agent = fixture();
    let spawned = spawn_config(&agent);
    assert!(diff(&spawned, &spawn_config(&agent)).is_empty());
    let mut saved = agent.clone();
    saved.revision += 1;
    saved.start_on_app_launch = Some(true);
    assert!(diff(&spawned, &spawn_config(&saved)).is_empty());
}

#[test]
fn diff_itemizes_changes_and_redacts_arguments_prompt_and_environment() {
    let mut before = fixture();
    before.harness.args = vec!["--token=old-secret".into()];
    before.environment.insert("KEEP".into(), "old-value".into());
    before
        .environment
        .insert("GONE".into(), "gone-value".into());
    let mut after = before.clone();
    after.harness.model = "new-model".into();
    after.harness.args = vec!["--token=new-secret".into()];
    after.system_prompt = "four".into();
    after.environment.insert("KEEP".into(), "new-value".into());
    after.environment.remove("GONE");
    after.environment.insert("NEW".into(), "new-secret".into());
    let entries = diff(&spawn_config(&before), &spawn_config(&after));
    let wire = serde_json::to_string(&entries).unwrap();
    for secret in [
        "old-secret",
        "new-secret",
        "old-value",
        "new-value",
        "gone-value",
    ] {
        assert!(!wire.contains(secret), "{secret} leaked: {wire}");
    }
    let fields: Vec<_> = entries.iter().map(|e| e.field.as_str()).collect();
    assert_eq!(
        fields,
        [
            "args",
            "env.GONE",
            "env.KEEP",
            "env.NEW",
            "model",
            "system_prompt"
        ]
    );
    assert_eq!(entries[1].change, RestartChange::Removed);
    assert_eq!(
        entries[2].change,
        RestartChange::Masked {
            before: Some(MASK.into()),
            after: Some(MASK.into())
        }
    );
    assert_eq!(entries[3].change, RestartChange::Added);
    assert_eq!(
        entries[4].change,
        RestartChange::Value {
            before: before.harness.model.clone().into(),
            after: "new-model".into()
        }
    );
    assert_eq!(
        entries[5].change,
        RestartChange::Text {
            before_chars: Some(before.system_prompt.chars().count()),
            after_chars: Some(4)
        }
    );
    assert!(wire.contains(r#""kind":"text","beforeChars""#), "{wire}");
}

#[test]
fn explicit_codex_effort_change_requires_a_running_agent_restart() {
    let mut running = fixture();
    running.harness.command = "codex-acp".into();
    running.harness.provider.clear();
    running.harness.model = "model-a".into();
    running.harness.configuration = Some(crate::AiConfiguration::Advanced {
        effort: crate::EffortSelection::Value {
            value: "low".into(),
        },
    });
    let spawned = spawn_config(&running);

    // This is the before/after comparison used by Save's restart selection.
    // Changing only the saved effort must remain observable as a restart.
    let mut saved = running;
    saved.harness.configuration = Some(crate::AiConfiguration::Advanced {
        effort: crate::EffortSelection::Value {
            value: "high".into(),
        },
    });
    let entries = diff(&spawned, &spawn_config(&saved));

    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.field.as_str())
            .collect::<Vec<_>>(),
        ["effort"]
    );
    assert_eq!(
        entries[0].change,
        RestartChange::Value {
            before: "low".into(),
            after: "high".into(),
        }
    );
}

#[test]
fn explicit_codex_configuration_uses_its_model_and_does_not_inherit_effort() {
    let mut agent = fixture();
    agent.harness.command = "codex-acp".into();
    agent.harness.provider.clear();
    agent.harness.model = "explicit-model".into();
    agent.imported["record"] = serde_json::json!({"effort_level": "legacy-effort"});
    agent.harness.configuration = Some(crate::AiConfiguration::Advanced {
        effort: crate::EffortSelection::Default,
    });

    let advanced = spawn_config(&agent);
    assert_eq!(advanced["model"], "explicit-model");
    assert!(advanced["effort"].is_null());

    agent.harness.configuration = Some(crate::AiConfiguration::Default);
    let defaults = spawn_config(&agent);
    assert!(defaults["model"].is_null());
    assert!(defaults["effort"].is_null());
}
