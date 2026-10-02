//! Files and commands for a plugin agent, in the one directory its owner chose.
//!
//! A plugin agent runs in the WebView, which has no filesystem and no shell. The
//! agent's saved `workspace` is the grant. File calls are confined to it. `exec`
//! only starts there: a shell reaches whatever the owner's account can, as a
//! harness agent's process does. Neither is a sandbox, and any enabled plugin can
//! call these for any enabled plugin agent that has a workspace.
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::{run, AgentHost};
use crate::host_request::HostStreams;

const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_COMMAND_BYTES: usize = 64 * 1024;
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
/// Longest a command may run, and the deadline when the caller names none.
const EXEC_DEADLINE: Duration = Duration::from_secs(30 * 60);

const OUTSIDE: &str = "Path is outside the agent's workspace";

async fn root(state: &AgentHost, id: String) -> Result<PathBuf, String> {
    run(state.clone(), move |host| {
        host.controller.plugin_workspace(&id)
    })
    .await
}

async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "Workspace operation failed")?
}

/// `path` inside the canonical `root`, with `..` and symlinks resolved. A path that
/// does not exist yet is checked through its nearest existing ancestor. A process
/// that swaps a directory for a symlink between this check and the use can still
/// escape; the owner's own account is not the adversary here.
fn resolve(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for part in root.join(path).components() {
        match part {
            Component::ParentDir => {
                clean.pop();
            }
            Component::CurDir => {}
            part => clean.push(part),
        }
    }
    let mut missing = Vec::new();
    let mut existing = clean.as_path();
    let real = loop {
        match std::fs::canonicalize(existing) {
            Ok(real) => break real,
            // A dangling symlink would be created through, wherever it points.
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && existing.symlink_metadata().is_err() =>
            {
                missing.push(existing.file_name().ok_or(OUTSIDE)?);
                existing = existing.parent().ok_or(OUTSIDE)?;
            }
            Err(_) => return Err("Path is unavailable".into()),
        }
    };
    if !real.starts_with(root) {
        return Err(OUTSIDE.into());
    }
    Ok(missing
        .iter()
        .rev()
        .fold(real, |path, part| path.join(part)))
}

fn read(root: &Path, path: &str) -> Result<String, String> {
    let file = resolve(root, path)?;
    let metadata = std::fs::metadata(&file).map_err(|_| "File not found")?;
    if !metadata.is_file() {
        return Err("Not a file".into());
    }
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err("File is larger than 8 MiB".into());
    }
    String::from_utf8(std::fs::read(&file).map_err(|_| "File could not be read")?)
        .map_err(|_| "File is not UTF-8 text".into())
}

fn write(root: &Path, path: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_FILE_BYTES {
        return Err("Content is larger than 8 MiB".into());
    }
    let file = resolve(root, path)?;
    if file.is_dir() {
        return Err("Path is a directory".into());
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Folder could not be created")?;
    }
    std::fs::write(&file, content).map_err(|_| "File could not be written".into())
}

#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct Entry {
    name: String,
    directory: bool,
}

fn list(root: &Path, path: &str) -> Result<Vec<Entry>, String> {
    let directory = resolve(root, path)?;
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory).map_err(|_| "Not a directory")? {
        let entry = entry.map_err(|_| "Folder could not be read")?;
        if entries.len() == MAX_ENTRIES {
            return Err("Folder has more than 10,000 entries".into());
        }
        entries.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            // Follows a symlink, so a linked folder lists as a folder.
            directory: entry.path().is_dir(),
        });
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

#[tauri::command]
pub(crate) async fn agent_workspace_read(
    state: tauri::State<'_, AgentHost>,
    id: String,
    path: String,
) -> Result<String, String> {
    let root = root(state.inner(), id).await?;
    blocking(move || read(&root, &path)).await
}

#[tauri::command]
pub(crate) async fn agent_workspace_write(
    state: tauri::State<'_, AgentHost>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let root = root(state.inner(), id).await?;
    blocking(move || write(&root, &path, &content)).await
}

#[tauri::command]
pub(crate) async fn agent_workspace_list(
    state: tauri::State<'_, AgentHost>,
    id: String,
    path: String,
) -> Result<Vec<Entry>, String> {
    let root = root(state.inner(), id).await?;
    blocking(move || list(&root, &path)).await
}

/// Output text in arrival order, then exactly one `Exit` or `Error`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum ExecEvent {
    Output {
        text: String,
    },
    /// `code` is absent when a signal ended the command.
    Exit {
        code: Option<i32>,
    },
    Error {
        message: String,
    },
}

