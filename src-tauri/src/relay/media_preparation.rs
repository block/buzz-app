//! Bounded conversion of uploaded HEIC and video bytes. No paths or ffmpeg
//! arguments are accepted from the webview; the result is uploaded by relay.rs.
//! The strict branch prepares one reviewed result source and keeps it private.
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    sync::{oneshot, Semaphore},
};

static SLOTS: OnceLock<Semaphore> = OnceLock::new();

const MAX_INPUT: usize = 500 * 1024 * 1024;
const MAX_IMAGE: u64 = 50 * 1024 * 1024;
const MAX_VIDEO: u64 = 500 * 1024 * 1024;
// Fit the relay's 3840x2160 envelope in either orientation (Retina screen
// recordings exceed it) at even dimensions, never upscale, then pad the odd
// edges of unscaled input for yuv420p.
const VIDEO_FILTER: &str = "scale=w='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(iw*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,iw)':h='if(lt(min(3840/max(iw,ih),2160/min(iw,ih)),1),round(ih*min(3840/max(iw,ih),2160/min(iw,ih))/2)*2,ih)',pad=ceil(iw/2)*2:ceil(ih/2)*2";

#[cfg(test)]
static STRICT_PROGRAMS: std::sync::Mutex<Option<(PathBuf, PathBuf)>> = std::sync::Mutex::new(None);
/// Serializes every test that converts: there are only two conversion slots.
#[cfg(test)]
pub(crate) static CONVERSIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Test-only stand-ins for the strict branch's ffmpeg and ffprobe until
/// dropped. Hold `CONVERSIONS` while it lives.
#[cfg(test)]
pub(crate) struct Programs;
#[cfg(test)]
impl Programs {
    pub(crate) fn set(ffmpeg: PathBuf, ffprobe: PathBuf) -> Self {
        *STRICT_PROGRAMS.lock().unwrap() = Some((ffmpeg, ffprobe));
        Self
    }
}
#[cfg(test)]
impl Drop for Programs {
    fn drop(&mut self) {
        *STRICT_PROGRAMS.lock().unwrap() = None;
    }
}
#[cfg(test)]
static WRITE_GATE: std::sync::Mutex<Option<HeldWrite>> = std::sync::Mutex::new(None);
#[cfg(test)]
struct HeldWrite {
    entered: oneshot::Sender<PathBuf>,
    release: std::sync::mpsc::Receiver<()>,
    joined: oneshot::Sender<()>,
}
/// Test-only hold of the strict branch's next blocking source write, armed
/// until dropped. Hold `CONVERSIONS` while it lives.
#[cfg(test)]
pub(crate) struct WriteGate {
    /// The held source path, sent from the blocking thread before it writes.
    pub(crate) entered: oneshot::Receiver<PathBuf>,
    /// Resolves when the owner polls the still-held write again; an error
    /// means the write's future was dropped while held.
    pub(crate) joined: oneshot::Receiver<()>,
    release: std::sync::mpsc::Sender<()>,
}
#[cfg(test)]
impl WriteGate {
    pub(crate) fn arm() -> Self {
        let (entered, entered_rx) = oneshot::channel();
        let (joined, joined_rx) = oneshot::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        *WRITE_GATE.lock().unwrap() = Some(HeldWrite {
            entered,
            release: release_rx,
            joined,
        });
        Self {
            entered: entered_rx,
            joined: joined_rx,
            release,
        }
    }
    pub(crate) fn release(&self) {
        let _ = self.release.send(());
    }
    fn held<T: Send + 'static>(
        source: &Path,
        work: impl FnOnce() -> Result<T, PreparationError> + Send + 'static,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<T, PreparationError>> + Send>>
    {
        let Some(HeldWrite {
            entered,
            release,
            joined,
        }) = WRITE_GATE.lock().unwrap().take()
        else {
            return Box::pin(blocking(work));
        };
        let path = source.to_owned();
        let mut write = Box::pin(blocking(move || {
            let _ = entered.send(path);
            // A dropped gate releases too.
            let _ = release.recv();
            work()
        }));
        let (mut polls, mut joined) = (0, Some(joined));
        Box::pin(std::future::poll_fn(move |cx| {
            let poll = std::future::Future::poll(write.as_mut(), cx);
            polls += 1;
            if poll.is_pending() && polls > 1 {
                if let Some(joined) = joined.take() {
                    let _ = joined.send(());
                }
            }
            poll
        }))
    }
}
#[cfg(test)]
impl Drop for WriteGate {
    fn drop(&mut self) {
        *WRITE_GATE.lock().unwrap() = None;
    }
}
const MAX_PROBE: usize = 64 * 1024;
// ISO base media brands; QuickTime (`qt  `) and unbranded files are not MP4.
const MP4_BRANDS: [&str; 8] = [
    "isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1",
];

