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
    assert!(waiting(true, Stopped, "goose", None));
    assert!(waiting(
        true,
        Failed,
        "/home/user/.local/bin/goose",
        Some("Required runtime executable is missing")
    ));
    assert!(waiting(
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