/// Runs `command` with bash in the agent's workspace and streams stdout and stderr,
/// merged, over `on_event`. Rejects only before the command starts; afterwards the
/// outcome is the final event. Stops at `timeout_ms`, at 30 minutes, past 8 MiB of
/// output, when `exec_id` is cancelled, or when nothing is listening.
#[tauri::command]
pub(crate) async fn agent_workspace_exec(
    state: tauri::State<'_, AgentHost>,
    streams: tauri::State<'_, HostStreams>,
    id: String,
    exec_id: String,
    command: String,
    timeout_ms: Option<u64>,
    on_event: tauri::ipc::Channel<ExecEvent>,
) -> Result<(), String> {
    if command.is_empty() || command.len() > MAX_COMMAND_BYTES {
        return Err("Invalid command".into());
    }
    let root = root(state.inner(), id).await?;
    let streams = streams.inner().clone();
    let cancelled = streams.open(&exec_id)?;
    let deadline = timeout_ms
        .map(Duration::from_millis)
        .map_or(EXEC_DEADLINE, |timeout| timeout.min(EXEC_DEADLINE));
    let emit = |event| on_event.send(event).is_ok();
    let outcome = exec(&root, &command, deadline, cancelled, &emit).await;
    streams.close(&exec_id);
    emit(match outcome {
        Ok(code) => ExecEvent::Exit { code },
        Err(message) => ExecEvent::Error { message },
    });
    Ok(())
}

/// Stops a command started by `agent_workspace_exec`. Unknown and finished ids are ignored.
#[tauri::command]
pub(crate) fn agent_workspace_exec_cancel(streams: tauri::State<'_, HostStreams>, exec_id: String) {
    if let Some(cancel) = streams.close(&exec_id) {
        let _ = cancel.send(());
    }
}

#[cfg(not(unix))]
async fn exec(
    _root: &Path,
    _command: &str,
    _deadline: Duration,
    _cancelled: tokio::sync::oneshot::Receiver<()>,
    _emit: &impl Fn(ExecEvent) -> bool,
) -> Result<Option<i32>, String> {
    Err("Commands need macOS or Linux".into())
}

