#[path = "../build_config.rs"]
mod build_config;
use build_config::{load, parse, selector, session_policy};

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
    std::fs::write(&path, "BUZZ_BUILD_AGENT_ENV='NEVER_PRINT").unwrap();
    assert!(!load(&path, |_| None).unwrap_err().contains("NEVER_PRINT"));
    // A fully supplied CI environment does not depend on an unrelated local file.
    assert_eq!(load(&path, |_| Some(String::new())).unwrap().len(), 4);
    for value in ["", "channel", "thread"] {
        assert!(session_policy(value).is_ok());
    }
    for value in ["THREAD", "other", "thread\nBUZZ_PRIVATE_KEY=NEVER_PRINT"] {
        assert!(!session_policy(value).unwrap_err().contains("NEVER_PRINT"));
    }
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

#[test]
fn unrelated_dev_syntax_is_ignored_without_promoting_multiline_contents() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    std::fs::write(&path, "# ignored='quote in comment\nFOO=bar baz\nBROKEN=\nnot an assignment\nOTHER='multiline\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=true\n'\nexport BUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=first\nDATABRICKS_MODEL_FILTER=team-*'\nTRAILING='unfinished\n").unwrap();
    let values = load(&path, |_| None).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
    assert_eq!(parse(&values["BUZZ_BUILD_AGENT_ENV"]).unwrap().1, "team-*");
    for invalid in [
        "BUZZ_BUILD_BUZZ_AGENT_PROVIDER=bad value",
        "BUZZ_BUILD_AGENT_ENV='unfinished",
        "BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY malformed",
    ] {
        std::fs::write(&path, invalid).unwrap();
        assert!(load(&path, |_| None).is_err(), "{invalid}");
    }
    // Explicit process values make even malformed same-key file values irrelevant.
    assert_eq!(
        load(&path, |key| (key == "BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY")
            .then(String::new))
        .unwrap()["BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY"],
        ""
    );
}

#[test]
fn lexical_selection_handles_bom_crlf_exports_comments_and_escaped_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    std::fs::write(&path, "\u{feff}# ignored=\"unclosed comment\r\nOTHER=\"a \\\"quote\r\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=true\r\n\"\r\nexport\tBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks-v2\r\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=first\r\nDATABRICKS_MODEL_FILTER=team-*'\r\n").unwrap();
    let values = load(&path, |_| None).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks-v2");
    assert_eq!(parse(&values["BUZZ_BUILD_AGENT_ENV"]).unwrap().2, "first");
}

#[test]
fn unclosed_unrelated_quotes_never_promote_embedded_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    for quote in ["'", "\"", "`"] {
        std::fs::write(
            &path,
            format!("OTHER={quote}unterminated\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=true\n"),
        )
        .unwrap();
        if quote == "`" {
            assert_eq!(
                load(&path, |_| None).unwrap_err(),
                "Invalid native build .env.local"
            );
        } else {
            assert!(load(&path, |_| None).unwrap().is_empty());
        }
    }
}

#[test]
fn whole_dotenv_records_never_promote_embedded_build_keys() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    for value in [
        "\"literal ` inside quote\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "`foo\"second`\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "\"first\"\"second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "prefix\"second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "foo\\ #\"more\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "'first'\"second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
        "prefix'second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n'",
        "\"first \"#\"second\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n\"",
    ] {
        let record = format!("OTHER={value}\n");
        // Pin the lexical contract to the actual decoder, not our scanner.
        let decoded: Vec<_> = dotenvy::from_read_iter(record.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].0, "OTHER");
        std::fs::write(
            &path,
            format!("{record}INVALID=bar baz\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\n"),
        )
        .unwrap();
        let values = load(&path, |_| None).unwrap();
        assert_eq!(values.len(), 1, "{record}");
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
        let values = load(&path, |key| {
            (key == "BUZZ_BUILD_BUZZ_AGENT_PROVIDER").then(String::new)
        })
        .unwrap();
        assert_eq!(values.len(), 1, "{record}");
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "");
    }
}

#[test]
fn selected_adjacent_segments_and_unrelated_comments_keep_record_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    std::fs::write(&path, "OTHER=value # ignored \"quote\nBUZZ_BUILD_AGENT_ENV=DATABRICKS_MODEL='build-model'\"\nDATABRICKS_MODEL_FILTER=team-*\"\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=data\"bricks\"_v2\n").unwrap();
    let values = load(&path, |_| None).unwrap();
    assert_eq!(values.len(), 2);
    assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
    assert_eq!(
        parse(&values["BUZZ_BUILD_AGENT_ENV"]).unwrap(),
        (String::new(), "team-*".into(), "build-model".into())
    );
}

#[test]
fn literal_backticks_do_not_hide_following_build_settings() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    for record in [
        "OTHER=prefix`literal",
        "OTHER=prefix`one`two`three",
        "export OTHER = prefix`literal",
        "OTHER=\"quoted ` literal\"",
        "OTHER='quoted ` literal'",
        "OTHER=\"prefix\"`literal",
    ] {
        let text = format!("{record}\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n");
        let decoded: Vec<_> = dotenvy::from_read_iter(text.as_bytes())
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(decoded.len(), 3, "{record}");
        std::fs::write(&path, text).unwrap();
        let values = load(&path, |_| None).unwrap();
        assert_eq!(values.len(), 2, "{record}");
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
        assert_eq!(values["BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY"], "1");
    }
}

#[test]
fn backtick_delimited_values_contain_multiline_text_and_reject_unclosed_framing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    for prefix in ["OTHER=", "  export OTHER = \t"] {
        std::fs::write(&path, format!("{prefix}`multiline\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n`\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\n")).unwrap();
        let values = load(&path, |_| None).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
        std::fs::write(
            &path,
            format!("{prefix}`NEVER_PRINT\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n"),
        )
        .unwrap();
        assert_eq!(
            load(&path, |_| None).unwrap_err(),
            "Invalid native build .env.local"
        );
        assert_eq!(load(&path, |_| Some(String::new())).unwrap().len(), 4);
    }
}

#[test]
fn backtick_comments_do_not_reject_a_closed_value_at_end_of_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    for record in [
        "OTHER=`note # literal`",
        "  export OTHER = `first\nnext # literal`",
        "OTHER=value # `not an opening delimiter",
    ] {
        std::fs::write(&path, format!("{record}\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=following-model'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\n")).unwrap();
        let values = load(&path, |_| None).unwrap();
        assert_eq!(values.len(), 3, "{record}");
        assert_eq!(
            values["BUZZ_BUILD_AGENT_ENV"],
            "DATABRICKS_MODEL=following-model"
        );
        assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
        assert_eq!(values["BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY"], "1");
    }
}

#[test]
fn backtick_comments_do_not_absorb_defaults_before_a_later_literal_backtick() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.local");
    std::fs::write(&path, "OTHER=`note # literal`\nBUZZ_BUILD_AGENT_ENV='DATABRICKS_MODEL=following-model'\nBUZZ_BUILD_BUZZ_AGENT_PROVIDER=databricks_v2\nBUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY=1\nAFTER=prefix`literal\n").unwrap();
    let values = load(&path, |_| None).unwrap();
    assert_eq!(values.len(), 3);
    assert_eq!(
        values["BUZZ_BUILD_AGENT_ENV"],
        "DATABRICKS_MODEL=following-model"
    );
    assert_eq!(values["BUZZ_BUILD_BUZZ_AGENT_PROVIDER"], "databricks_v2");
    assert_eq!(values["BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY"], "1");
}
