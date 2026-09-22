use buzzodz_plugins::{bundled_manifests, Manager};
use std::{fs, path::PathBuf};
fn fixture() -> (tempfile::TempDir, Manager, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    let source = temp.path().join("build");
    fs::create_dir(&source).unwrap();
    fs::write(
        source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
    (temp, manager, source)
}
#[test]
fn install_enable_update_rollback_and_remove_survive_restart() {
    let (temp, manager, source) = fixture();
    let catalog = manager.install(&source).unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    let first = catalog
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    assert!(manager.module("example.page", &first).is_err());
    manager.change("enable", "example.page").unwrap();
    fs::write(source.join("plugin.js"), "export const second = true;").unwrap();
    let next = manager.install(&source).unwrap();
    assert!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert_eq!(
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .previous
            .as_deref(),
        Some(first.as_str())
    );
    assert!(manager.module("example.page", &first).is_err());
    let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
    assert_eq!(
        reopened
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision,
        next.plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .revision
    );
    reopened.change("rollback", "example.page").unwrap();
    assert!(reopened
        .module("example.page", &first)
        .unwrap()
        .contains("apply"));
    reopened.change("remove", "example.page").unwrap();
    assert_eq!(
        reopened.catalog().unwrap().plugins.len(),
        bundled_manifests().len()
    );
}
#[test]
fn source_metadata_from_newer_writer_survives_management_changes() {
    let (temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    let registry_path = temp.path().join("profiles/test/registry.json");
    let mut registry: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    let installed = &mut registry["installed"]["example.page"];
    installed.as_object_mut().unwrap().remove("currentSource");
    installed.as_object_mut().unwrap().remove("previousSource");
    fs::write(
        &registry_path,
        serde_json::to_vec_pretty(&registry).unwrap(),
    )
    .unwrap();
    assert!(manager.catalog().is_ok());

    let installed = &mut registry["installed"]["example.page"];
    installed["currentSource"] = serde_json::Value::Null;
    installed["previousSource"] = serde_json::Value::Null;
    fs::write(
        &registry_path,
        serde_json::to_vec_pretty(&registry).unwrap(),
    )
    .unwrap();

    manager.change("enable", "example.page").unwrap();

    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    let installed = &saved["installed"]["example.page"];
    assert_eq!(installed["currentSource"], serde_json::Value::Null);
    assert_eq!(installed["previousSource"], serde_json::Value::Null);

    let mut invalid = saved;
    invalid["installed"]["example.page"]["currentSource"] = serde_json::json!({
        "root": source,
        "path": ".",
        "unexpected": true
    });
    fs::write(&registry_path, serde_json::to_vec_pretty(&invalid).unwrap()).unwrap();
    assert!(manager.catalog().is_err());
}
#[test]
fn source_metadata_follows_its_revision_across_install_and_rollback() {
    let (temp, manager, first_source) = fixture();
    let first = manager
        .install(&first_source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap()
        .revision;
    let first_source = first_source.canonicalize().unwrap();
    let second_source = temp.path().join("second-build");
    fs::create_dir(&second_source).unwrap();
    fs::write(
        second_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        second_source.join("plugin.js"),
        "export const second = true;",
    )
    .unwrap();
    let second = manager
        .install(&second_source)
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == "example.page")
        .unwrap()
        .revision;
    let second_source = second_source.canonicalize().unwrap();
    manager.change("enable", "example.page").unwrap();
    manager.change("disable", "example.page").unwrap();
    let registry_path = temp.path().join("profiles/test/registry.json");
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    let installed = &registry["installed"]["example.page"];
    assert_eq!(installed["current"], second);
    assert_eq!(
        installed["currentSource"]["root"],
        serde_json::to_value(&second_source).unwrap()
    );
    assert_eq!(installed["currentSource"]["path"], ".");
    assert_eq!(installed["previous"], first);
    assert_eq!(
        installed["previousSource"]["root"],
        serde_json::to_value(&first_source).unwrap()
    );

    manager.change("rollback", "example.page").unwrap();
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
    let installed = &registry["installed"]["example.page"];
    assert_eq!(installed["current"], first);
    assert_eq!(
        installed["currentSource"]["root"],
        serde_json::to_value(&first_source).unwrap()
    );
    assert_eq!(installed["previous"], second);
    assert_eq!(
        installed["previousSource"]["root"],
        serde_json::to_value(&second_source).unwrap()
    );

    let replacement_source = temp.path().join("replacement-build");
    fs::create_dir(&replacement_source).unwrap();
    fs::write(
        replacement_source.join("manifest.json"),
        r#"{"id":"example.page","name":"Example","apiVersion":1}"#,
    )
    .unwrap();
    fs::write(
        replacement_source.join("plugin.js"),
        "export function apply() {}",
    )
    .unwrap();
    manager.install(&replacement_source).unwrap();
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(registry_path).unwrap()).unwrap();
    let installed = &registry["installed"]["example.page"];
    assert_eq!(installed["current"], first);
    assert_eq!(
        installed["currentSource"]["root"],
        serde_json::to_value(replacement_source.canonicalize().unwrap()).unwrap()
    );
    assert_eq!(installed["previous"], second);
    assert_eq!(
        installed["previousSource"]["root"],
        serde_json::to_value(second_source).unwrap()
    );
}
#[test]
fn invalid_install_preserves_working_revision() {
    let (_temp, manager, source) = fixture();
    let before = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    for metadata in [
        r#"{"id":"../escape","name":"Invalid","apiVersion":1}"#,
        r#"{"id":"example.page","name":"Invalid","apiVersion":2}"#,
        "{broken}",
    ] {
        fs::write(source.join("manifest.json"), metadata).unwrap();
        assert!(manager.install(&source).is_err());
        assert_eq!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == "example.page")
                .unwrap()
                .revision,
            before
        );
    }
}
#[test]
fn corrupt_artifact_does_not_block_disable_or_remove() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    fs::write(
        temp.path().join(format!(
            "profiles/test/artifacts/example.page/{revision}.json"
        )),
        "broken",
    )
    .unwrap();
    assert!(manager.module("example.page", &revision).is_err());
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
}
#[test]
fn corrupt_settings_require_recovery_and_are_backed_up() {
    let (temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    let root = temp.path().join("profiles/test");
    fs::write(root.join("registry.json"), "{broken}").unwrap();
    assert!(manager.catalog().is_err());
    assert!(manager.change("disable", "buzz.channels").is_err());
    manager.recover().unwrap();
    assert!(manager.catalog().is_ok());
    let backup = fs::read_dir(root)
        .unwrap()
        .filter_map(|p| p.ok())
        .find(|p| {
            p.file_name()
                .to_string_lossy()
                .starts_with("registry-backup-")
        })
        .unwrap();
    assert_eq!(fs::read_to_string(backup.path()).unwrap(), "{broken}");
}
#[test]
fn safe_mode_and_profiles_are_independent() {
    let (temp, manager, source) = fixture();
    let revision = manager
        .install(&source)
        .unwrap()
        .plugins
        .iter()
        .find(|p| p.manifest.id == "example.page")
        .unwrap()
        .revision
        .clone();
    manager.change("enable", "example.page").unwrap();
    let safe = Manager::open(Some(temp.path().into()), "test", true).unwrap();
    assert!(safe.module("example.page", &revision).is_err());
    assert!(safe.external_plugins_paused());
    assert!(!manager.external_plugins_paused());
    assert!(
        safe.catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
    assert!(manager.module("example.page", &revision).is_ok());
    safe.change("disable", "example.page").unwrap();
    assert_eq!(
        Manager::open(Some(temp.path().into()), "other", false)
            .unwrap()
            .catalog()
            .unwrap()
            .plugins
            .len(),
        bundled_manifests().len()
    );
}
#[test]
fn concurrent_changes_do_not_lose_installs() {
    let (_temp, manager, source) = fixture();
    manager.install(&source).unwrap();
    std::thread::scope(|scope| {
        for _ in 0..8 {
            scope.spawn(|| {
                for _ in 0..5 {
                    manager.change("disable", "buzz.channels").unwrap();
                    manager.change("enable", "example.page").unwrap();
                }
            });
        }
    });
    let catalog = manager.catalog().unwrap();
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.page")
            .unwrap()
            .enabled
    );
}
#[test]
fn management_never_executes_code_and_protects_bundled_identity() {
    let (_temp, manager, source) = fixture();
    fs::write(
        source.join("plugin.js"),
        "throw new Error('broken'); while(true) {}",
    )
    .unwrap();
    manager.install(&source).unwrap();
    manager.change("enable", "example.page").unwrap();
    manager.change("disable", "example.page").unwrap();
    manager.change("remove", "example.page").unwrap();
    fs::write(
        source.join("manifest.json"),
        serde_json::to_vec(&bundled_manifests()[0]).unwrap(),
    )
    .unwrap();
    assert!(manager.install(&source).is_err());
    assert!(manager
        .change("remove", &bundled_manifests()[0].id)
        .is_err());
}

#[test]
fn bundled_plugins_have_independent_flags_and_all_ids_are_reserved() {
    let (root, manager, source) = fixture();
    manager.change("disable", "buzz.github").unwrap();
    let catalog = manager.catalog().unwrap();
    assert!(
        catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.channels")
            .unwrap()
            .enabled
    );
    assert!(
        !catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "buzz.github")
            .unwrap()
            .enabled
    );
    for id in [
        "buzz.terminal",
        "buzz.bestie",
        "buzz.projects",
        "buzz.agents",
        "buzz.emoji",
        "buzz.mentions",
        "buzz.links",
    ] {
        assert!(
            manager
                .catalog()
                .unwrap()
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        manager.change("disable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.channels")
                .unwrap()
                .enabled
        );
        manager.change("enable", id).unwrap();
        let reloaded = manager.catalog().unwrap();
        assert!(
            reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap()
                .enabled
        );
        assert!(
            !reloaded
                .plugins
                .iter()
                .find(|p| p.manifest.id == "buzz.github")
                .unwrap()
                .enabled
        );
        assert!(manager.change("remove", id).is_err());
    }
    assert!(manager.change("remove", "buzz.channels").is_err());
    for manifest in buzzodz_plugins::bundled_manifests() {
        fs::write(
            source.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(manager.install(&source).is_err());
    }
    drop(root);
}
