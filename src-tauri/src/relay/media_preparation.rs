//! Bounded conversion of uploaded HEIC, video and animated-avatar WebM bytes.
//! No paths or ffmpeg arguments are accepted from the webview; the result is
//! uploaded by relay.rs.
use std::sync::OnceLock;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{oneshot, Semaphore},
};

static SLOTS: OnceLock<Semaphore> = OnceLock::new();

const MAX_INPUT: usize = 500 * 1024 * 1024;
const MAX_IMAGE: u64 = 50 * 1024 * 1024;
const MAX_VIDEO: u64 = 500 * 1024 * 1024;
const MAX_ANIMATION_INPUT: usize = 64 * 1024 * 1024;
// Below app_agents' MEDIA_LIMIT, so an agent join can copy the animation.
const MAX_ANIMATION: u64 = 3_670_016;
// Viewers keep the animation in the media disk cache.
const _: () = assert!(MAX_ANIMATION as usize <= super::media_cache::ANIMATION_ENTRY_MAX);
// Fit the relay's 3840x2160 envelope in either orientation (Retina screen
// recordings exceed it) at even dimensions, never upscale, then pad the odd
// edges of unscaled input for yuv420p.
const VIDEO_FILTER: &str = "scale=w='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(iw*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,iw)':h='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(ih*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,ih)',pad=ceil(iw/2)*2:ceil(ih/2)*2";
// An animated avatar's VP9-alpha WebM becomes an APNG that keeps transparency:
// 12 fps, within 256x256, never upscaled. Matches video-preparation.ts.
const ANIMATION_FILTER: &str = "fps=12,scale=w='min(256,iw)':h='min(256,ih)':force_original_aspect_ratio=decrease:flags=lanczos,format=rgba";

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
        "animation:matroska" => ("matroska", false, false),
        _ => return None,
    };
    if result.2 && size > 128 * 1024 * 1024 {
        return None;
    }
    if mode == "animation:matroska" && size > MAX_ANIMATION_INPUT {
        return None;
    }
    Some(result)
}

fn ffmpeg_command(program: &Path) -> Command {
    let path = crate::host_command::effective_path();
    let mut cmd = Command::new(program);
    cmd.env_clear().env("PATH", path).env("LANG", "C");
    #[cfg(windows)]
    {
        cmd.env(
            "SystemRoot",
            std::env::var_os("SystemRoot").unwrap_or_default(),
        );
        cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    cmd.stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    cmd
}

fn supports_heic_grids(version: &[u8]) -> bool {
    std::str::from_utf8(version)
        .ok()
        .and_then(|text| text.strip_prefix("ffmpeg version "))
        .and_then(|text| text.strip_prefix('n').unwrap_or(text).split('.').next())
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= 8)
}