/// Frozen generic expectations for one strictly prepared video.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct StrictVideo {
    width: u32,
    height: u32,
    duration_ms: u32,
    tolerance_ms: u32,
    max_bytes: u64,
}

/// Even dimensions inside the relay envelope in either orientation; no
/// vendor defaults.
pub(crate) fn strict_video(
    width: u32,
    height: u32,
    duration_ms: u32,
    tolerance_ms: u32,
    max_bytes: u32,
) -> Option<StrictVideo> {
    let even = |side: u32| side > 0 && side.is_multiple_of(2);
    (even(width)
        && even(height)
        && width.max(height) <= 3840
        && width.min(height) <= 2160
        && (1..=600_000).contains(&duration_ms)
        && tolerance_ms <= 100
        && tolerance_ms < duration_ms
        && (1..=16 * 1024 * 1024).contains(&max_bytes))
    .then_some(StrictVideo {
        width,
        height,
        duration_ms,
        tolerance_ms,
        max_bytes: max_bytes.into(),
    })
}

/// One validated prepared video and its private directory, which also holds
/// the written source. Dropping it removes both files.
pub(crate) struct Prepared {
    directory: tempfile::TempDir,
    // Which downloaded bytes it came from; only tests read it today.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) source_sha256: String,
    pub(crate) prepared_sha256: String,
    pub(crate) prepared_size: usize,
    /// `WIDTHxHEIGHT` as the final strict probe measured it.
    pub(crate) dim: String,
}
impl Prepared {
    #[cfg(test)]
    pub(crate) fn directory(&self) -> &Path {
        self.directory.path()
    }
    /// The prepared file, opened only while it still hashes to exactly what
    /// was prepared. Blocking. The private directory has no other writer.
    pub(crate) fn file(&self) -> Option<std::fs::File> {
        let path = self.directory.path().join("prepared.mp4");
        let (size, sha256) = super::upload_spool::hash_file(&path).ok()?;
        (size == self.prepared_size && sha256 == self.prepared_sha256)
            .then(|| std::fs::File::open(path).ok())?
    }
}

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
    cmd.arg("-version");
    let version = bounded_stdout(
        cmd,
        4096,
        Duration::from_secs(5),
        cancelled,
        PreparationError::Ffmpeg,
    )
    .await?;
    if supports_heic_grids(&version) {
        Ok(())
    } else {
        Err(PreparationError::Ffmpeg)
    }
}

