//! Recover listeners left behind when a native dev reload bypasses Drop/Exit.
//! Scope is the exact resource executable, never an agent name or a generic PID.
use crate::Result;
use std::{
    path::Path,
    process::{Command, Stdio},
};

fn table() -> Result<String> {
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,lstart=,comm="])
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Could not inspect orphaned agent listeners")?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Could not inspect orphaned agent listeners".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "Could not decode process inventory".into())
}
fn candidates(table: &str, executable: &Path) -> Vec<(u32, String)> {
    table
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<u32>().ok()?;
            let parent = fields.next()?.parse::<u32>().ok()?;
            // lstart is five fields; preserve the whole row to fence PID reuse.
            for _ in 0..5 {
                fields.next()?;
            }
            let path = fields.collect::<Vec<_>>().join(" ");
            (pid > 1 && parent == 1 && Path::new(&path) == executable)
                .then(|| (pid, line.trim().to_owned()))
        })
        .collect()
}
pub(crate) fn sweep(executable: &Path) -> Result<()> {
    let targets = candidates(&table()?, executable);
    if targets.len() > 128 {
        return Err(
            "Too many orphaned listeners; cleanup must finish before starting agents".into(),
        );
    }
    for (pid, identity) in targets {
        // A live owner's listener is excluded even when it uses the same binary.
        if !candidates(&table()?, executable).contains(&(pid, identity)) {
            continue;
        }
        crate::process::stop_session(pid, None)?;
    }
    if !candidates(&table()?, executable).is_empty() {
        return Err("Orphaned agent cleanup is incomplete; retry before starting agents".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ownership_filter_excludes_other_apps_and_live_parents() {
        let table = "101 1 Thu Sep 24 13:00:00 2026 /tmp/Our App/buzz-acp\n102 999 Thu Sep 24 13:00:00 2026 /tmp/Our App/buzz-acp\n103 1 Thu Sep 24 13:00:00 2026 /Applications/Buzz.app/buzz-acp\n";
        let found = candidates(table, Path::new("/tmp/Our App/buzz-acp"));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, 101);
    }
    #[test]
    #[ignore = "subprocess fixture; invoked by abrupt_owner_exit_is_cleaned_before_replacement"]
    fn abruptly_exit_owner() {
        let Some(path) = std::env::var_os("BUZZ_ORPHAN_FIXTURE") else {
            return;
        };
        let mut command = Command::new(path);
        command
            .args(["--exact", "orphans::tests::listener_fixture", "--ignored"])
            .env("BUZZ_ORPHAN_LISTENER", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let _process = crate::ContainedProcess::spawn(&mut command).unwrap();
        // Deliberately bypass destructors, like a killed dev app.
        std::process::exit(0);
    }
    #[test]
    #[ignore = "listener fixture invoked only by the orphan regression"]
    fn listener_fixture() {
        if std::env::var_os("BUZZ_ORPHAN_LISTENER").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    }
    #[test]
    fn abrupt_owner_exit_is_cleaned_before_replacement() {
        let binary = std::env::current_exe().unwrap();
        let mut live_command = Command::new(&binary);
        live_command
            .args(["--exact", "orphans::tests::listener_fixture", "--ignored"])
            .env("BUZZ_ORPHAN_LISTENER", "1")
            .stdout(Stdio::null());
        let mut live = crate::ContainedProcess::spawn(&mut live_command).unwrap();
        let status = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "orphans::tests::abruptly_exit_owner",
                "--ignored",
            ])
            .env("BUZZ_ORPHAN_FIXTURE", &binary)
            .status()
            .unwrap();
        assert!(status.success());
        assert_eq!(candidates(&table().unwrap(), &binary).len(), 1);
        sweep(&binary).unwrap();
        assert!(candidates(&table().unwrap(), &binary).is_empty());
        assert!(live.alive().unwrap());
        live.stop().unwrap();
    }
}
