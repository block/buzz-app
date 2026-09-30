//! Bounded conversion of uploaded HEIC and video bytes. No paths or ffmpeg
//! arguments are accepted from the webview; the result is uploaded by relay.rs.
use std::sync::OnceLock;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    process::Command,
    sync::{oneshot, Semaphore},
};

static SLOTS: OnceLock<Semaphore> = OnceLock::new();

const MAX_INPUT: usize = 500 * 1024 * 1024;
const MAX_IMAGE: u64 = 50 * 1024 * 1024;
const MAX_VIDEO: u64 = 500 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PreparationError {
    Size,
    Capacity,
    Ffmpeg,
    Image,
    Video,
    Io,
    Cancelled,
}

impl PreparationError {
    pub(super) fn code(&self) -> &'static str {
        match self {
            Self::Size => "size",
            Self::Capacity => "capacity",
            Self::Ffmpeg => "ffmpeg",
            Self::Image => "image",
            Self::Video => "video",
            Self::Io => "io",
            Self::Cancelled => "cancelled",
        }
    }

    pub(super) fn status(&self) -> u16 {
        match self {
            Self::Size => 413,
            Self::Capacity => 429,
            Self::Ffmpeg => 503,
            _ => 400,
        }
    }
}

// The frontend owns container recognition. The host accepts only this fixed
// mode table, never paths, URLs or caller-provided ffmpeg arguments. ffmpeg's
// fixed demuxer validates the actual input; header sniffing is not a sandbox.
fn allowed_mode(mode: &str, size: usize) -> Option<(&'static str, bool, bool)> {
    let result = match mode {
        "image:mov" => ("mov", true, false),
        "video:mov" => ("mov", false, false),
        "video:avi" => ("avi", false, false),
        "video:matroska" => ("matroska", false, false),
        "video:flv" => ("flv", false, false),
        "video:asf" => ("asf", false, false),
        "video:mpeg" => ("mpeg", false, false),
        "video:m4v" => ("m4v", false, false),
        "video:mpegvideo" => ("mpegvideo", false, false),
        "voice:wav" => ("wav", false, true),
        "voice:flac" => ("flac", false, true),
        "voice:ogg" => ("ogg", false, true),
        "voice:aiff" => ("aiff", false, true),
        "voice:mp3" => ("mp3", false, true),
        "voice:aac" => ("aac", false, true),
        "voice:amr" => ("amr", false, true),
        "voice:mov" => ("mov", false, true),
        _ => return None,
    };
    if result.2 && size > 128 * 1024 * 1024 {
        return None;
    }
    Some(result)
}

fn spawn_conversion(cmd: &mut Command) -> Result<tokio::process::Child, PreparationError> {
    cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            PreparationError::Ffmpeg
        } else {
            PreparationError::Io
        }
    })
}

async fn wait_for_conversion(
    mut child: tokio::process::Child,
    output: &Path,
    image: bool,
    cancelled: &mut oneshot::Receiver<()>,
    timeout: Duration,
    limit: u64,
) -> Result<(), PreparationError> {
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut monitor = tokio::time::interval(Duration::from_millis(250));
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|_| PreparationError::Io),
            _ = &mut *cancelled => { child.kill().await.ok(); return Err(PreparationError::Cancelled); },
            _ = &mut deadline => { child.kill().await.ok(); return Err(if image { PreparationError::Image } else { PreparationError::Video }); },
            _ = monitor.tick() => if output_size(output, limit).is_err() { child.kill().await.ok(); return Err(PreparationError::Size); },
        }
    }?;
    if status.success() {
        Ok(())
    } else {
        Err(if image {
            PreparationError::Image
        } else {
            PreparationError::Video
        })
    }
}

fn output_size(path: &Path, limit: u64) -> Result<(), &'static str> {
    if path.metadata().is_ok_and(|meta| meta.len() > limit) {
        Err("size")
    } else {
        Ok(())
    }
}

fn private_tempdir_in(parent: &Path) -> std::io::Result<tempfile::TempDir> {
    let mut builder = tempfile::Builder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Set permissions during creation: the source must never become readable
        // through a shared temporary parent, even briefly.
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder.tempdir_in(parent)
}

