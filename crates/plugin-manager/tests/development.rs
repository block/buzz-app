use buzzodz_plugins::{bundled_manifests, Manager};
use std::{collections::BTreeMap, fs, path::Path};

const FINGERPRINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn write_build(path: &Path, id: &str, code: &str) {
    fs::create_dir_all(path).unwrap();
    let manifest = bundled_manifests()
        .into_iter()
        .find(|manifest| manifest.id == id)
        .unwrap();
    fs::write(
        path.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(path.join("plugin.js"), code).unwrap();
    fs::write(
        path.join("plugin.dev.json"),
        serde_json::json!({"version":1,"id":id,"hostBuildId":FINGERPRINT}).to_string(),
    )
    .unwrap();
}
fn initialize(manager: &Manager, ids: &[&str]) {
    manager
        .initialize_development(
            ids.iter()
                .map(|id| (id.to_string(), FINGERPRINT.into()))
                .collect(),
        )
        .unwrap();
}
fn revision(manager: &Manager, id: &str) -> String {
    manager
        .catalog()
        .unwrap()
        .plugins
        .into_iter()
        .find(|plugin| plugin.manifest.id == id)
        .unwrap()
        .revision
}

#[test]
fn ordinary_import_stays_reserved_in_every_native_build() {
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    let source = home.path().join("build");
    write_build(&source, "buzz.inbox", "export function apply() {}");
    assert!(manager.install(&source).is_err());
    assert_eq!(revision(&manager, "buzz.inbox"), "bundled");
    if !cfg!(debug_assertions) {
        assert!(manager
            .initialize_development(BTreeMap::from([("buzz.inbox".into(), FINGERPRINT.into())]))
            .is_err());
        assert!(manager.prepare_development("buzz.inbox", &source).is_err());
        assert!(manager.use_compiled("buzz.inbox").is_err());
    }
}

#[test]
fn selection_is_shared_by_clones_not_restart_or_registry_and_keeps_original_identity() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    initialize(&manager, &["buzz.inbox"]);
    let source = home.path().join("build");
    write_build(&source, "buzz.inbox", "export const first = true;");
    let prepared = manager.prepare_development("buzz.inbox", &source).unwrap();
    fs::write(
        source.join("plugin.js"),
        "throw Error('changed after preview');",
    )
    .unwrap();
    assert!(manager.attach_development(&prepared, "wrong").is_err());
    let catalog = manager
        .attach_development(&prepared, &prepared.preview.token)
        .unwrap();
    assert_eq!(catalog.plugins.len(), bundled_manifests().len());
    let plugin = catalog
        .plugins
        .iter()
        .find(|plugin| plugin.manifest.id == "buzz.inbox")
        .unwrap();
    assert_eq!(plugin.source, "development");
    assert!(plugin.enabled && plugin.reloadable && plugin.development_supported);
    assert_eq!(plugin.revision.len(), 64);
    assert!(manager
        .clone()
        .module("buzz.inbox", &plugin.revision)
        .unwrap()
        .contains("first"));
    assert!(manager.host_grants("buzz.inbox", "bundled").is_err());
    assert!(manager.host_grants("buzz.inbox", &plugin.revision).is_ok());
    assert!(!home.path().join("profiles/test/registry.json").exists());
    let reopened = Manager::open(Some(home.path().into()), "test", false).unwrap();
    assert_eq!(revision(&reopened, "buzz.inbox"), "bundled");
    assert!(reopened.module("buzz.inbox", &plugin.revision).is_err());
    manager.use_compiled("buzz.inbox").unwrap();
    assert_eq!(revision(&manager, "buzz.inbox"), "bundled");
    assert!(manager.module("buzz.inbox", &plugin.revision).is_err());
    assert!(manager.host_grants("buzz.inbox", "bundled").is_ok());
}

