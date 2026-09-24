#[path = "../build_config.rs"]
mod build_config;
use build_config::{load, parse, selector};

#[test]
fn local_multiline_defaults_are_allowlisted_and_process_wins_including_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    assert!(load(&path, |_| None).unwrap().is_empty());
    std::fs::write(&path, "BUZZ_BUILD_AGENT_ENV='DATABRICKS_HOST=https://workspace.example.com\nDATABRICKS_MODEL=custom-model\nDATABRICKS_MODEL_FILTER=team-*'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nUNRELATED_SECRET=NEVER_PRINT\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=\n").unwrap();
    let values = load(&path, |_| None).unwrap();
    assert_eq!(values.len(), 3);
    assert_eq!(
        parse(&values["BUZZ_BUILD_AGENT_ENV"]).unwrap(),
        (
            "https://workspace.example.com".into(),
            "team-*".into(),
            "custom-model".into()
        )
    );
    assert_eq!(values["BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY"], "");
    for override_value in ["", "DATABRICKS_HOST=https://ci.example.com"] {
        let values = load(&path, |key| {
            (key == "BUZZ_BUILD_AGENT_ENV").then(|| override_value.into())
        })
        .unwrap();
        assert_eq!(values["BUZZ_BUILD_AGENT_ENV"], override_value);
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
    }
    std::fs::remove_file(&path).unwrap();
    assert!(load(&path, |_| None).unwrap().is_empty());
}

#[test]
fn errors_never_echo_local_values_and_unknown_agent_keys_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    std::fs::write(&path, "BROKEN='NEVER_PRINT").unwrap();
    assert!(!load(&path, |_| None).unwrap_err().contains("NEVER_PRINT"));
    // A fully supplied CI environment does not depend on an unrelated local file.
    assert_eq!(load(&path, |_| Some(String::new())).unwrap().len(), 3);
    for raw in [
        "DATABRICKS_TOKEN=NEVER_PRINT",
        "OTHER=NEVER_PRINT",
        "BUZZ_PRIVATE_KEY=NEVER_PRINT",
        "DATABRICKS_HOST=x\nDATABRICKS_HOST=y",
        "malformed",
        "DATABRICKS_HOST=https://user:NEVER_PRINT@example.com",
        "DATABRICKS_HOST=https://example.com/path",
        "DATABRICKS_HOST=https://example.com?NEVER_PRINT",
        "DATABRICKS_MODEL=a\tNEVER_PRINT",
    ] {
        assert!(!parse(raw).unwrap_err().contains("NEVER_PRINT"));
    }
    assert!(selector("bad\nvalue", 128).is_err());
    assert!(selector(&"a".repeat(129), 128).is_err());
    assert_eq!(
        parse("").unwrap(),
        (String::new(), String::new(), String::new())
    );
}
