use super::*;
use std::fs;

#[test]
fn fresh_workspace_installs_discoverable_cli_guidance() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join(".buzz");
    ensure_buzz_cli_skill(&workspace).unwrap();
    let skill = workspace.join(".agents/skills/buzz-cli/SKILL.md");
    let text = fs::read_to_string(&skill).expect("fresh installs must provide the CLI skill");
    assert!(text.starts_with("---\nname: buzz-cli\n"));
    assert!(text.contains("buzz messages send"));
    assert!(text.contains("Never read or echo the value"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&skill).unwrap().permissions().mode() & 0o777,
            0o600
        );
        for provider in [".claude", ".codex", ".goose"] {
            let discovered = workspace.join(provider).join("skills/buzz-cli/SKILL.md");
            assert_eq!(
                fs::canonicalize(discovered).unwrap(),
                fs::canonicalize(&skill).unwrap()
            );
        }
    }
    ensure_buzz_cli_skill(&workspace).unwrap();
    assert_eq!(fs::read_to_string(skill).unwrap(), text);
}

#[test]
fn refresh_preserves_current_or_newer_edits_and_repairs_missing_content() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join(".buzz");
    ensure_buzz_cli_skill(&workspace).unwrap();
    let skill = workspace.join(".agents/skills/buzz-cli/SKILL.md");
    let version = skill.with_file_name(".skill-version");
    let installed = fs::read_to_string(&skill).unwrap();
    let current = fs::read_to_string(&version).unwrap();
    for marker in [current.as_str(), "999\n"] {
        fs::write(&skill, "user edits").unwrap();
        fs::write(&version, marker).unwrap();
        ensure_buzz_cli_skill(&workspace).unwrap();
        assert_eq!(fs::read_to_string(&skill).unwrap(), "user edits");
        assert_eq!(fs::read_to_string(&version).unwrap(), marker);
    }
    fs::write(&version, "1\n").unwrap();
    ensure_buzz_cli_skill(&workspace).unwrap();
    assert_eq!(fs::read_to_string(&skill).unwrap(), installed);
    fs::write(&version, "999\n").unwrap();
    fs::remove_file(&skill).unwrap();
    ensure_buzz_cli_skill(&workspace).unwrap();
    assert_eq!(fs::read_to_string(&skill).unwrap(), installed);
    assert_eq!(fs::read_to_string(&version).unwrap(), "999\n");
}

#[cfg(unix)]
#[test]
fn legacy_claude_layout_migrates_edits_and_supporting_files() {
    for partial in ["absent", "empty", "unversioned"] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join(".buzz");
        let legacy = workspace.join(".claude/skills/buzz-cli");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("SKILL.md"), "legacy user edits").unwrap();
        fs::write(legacy.join("reference.md"), "supporting file").unwrap();
        let canonical = workspace.join(".agents/skills/buzz-cli");
        if partial != "absent" {
            fs::create_dir_all(&canonical).unwrap();
            if partial == "unversioned" {
                fs::write(canonical.join("SKILL.md"), "unfinished generated template").unwrap();
                fs::write(canonical.join("other.md"), "canonical resource").unwrap();
            }
        }
        ensure_buzz_cli_skill(&workspace).unwrap();
        assert!(fs::symlink_metadata(&legacy)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(canonical.join("SKILL.md")).unwrap(),
            "legacy user edits"
        );
        assert_eq!(
            fs::read_to_string(legacy.join("reference.md")).unwrap(),
            "supporting file"
        );
        if partial == "unversioned" {
            assert_eq!(
                fs::read_to_string(canonical.join("other.md")).unwrap(),
                "canonical resource"
            );
        }
        ensure_buzz_cli_skill(&workspace).unwrap();
        assert_eq!(
            fs::read_to_string(legacy.join("SKILL.md")).unwrap(),
            "legacy user edits"
        );
    }
}

