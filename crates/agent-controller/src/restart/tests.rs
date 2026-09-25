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
