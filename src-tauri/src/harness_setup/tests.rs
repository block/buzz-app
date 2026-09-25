use super::*;
use std::io::Write as _;

#[tokio::test]
async fn one_install_at_a_time_and_success_log() {
    let state = std::sync::Arc::new(HarnessSetup::default());
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agent-controller/goose-install.log");
    let (started, observed) = tokio::sync::oneshot::channel();
    let (release, done) = tokio::sync::oneshot::channel::<()>();
    let installing = state.clone();
    let output = path.clone();
    let task = tokio::spawn(async move {
        let _guard = installing.claim().unwrap();
        run_install(&output, |mut log| async move {
            started.send(()).unwrap();
            done.await.unwrap();
            writeln!(log, "CLI installed").unwrap();
            Ok(true)
        })
        .await
        .unwrap()
    });
    observed.await.unwrap();
    assert!(state.claim().is_err());
    release.send(()).unwrap();
    let report = task.await.unwrap();
    assert!(state.claim().is_ok());
    assert!(report.ready);
    assert_eq!(report.output.trim(), "CLI installed");
    assert_eq!(
        std::fs::read_to_string(path).unwrap().trim(),
        "CLI installed"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("agent-controller/goose-install.log"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[tokio::test]
async fn failure_records_combined_output_and_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("goose-install.log");
    let report = run_install(&path, |mut log| async move {
        writeln!(log, "stdout and stderr").unwrap();
        Err("Installer exited unexpectedly".into())
    })
    .await
    .unwrap();
    assert!(!report.ready);
    assert_eq!(
        report.error.as_deref(),
        Some("Installer exited unexpectedly")
    );
    assert!(report.output.contains("stdout and stderr"));
    assert!(std::fs::read_to_string(path)
        .unwrap()
        .contains("Installer exited unexpectedly"));
}

#[test]
fn only_enabled_goose_waiting_for_a_missing_cli_restarts() {
    use ProcessStatus::{Failed, Running, Stopped};
    assert!(waiting(
        true,
        Failed,
        "/home/user/.local/bin/goose",
        Some("Required runtime executable is missing")
    ));
    // Enabled but never started this session is not evidence of waiting.
    assert!(!waiting(true, Stopped, "goose", None));
    assert!(!waiting(
        true,
        Failed,
        "goose",
        Some("Choose the installed harness's absolute executable path")
    ));
    assert!(!waiting(false, Stopped, "goose", None));
    assert!(!waiting(
        false,
        Failed,
        "goose",
        Some("Required runtime executable is missing")
    ));
    assert!(!waiting(true, Running, "goose", None));
    assert!(!waiting(true, Stopped, "buzz-agent", None));
    assert!(!waiting(
        true,
        Failed,
        "goose",
        Some("Agent listener exited; restart to retry")
    ));
    assert!(!waiting(
        true,
        Failed,
        "goose",
        Some("Saved agent key is unavailable")
    ));
}

#[cfg(unix)]
#[test]
fn quit_kills_the_tracked_installer_group_and_fences_late_spawns() {
    use std::io::BufRead as _;
    use std::os::unix::process::CommandExt;
    let spawn = || {
        std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & printf 'ready\\n'; wait"])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap()
    };
    let state = HarnessSetup::default();
    let mut active = spawn();
    let guard = state.claim().unwrap();
    state.track(active.id()).unwrap();
    let mut marker = String::new();
    std::io::BufReader::new(active.stdout.take().unwrap())
        .read_line(&mut marker)
        .unwrap();
    assert_eq!(marker, "ready\n", "the helper must exist before Quit");
    state.shutdown();
    // SIGKILL reached the group leader; its sleeping child shares the group.
    assert!(!active.wait().unwrap().success());
    let gone = (0..50).any(|_| {
        std::thread::sleep(std::time::Duration::from_millis(20));
        (unsafe { libc::kill(-(active.id() as i32), 0) }) == -1
    });
    assert!(gone, "installer helpers survived Quit");
    drop(guard);

    assert_eq!(state.claim().err().as_deref(), Some("Buzz is quitting"));
    let mut late = spawn();
    assert_eq!(
        state.track(late.id()).err().as_deref(),
        Some("Buzz is quitting")
    );
    assert!(!late.wait().unwrap().success());
}

#[test]
fn a_finished_install_clears_its_group_without_killing_it_again_on_quit() {
    let state = HarnessSetup::default();
    let guard = state.claim().unwrap();
    // Above supported OS pid limits; even a failed assertion cannot signal a
    // real process group from this test.
    let absent_group = i32::MAX as u32;
    state.track(absent_group).unwrap();
    state.untrack(absent_group, false);
    assert!(state.1.lock().unwrap().group.is_none());
    state.shutdown();
    drop(guard);
    assert_eq!(state.claim().err().as_deref(), Some("Buzz is quitting"));
}