#[test]
fn reload_is_immutable_and_rejects_compatibility_identity_and_grant_changes() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    initialize(&manager, &["buzz.inbox"]);
    let source = home.path().join("build");
    write_build(&source, "buzz.inbox", "export const first = true;");
    let first = manager.prepare_development("buzz.inbox", &source).unwrap();
    manager
        .attach_development(&first, &first.preview.token)
        .unwrap();
    write_build(&source, "buzz.inbox", "export const second = true;");
    manager.reload("buzz.inbox").unwrap();
    let second = revision(&manager, "buzz.inbox");
    assert_ne!(second, first.preview.revision);
    assert!(manager
        .module("buzz.inbox", &first.preview.revision)
        .is_err());
    assert!(manager
        .module("buzz.inbox", &second)
        .unwrap()
        .contains("second"));
    // A bad candidate never changes the healthy selection.
    fs::write(source.join("plugin.dev.json"), serde_json::json!({"version":1,"id":"buzz.inbox","hostBuildId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}).to_string()).unwrap();
    assert!(manager.reload("buzz.inbox").is_err());
    write_build(&source, "buzz.links", "export const wrong = true;");
    assert!(manager.reload("buzz.inbox").is_err());
    write_build(&source, "buzz.inbox", "export const third = true;");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(source.join("manifest.json")).unwrap()).unwrap();
    manifest["host"] = serde_json::json!({"networkOrigins":["https://example.com"]});
    fs::write(source.join("manifest.json"), manifest.to_string()).unwrap();
    assert!(manager
        .reload("buzz.inbox")
        .err()
        .unwrap()
        .contains("Host access changed"));
    assert_eq!(revision(&manager, "buzz.inbox"), second);
    // Explicit re-preview is the only way to accept changed access.
    let third = manager.prepare_development("buzz.inbox", &source).unwrap();
    manager
        .attach_development(&third, &third.preview.token)
        .unwrap();
    assert_eq!(
        manager
            .host_grants("buzz.inbox", &third.preview.revision)
            .unwrap()
            .network_origins,
        ["https://example.com"]
    );
}

#[test]
fn disabled_defaults_required_channels_and_safe_mode_are_preserved() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    initialize(&manager, &["buzz.todos", "buzz.channels"]);
    for (id, enabled) in [("buzz.todos", false), ("buzz.channels", true)] {
        let source = home.path().join(id);
        write_build(&source, id, "export function apply() {}");
        let prepared = manager.prepare_development(id, &source).unwrap();
        let catalog = manager
            .attach_development(&prepared, &prepared.preview.token)
            .unwrap();
        assert_eq!(
            catalog
                .plugins
                .iter()
                .find(|plugin| plugin.manifest.id == id)
                .unwrap()
                .enabled,
            enabled
        );
        assert_eq!(
            manager.module(id, &prepared.preview.revision).is_ok(),
            enabled
        );
        manager.use_compiled(id).unwrap();
    }
    assert!(manager.change("disable", "buzz.channels").is_err());
    let safe = Manager::open(Some(home.path().into()), "test", true).unwrap();
    assert!(safe.initialize_development(BTreeMap::new()).is_err());
    assert!(safe
        .prepare_development("buzz.channels", &home.path().join("buzz.channels"))
        .is_err());
    assert!(safe.external_plugins_paused());
    assert!(safe
        .catalog()
        .unwrap()
        .plugins
        .iter()
        .all(|plugin| plugin.source == "bundled"));
}

#[test]
fn stale_preview_is_rejected_even_after_reverting_to_same_hash() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    initialize(&manager, &["buzz.inbox"]);
    let source = home.path().join("build");
    write_build(&source, "buzz.inbox", "export const first = true;");
    let first = manager.prepare_development("buzz.inbox", &source).unwrap();
    manager
        .attach_development(&first, &first.preview.token)
        .unwrap();
    let stale = manager.prepare_development("buzz.inbox", &source).unwrap();
    manager.use_compiled("buzz.inbox").unwrap();
    let fresh = manager.prepare_development("buzz.inbox", &source).unwrap();
    manager
        .attach_development(&fresh, &fresh.preview.token)
        .unwrap();
    assert_eq!(revision(&manager, "buzz.inbox"), stale.preview.revision);
    assert!(manager
        .attach_development(&stale, &stale.preview.token)
        .is_err());
    let changed = BTreeMap::from([(
        "buzz.inbox".into(),
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
    )]);
    assert!(manager.initialize_development(changed).is_err());
}

#[cfg(unix)]
#[test]
fn development_reader_refuses_symlinks_and_empty_code() {
    if !cfg!(debug_assertions) {
        return;
    }
    let home = tempfile::tempdir().unwrap();
    let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
    initialize(&manager, &["buzz.inbox"]);
    let source = home.path().join("build");
    write_build(&source, "buzz.inbox", "export function apply() {}");
    fs::remove_file(source.join("plugin.js")).unwrap();
    let outside = home.path().join("outside.js");
    fs::write(&outside, "export function apply() {}").unwrap();
    std::os::unix::fs::symlink(&outside, source.join("plugin.js")).unwrap();
    assert!(manager.prepare_development("buzz.inbox", &source).is_err());
    fs::remove_file(source.join("plugin.js")).unwrap();
    fs::write(source.join("plugin.js"), " ").unwrap();
    assert!(manager.prepare_development("buzz.inbox", &source).is_err());
}
