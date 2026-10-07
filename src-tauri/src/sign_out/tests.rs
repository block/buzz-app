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
fn no_agents(_: &Path) -> Result<(), String> {
    panic!("agent keys must not be touched")
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
        finish_pending(&paths, |_| Ok(()), || panic!("key must not be touched")),
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
        finish_pending(
            &paths,
            |_| Ok(()),
            || {
                removed.set(true);
                Ok(())
            }
        ),
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
        assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
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
            finish_pending(&paths, |_| Ok(()), || Err("keychain denied".into())),
            Err(FAILED.into())
        );
        // Everything, including the marker, is exactly where it was.
        assert_eq!(listing(dir.path()), before);
        assert!(paths.marker.exists());

        assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
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
    assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
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
    assert!(finish_pending(&paths, |_| Ok(()), || Err("locked".into())).is_err());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn an_unreadable_marker_blocks_without_touching_the_key_or_data() {
    let (dir, paths) = fixture();
    fs::write(&paths.marker, "{\"wipe\":true}").unwrap();
    let before = listing(dir.path());
    assert!(finish_pending(&paths, |_| Ok(()), || panic!("key must not be touched")).is_err());
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
    assert!(boot(&release, no_agents, || panic!(
        "release key must not be touched"
    ))
    .is_ok());
    assert_eq!(data(dir.path()), before);
    assert!(debug.marker.exists());
}

#[test]
fn a_retry_clears_storage_recreated_after_the_key_was_removed() {
    let (dir, paths) = fixture();
    mark(&paths, true, false);
    // Trash cleanup fails once (a file where its folder should be).
    fs::write(trash(&paths.others[0]), "stuck").unwrap();
    assert!(finish_pending(&paths, |_| Ok(()), || Ok(())).is_err());
    assert!(paths.marker.exists());
    // Something recreates storage before the next launch.
    fs::create_dir_all(&paths.others[0]).unwrap();
    fs::write(paths.others[0].join("recreated"), "new").unwrap();
    fs::write(paths.app_data.join("recreated.sqlite3"), "new").unwrap();
    fs::remove_file(trash(&paths.others[0])).unwrap();
    // The key is already gone; the retry must still succeed and leave nothing.
    assert_eq!(finish_pending(&paths, |_| Ok(()), || Ok(())), Ok(()));
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
    let first = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let second = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    assert!(first.begin().is_err());
    drop(second);
    first.begin().unwrap();
    // While one instance signs out, a new launch neither runs nor waits forever.
    assert_eq!(
        boot(&paths, no_agents, || panic!("no marker")).err(),
        Some(SIGNING_OUT.into())
    );
    first.abort();
    assert!(boot(&paths, no_agents, || panic!("no marker")).is_ok());
}

#[test]
fn a_second_sign_out_in_the_same_instance_is_refused() {
    let (_dir, paths) = fixture();
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    instance.begin().unwrap();
    assert_eq!(instance.begin(), Err(refuse(ALREADY)));
    // Concurrent calls race for the same guard; exactly one is admitted.
    instance.abort();
    let admitted = std::thread::scope(|scope| {
        let calls: Vec<_> = (0..8)
            .map(|_| scope.spawn(|| instance.begin().is_ok()))
            .collect();
        calls
            .into_iter()
            .map(|call| call.join().unwrap())
            .filter(|&admitted| admitted)
            .count()
    });
    assert_eq!(admitted, 1);
}

#[test]
fn a_pending_sign_out_waits_for_the_restarting_instance_to_exit() {
    let (dir, paths) = fixture();
    let exiting = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    exiting.begin().unwrap();
    mark(&paths, false, false);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        drop(exiting);
    });
    let before = data(dir.path());
    assert!(boot(&paths, no_agents, || Ok(())).is_ok());
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

