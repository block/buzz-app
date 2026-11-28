//! Shared commit outcomes; fake-only cleanup and no desktop-specific state.
use super::*;

#[test]
fn committed_catalog_failure_never_becomes_recovery_or_reset_authority() {
    let env = Env::new();
    env.ready(SLOT);
    let registry = env.manager.storage_root().join("registry.json");
    fs::write(&registry, b"not json").unwrap();
    let outcome = env.manager.management_outcome(Ok(()), None, false);
    assert!(outcome.committed);
    assert!(outcome.catalog.is_none());
    assert_eq!(
        outcome.problem,
        Some("Plugin change saved; catalog is unavailable")
    );
    assert!(env.store.items.lock().unwrap().is_empty());
}
#[test]
fn persistence_error_is_uncertain_even_if_renamed_registry_is_readable() {
    let env = Env::new();
    env.ready(SLOT);
    let outcome =
        env.manager
            .management_outcome(Err("post-rename directory sync".into()), None, false);
    assert!(!outcome.committed);
    assert!(outcome.catalog.is_some());
    assert_eq!(
        outcome.problem,
        Some("Plugin change outcome is unknown; refresh before trying again")
    );
    assert!(!outcome.cleanup_due);
    assert!(
        env.manager.change_managed("remove", "absent").is_err(),
        "pre-persistence refusal stays separate"
    );
}
#[test]
fn all_shared_retiring_paths_report_cleanup_due_but_do_not_prompt_until_requested() {
    for operation in ["install", "reload", "rollback", "recover"] {
        let env = Env::new();
        env.ready(SLOT);
        env.set(ALICE, SENTINEL).unwrap();
        // Disable retains credentials and does not retry old debt.
        assert!(
            !env.manager
                .change_managed("disable", PLUGIN)
                .unwrap()
                .cleanup_due
        );
        let changed = SLOT.replace("Bearer", "Token");
        let outcome = match operation {
            "install" => {
                fs::write(
                    env.temp.path().join("build/manifest.json"),
                    manifest(&changed),
                )
                .unwrap();
                let source = env.temp.path().join("build");
                let release = crate::prepare_artifact(&source).unwrap();
                env.manager
                    .install_artifact_managed(&release, None)
                    .unwrap()
            }
            "reload" => {
                fs::write(
                    env.temp.path().join("build/plugin.js"),
                    "export const updated=true;",
                )
                .unwrap();
                // Unchanged policy reload retains live enrollment.
                let retained = env.manager.reload_managed(PLUGIN).unwrap();
                assert!(!retained.cleanup_due);
                fs::write(
                    env.temp.path().join("build/manifest.json"),
                    manifest(&changed),
                )
                .unwrap();
                env.manager
                    .reload_with_commit_hook(PLUGIN, true, || {})
                    .unwrap()
            }
            "rollback" => {
                env.install(&changed);
                env.manager.change("enable", PLUGIN).unwrap();
                env.set(ALICE, SENTINEL).unwrap();
                env.store.deletes.store(0, Ordering::SeqCst);
                env.manager.change_managed("rollback", PLUGIN).unwrap()
            }
            _ => env.manager.recover_managed().unwrap(),
        };
        assert!(outcome.committed);
        assert!(
            outcome.cleanup_due,
            "{operation} must schedule its initial cleanup"
        );
        assert_eq!(
            env.store.deletes.load(Ordering::SeqCst),
            0,
            "metadata-only contract must not prompt"
        );
        let result = env.manager.management_cleanup(outcome);
        assert!(result.committed);
        let deadline = Instant::now() + Duration::from_secs(5);
        while env.pending() != 0 {
            assert!(Instant::now() < deadline, "initial cleanup never completed");
            std::thread::yield_now();
        }
        assert_eq!(env.store.count(), 0);
    }
}

/// Automatic policy updates share this conditional owner with manual installs.
#[test]
fn conditional_installs_retire_like_manual_ones_and_refusals_retire_nothing() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    let source = env.temp.path().join("build");
    let conditional = |check: Option<bool>| {
        let release = crate::prepare_artifact(&source).unwrap();
        let committed = std::cell::Cell::new(false);
        let outcome = env
            .manager
            .install_artifact_if(
                &release,
                None,
                |_| Ok(check),
                || {
                    committed.set(true);
                    Ok(())
                },
            )
            .unwrap();
        (outcome, committed.get())
    };
    fs::write(source.join("plugin.js"), "export const updated=true;").unwrap();
    let (unchanged, recorded) = conditional(Some(false));
    let unchanged = unchanged.unwrap();
    assert!(unchanged.committed && recorded);
    assert!(!unchanged.cleanup_due, "same policy keeps its enrollment");
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    let changed = SLOT.replace("Bearer", "Token");
    fs::write(source.join("manifest.json"), manifest(&changed)).unwrap();
    let (refused, recorded) = conditional(None);
    assert!(refused.is_none() && !recorded);
    assert_eq!(env.status(ALICE), SecretStatus::Saved);
    assert_eq!(env.pending(), 0);
    let (retired, recorded) = conditional(Some(false));
    let retired = retired.unwrap();
    assert!(retired.committed && recorded && retired.cleanup_due);
    assert_eq!(env.pending(), 1);
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
}

#[test]
fn deliberate_retry_refuses_a_pending_sign_out_before_store_work() {
    let env = Env::new();
    env.ready(SLOT);
    env.set(ALICE, SENTINEL).unwrap();
    env.manager.change("remove", PLUGIN).unwrap();
    begin_sign_out(&env.root(), Some(ALICE), None).unwrap();
    assert_eq!(
        env.manager.start_credential_cleanup().unwrap_err(),
        "A sign-out is still finishing; open Buzz to complete it first"
    );
    assert_eq!(env.store.deletes.load(Ordering::SeqCst), 0);
    assert_eq!(env.pending(), 1);
}

#[test]
fn actual_save_failure_is_unknown_not_a_claimed_rollback() {
    let env = Env::new();
    env.ready(SLOT);
    let registry = env.manager.storage_root().join("registry.json");
    let bytes = fs::read(&registry).unwrap();
    let blocked = registry.clone();
    native_creators::AFTER_READ.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            fs::remove_file(&blocked).unwrap();
            fs::create_dir(&blocked).unwrap();
        }))
    });
    let outcome = env.manager.change_managed("disable", PLUGIN).unwrap();
    assert!(!outcome.committed);
    assert!(outcome.catalog.is_none());
    assert!(outcome.problem.unwrap().contains("unknown"));
    assert!(!outcome.cleanup_due);
    fs::remove_dir(&registry).unwrap();
    fs::write(&registry, bytes).unwrap();
    assert!(
        env.manager
            .catalog()
            .unwrap()
            .plugins
            .iter()
            .find(|p| p.manifest.id == PLUGIN)
            .unwrap()
            .enabled
    );
}

#[test]
fn registry_preflight_refusal_is_not_an_uncertain_save() {
    let env = Env::new();
    let registry = Registry {
        version: 3,
        ..Registry::default()
    };
    assert_eq!(
        env.manager.save_outcome(&registry).unwrap_err(),
        "Plugin settings lineage is inconsistent"
    );
    assert!(!env.manager.storage_root().join("registry.json").exists());
}
