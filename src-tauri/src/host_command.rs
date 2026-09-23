use crate::{with_manager, PluginManager};
use buzzodz_plugins::HostCommand;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const MAX_OUTPUT_BYTES: u64 = 4096;
const DEADLINE: Duration = Duration::from_secs(5);

// Tokio kills only the direct child on future cancellation; the group also owns descendants.
#[cfg(unix)]
struct ProcessGroupGuard {
    process_id: i32,
    armed: bool,
}

#[cfg(unix)]
impl ProcessGroupGuard {
    fn kill(&self) {
        unsafe { libc::kill(-self.process_id, libc::SIGKILL) };
    }
}

#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if self.armed {
            self.kill();
        }
    }
}

#[tauri::command]
pub(crate) async fn plugin_host_run_command(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    command_id: String,
) -> Result<Option<String>, String> {
    let operation = async {
        let command = with_manager(manager, move |manager| {
            manager
                .host_grants(&id, &revision)?
                .commands
                .into_iter()
                .find(|command| command.id == command_id)
                .ok_or_else(|| "Command is not declared".into())
        })
        .await
        .ok()?;
        run_command(&command, DEADLINE).await
    };
    Ok(tokio::time::timeout(DEADLINE, operation)
        .await
        .ok()
        .flatten())
}

fn resolve_program(program: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::var_os("PATH").unwrap_or_default();
        let mut directories = std::env::split_paths(&path).collect::<Vec<_>>();
        directories.extend(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
        if let Some(executable) =
            directories
                .into_iter()
                .map(|path| path.join(program))
                .find(|path| {
                    std::fs::metadata(path).is_ok_and(|metadata| {
                        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
                    })
                })
        {
            return executable;
        }
    }
    PathBuf::from(program)
}

async fn run_command(command: &HostCommand, deadline: Duration) -> Option<String> {
    run(&resolve_program(&command.program), &command.args, deadline).await
}

async fn run(executable: &Path, args: &[String], deadline: Duration) -> Option<String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    let mut child = command.spawn().ok()?;
    #[cfg(unix)]
    let mut process_group = ProcessGroupGuard {
        process_id: child.id()? as i32,
        armed: true,
    };
    let stdout = child.stdout.take()?;
    let output = tokio::time::timeout(deadline, async {
        let mut bytes = Vec::new();
        stdout
            .take(MAX_OUTPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() as u64 > MAX_OUTPUT_BYTES {
            return None;
        }
        let status = child.wait().await.ok()?;
        #[cfg(unix)]
        {
            process_group.armed = false;
        }
        Some((bytes, status.success()))
    })
    .await;

    if let Ok(Some((bytes, success))) = output {
        return if success {
            String::from_utf8(bytes).ok()
        } else {
            None
        };
    }

    #[cfg(unix)]
    process_group.kill();
    let _ = child.start_kill();
    let _ = child.wait().await;
    #[cfg(unix)]
    {
        process_group.armed = false;
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::run;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    fn executable(script: &str) -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tool");
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        (directory, path)
    }

    #[tokio::test]
    async fn passes_exact_args_without_shell_interpretation() {
        let (_directory, path) = executable(
            "[ \"$#\" -eq 2 ] && [ \"$1\" = status ] && [ \"$2\" = '--mode=ready;echo injected' ] || exit 1\nprintf 'ready \\n'",
        );
        assert_eq!(
            run(
                &path,
                &["status".into(), "--mode=ready;echo injected".into()],
                Duration::from_secs(1)
            )
            .await,
            Some("ready \n".into())
        );
    }

    #[tokio::test]
    async fn returns_none_for_failures_and_invalid_utf8() {
        let (_directory, path) = executable("echo 'private stderr' >&2; exit 1");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        let (_directory, path) = executable("printf '\\377'");
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert_eq!(
            run(
                PathBuf::from("missing-tool-executable").as_path(),
                &[],
                Duration::from_secs(1)
            )
            .await,
            None
        );
    }

    #[tokio::test]
    async fn rejects_large_output_without_waiting_for_the_process() {
        let (_directory, path) = executable("yes x");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_secs(1)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn kills_a_stalled_command_at_the_deadline() {
        let (_directory, path) = executable("sleep 10");
        let started = Instant::now();
        assert_eq!(run(&path, &[], Duration::from_millis(50)).await, None);
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn aborting_the_read_kills_the_cli_process() {
        let (_directory, path) = executable("printf '%s' \"$$\" > \"$0.pid\"\nexec sleep 10");
        let marker = path.with_extension("pid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake command did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let result =
                    unsafe { libc::waitpid(process_id, std::ptr::null_mut(), libc::WNOHANG) };
                if result == process_id
                    || (result == -1
                        && std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD))
                {
                    break;
                }
                assert_eq!(result, 0);
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(-process_id, libc::SIGKILL) };
            unsafe { libc::waitpid(process_id, std::ptr::null_mut(), 0) };
        }
        assert!(exited.is_ok(), "aborted command left the child running");
    }

    #[tokio::test]
    async fn aborting_the_read_kills_descendants() {
        let (_directory, path) =
            executable("sleep 10 &\nprintf '%s' \"$!\" > \"$0.childpid\"\nwait");
        let marker = path.with_extension("childpid");
        let reader = tokio::spawn(async move { run(&path, &[], Duration::from_secs(5)).await });
        let process_id = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Ok(process_id) = fs::read_to_string(&marker) {
                    if let Ok(process_id) = process_id.parse::<i32>() {
                        break process_id;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("descendant did not start");

        reader.abort();
        assert!(reader.await.unwrap_err().is_cancelled());
        let exited = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if unsafe { libc::kill(process_id, 0) } == -1
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        if exited.is_err() {
            unsafe { libc::kill(process_id, libc::SIGKILL) };
        }
        assert!(exited.is_ok(), "aborted command left a descendant running");
    }
}
