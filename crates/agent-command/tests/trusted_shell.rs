#![cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[test]
fn bundled_shell_ignores_path_startup_and_imported_functions_without_mcp() {
    let directory = tempfile::tempdir().unwrap();
    let fake = directory.path().join("bash");
    std::fs::write(&fake, "#!/bin/sh\nprintf planted\nexit 88\n").unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_buzz-agent-command"))
        .args(["--shell", "printf '%s\\n' native", "bootstrap-test"])
        .env("PATH", directory.path())
        .env("BASH_ENV", &fake)
        .env("ENV", &fake)
        .env("BASH_FUNC_printf%%", "() { echo planted; }")
        .env_remove("BUZZ_AGENT_CONNECTION")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"native\n");
    assert!(output.stderr.is_empty());
}
