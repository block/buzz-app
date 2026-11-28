//! Restarts Buzz after an update installs or a sign-out commits, and opens
//! the copy that was just moved into `/Applications`.
//!
//! Tauri's restart opens the next instance while this one is still exiting. The
//! macOS Dock then shows that instance in a tile of its own beside the pinned
//! one, which stays in its recent apps once it quits: another Buzz icon for
//! every restart. On macOS the next instance therefore opens only after this
//! process has exited. A move to `/Applications` waits the same way, then
//! detaches the disk image the moved copy ran from.

/// Exits through the usual teardown, then opens Buzz again.
pub(crate) fn request<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    #[cfg(target_os = "macos")]
    if macos::bundle().is_some() {
        macos::PENDING.store(true, std::sync::atomic::Ordering::Relaxed);
        app.exit(0);
        return;
    }
    app.request_restart();
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{on_exit, open_after_exit};

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::OsString;
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::Manager;

    pub(super) static PENDING: AtomicBool = AtomicBool::new(false);

    const OPEN: &str = "/usr/bin/open";
    const HDIUTIL: &str = "/usr/bin/hdiutil";

    /// The app bundle this process was started from, as Tauri's restart uses it.
    pub(super) fn bundle() -> Option<PathBuf> {
        if !crate::dock::bundled() {
            return None;
        }
        let executable = tauri::utils::platform::current_exe().ok()?;
        executable.ancestors().nth(3).map(Path::to_path_buf)
    }

    /// On `RunEvent::Exit`, after teardown: hands a requested relaunch to a
    /// process that outlives this one, or restarts as Tauri does if it can't.
    pub(crate) fn on_exit<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        if !PENDING.load(Ordering::Relaxed) {
            return;
        }
        let env = app.env();
        let spawned = bundle()
            .ok_or_else(|| "Buzz is not running from an app bundle".to_string())
            .and_then(|bundle| {
                relauncher(
                    Path::new(OPEN),
                    Path::new(HDIUTIL),
                    std::process::id(),
                    &bundle,
                    env.args_os.iter().skip(1),
                    None,
                )
                .spawn()
                .map_err(|error| error.to_string())
            });
        if let Err(error) = spawned {
            eprintln!("Could not relaunch Buzz after it exits: {error}");
            tauri::process::restart(&env);
        }
    }

    /// Once this process has exited, opens `bundle` as a new instance, then
    /// detaches the disk image mounted at `detach_mount`, if one is given.
    pub(crate) fn open_after_exit(
        bundle: &Path,
        detach_mount: Option<&Path>,
    ) -> std::io::Result<()> {
        relauncher(
            Path::new(OPEN),
            Path::new(HDIUTIL),
            std::process::id(),
            bundle,
            std::iter::empty(),
            detach_mount,
        )
        .spawn()?;
        Ok(())
    }

    /// Waits for `pid` to exit, then runs `open -n <bundle> --args <args>`,
    /// detached from this process's stdio and process group. With a
    /// `detach_mount` it runs `hdiutil detach <detach_mount>` a second after
    /// `open` returns, whatever `open` returned.
    ///
    /// Every path is a positional argument of the script, never part of its
    /// text, so no name can be read as shell syntax.
    fn relauncher<'a>(
        open: &Path,
        hdiutil: &Path,
        pid: u32,
        bundle: &Path,
        args: impl IntoIterator<Item = &'a OsString>,
        detach_mount: Option<&Path>,
    ) -> Command {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(
                r#"pid=$1; hdiutil=$2; mount=$3; shift 3
while /bin/kill -0 "$pid" 2>/dev/null; do /bin/sleep 0.1; done
[ -n "$mount" ] || exec "$@"
"$@"
/bin/sleep 1
exec "$hdiutil" detach "$mount""#,
            )
            .arg("sh")
            .arg(pid.to_string())
            .arg(hdiutil)
            .arg(detach_mount.unwrap_or(Path::new("")))
            .arg(open)
            .arg("-n")
            .arg(bundle)
            .arg("--args")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        command
    }

    #[cfg(test)]
    mod tests {
        use super::relauncher;
        use std::ffi::OsString;
        use std::path::Path;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        /// Runs the relauncher against a process that exits only once the
        /// relauncher is waiting for it. Returns what the stand-ins for `open`
        /// and `hdiutil` recorded, in the order they ran: whether the old
        /// process was still running, the stand-in's name, and each argument
        /// it was given, one per line.
        fn relaunch(bundle: &str, detach_mount: Option<&str>) -> String {
            let dir = tempfile::tempdir().unwrap();
            let record = dir.path().join("record");
            let tool = |name: &str| {
                let path = dir.path().join(name);
                std::fs::write(
                    &path,
                    format!(
                        "#!/bin/sh\nif /bin/kill -0 \"$OLD\" 2>/dev/null; then s=running; else s=exited; fi\nprintf '%s\\n' \"$s\" \"${{0##*/}}\" \"$@\" >> '{}'\n",
                        record.display()
                    ),
                )
                .unwrap();
                std::fs::set_permissions(
                    &path,
                    std::os::unix::fs::PermissionsExt::from_mode(0o755),
                )
                .unwrap();
                path
            };
            let (open, hdiutil) = (tool("open"), tool("hdiutil"));
            let mut old = Command::new("/bin/sleep")
                .arg("30")
                .stdout(Stdio::null())
                .spawn()
                .unwrap();
            let args = [OsString::from("--flag"), OsString::from("two words")];

            let mut command = relauncher(
                &open,
                &hdiutil,
                old.id(),
                bundle.as_ref(),
                &args,
                detach_mount.map(Path::new),
            );
            let mut waiter = command.env("OLD", old.id().to_string()).spawn().unwrap();
            // Exit the old process only once the relauncher is polling it (its
            // `sleep` child is running) or has already finished without waiting.
            let deadline = Instant::now() + Duration::from_secs(10);
            let waiter_pid = waiter.id().to_string();
            let polling = || {
                Command::new("/usr/bin/pgrep")
                    .args(["-P", &waiter_pid, "sleep"])
                    .stdout(Stdio::null())
                    .status()
                    .unwrap()
                    .success()
            };
            while !polling() && waiter.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "relauncher never polled");
                std::thread::sleep(Duration::from_millis(20));
            }

            old.kill().unwrap();
            old.wait().unwrap();
            while waiter.try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline, "relauncher never ran");
                std::thread::sleep(Duration::from_millis(20));
            }
            std::fs::read_to_string(&record).unwrap()
        }

        #[test]
        fn opens_the_bundle_only_after_the_process_has_exited() {
            assert_eq!(
                relaunch("/Applications/Buzz.app", None),
                "exited\nopen\n-n\n/Applications/Buzz.app\n--args\n--flag\ntwo words\n"
            );
        }

        #[test]
        fn detaches_the_disk_image_only_after_opening_the_bundle() {
            // A quote in the bundle name and a space in the mount point, as a
            // second mounted image gets: each still arrives as one argument.
            assert_eq!(
                relaunch("/Applications/Buzz's.app", Some("/Volumes/Buzz 1")),
                "exited\nopen\n-n\n/Applications/Buzz's.app\n--args\n--flag\ntwo words\n\
                 exited\nhdiutil\ndetach\n/Volumes/Buzz 1\n"
            );
        }
    }
}