/// A fixed tool's stdout, bounded in size and time; any failure kills and
/// reaps it.
async fn bounded_stdout(
    cmd: &mut Command,
    limit: usize,
    timeout: Duration,
    cancelled: &mut oneshot::Receiver<()>,
    failure: PreparationError,
) -> Result<Vec<u8>, PreparationError> {
    cmd.stdout(Stdio::piped());
    let mut child = spawn_conversion(cmd)?;
    let stdout = child.stdout.take().ok_or(PreparationError::Io)?;
    let read = async {
        let mut output = Vec::new();
        stdout
            .take(limit as u64 + 1)
            .read_to_end(&mut output)
            .await
            .ok()
            .filter(|_| output.len() <= limit)?;
        child
            .wait()
            .await
            .ok()
            .filter(|status| status.success())
            .map(|_| output)
    };
    let result = tokio::select! {
        output = read => output.ok_or(failure),
        _ = &mut *cancelled => Err(PreparationError::Cancelled),
        _ = tokio::time::sleep(timeout) => Err(failure),
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
    prepare_file_with_program(source, size, directory, mode, cancelled, &program, None).await
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
        None,
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
    // The strict branch's size cap and remaining deadline replace the
    // ordinary defaults; it decodes the whole source, failing on any error.
    strict: Option<(u64, Duration)>,
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
    let output = directory.join(if image {
        "prepared.jpg"
    } else {
        "prepared.mp4"
    });
    if image {
        require_heic_grid_support(&mut ffmpeg_command(program), cancelled).await?;
    }
    let mut cmd = ffmpeg_command(program);
    cmd.args(["-y", "-nostdin", "-loglevel", "error"]);
    if strict.is_some() {
        cmd.args(["-xerror", "-err_detect", "explode"]);
    }
    if voice {
        cmd.args(["-f", "lavfi", "-i", "color=c=black:s=16x16:r=1"]);
    }
    cmd.args(["-protocol_whitelist", "file,pipe", "-f", demuxer]);
    if demuxer == "mov" {
        cmd.args(["-enable_drefs", "0", "-use_absolute_path", "0"]);
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
    let (limit, timeout) = strict.unwrap_or((
        if image { MAX_IMAGE } else { MAX_VIDEO },
        Duration::from_secs(if image { 60 } else { 600 }),
    ));
    wait_for_conversion(child, &output, image, cancelled, timeout, limit).await?;
    let size = output.metadata().map_err(|_| PreparationError::Io)?.len();
    if size == 0 || size > limit {
        return Err(PreparationError::Size);
    }
    if cancelled.try_recv().is_ok() {
        return Err(PreparationError::Cancelled);
    }
    Ok((output, if image { "image/jpeg" } else { "video/mp4" }))
}

fn strict_programs() -> (PathBuf, PathBuf) {
    #[cfg(test)]
    if let Some(programs) = STRICT_PROGRAMS.lock().unwrap().clone() {
        return programs;
    }
    let path = crate::host_command::effective_path();
    (
        crate::host_command::resolve_program("ffmpeg", &path),
        crate::host_command::resolve_program("ffprobe", &path),
    )
}

/// Verified facts from one bounded probe of a fixed-demuxer MP4.
#[derive(Debug, PartialEq)]
struct Facts {
    width: u64,
    height: u64,
    duration_ms: f64,
    codec: String,
    audio: Vec<String>,
}

fn parse_probe(output: &[u8]) -> Option<Facts> {
    let probe: serde_json::Value = serde_json::from_slice(output).ok()?;
    let brand = probe["format"]["tags"]["major_brand"].as_str()?;
    if !MP4_BRANDS.contains(&brand) {
        return None;
    }
    let streams = probe["streams"].as_array()?;
    let mut videos = streams.iter().filter(|s| s["codec_type"] == "video");
    let (video, None) = (videos.next()?, videos.next()) else {
        return None;
    };
    let duration: f64 = video["duration"].as_str()?.parse().ok()?;
    if !duration.is_finite() || duration <= 0.0 {
        return None;
    }
    Some(Facts {
        width: video["width"].as_u64()?,
        height: video["height"].as_u64()?,
        duration_ms: duration * 1000.0,
        codec: video["codec_name"].as_str()?.to_owned(),
        audio: streams
            .iter()
            .filter(|s| s["codec_type"] == "audio")
            .map(|s| s["codec_name"].as_str().unwrap_or_default().to_owned())
            .collect(),
    })
}

impl Facts {
    /// Shape and video-track duration only: never repaired, trimmed or stretched.
    fn matches(&self, expected: &StrictVideo) -> bool {
        self.width == u64::from(expected.width)
            && self.height == u64::from(expected.height)
            && (self.duration_ms - f64::from(expected.duration_ms)).abs()
                <= f64::from(expected.tolerance_ms)
    }
}

async fn probe(
    ffprobe: &Path,
    file: &Path,
    timeout: Duration,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<Facts, PreparationError> {
    let mut cmd = ffmpeg_command(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        "mov",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-show_entries",
        "format_tags=major_brand:stream=codec_type,codec_name,width,height,duration",
        "-of",
        "json",
    ])
    .arg(file);
    let output = bounded_stdout(
        &mut cmd,
        MAX_PROBE,
        timeout,
        cancelled,
        PreparationError::Video,
    )
    .await?;
    parse_probe(&output).ok_or(PreparationError::Video)
}

/// Complete decode of the prepared output; parsing headers is not decoding.
async fn decode(
    ffmpeg: &Path,
    file: &Path,
    limit: u64,
    timeout: Duration,
    cancelled: &mut oneshot::Receiver<()>,
) -> Result<(), PreparationError> {
    let mut cmd = ffmpeg_command(ffmpeg);
    cmd.args([
        "-nostdin",
        "-v",
        "error",
        "-xerror",
        "-err_detect",
        "explode",
        "-protocol_whitelist",
        "file",
        "-f",
        "mov",
        "-enable_drefs",
        "0",
        "-use_absolute_path",
        "0",
        "-i",
    ])
    .arg(file)
    .args(["-map", "0", "-f", "null", "-"])
    .stdout(Stdio::null());
    let child = spawn_conversion(&mut cmd)?;
    wait_for_conversion(child, file, false, cancelled, timeout, limit).await
}

/// Writes the retained source privately, checking it against its committed hash.
fn write_source(path: &Path, bytes: Vec<u8>, sha256: &str) -> Result<(), PreparationError> {
    use std::io::Write as _;
    let mut file = std::fs::File::options()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| PreparationError::Io)?;
    let mut hash = Sha256::new();
    for chunk in bytes.chunks(1024 * 1024) {
        hash.update(chunk);
        file.write_all(chunk).map_err(|_| PreparationError::Io)?;
    }
    if format!("{:x}", hash.finalize()) == sha256 {
        Ok(())
    } else {
        Err(PreparationError::Video)
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, PreparationError> + Send + 'static,
) -> Result<T, PreparationError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| PreparationError::Io)?
}