pub(super) async fn prepare(
    body: Vec<u8>,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(Vec<u8>, &'static str), PreparationError> {
    if body.is_empty() || body.len() > MAX_INPUT {
        return Err(PreparationError::Size);
    }
    let (demuxer, image, voice) =
        allowed_mode(mode, body.len()).ok_or(if mode.starts_with("image:") {
            PreparationError::Image
        } else {
            PreparationError::Video
        })?;
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    let _slot = SLOTS
        .get_or_init(|| Semaphore::new(2))
        .try_acquire()
        .map_err(|_| PreparationError::Capacity)?;
    let directory = private_tempdir_in(&std::env::temp_dir()).map_err(|_| PreparationError::Io)?;
    let source = directory.path().join("source");
    let output = directory.path().join(if image {
        "prepared.jpg"
    } else {
        "prepared.mp4"
    });
    // File writes can be large; keep the async executor responsive.
    tokio::task::spawn_blocking(move || std::fs::write(source, body))
        .await
        .map_err(|_| PreparationError::Io)?
        .map_err(|_| PreparationError::Io)?;
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    let path = crate::host_command::effective_path();
    let mut cmd = Command::new(crate::host_command::resolve_program("ffmpeg", &path));
    cmd.args(["-y", "-nostdin", "-loglevel", "error"]);
    if voice {
        cmd.args(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1"]);
    }
    cmd.args(["-protocol_whitelist", "file,pipe", "-f", demuxer]);
    if demuxer == "mov" {
        cmd.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    cmd.arg("-i").arg(directory.path().join("source"));
    if image {
        // Automatic selection assembles HEIC tile grids. Mapping 0:v:0
        // selects the first tile and silently crops the image.
        cmd.args([
            "-map_metadata",
            "-1",
            "-frames:v",
            "1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-q:v",
            "2",
        ]);
    } else {
        cmd.args([
            "-map",
            "0:v:0",
            "-map",
            if voice { "1:a:0" } else { "0:a:0?" },
        ]);
        if voice {
            cmd.arg("-shortest");
        }
        cmd.args([
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-sn",
            "-dn",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-flags:a",
            "+bitexact",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "pad=ceil(iw/2)*2:ceil(ih/2)*2",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            "-metadata",
            "encoder=",
        ]);
    }
    cmd.arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.env_clear().env("PATH", path).env("LANG", "C");
    #[cfg(windows)]
    cmd.env(
        "SystemRoot",
        std::env::var_os("SystemRoot").unwrap_or_default(),
    );
    #[cfg(windows)]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    cmd.kill_on_drop(true);
    let child = spawn_conversion(&mut cmd)?;
    let limit = if image { MAX_IMAGE } else { MAX_VIDEO };
    wait_for_conversion(
        child,
        &output,
        image,
        cancelled,
        Duration::from_secs(if image { 60 } else { 600 }),
        limit,
    )
    .await?;
    let size = output.metadata().map_err(|_| PreparationError::Io)?.len();
    if size == 0 || size > limit {
        return Err(PreparationError::Size);
    }
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(output))
        .await
        .map_err(|_| PreparationError::Io)?
        .map_err(|_| PreparationError::Io)?;
    if bytes.len() as u64 != size {
        return Err(PreparationError::Io);
    }
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    Ok((bytes, if image { "image/jpeg" } else { "video/mp4" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    static CONVERSIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[cfg(unix)]
    #[test]
    fn preparation_source_stays_private_under_a_shared_temp_parent() {
        use std::os::unix::fs::PermissionsExt;

        let parent = tempfile::tempdir().unwrap();
        std::fs::set_permissions(parent.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let directory = private_tempdir_in(parent.path()).unwrap();
        let source = directory.path().join("source");
        std::fs::write(&source, b"private original media").unwrap();
        let mode = directory.path().metadata().unwrap().permissions().mode();
        assert_eq!(
            mode & 0o077,
            0,
            "other users must not traverse the directory"
        );
        assert_ne!(mode & 0o700, 0, "the owner must retain access");
        assert!(source.exists());
    }
    #[tokio::test]
    #[cfg_attr(windows, ignore = "requires ffmpeg; Windows CI does not provision it")]
    async fn converts_video_with_fixed_demuxer_and_strips_input_metadata() {
        let _guard = CONVERSIONS.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.avi");
        let generated = std::process::Command::new("ffmpeg")
            .args([
                "-y",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=16x16:r=1",
                "-t",
                "1",
                "-metadata",
                "comment=private",
                "-c:v",
                "mpeg4",
            ])
            .arg(&input)
            .status();
        assert!(generated
            .expect("conversion tests require ffmpeg on PATH")
            .success());
        let bytes = std::fs::read(input).unwrap();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "video:avi", &mut cancelled).await.unwrap();
        assert_eq!(mime, "video/mp4");
        assert!(prepared.windows(4).any(|chunk| chunk == b"ftyp"));
        assert!(!prepared.windows(7).any(|chunk| chunk == b"private"));
    }

    #[tokio::test]
    #[cfg_attr(windows, ignore = "requires ffmpeg; Windows CI does not provision it")]
    async fn converts_legacy_mov_with_leading_free_box() {
        let _guard = CONVERSIONS.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.mov");
        let generated = std::process::Command::new(crate::host_command::resolve_program(
            "ffmpeg",
            &crate::host_command::effective_path(),
        ))
        .args([
            "-y",
            "-nostdin",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=16x16:r=1",
            "-t",
            "1",
            "-c:v",
            "mpeg4",
        ])
        .arg(&input)
        .status();
        assert!(generated
            .expect("conversion tests require ffmpeg on PATH")
            .success());
        let mut bytes = std::fs::read(input).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        bytes[4..8].copy_from_slice(b"free");
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "video:mov", &mut cancelled).await.unwrap();
        assert_eq!(mime, "video/mp4");
        assert!(prepared.windows(4).any(|chunk| chunk == b"ftyp"));
    }

    #[tokio::test]
    #[cfg_attr(windows, ignore = "requires ffmpeg; Windows CI does not provision it")]
    async fn converts_tiled_heic_without_cropping() {
        let _guard = CONVERSIONS.lock().await;
        let bytes = include_bytes!("../../../tests/fixtures/media/tiled.heic").to_vec();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "image:mov", &mut cancelled).await.unwrap();
        assert_eq!(mime, "image/jpeg");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("prepared.jpg");
        std::fs::write(&output, prepared).unwrap();
        let dimensions = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0",
            ])
            .arg(output)
            .output()
            .expect("conversion tests require ffprobe");
        assert!(dimensions.status.success());
        assert_eq!(
            String::from_utf8(dimensions.stdout).unwrap().trim(),
            "1536,1024"
        );
    }

    #[tokio::test]
    async fn cancelled_input_never_starts_conversion() {
        let (sender, mut cancelled) = oneshot::channel();
        sender.send(()).unwrap();
        assert_eq!(
            prepare(vec![1], "video:avi", &mut cancelled).await,
            Err(PreparationError::Cancelled)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn running_conversion_is_killed_on_cancel_deadline_and_size() {
        for expected in [
            PreparationError::Cancelled,
            PreparationError::Video,
            PreparationError::Size,
        ] {
            let directory = tempfile::tempdir().unwrap();
            let output = directory.path().join("prepared.mp4");
            std::fs::write(&output, [0; 2]).unwrap();
            // exec leaves one child, not a shell-owned descendant. Sleep is the
            // stalled workload, not synchronization or a test timing assertion.
            let mut command = Command::new("/bin/sh");
            command.args(["-c", "exec sleep 60"]).kill_on_drop(true);
            let child = command.spawn().unwrap();
            let pid = child.id().unwrap();
            let (sender, mut cancelled) = oneshot::channel();
            let timeout = if expected == PreparationError::Video {
                Duration::ZERO
            } else {
                Duration::from_secs(60)
            };
            let limit = if expected == PreparationError::Size {
                1
            } else {
                10
            };
            if expected == PreparationError::Cancelled {
                sender.send(()).unwrap();
            }
            assert_eq!(
                wait_for_conversion(child, &output, false, &mut cancelled, timeout, limit).await,
                Err(expected)
            );
            assert!(!std::process::Command::new("/bin/kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success());
        }
    }

    #[tokio::test]
    async fn two_slots_reject_excess_work_and_release_on_drop() {
        let _guard = CONVERSIONS.lock().await;
        let slots = SLOTS.get_or_init(|| Semaphore::new(2));
        let first = slots.try_acquire().unwrap();
        let second = slots.try_acquire().unwrap();
        let (_sender, mut cancelled) = oneshot::channel();
        assert_eq!(
            prepare(vec![1], "video:avi", &mut cancelled).await,
            Err(PreparationError::Capacity)
        );
        drop(first);
        assert!(slots.try_acquire().is_ok());
        drop(second);
        assert_eq!(slots.available_permits(), 2);
    }

    #[test]
    fn missing_ffmpeg_reports_service_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let mut cmd = Command::new(directory.path().join("missing-ffmpeg"));
        let error = spawn_conversion(&mut cmd).unwrap_err();
        assert_eq!(error, PreparationError::Ffmpeg);
        assert_eq!(error.status(), 503);
    }

    #[test]
    fn modes_allow_only_fixed_demuxers_and_bound_voice_input() {
        for demuxer in [
            "mov",
            "avi",
            "matroska",
            "flv",
            "asf",
            "mpeg",
            "m4v",
            "mpegvideo",
        ] {
            assert_eq!(
                allowed_mode(&format!("video:{demuxer}"), 1),
                Some((demuxer, false, false))
            );
        }
        for demuxer in ["mov", "wav", "flac", "ogg", "aiff", "mp3", "aac", "amr"] {
            assert_eq!(
                allowed_mode(&format!("voice:{demuxer}"), 128 * 1024 * 1024),
                Some((demuxer, false, true))
            );
            assert!(allowed_mode(&format!("voice:{demuxer}"), 128 * 1024 * 1024 + 1).is_none());
        }
        assert_eq!(allowed_mode("image:mov", 1), Some(("mov", true, false)));
        for mode in [
            "image:concat",
            "video:concat",
            "voice:concat",
            "video:http",
            "image:avi",
            "mov",
        ] {
            assert!(allowed_mode(mode, 1).is_none());
        }
        assert_eq!(PreparationError::Ffmpeg.status(), 503);
    }
}