const CHILD: &str = "BUZZ_SIGN_OUT_TEST_CHILD";
/// Another Buzz process: boots, tries to sign out, then holds on briefly and exits.
#[test]
fn child_instance() {
    let Some(root) = std::env::var_os(CHILD) else {
        return;
    };
    let paths = paths_for(Path::new(&root), "identity");
    let instance = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    match instance.begin() {
        Err(_) => println!("child: refused"),
        Ok(()) => {
            mark(&paths, true, false);
            println!("child: signing out");
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}
/// Run `child_instance` in a separate process and return once it reports.
fn spawn_child(root: &Path) -> (std::process::Child, String) {
    use std::io::BufRead;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["sign_out::tests::child_instance", "--exact", "--nocapture"])
        .env(CHILD, root)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = std::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let report = lines
        .by_ref()
        .map(Result::unwrap)
        .find(|line| line.starts_with("child: "))
        .unwrap();
    // Keep reading, so the child never fails writing the rest of its output.
    std::thread::spawn(move || lines.for_each(drop));
    (child, report)
}

#[test]
fn across_processes_a_running_instance_blocks_sign_out_and_a_later_launch_finishes_it() {
    let (dir, paths) = fixture();
    // A launch that is already running refuses the other process's sign-out.
    let running = boot(&paths, no_agents, || panic!("no marker"))
        .ok()
        .unwrap();
    let (mut child, report) = spawn_child(dir.path());
    assert_eq!(report, "child: refused");
    assert!(child.wait().unwrap().success());
    assert!(!paths.marker.exists());
    drop(running);
    // A launch that starts while the other process signs out waits, then finishes it.
    let (mut child, report) = spawn_child(dir.path());
    assert_eq!(report, "child: signing out");
    let removed = Cell::new(false);
    assert!(boot(&paths, no_agents, || {
        removed.set(true);
        Ok(())
    })
    .is_ok());
    assert!(child.wait().unwrap().success());
    assert!(removed.get());
    assert!(!paths.marker.exists());
    assert_eq!(
        listing(dir.path())
            .into_iter()
            .filter(|path| !path.ends_with("instance.lock"))
            .collect::<Vec<_>>(),
        [
            "app/",
            "app/agent-controller/",
            "app/agent-controller/agents.json"
        ]
    );
}

#[test]
fn agent_keys_go_first_and_an_interruption_retries_without_moving_anything() {
    let (dir, paths) = fixture();
    mark(&paths, true, true);
    let before = listing(dir.path());
    assert_eq!(
        finish_pending(
            &paths,
            |registry| {
                assert!(registry.join("agents.json").exists());
                Err("keychain interrupted".into())
            },
            || panic!("the human key waits for the agent keys")
        ),
        Err(FAILED.into())
    );
    assert_eq!(listing(dir.path()), before);
    let removed = Cell::new(false);
    assert_eq!(
        finish_pending(
            &paths,
            |_| {
                removed.set(true);
                Ok(())
            },
            || Ok(())
        ),
        Ok(())
    );
    assert!(removed.get());
    assert!(listing(dir.path()).is_empty());
}

#[test]
fn kept_agents_keep_their_keys() {
    let (_dir, paths) = fixture();
    mark(&paths, true, false);
    assert_eq!(finish_pending(&paths, no_agents, || Ok(())), Ok(()));
}

#[test]
fn only_release_builds_sign_out_and_wipe_needs_default_plugin_storage() {
    assert!(refusal(true, false, false, false, false)
        .unwrap()
        .contains("development builds"));
    assert!(refusal(false, true, false, false, false)
        .unwrap()
        .contains("development broker"));
    assert!(refusal(false, false, true, true, false)
        .unwrap()
        .contains("BUZZODZ_HOME"));
    assert_eq!(refusal(false, false, true, false, false), None);
    assert_eq!(refusal(false, false, false, true, true), None);
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
fn preparation_commits_the_marker_before_stopping_agents() {
    let (_dir, paths) = fixture();
    let marker = paths.marker.clone();
    let stopped = Cell::new(false);
    run(prepare(&paths.marker, choices(true), || {
        assert!(marker.exists());
        stopped.set(true);
        async { Ok(()) }
    }))
    .unwrap();
    assert!(stopped.get());
}

#[test]
fn a_marker_write_failure_stops_nothing() {
    let (dir, _) = fixture();
    let marker = dir.path().join("missing-folder/marker");
    let failure = run(prepare(
        &marker,
        choices(true),
        || -> std::future::Ready<Result<(), String>> { panic!("agents must not stop") },
    ))
    .unwrap_err();
    assert_eq!(failure, refuse(NOT_PREPARED));
}

#[test]
fn a_shutdown_failure_keeps_the_marker_and_asks_to_reopen() {
    let (_dir, paths) = fixture();
    let failure = run(prepare(&paths.marker, choices(false), || async {
        Err("controller stuck".to_owned())
    }))
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
            "message": "Sign out is unavailable in development builds",
            "reopen": false
        })
    );
    // Refused before any agent was stopped.
    assert!(invoke(&view, "agent_control_snapshot", serde_json::json!({})).is_ok());
}