/// Prepares one retained reviewed source: probe it, fully decode it while
/// converting, then probe, fully decode and hash the exact output. Mismatches
/// fail; nothing is repaired or retried. Missing ffmpeg or ffprobe fails safely.
pub(super) async fn prepare_strict(
    bytes: Vec<u8>,
    source_sha256: String,
    expected: StrictVideo,
    timeout: Duration,
    mut cancelled: oneshot::Receiver<()>,
) -> Result<Prepared, PreparationError> {
    let end = tokio::time::Instant::now() + timeout;
    let left = || end.saturating_duration_since(tokio::time::Instant::now());
    let size = bytes.len();
    if size == 0 || size as u64 > expected.max_bytes {
        return Err(PreparationError::Size);
    }
    let (ffmpeg, ffprobe) = strict_programs();
    let directory = super::upload_spool::private_tempdir_in(&std::env::temp_dir())
        .map_err(|_| PreparationError::Io)?;
    let source = directory.path().join("source.mp4");
    let (path, hash) = (source.clone(), source_sha256.clone());
    let write = move || write_source(&path, bytes, &hash);
    #[cfg(test)]
    let write = WriteGate::held(&source, write);
    #[cfg(not(test))]
    let write = blocking(write);
    write.await?;
    let facts = probe(&ffprobe, &source, left(), &mut cancelled).await?;
    if !facts.matches(&expected) {
        return Err(PreparationError::Video);
    }
    let (output, _) = prepare_file_with_program(
        &source,
        size,
        directory.path(),
        "video:mov",
        &mut cancelled,
        &ffmpeg,
        Some((expected.max_bytes, left())),
    )
    .await?;
    let facts = probe(&ffprobe, &output, left(), &mut cancelled).await?;
    if !facts.matches(&expected)
        || facts.codec != "h264"
        || facts.audio.len() > 1
        || facts.audio.iter().any(|codec| codec != "aac")
    {
        return Err(PreparationError::Video);
    }
    let dim = format!("{}x{}", facts.width, facts.height);
    decode(&ffmpeg, &output, expected.max_bytes, left(), &mut cancelled).await?;
    // The exact file after every write and check has stopped.
    let (prepared_size, prepared_sha256) =
        blocking(move || super::upload_spool::hash_file(&output).map_err(|_| PreparationError::Io))
            .await?;
    if prepared_size == 0 || prepared_size as u64 > expected.max_bytes {
        return Err(PreparationError::Size);
    }
    if cancelled.try_recv().is_ok() || left().is_zero() {
        return Err(PreparationError::Cancelled);
    }
    Ok(Prepared {
        directory,
        source_sha256,
        prepared_sha256,
        prepared_size,
        dim,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn generated(dir: &Path, name: &str, args: &[&str]) -> Vec<u8> {
        let path = dir.join(name);
        let ffmpeg =
            crate::host_command::resolve_program("ffmpeg", &crate::host_command::effective_path());
        assert!(std::process::Command::new(ffmpeg)
            .args(["-y", "-nostdin", "-loglevel", "error"])
            .args(args)
            .arg(&path)
            .status()
            .unwrap()
            .success());
        std::fs::read(path).unwrap()
    }
    const VIDEO: [&str; 4] = [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=24:duration=2",
    ];
    const AUDIO: [&str; 4] = ["-f", "lavfi", "-i", "sine=frequency=440:duration=2"];
    const H264: [&str; 6] = [
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
    ];
    fn mp4(dir: &Path, name: &str, extra: &[&str]) -> Vec<u8> {
        generated(dir, name, &[&VIDEO[..], &H264[..], extra].concat())
    }
    fn expected(duration_ms: u32, max_bytes: u32) -> StrictVideo {
        strict_video(640, 360, duration_ms, 50, max_bytes).unwrap()
    }
    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    async fn strict(bytes: Vec<u8>, expected: StrictVideo) -> Result<Prepared, PreparationError> {
        let (_keep, cancelled) = oneshot::channel();
        let hash = digest(&bytes);
        prepare_strict(bytes, hash, expected, Duration::from_secs(60), cancelled).await
    }
    fn probed(file: &Path) -> serde_json::Value {
        let output = std::process::Command::new(crate::host_command::resolve_program(
            "ffprobe",
            &crate::host_command::effective_path(),
        ))
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(file)
        .output()
        .unwrap();
        serde_json::from_slice(&output.stdout).unwrap()
    }

    #[test]
    fn strict_expectations_are_generic_bounded_shapes() {
        assert!(strict_video(1280, 720, 5000, 50, 16 * 1024 * 1024).is_some());
        assert!(strict_video(2160, 3840, 600_000, 100, 1).is_some());
        for (w, h, d, t, max) in [
            (1281, 720, 5000, 50, 1),
            (0, 720, 5000, 50, 1),
            (3842, 720, 5000, 50, 1),
            (2162, 2162, 5000, 50, 1),
            (1280, 720, 0, 0, 1),
            (1280, 720, 600_001, 50, 1),
            (1280, 720, 5000, 101, 1),
            (1280, 720, 50, 50, 1),
            (1280, 720, 5000, 50, 0),
            (1280, 720, 5000, 50, 16 * 1024 * 1024 + 1),
        ] {
            assert!(
                strict_video(w, h, d, t, max).is_none(),
                "{w}x{h} {d}±{t} {max}"
            );
        }
    }

    #[tokio::test]
    async fn strict_preparation_verifies_mp4_with_and_without_audio() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() || media_tool_version("ffprobe").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        for audio in [true, false] {
            let source = if audio {
                let tail = [
                    "-c:a",
                    "aac",
                    "-shortest",
                    "-metadata",
                    "title=fixture-private-title",
                ];
                generated(
                    dir.path(),
                    "audio.mp4",
                    &[&VIDEO[..], &AUDIO[..], &H264[..], &tail[..]].concat(),
                )
            } else {
                mp4(dir.path(), "silent.mp4", &[])
            };
            let prepared = strict(source.clone(), expected(2000, 16 * 1024 * 1024))
                .await
                .unwrap();
            let file = prepared.directory().join("prepared.mp4");
            let bytes = std::fs::read(&file).unwrap();
            assert_eq!(prepared.source_sha256, digest(&source));
            assert_eq!(
                (prepared.prepared_sha256.as_str(), prepared.prepared_size),
                (digest(&bytes).as_str(), bytes.len())
            );
            assert_eq!(
                std::fs::read(prepared.directory().join("source.mp4")).unwrap(),
                source
            );
            let probe = probed(&file);
            let streams = probe["streams"].as_array().unwrap();
            assert_eq!(
                (
                    streams[0]["codec_name"].as_str(),
                    streams[0]["width"].as_u64(),
                    streams[0]["height"].as_u64()
                ),
                (Some("h264"), Some(640), Some(360))
            );
            assert_eq!(streams.iter().any(|s| s["codec_type"] == "audio"), audio);
            assert!(!probe.to_string().contains("fixture-private-title"));
            let directory = prepared.directory().to_owned();
            drop(prepared);
            assert!(!directory.exists(), "dropping the value removes both files");
        }
    }

    #[tokio::test]
    async fn strict_preparation_rejects_rather_than_repairs() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() || media_tool_version("ffprobe").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let source = mp4(dir.path(), "source.mp4", &["-movflags", "+faststart"]);
        let max = 16 * 1024 * 1024;
        // The measured video track is exactly 2000 ms: tolerance is inclusive.
        assert!(strict(source.clone(), expected(2050, max)).await.is_ok());
        assert!(strict(source.clone(), expected(1950, max)).await.is_ok());
        let mut corrupt = source.clone();
        let middle = corrupt.len() / 2;
        for byte in &mut corrupt[middle..middle + 4096] {
            *byte ^= 0x5a;
        }
        let quicktime = generated(dir.path(), "source.mov", &[&VIDEO[..], &H264[..]].concat());
        let two_videos = generated(
            dir.path(),
            "two.mp4",
            &[
                &VIDEO[..],
                &VIDEO[..],
                &H264[..],
                &["-map", "0:v", "-map", "1:v"],
            ]
            .concat(),
        );
        // A heavily compressed source re-encodes larger than itself.
        let tiny = generated(
            dir.path(),
            "tiny.mp4",
            &[
                &VIDEO[..],
                &["-c:v", "libx264", "-crf", "51", "-pix_fmt", "yuv420p"],
            ]
            .concat(),
        );
        let cases: [(&str, Vec<u8>, StrictVideo, PreparationError); 10] = [
            (
                "html",
                b"<html>not media</html>".to_vec(),
                expected(2000, max),
                PreparationError::Video,
            ),
            (
                "quicktime",
                quicktime,
                expected(2000, max),
                PreparationError::Video,
            ),
            (
                "wrong shape",
                source.clone(),
                strict_video(1280, 720, 2000, 50, max).unwrap(),
                PreparationError::Video,
            ),
            (
                "short",
                source.clone(),
                expected(2051, max),
                PreparationError::Video,
            ),
            (
                "long",
                source.clone(),
                expected(1949, max),
                PreparationError::Video,
            ),
            (
                "truncated",
                source[..source.len() / 2].to_vec(),
                expected(2000, max),
                PreparationError::Video,
            ),
            (
                "corrupt tail",
                corrupt,
                expected(2000, max),
                PreparationError::Video,
            ),
            (
                "two videos",
                two_videos,
                expected(2000, max),
                PreparationError::Video,
            ),
            (
                "source over max",
                source.clone(),
                expected(2000, source.len() as u32 - 1),
                PreparationError::Size,
            ),
            (
                "output over max",
                tiny.clone(),
                expected(2000, tiny.len() as u32),
                PreparationError::Size,
            ),
        ];
        for (name, bytes, expectation, error) in cases {
            assert_eq!(
                strict(bytes, expectation).await.err(),
                Some(error),
                "{name}"
            );
        }
        let (_keep, cancelled) = oneshot::channel();
        assert_eq!(
            prepare_strict(
                source,
                "0".repeat(64),
                expected(2000, max),
                Duration::from_secs(60),
                cancelled
            )
            .await
            .err(),
            Some(PreparationError::Video),
            "the committed source hash is checked while writing"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn strict_tools_fail_closed_and_are_bounded_and_cancellable() {
        let _guard = CONVERSIONS.lock().await;
        if media_tool_version("ffmpeg").is_none() || media_tool_version("ffprobe").is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let source = mp4(dir.path(), "source.mp4", &[]);
        let path = crate::host_command::effective_path();
        let (ffmpeg, ffprobe) = (
            crate::host_command::resolve_program("ffmpeg", &path),
            crate::host_command::resolve_program("ffprobe", &path),
        );
        let fake = dir.path().join("fake");
        let missing = dir.path().join("missing");
        let real = format!("exec {:?} \"$@\"", ffprobe);
        for (name, ffmpeg, script, error) in [
            ("missing ffprobe", ffmpeg.clone(), None, PreparationError::Ffmpeg),
            ("missing ffmpeg", missing.clone(), Some(real.clone()), PreparationError::Ffmpeg),
            ("malformed probe", ffmpeg.clone(), Some("printf 'not json'".into()), PreparationError::Video),
            ("oversized probe", ffmpeg.clone(), Some("exec yes x".into()), PreparationError::Video),
            ("probe failure", ffmpeg.clone(), Some("exit 1".into()), PreparationError::Video),
            ("nonfinite duration", ffmpeg.clone(), Some(r#"printf '{"streams":[{"codec_type":"video","codec_name":"h264","width":640,"height":360,"duration":"inf"}],"format":{"tags":{"major_brand":"isom"}}}'"#.into()), PreparationError::Video),
            ("final codec", ffmpeg.clone(), Some(format!(r#"case "$*" in *prepared.mp4*) printf '{{"streams":[{{"codec_type":"video","codec_name":"hevc","width":640,"height":360,"duration":"2.0"}}],"format":{{"tags":{{"major_brand":"isom"}}}}}}';; *) {real};; esac"#)), PreparationError::Video),
        ] {
            let probe = match script {
                Some(script) => {
                    crate::test_executable::write_executable(&fake, format!("#!/bin/sh\n{script}\n"));
                    fake.clone()
                }
                None => missing.clone(),
            };
            let _programs = Programs::set(ffmpeg, probe);
            assert_eq!(
                strict(source.clone(), expected(2000, 16 * 1024 * 1024)).await.err(),
                Some(error),
                "{name}"
            );
        }
        // A held conversion is killed and reaped on cancellation.
        let pid = dir.path().join("pid");
        crate::test_executable::write_executable(
            &fake,
            format!("#!/bin/sh\necho $$ > {pid:?}\nexec sleep 60\n"),
        );
        let _programs = Programs::set(fake.clone(), ffprobe);
        let (stop, cancelled) = oneshot::channel::<()>();
        let hash = digest(&source);
        let work = tokio::spawn(prepare_strict(
            source,
            hash,
            expected(2000, 16 * 1024 * 1024),
            Duration::from_secs(60),
            cancelled,
        ));
        while std::fs::read_to_string(&pid).map_or(true, |pid| !pid.ends_with('\n')) {
            tokio::task::yield_now().await;
        }
        drop(stop);
        assert_eq!(work.await.unwrap().err(), Some(PreparationError::Cancelled));
        let pid = std::fs::read_to_string(&pid).unwrap();
        assert!(!std::process::Command::new("/bin/kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
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
