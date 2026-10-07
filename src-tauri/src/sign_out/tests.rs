use super::*;
use std::cell::Cell;

fn fixture() -> (tempfile::TempDir, Paths) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let paths = Paths {
        marker: root.join(".app.sign-out-pending"),
        app_data: root.join("app"),
        others: vec![root.join("webkit")],
    };
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
        None
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
        None
    );
    assert!(removed.get());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn wipe_keeps_agents_unless_they_are_removed_too() {
    for remove_agents in [false, true] {
        let (dir, paths) = fixture();
        mark(&paths, true, remove_agents);
        assert_eq!(finish_pending(&paths, || Ok(())), None);
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
            finish_pending(&paths, || Err("keychain denied".into())).as_deref(),
            Some(FAILED)
        );
        // Everything, including the marker, is exactly where it was.
        assert_eq!(listing(dir.path()), before);
        assert!(paths.marker.exists());

        assert_eq!(finish_pending(&paths, || Ok(())), None);
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
    assert_eq!(finish_pending(&paths, || Ok(())), None);
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
    assert!(finish_pending(&paths, || Err("locked".into())).is_some());
    assert_eq!(listing(dir.path()), before);
}

#[test]
fn an_unreadable_marker_blocks_without_touching_the_key_or_data() {
    let (dir, paths) = fixture();
    fs::write(&paths.marker, "{\"wipe\":true}").unwrap();
    let before = listing(dir.path());
    assert!(finish_pending(&paths, || panic!("key must not be touched")).is_some());
    assert_eq!(listing(dir.path()), before);
}
