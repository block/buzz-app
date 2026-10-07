use super::*;
use std::cell::Cell;
use std::future::Future;

fn paths_for(root: &Path, service: &str) -> Paths {
    Paths {
        marker: root.join(marker_name("app", service)),
        lock: root.join(".app.instance.lock"),
        app_data: root.join("app"),
        others: vec![root.join("webkit")],
    }
}
fn fixture() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let paths = paths_for(root, "identity");
    fs::create_dir_all(paths.app_data.join(KEPT)).unwrap();
    fs::write(paths.app_data.join(KEPT).join("agents.json"), "agents").unwrap();
    fs::write(paths.app_data.join("archive.sqlite3"), "archive").unwrap();
    fs::create_dir_all(&paths.others[0]).unwrap();
    fs::write(paths.others[0].join("localstorage"), "prefs").unwrap();
    (dir, paths)
}
fn mark(paths: &Paths, wipe: bool, remove_agents: bool) {
    write_marker(
        &paths.marker,
        Choices {
            wipe,
            remove_agents,
        },
    )
    .unwrap();
}
/// Listing without the instance lock file, which boot creates.
fn data(root: &Path) -> Vec<String> {
    listing(root)
        .into_iter()
        .filter(|path| !path.ends_with("instance.lock"))
        .collect()
}
fn listing(root: &Path) -> Vec<String> {
    let mut found: Vec<String> = walk(root, root);
    found.sort();
    found
}
fn walk(root: &Path, dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .flat_map(|entry| {
            let path = entry.unwrap().path();
            let name = path.strip_prefix(root).unwrap().display().to_string();
            if path.is_dir() {
                let mut nested = walk(root, &path);
                nested.push(format!("{name}/"));
                nested
            } else {
                vec![name]
            }
        })
        .collect()
}

#[test]
fn no_marker_leaves_everything_alone() {
    let (dir, paths) = fixture();
    let before = listing(dir.path());
    assert_eq!(
        finish_pending(&paths, || panic!("key must not be touched")),
        Ok(())
    );
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn sign_out_without_wipe_removes_only_the_key_and_marker() {
    let (dir, paths) = fixture();
    let before = listing(dir.path());
    mark(&paths, false, false);
    let removed = Cell::new(false);
    assert_eq!(
        finish_pending(&paths, || {
            removed.set(true);
            Ok(())
        }),
        Ok(())
    );
    assert!(removed.get());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn wipe_keeps_agents_unless_they_are_removed_too() {
    for remove_agents in [false, true] {
        let (dir, paths) = fixture();
        mark(&paths, true, remove_agents);
        assert_eq!(finish_pending(&paths, || Ok(())), Ok(()));
        let expected: &[&str] = if remove_agents {
            &[]
        } else {
            &[
                "app/",
                "app/agent-controller/",
                "app/agent-controller/agents.json",
            ]
        };
        assert_eq!(listing(dir.path()), expected);
    }
}

#[test]
fn key_removal_failure_restores_data_keeps_marker_and_the_retry_succeeds() {
    for remove_agents in [false, true] {
        let (dir, paths) = fixture();
        mark(&paths, true, remove_agents);
        let mut before = listing(dir.path());
        assert_eq!(
            finish_pending(&paths, || Err("keychain denied".into())),
            Err(FAILED.into())
        );
        // Everything, including the marker, is exactly where it was.
        assert_eq!(listing(dir.path()), before);
        assert!(paths.marker.exists());

        assert_eq!(finish_pending(&paths, || Ok(())), Ok(()));
        before = listing(dir.path());
        assert!(!before.iter().any(|path| path.contains("archive")));
        assert!(!paths.marker.exists());
    }
}

#[test]
fn a_wipe_interrupted_part_way_resumes_on_the_next_launch() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    // Crash after moving app data aside, before returning the agent registry.
    fs::rename(&paths.app_data, trash(&paths.app_data)).unwrap();
    assert_eq!(finish_pending(&paths, || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json"
        ]
    );
}

#[test]
fn an_interrupted_wipe_rolls_back_fully_when_the_key_cannot_be_removed() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    let before = listing(dir.path());
    fs::rename(&paths.app_data, trash(&paths.app_data)).unwrap();
    assert!(finish_pending(&paths, || Err("locked".into())).is_err());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn an_unreadable_marker_blocks_without_touching_the_key_or_data() {
    let (dir, paths) = fixture();
    fs::write(&paths.marker, "{\"wipe\":true}").unwrap();
    let before = listing(dir.path());
    assert!(finish_pending(&paths, || panic!("key must not be touched")).is_err());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn a_debug_sign_out_never_touches_the_release_key_or_data() {
    let (dir, debug) = fixture();
    let debug = Paths {
        marker: dir.path().join(marker_name("app", "identity.debug")),
        ..debug
    };
    let release = paths_for(dir.path(), "identity");
    assert_ne!(debug.marker, release.marker);
    mark(&debug, true, true);
    let before = data(dir.path());
    // The release build launches first: its key and the shared folders stay put.
    assert!(boot(&release, || panic!("release key must not be touched")).is_ok());
    assert_eq!(data(dir.path()), before);
    assert!(debug.marker.exists());
}

#[test]
fn a_retry_clears_storage_recreated_after_the_key_was_removed() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    // Trash cleanup fails once (a file where its folder should be).
    fs::write(trash(&paths.others[0]), "stuck").unwrap();
    assert!(finish_pending(&paths, || Ok(())).is_err());
    assert!(paths.marker.exists());
    // Something recreates storage before the next launch.
    fs::create_dir_all(&paths.others[0]).unwrap();
    fs::write(paths.others[0].join("recreated"), "new").unwrap();
    fs::write(paths.app_data.join("recreated.sqlite3"), "new").unwrap();
    fs::remove_file(trash(&paths.others[0])).unwrap();
    // The key is already gone; the retry must still succeed and leave nothing.
    assert_eq!(finish_pending(&paths, || Ok(())), Ok(()));
    assert_eq!(
        listing(dir.path()),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json"
        ]
    );
}

