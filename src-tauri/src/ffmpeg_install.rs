//! Install the media encoder using the host's package manager.
use std::{ffi::OsStr, path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn encoder(path: &OsStr, minimum: u32) -> Option<(PathBuf, u32)> {
    let filename = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidates = std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(filename));
    #[cfg(windows)]
    let candidates = candidates
        .chain(dirs::data_local_dir().map(|dir| dir.join("Microsoft/WinGet/Links/ffmpeg.exe")));
    let mut first = None;
    for program in candidates.filter(|p| p.is_file()) {
        if let Some(major) = version(&program).await {
            if major >= minimum {
                return Some((program, major));
            }
            first.get_or_insert((program, major));
        }
    }
    first
}

pub(crate) async fn program(path: &OsStr, heic: bool) -> PathBuf {
    encoder(path, if heic { 8 } else { 1 })
        .await
        .map(|(program, _)| program)
        .unwrap_or_else(|| crate::host_command::resolve_program("ffmpeg", path))
}

fn command(executable: PathBuf, path: &OsStr) -> Command {
    let mut cmd = Command::new(executable);
    crate::host_process::remove_bundle_environment(&mut cmd);
    crate::host_process::set_host_path(&mut cmd, path);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    cmd
}

async fn version(program: &std::path::Path) -> Option<u32> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        crate::relay::media_preparation::ffmpeg_command(program)
            .arg("-version")
            .stdout(Stdio::piped())
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    std::str::from_utf8(&output.stdout)
        .ok()?
        .strip_prefix("ffmpeg version ")?
        .trim_start_matches('n')
        .split('.')
        .next()?
        .parse()
        .ok()
}

#[tauri::command]
pub(crate) async fn install_ffmpeg(require_version8: bool) -> Result<(), String> {
    // The worker owns the lock even if the invoking window goes away.
    tokio::spawn(async move {
        let _guard = INSTALL.lock().await;
        let path = crate::host_command::effective_path();
        install_with_path(&path, require_version8, std::env::consts::OS).await
    })
    .await
    .map_err(|_| "The installer task stopped unexpectedly.".to_string())?
}

async fn install_with_path(path: &OsStr, require_version8: bool, os: &str) -> Result<(), String> {
    let minimum = if require_version8 { 8 } else { 1 };
    let current = encoder(path, minimum).await.map(|(_, major)| major);
    if current.is_some_and(|v| v >= minimum) {
        return Ok(());
    }
    let (manager, args, missing): (&str, &[&str], &str) = match os {
        "macos" => (
            "brew",
            &["install", "ffmpeg"],
            "Automatic installation requires Homebrew on this Mac.",
        ),
        "windows" => (
            "winget",
            &[
                "install",
                "--id",
                "Gyan.FFmpeg",
                "--exact",
                "--source",
                "winget",
                "--scope",
                "user",
                "--accept-source-agreements",
                "--accept-package-agreements",
                "--disable-interactivity",
            ],
            "Automatic installation requires Windows App Installer.",
        ),
        _ => return Err("Automatic installation is unavailable on this device.".into()),
    };
    let mut installer = command(crate::host_command::resolve_program(manager, path), path);
    #[cfg(test)]
    installer.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    let status = installer.args(args).status().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            missing
        } else {
            "Buzz could not start the package manager."
        }
    })?;
    let installed = encoder(path, minimum).await.map(|(_, major)| major);
    if installed.is_some_and(|v| v >= minimum) {
        return Ok(());
    }
    if !status.success() {
        return Err("Installation didn’t finish. Check your connection and any system approval prompt, then try again.".into());
    }
    Err("The package manager finished, but a compatible FFmpeg is still unavailable.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Run explicitly on a host prepared for acceptance. This may install software.
    #[tokio::test]
    #[ignore = "requires a real host package manager"]
    async fn host_installation() {
        let path = crate::host_command::effective_path();
        assert!(
            encoder(&path, 1).await.is_none(),
            "fresh install requires a host without a usable FFmpeg"
        );
        install_ffmpeg(false).await.expect("install FFmpeg");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("voice-note.m4a");
        let status = crate::relay::media_preparation::ffmpeg_command(&program(&path, false).await)
            .args([
                "-nostdin", "-f", "lavfi", "-i", "anullsrc", "-t", "0.1", "-c:a", "aac",
            ])
            .arg(&output)
            .status()
            .await
            .expect("start recovered encoder");
        assert!(
            status.success() && output.metadata().unwrap().len() > 0,
            "encode a voice note after installation"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn older_unmanaged_ffmpeg_is_replaced_and_rechecked() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let write = |name: &str, body: &str| {
            let file = directory.path().join(name);
            std::fs::write(&file, body).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
        };
        let path = directory.path().as_os_str();
        write("ffmpeg", "#!/bin/sh\necho 'ffmpeg version 7.0'\n");
        let newer = tempfile::tempdir().unwrap();
        let compatible = newer.path().join("ffmpeg");
        crate::test_executable::write_executable(
            &compatible,
            "#!/bin/sh\necho 'ffmpeg version 8.0'\n",
        );
        let multiple = std::env::join_paths([directory.path(), newer.path()]).unwrap();
        assert_eq!(program(&multiple, true).await, compatible);
        assert_eq!(
            program(&multiple, false).await,
            directory.path().join("ffmpeg")
        );
        write(
            "winget",
            r##"#!/bin/sh
[ "$1" = install ] || exit 1
echo "#!/bin/sh" > "$PATH/ffmpeg"
echo "echo ffmpeg version 8.0" >> "$PATH/ffmpeg"
"##,
        );
        install_with_path(path, true, "windows").await.unwrap();
        assert_eq!(encoder(path, 8).await.map(|(_, major)| major), Some(8));
    }
}