async fn require_heic_grid_support(
    cmd: &mut Command,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(), PreparationError> {
    cmd.arg("-version").stdout(Stdio::piped());
    let mut child = spawn_conversion(cmd)?;
    let stdout = child.stdout.take().ok_or(PreparationError::Ffmpeg)?;
    let probe = async {
        let mut version = Vec::new();
        stdout
            .take(4097)
            .read_to_end(&mut version)
            .await
            .map_err(|_| PreparationError::Ffmpeg)?;
        if version.len() > 4096 {
            return Err(PreparationError::Ffmpeg);
        }
        let status = child.wait().await.map_err(|_| PreparationError::Ffmpeg)?;
        if status.success() && supports_heic_grids(&version) {
            Ok(())
        } else {
            Err(PreparationError::Ffmpeg)
        }
    };
    let result = tokio::select! {
        result = probe => result,
        _ = &mut *cancelled => Err(PreparationError::Cancelled),
        _ = tokio::time::sleep(Duration::from_secs(5)) => Err(PreparationError::Ffmpeg),
    };
    if result.is_err() {
        child.kill().await.ok();
    }
    result
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

#[cfg(test)]
use super::upload_spool::private_tempdir_in;

pub(super) async fn prepare_file(
    source: &Path,
    size: usize,
    directory: &Path,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(std::path::PathBuf, &'static str), PreparationError> {
    let path = crate::host_command::effective_path();
    let program = crate::host_command::resolve_program("ffmpeg", &path);
    prepare_file_with_program(source, size, directory, mode, cancelled, &program).await
}

#[cfg(test)]
pub(super) async fn prepare(
    body: Vec<u8>,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(Vec<u8>, &'static str), PreparationError> {
    let program =
        crate::host_command::resolve_program("ffmpeg", &crate::host_command::effective_path());
    prepare_with_program(body, mode, cancelled, &program).await
}

#[cfg(test)]
async fn prepare_with_program(
    body: Vec<u8>,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
    program: &Path,
) -> Result<(Vec<u8>, &'static str), PreparationError> {
    let directory = private_tempdir_in(&std::env::temp_dir()).map_err(|_| PreparationError::Io)?;
    let source = directory.path().join("source");
    std::fs::write(&source, &body).map_err(|_| PreparationError::Io)?;
    let (output, kind) = prepare_file_with_program(
        &source,
        body.len(),
        directory.path(),
        mode,
        cancelled,
        program,
    )
    .await?;
    Ok((
        std::fs::read(output).map_err(|_| PreparationError::Io)?,
        kind,
    ))
}

async fn prepare_file_with_program(
    source: &Path,
    size: usize,
    directory: &Path,
    mode: &str,
    cancelled: &mut oneshot::Receiver<()>,
    program: &Path,
) -> Result<(std::path::PathBuf, &'static str), PreparationError> {
    if size == 0 || size > MAX_INPUT {
        return Err(PreparationError::Size);
    }
    let (demuxer, image, voice) =
        allowed_mode(mode, size).ok_or(if mode.starts_with("image:") {
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
    let animation = mode == "animation:matroska";
    let output = directory.join(if image {
        "prepared.jpg"
    } else if animation {
        "prepared.png"
    } else {
        "prepared.mp4"
    });
    if image {
        require_heic_grid_support(&mut ffmpeg_command(program), cancelled).await?;
    }
    let mut cmd = ffmpeg_command(program);
    cmd.args(["-y", "-nostdin", "-loglevel", "error"]);
    if voice {
        cmd.args(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1"]);
    }
    cmd.args(["-protocol_whitelist", "file,pipe", "-f", demuxer]);
    if demuxer == "mov" {
        cmd.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
    }
    if animation {
        // Only libvpx reads the alpha in Matroska BlockAdditional; the built-in
        // vp9 decoder silently drops it.
        cmd.args(["-c:v", "libvpx-vp9"]);
    }
    cmd.arg("-i").arg(source);
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
    } else if animation {
        cmd.args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-fflags",
            "+bitexact",
            "-flags:v",
            "+bitexact",
            "-t",
            "10",
            "-vf",
            ANIMATION_FILTER,
            "-c:v",
            "apng",
            "-plays",
            "0",
            "-pred",
            "mixed",
            "-f",
            "apng",
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
            VIDEO_FILTER,
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
    let child = spawn_conversion(&mut cmd)?;
    let limit = if image {
        MAX_IMAGE
    } else if animation {
        MAX_ANIMATION
    } else {
        MAX_VIDEO
    };
    let timeout = if image {
        60
    } else if animation {
        120
    } else {
        600
    };
    wait_for_conversion(
        child,
        &output,
        image,
        cancelled,
        Duration::from_secs(timeout),
        limit,
    )
    .await?;
    let size = output.metadata().map_err(|_| PreparationError::Io)?.len();
    if size == 0 || size > limit {
        return Err(PreparationError::Size);
    }
    if animation {
        let bytes = tokio::fs::read(&output)
            .await
            .map_err(|_| PreparationError::Io)?;
        let clean = png_rendering_chunks(&bytes).ok_or(PreparationError::Video)?;
        tokio::fs::write(&output, clean)
            .await
            .map_err(|_| PreparationError::Io)?;
    }
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    Ok((
        output,
        if image {
            "image/jpeg"
        } else if animation {
            "image/png"
        } else {
            "video/mp4"
        },
    ))
}

/// ffmpeg's PNG encoder always writes pHYs, which the relay refuses. Keep
/// critical chunks and the rendering chunks the relay allows, as cleanPng does.
fn png_rendering_chunks(bytes: &[u8]) -> Option<Vec<u8>> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    const RENDERING: [&[u8; 4]; 11] = [
        b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"bKGD", b"hIST", b"tRNS", b"sPLT", b"acTL", b"fcTL",
        b"fdAT",
    ];
    if !bytes.starts_with(SIGNATURE) {
        return None;
    }
    let mut out = SIGNATURE.to_vec();
    let mut i = SIGNATURE.len();
    loop {
        let header = bytes.get(i..i.checked_add(8)?)?;
        let len = usize::try_from(u32::from_be_bytes(header[..4].try_into().ok()?)).ok()?;
        let kind: &[u8; 4] = header[4..].try_into().ok()?;
        let end = i.checked_add(12)?.checked_add(len)?;
        let chunk = bytes.get(i..end)?;
        if kind == b"iCCP" {
            return None;
        }
        if kind[0] & 0x20 == 0 || RENDERING.contains(&kind) {
            out.extend_from_slice(chunk);
        }
        if kind == b"IEND" {
            return (end == bytes.len()).then_some(out);
        }
        i = end;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    static CONVERSIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    // Match block/buzz: ffmpeg is an optional host dependency, so real
    // conversion tests return early when the required tools are unavailable.
    // Installed tools must still succeed; conversion failures are not skipped.
    fn media_tool_version(name: &str) -> Option<Vec<u8>> {
        let program =
            crate::host_command::resolve_program(name, &crate::host_command::effective_path());
        match std::process::Command::new(program).arg("-version").output() {
            Ok(output) => {
                assert!(output.status.success(), "{name} version check failed");
                Some(output.stdout)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("skipping real conversion: {name} not found");
                None
            }
            Err(error) => panic!("could not run {name}: {error}"),
        }
    }

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
    async fn converts_video_with_fixed_demuxer_and_strips_input_metadata() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.avi");
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
    async fn converts_legacy_mov_with_leading_free_box() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() {
            return;
        }
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
    async fn shrinks_retina_screen_recording_into_relay_envelope() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() || media_tool_version("ffprobe").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("recording.mov");
        let ffmpeg =
            crate::host_command::resolve_program("ffmpeg", &crate::host_command::effective_path());
        // A full-screen Retina capture: short edge 2234 > 2160, and a naive
        // scale would give an odd 3341 width that padding blackens.
        let generated = std::process::Command::new(&ffmpeg)
            .args([
                "-y",
                "-nostdin",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=3456x2234:r=1",
                "-t",
                "1",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
            ])
            .arg(&input)
            .status();
        assert!(generated
            .expect("conversion tests require ffmpeg on PATH")
            .success());
        let bytes = std::fs::read(input).unwrap();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, _) = prepare(bytes, "video:mov", &mut cancelled).await.unwrap();
        let output = dir.path().join("prepared.mp4");
        std::fs::write(&output, prepared).unwrap();
        let dimensions = std::process::Command::new(crate::host_command::resolve_program(
            "ffprobe",
            &crate::host_command::effective_path(),
        ))
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
            "3342,2160"
        );
    }

    #[tokio::test]
    async fn converts_tiled_heic_without_cropping() {
        let _guard = CONVERSIONS.lock().await;
        let Some(version) = media_tool_version("ffmpeg") else {
            return;
        };
        // The tiled fixture needs ffmpeg 8+, unlike the video fixtures.
        if !supports_heic_grids(&version) {
            eprintln!("skipping tiled HEIC conversion: ffmpeg 8+ required");
            return;
        }
        if media_tool_version("ffprobe").is_none() {
            return;
        }
        let bytes = include_bytes!("../../../tests/fixtures/media/tiled.heic").to_vec();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "image:mov", &mut cancelled).await.unwrap();
        assert_eq!(mime, "image/jpeg");
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("prepared.jpg");
        std::fs::write(&output, prepared).unwrap();
        let dimensions = std::process::Command::new(crate::host_command::resolve_program(
            "ffprobe",
            &crate::host_command::effective_path(),
        ))
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

    fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut chunk = (data.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(data);
        chunk.extend_from_slice(&[0; 4]);
        chunk
    }

    fn png_chunks(bytes: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let mut chunks = Vec::new();
        let mut i = 8;
        while i < bytes.len() {
            let len = u32::from_be_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
            let kind = bytes[i + 4..i + 8].try_into().unwrap();
            chunks.push((kind, bytes[i + 8..i + 8 + len].to_vec()));
            i += 12 + len;
        }
        chunks
    }

    #[test]
    fn png_rendering_chunks_drop_only_what_the_relay_refuses() {
        let signature = b"\x89PNG\r\n\x1a\n";
        let build = |kinds: &[&[u8; 4]]| {
            let mut png = signature.to_vec();
            for kind in kinds {
                png.extend(png_chunk(kind, &[1, 2, 3]));
            }
            png
        };
        let clean = build(&[b"IHDR", b"acTL", b"fcTL", b"IDAT", b"fdAT", b"IEND"]);
        let ffmpeg = build(&[
            b"IHDR", b"pHYs", b"acTL", b"fcTL", b"IDAT", b"fdAT", b"IEND",
        ]);
        assert_eq!(png_rendering_chunks(&ffmpeg), Some(clean));
        assert_eq!(
            png_rendering_chunks(&build(&[b"IHDR", b"iCCP", b"IDAT", b"IEND"])),
            None
        );
        let mut trailing = build(&[b"IHDR", b"IDAT", b"IEND"]);
        trailing.push(0);
        assert_eq!(png_rendering_chunks(&trailing), None);
    }

    #[tokio::test]
    async fn converts_alpha_webm_to_looping_relay_clean_apng() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("avatar.webm");
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
            "color=c=red@0.5:s=32x32:r=24:d=1,format=yuva420p",
            "-c:v",
            "libvpx-vp9",
            "-auto-alt-ref",
            "0",
            "-pix_fmt",
            "yuva420p",
        ])
        .arg(&input)
        .status();
        assert!(generated
            .expect("conversion tests require ffmpeg on PATH")
            .success());
        let bytes = std::fs::read(input).unwrap();
        let (_sender, mut cancelled) = oneshot::channel();
        let (prepared, mime) = prepare(bytes, "animation:matroska", &mut cancelled)
            .await
            .unwrap();
        assert_eq!(mime, "image/png");
        assert!(prepared.starts_with(b"\x89PNG\r\n\x1a\n"));
        let chunks = png_chunks(&prepared);
        for (kind, _) in &chunks {
            assert!(
                [b"IHDR", b"acTL", b"fcTL", b"IDAT", b"fdAT", b"IEND"].contains(&kind),
                "unexpected {}",
                String::from_utf8_lossy(kind)
            );
        }
        let (_, actl) = chunks.iter().find(|(kind, _)| kind == b"acTL").unwrap();
        assert_eq!(&actl[4..8], &[0; 4], "plays forever");
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
    fn image_conversion_requires_a_known_grid_capable_ffmpeg() {
        for version in [
            "ffmpeg version 6.0.1",
            "ffmpeg version 7.1.4",
            "ffmpeg version N-123",
            "ffmpeg version bad",
            "other version 8.0",
        ] {
            assert!(!supports_heic_grids(version.as_bytes()), "{version}");
        }
        for version in [
            "ffmpeg version 8.0 Copyright",
            "ffmpeg version 8.1.2-Jellyfin Copyright",
            "ffmpeg version 9.0.1 Copyright",
            "ffmpeg version n9.0.2 Copyright",
            "ffmpeg version n8.0 Copyright",
        ] {
            assert!(supports_heic_grids(version.as_bytes()), "{version}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn old_ffmpeg_is_rejected_before_image_conversion() {
        let _guard = CONVERSIONS.lock().await;
        let directory = tempfile::tempdir().unwrap();
        let program = directory.path().join("ffmpeg");
        // Any invocation beyond the version probe is a test failure.
        crate::test_executable::write_executable(&program, "#!/bin/sh\nif [ \"$1\" = -version ]; then printf 'ffmpeg version 7.1.4 Copyright'; else exit 99; fi\n");
        let (_sender, mut cancelled) = oneshot::channel();
        let bytes = include_bytes!("../../../tests/fixtures/media/tiled.heic").to_vec();
        assert_eq!(
            prepare_with_program(bytes, "image:mov", &mut cancelled, &program).await,
            Err(PreparationError::Ffmpeg)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_probe_is_bounded_and_cancellable() {
        for oversized in [false, true] {
            let mut command = Command::new("/bin/sh");
            command
                .args([
                    "-c",
                    if oversized {
                        "exec yes x"
                    } else {
                        "exec sleep 60"
                    },
                ])
                .kill_on_drop(true);
            let (sender, mut cancelled) = oneshot::channel();
            if !oversized {
                sender.send(()).unwrap();
            }
            assert_eq!(
                require_heic_grid_support(&mut command, &mut cancelled).await,
                Err(if oversized {
                    PreparationError::Ffmpeg
                } else {
                    PreparationError::Cancelled
                })
            );
        }
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
        assert_eq!(
            allowed_mode("animation:matroska", 1),
            Some(("matroska", false, false))
        );
        assert!(allowed_mode("animation:matroska", MAX_ANIMATION_INPUT + 1).is_none());
        for mode in [
            "image:concat",
            "video:concat",
            "voice:concat",
            "video:http",
            "image:avi",
            "animation:mov",
            "animation:concat",
            "mov",
        ] {
            assert!(allowed_mode(mode, 1).is_none());
        }
        assert_eq!(PreparationError::Ffmpeg.status(), 503);
    }
}