#[cfg(unix)]
async fn exec(
    root: &Path,
    command: &str,
    deadline: Duration,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
    emit: &impl Fn(ExecEvent) -> bool,
) -> Result<Option<i32>, String> {
    use crate::host_command::{effective_path, ProcessGroupGuard};
    use tokio::io::AsyncReadExt as _;

    let mut shell = tokio::process::Command::new("/bin/bash");
    shell
        // One pipe keeps stdout and stderr in the order the command wrote them.
        .args(["-c", &format!("exec 2>&1\n{command}")])
        .current_dir(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let path = effective_path();
    if !path.is_empty() {
        shell.env("PATH", path);
    }
    shell.process_group(0);
    let mut child = shell.spawn().map_err(|_| "Command could not start")?;
    let mut group = ProcessGroupGuard {
        process_id: child.id().ok_or("Command could not start")? as i32,
        armed: true,
    };
    let mut stdout = child.stdout.take().ok_or("Command could not start")?;
    let finished = async {
        let mut pending = Vec::new();
        let mut buffer = vec![0; 16 * 1024];
        let mut total = 0;
        loop {
            let read = stdout
                .read(&mut buffer)
                .await
                .map_err(|_| "Command output failed")?;
            if read == 0 {
                break;
            }
            total += read;
            if total > MAX_OUTPUT_BYTES {
                return Err("Command output is larger than 8 MiB".to_owned());
            }
            let text = decode(&mut pending, &buffer[..read]);
            if !text.is_empty() && !emit(ExecEvent::Output { text }) {
                return Err("Command output has no reader".into());
            }
        }
        if !pending.is_empty() {
            emit(ExecEvent::Output {
                text: String::from_utf8_lossy(&pending).into_owned(),
            });
        }
        let status = child.wait().await.map_err(|_| "Command failed")?;
        Ok(status.code())
    };
    let outcome = tokio::select! {
        outcome = tokio::time::timeout(deadline, finished) => {
            outcome.unwrap_or_else(|_| Err("Command timed out".into()))
        }
        _ = &mut cancelled => Err("Command was cancelled".into()),
    };
    if outcome.is_err() {
        group.kill();
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    // A command that exited keeps what it deliberately left running in the background.
    group.armed = false;
    outcome
}

/// Appends `chunk` and takes its text, replacing invalid bytes and keeping a
/// character split across chunks for the next call.
#[cfg(unix)]
fn decode(pending: &mut Vec<u8>, chunk: &[u8]) -> String {
    pending.extend_from_slice(chunk);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(valid) => {
                text.push_str(valid);
                pending.clear();
                return text;
            }
            Err(error) => {
                let (valid, rest) = pending.split_at(error.valid_up_to());
                text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                let Some(invalid) = error.error_len() else {
                    *pending = rest.to_vec();
                    return text;
                };
                text.push(char::REPLACEMENT_CHARACTER);
                *pending = rest[invalid..].to_vec();
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("work");
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        (directory, root)
    }

    #[test]
    fn file_calls_stay_inside_the_workspace() {
        let (directory, root) = workspace();
        std::fs::write(directory.path().join("secret"), "outside").unwrap();
        std::os::unix::fs::symlink(directory.path(), root.join("up")).unwrap();
        std::os::unix::fs::symlink(directory.path().join("absent"), root.join("dangling")).unwrap();

        write(&root, "src/deep/a.txt", "one").unwrap();
        assert_eq!(read(&root, "src/deep/../deep/a.txt").unwrap(), "one");
        assert_eq!(
            read(&root, root.join("src/deep/a.txt").to_str().unwrap()).unwrap(),
            "one"
        );
        assert_eq!(
            list(&root, "src").unwrap(),
            [Entry {
                name: "deep".into(),
                directory: true
            }]
        );
        for path in [
            "../secret",
            "src/../../secret",
            "up/secret",
            directory.path().join("secret").to_str().unwrap(),
        ] {
            assert_eq!(read(&root, path).unwrap_err(), OUTSIDE, "{path}");
        }
        for path in ["../new", "up/new", "/tmp/buzz-agent-workspace-test"] {
            assert_eq!(write(&root, path, "x").unwrap_err(), OUTSIDE, "{path}");
        }
        assert_eq!(
            write(&root, "dangling", "x").unwrap_err(),
            "Path is unavailable"
        );
        assert!(!directory.path().join("absent").exists());
        assert!(!directory.path().join("new").exists());
        assert_eq!(list(&root, "..").unwrap_err(), OUTSIDE);
    }

    #[test]
    fn reads_refuse_folders_and_binary_files() {
        let (_directory, root) = workspace();
        std::fs::write(root.join("blob"), [0xff, 0xfe]).unwrap();
        assert_eq!(read(&root, ".").unwrap_err(), "Not a file");
        assert_eq!(read(&root, "absent").unwrap_err(), "File not found");
        assert_eq!(read(&root, "blob").unwrap_err(), "File is not UTF-8 text");
        assert_eq!(write(&root, ".", "x").unwrap_err(), "Path is a directory");
        assert_eq!(list(&root, "blob").unwrap_err(), "Not a directory");
    }

    async fn run_exec(
        root: &Path,
        command: &str,
        deadline: Duration,
    ) -> (Result<Option<i32>, String>, String) {
        let output = Mutex::new(String::new());
        let (_cancel, cancelled) = tokio::sync::oneshot::channel();
        let emit = |event| {
            if let ExecEvent::Output { text } = event {
                output.lock().unwrap().push_str(&text);
            }
            true
        };
        let outcome = exec(root, command, deadline, cancelled, &emit).await;
        (outcome, output.into_inner().unwrap())
    }

    #[tokio::test]
    async fn exec_runs_in_the_workspace_and_merges_output_in_order() {
        let (_directory, root) = workspace();
        let (outcome, output) = run_exec(
            &root,
            "pwd; echo problem >&2; printf 'caf\\303\\251 \\377'; exit 3",
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(outcome, Ok(Some(3)));
        assert_eq!(
            output,
            format!("{}\nproblem\ncafé \u{fffd}", root.display())
        );
    }

    #[tokio::test]
    async fn exec_kills_the_process_group_at_the_deadline() {
        let (_directory, root) = workspace();
        let (outcome, output) = run_exec(
            &root,
            "echo started; (sleep 30; touch late) & sleep 30",
            Duration::from_millis(500),
        )
        .await;
        assert_eq!(outcome, Err("Command timed out".into()));
        assert_eq!(output, "started\n");
        let survivors = std::process::Command::new("/usr/bin/pgrep")
            .args(["-f", "sleep 30; touch late"])
            .output()
            .unwrap();
        assert!(survivors.stdout.is_empty());
    }

    #[tokio::test]
    async fn exec_stops_when_cancelled() {
        let (_directory, root) = workspace();
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        let started = std::time::Instant::now();
        let emit = |_| true;
        let running = exec(&root, "sleep 30", Duration::from_secs(60), cancelled, &emit);
        let stop = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.send(()).unwrap();
        };
        let (outcome, ()) = tokio::join!(running, stop);
        assert_eq!(outcome, Err("Command was cancelled".into()));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn decode_keeps_a_character_split_across_chunks() {
        let mut pending = Vec::new();
        assert_eq!(decode(&mut pending, &[b'a', 0xc3]), "a");
        assert_eq!(decode(&mut pending, &[0xa9, 0xff, b'b']), "é\u{fffd}b");
        assert!(pending.is_empty());
    }
}