#[test]
fn instances_share_the_lock_and_sign_out_needs_it_alone() {
    let (_dir, paths) = fixture();
    // Two independent lock handles behave like two processes for OS file locks.
    let first = boot(&paths, || panic!("no marker")).ok().unwrap();
    let second = boot(&paths, || panic!("no marker")).ok().unwrap();
    assert!(!first.claim());
    // A pending sign-out waits for the other instance, then refuses.
    mark(&paths, false, false);
    assert_eq!(
        boot(&paths, || panic!("key must not be touched")).err(),
        Some(BUSY.into())
    );
    drop(second);
    assert!(first.claim());
    // While one instance holds it alone, a new launch neither runs nor waits forever.
    assert_eq!(
        boot(&paths, || panic!("key must not be touched")).err(),
        Some(BUSY.into())
    );
    fs::remove_file(&paths.marker).unwrap();
    assert_eq!(
        boot(&paths, || panic!("no marker")).err(),
        Some(SIGNING_OUT.into())
    );
    first.release();
    assert!(boot(&paths, || panic!("no marker")).is_ok());
}

#[test]
fn a_pending_sign_out_waits_for_the_restarting_instance_to_exit() {
    let (dir, paths) = fixture();
    let exiting = boot(&paths, || panic!("no marker")).ok().unwrap();
    mark(&paths, false, false);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        drop(exiting);
    });
    let before = data(dir.path());
    assert!(boot(&paths, || Ok(())).is_ok());
    release.join().unwrap();
    assert!(!paths.marker.exists());
    assert_eq!(
        data(dir.path()),
        before
            .into_iter()
            .filter(|path| !path.ends_with("sign-out-pending"))
            .collect::<Vec<_>>()
    );
}

fn choices(remove_agents: bool) -> Choices {
    Choices {
        wipe: true,
        remove_agents,
    }
}
fn run<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

#[test]
fn preparation_commits_the_marker_before_removing_or_stopping_agents() {
    let (_dir, paths) = fixture();
    let marker = paths.marker.clone();
    let seen = Cell::new(0);
    run(prepare(
        &paths.marker,
        choices(true),
        || {
            assert!(marker.exists());
            seen.set(seen.get() + 1);
            async { Ok(()) }
        },
        || {
            seen.set(seen.get() + 1);
            async { Ok(()) }
        },
    ))
    .unwrap();
    assert_eq!(seen.get(), 2);
    assert!(paths.marker.exists());
}

#[test]
fn a_marker_write_failure_removes_and_stops_nothing() {
    let (dir, _) = fixture();
    let marker = dir.path().join("missing-folder/marker");
    let failure = run(prepare(
        &marker,
        choices(true),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not be removed") },
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert_eq!(failure, refuse(NOT_PREPARED));
}

#[test]
fn an_agent_removal_failure_withdraws_the_marker_and_keeps_buzz_usable() {
    let (_dir, paths) = fixture();
    let failure = run(prepare(
        &paths.marker,
        choices(true),
        || async { Err("one agent failed".to_owned()) },
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert!(!failure.reopen);
    assert!(failure.message.contains("some may already be gone"));
    assert!(!paths.marker.exists());
}

#[test]
fn a_shutdown_failure_keeps_the_marker_and_asks_to_reopen() {
    let (_dir, paths) = fixture();
    let failure = run(prepare(
        &paths.marker,
        choices(false),
        || -> std::future::Ready<Result<(), String>> { panic!("agents are kept") },
        || async { Err("controller stuck".to_owned()) },
    ))
    .unwrap_err();
    assert_eq!(
        failure,
        Failure {
            message: REOPEN.into(),
            reopen: true
        }
    );
    assert!(paths.marker.exists());
}

#[test]
fn production_acl_lets_sign_out_reach_native_validation() {
    use crate::agents::tests::{fixture, invoke};
    let (_dir, _host, _app, view) = fixture();
    let error = invoke(
        &view,
        "sign_out",
        serde_json::json!({"wipe": false, "removeAgents": true}),
    )
    .unwrap_err();
    assert_eq!(
        error,
        serde_json::json!({
            "message": "Removing agents is part of wiping this device",
            "reopen": false
        })
    );
    // Refused before any agent was stopped.
    assert!(invoke(&view, "agent_control_snapshot", serde_json::json!({})).is_ok());
}