#[cfg(unix)]
#[test]
fn migration_refuses_conflicts_or_redirected_legacy_content_before_removing_files() {
    use std::os::unix::fs::symlink;
    for problem in ["resource-conflict", "SKILL.md", ".skill-version"] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join(".buzz");
        let canonical = workspace.join(".agents/skills/buzz-cli");
        let legacy = workspace.join(".claude/skills/buzz-cli");
        fs::create_dir_all(&canonical).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(canonical.join("SKILL.md"), "canonical content").unwrap();
        fs::write(legacy.join("SKILL.md"), "legacy edits").unwrap();
        if problem == "resource-conflict" {
            fs::write(canonical.join("reference.md"), "canonical reference").unwrap();
            fs::write(legacy.join("reference.md"), "legacy reference").unwrap();
        } else {
            let outside = dir.path().join("outside");
            fs::write(&outside, "untouched").unwrap();
            let link = legacy.join(problem);
            if link.exists() {
                fs::remove_file(&link).unwrap();
            }
            symlink(outside, link).unwrap();
        }
        assert!(ensure_buzz_cli_skill(&workspace).is_err());
        assert_eq!(
            fs::read_to_string(canonical.join("SKILL.md")).unwrap(),
            "canonical content"
        );
        if problem == "resource-conflict" {
            assert_eq!(
                fs::read_to_string(legacy.join("reference.md")).unwrap(),
                "legacy reference"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn provider_customizations_survive_and_dangling_links_are_repaired() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join(".buzz");
    let custom = workspace.join(".goose/skills/buzz-cli");
    fs::create_dir_all(&custom).unwrap();
    fs::write(custom.join("SKILL.md"), "custom Goose skill").unwrap();
    let codex = workspace.join(".codex/skills");
    fs::create_dir_all(&codex).unwrap();
    symlink("missing", codex.join("buzz-cli")).unwrap();
    ensure_buzz_cli_skill(&workspace).unwrap();
    assert_eq!(
        fs::read_to_string(custom.join("SKILL.md")).unwrap(),
        "custom Goose skill"
    );
    assert!(codex.join("buzz-cli/SKILL.md").is_file());
}

#[cfg(unix)]
#[test]
fn redirected_directories_and_skill_files_are_rejected_without_external_writes() {
    use std::os::unix::fs::symlink;
    for redirected in ["", ".agents", ".agents/skills", ".agents/skills/buzz-cli"] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join(".buzz");
        let outside = dir.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let link = if redirected.is_empty() {
            workspace.clone()
        } else {
            workspace.join(redirected)
        };
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&outside, &link).unwrap();
        assert!(ensure_buzz_cli_skill(&workspace).is_err(), "{redirected}");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    }
    for redirected in ["SKILL.md", ".skill-version"] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join(".buzz");
        ensure_buzz_cli_skill(&workspace).unwrap();
        let file = workspace.join(".agents/skills/buzz-cli").join(redirected);
        let outside = dir.path().join("outside");
        fs::write(&outside, "untouched").unwrap();
        fs::remove_file(&file).unwrap();
        symlink(&outside, &file).unwrap();
        assert!(ensure_buzz_cli_skill(&workspace).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "untouched");
    }
}

#[cfg(unix)]
#[test]
fn redirected_provider_skips_only_its_link_and_preserves_external_content() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    for provider in [".claude", ".codex", ".goose"] {
        for child in ["", "skills"] {
            let dir = tempfile::tempdir().unwrap();
            let workspace = dir.path().join(".buzz");
            let outside = dir.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("SKILL.md"), "external skill").unwrap();
            fs::set_permissions(&outside, fs::Permissions::from_mode(0o750)).unwrap();
            let parent = workspace.join(provider);
            let link = if child.is_empty() {
                parent
            } else {
                parent.join(child)
            };
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            symlink(&outside, &link).unwrap();
            for _ in 0..2 {
                ensure_buzz_cli_skill(&workspace).unwrap();
                let canonical = workspace.join(".agents/skills/buzz-cli/SKILL.md");
                let content = fs::read_to_string(&canonical).unwrap();
                assert!(content.starts_with("---\nname: buzz-cli\n"));
                for other in [".claude", ".codex", ".goose"] {
                    if other != provider {
                        let discovered = workspace.join(other).join("skills/buzz-cli/SKILL.md");
                        assert_eq!(
                            fs::canonicalize(discovered).unwrap(),
                            fs::canonicalize(&canonical).unwrap()
                        );
                    }
                }
                assert_eq!(
                    fs::read_to_string(outside.join("SKILL.md")).unwrap(),
                    "external skill"
                );
                assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
                assert_eq!(
                    fs::metadata(&outside).unwrap().permissions().mode() & 0o777,
                    0o750
                );
                assert_eq!(fs::read_link(&link).unwrap(), outside);
            }
        }
    }
}
