//! Machine tool discovery is independent of the managed agent's environment.
use crate::Result;
#[cfg(unix)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) fn tools_path() -> Result<OsString> {
    #[cfg(windows)]
    return Ok(std::env::var_os("PATH").unwrap_or_default());
    #[cfg(unix)]
    {
        // Desktop discovery asks for several tools per refresh. Run startup files
        // once per host process, not once per candidate executable.
        static LOGIN_PATH: std::sync::OnceLock<Option<OsString>> = std::sync::OnceLock::new();
        let shell =
            LOGIN_PATH.get_or_init(|| login_path(&shell(), std::time::Duration::from_secs(2)));
        let inherited = std::env::var_os("PATH");
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let local = home
            .filter(|h| h.is_absolute())
            .map(|h| h.join(".local/bin"));
        compose(
            local
                .into_iter()
                .chain(shell.iter().flat_map(std::env::split_paths))
                .chain(inherited.iter().flat_map(std::env::split_paths))
                .chain(
                    ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from),
                ),
        )
    }
}

/// Keep caller-owned bundle/runtime entries first; never interpret an empty or
/// relative tool directory against an agent's workspace.
pub(crate) fn compose(dirs: impl IntoIterator<Item = PathBuf>) -> Result<OsString> {
    let mut paths = Vec::new();
    for dir in dirs {
        if dir.is_absolute() && !paths.contains(&dir) {
            paths.push(dir);
        }
    }
    std::env::join_paths(paths).map_err(|_| "Invalid runtime tools path".into())
}

#[cfg(unix)]
fn shell() -> PathBuf {
    std::env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && super::executable(p).is_ok())
        .or_else(passwd_shell)
        .unwrap_or_else(|| "/bin/sh".into())
}

#[cfg(unix)]
fn passwd_shell() -> Option<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = vec![0u8; 16 * 1024];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    // SAFETY: writable entry/buffer/result; copy the returned buffer-backed path
    // before the buffer goes away. Reentrant lookup permits concurrent launches.
    unsafe {
        if libc::getpwuid_r(
            libc::getuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
        {
            return None;
        }
        let ptr = (*result).pw_shell;
        if ptr.is_null() {
            return None;
        }
        let path = PathBuf::from(OsStr::from_bytes(CStr::from_ptr(ptr).to_bytes()));
        (path.is_absolute() && super::executable(&path).is_ok()).then_some(path)
    }
}

#[cfg(unix)]
fn login_path(shell: &std::path::Path, timeout: std::time::Duration) -> Option<OsString> {
    use std::io::{Read, Seek, SeekFrom};
    use std::os::unix::{ffi::OsStringExt, process::CommandExt};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    // Rc files can emit banners or retain stdout in helpers. A bounded private
    // file avoids pipe readers surviving the probe. Only the framed PATH is used;
    // shell-exported credentials never become the launch environment.
    let mut output = tempfile::tempfile().ok()?;
    let mut probe = Command::new(shell);
    probe
        .args([
            "-ilc",
            "printf '\\0BUZZ_TOOL_PATH\\0'; /usr/bin/printenv PATH; printf '\\0'",
        ])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        .env("SHELL", shell)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(output.try_clone().ok()?)
        .stderr(Stdio::null())
        .process_group(0);
    for key in [
        "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            probe.env(key, value);
        }
    }
    if let Some(home) = std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|h| h.is_absolute() && h.is_dir())
    {
        probe.current_dir(home);
    }
    let mut child = probe.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    let success = loop {
        if output.metadata().map_or(true, |m| m.len() > 64 * 1024) {
            break false;
        }
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Err(_) => break false,
            Ok(None) if Instant::now() >= deadline => break false,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    // Retire the shell's helper group on success as well as timeout.
    // SAFETY: process_group(0) made the spawned child its group leader.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
    if !success {
        return None;
    }
    output.seek(SeekFrom::Start(0)).ok()?;
    let mut bytes = Vec::new();
    output.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 64 * 1024 {
        return None;
    }
    let marker = b"\0BUZZ_TOOL_PATH\0";
    let start = bytes.windows(marker.len()).rposition(|w| w == marker)? + marker.len();
    let mut length = bytes[start..].iter().position(|b| *b == 0)?;
    // printenv preserves the shell's exported PATH (including fish's list form)
    // and adds one newline; do not trim whitespace in directory names.
    if length > 0 && bytes[start + length - 1] == b'\n' {
        length -= 1;
    }
    (length > 0).then(|| OsString::from_vec(bytes[start..start + length].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn composition_keeps_priority_and_ignores_workspace_relative_entries() {
        let root = tempfile::tempdir().unwrap();
        let bundle = root.path().join("bundle");
        let installed = root.path().join("tool manager/bin");
        let result = compose([
            bundle.clone(),
            installed.clone(),
            PathBuf::new(),
            "relative/bin".into(),
            bundle.clone(),
        ])
        .unwrap();
        assert_eq!(
            std::env::split_paths(&result).collect::<Vec<_>>(),
            [bundle, installed]
        );
    }
    #[test]
    #[cfg(unix)]
    fn login_probe_ignores_banners_and_bounds_failed_shells() {
        use std::time::Duration;
        let root = tempfile::tempdir().unwrap();
        let shell = root.path().join("shell");
        for (script, expected) in [
            (
                "#!/bin/sh\nprintf 'welcome\\n\\0BUZZ_TOOL_PATH\\0/custom/bin:/usr/bin\\0bye\\n'",
                Some("/custom/bin:/usr/bin"),
            ),
            ("#!/bin/sh\nexit 1", None),
            ("#!/bin/sh\nprintf 'no framed path'", None),
            ("#!/bin/sh\nprintf '\\0BUZZ_TOOL_PATH\\0\\0'", None),
            ("#!/bin/sh\n/bin/sleep 10", None),
            ("#!/bin/sh\n/usr/bin/head -c 70000 /dev/zero", None),
        ] {
            crate::test_executable::write_executable(&shell, script);
            assert_eq!(
                login_path(&shell, Duration::from_millis(100)).as_deref(),
                expected.map(OsStr::new)
            );
        }
        assert!(login_path(&root.path().join("missing"), Duration::from_millis(100)).is_none());
    }
}
