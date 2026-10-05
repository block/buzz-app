//! Packaged repository reads with the development broker's `project-git` contract
//! (`dev/project-git.mjs`). IdentityHost signs the NIP-98 header; system Git reads into
//! an isolated bare repository that is removed after every outcome. No checkout, hooks,
//! submodules, user Git configuration, arbitrary URL or write RPC.
use super::{hex_key, origin, RelayResponse, Result};
use crate::identity::{EventTemplate, IdentityHost};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicUsize, Ordering},
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

const READ_BYTES: usize = 4 * 1024 * 1024;
const TEXT_BYTES: u64 = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(12);
static READS: AtomicUsize = AtomicUsize::new(0);

#[derive(serde::Deserialize, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct GitRead {
    owner: String,
    dtag: String,
    commit: Option<String>,
    path: Option<String>,
}

fn git_hash(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Mirrors `parseGitRead` in `src/features/projects/git.ts`.
fn parse_read(read: GitRead) -> Result<GitRead> {
    let dtag = read.dtag.as_bytes();
    let valid = hex_key(&read.owner.to_ascii_lowercase())
        && !dtag.is_empty()
        && dtag.len() <= 64
        && dtag[0] != b'.'
        && dtag
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !read.dtag.contains("..")
        && read.commit.as_deref().map_or(true, git_hash)
        && read.path.as_deref().map_or(true, |path| {
            path.encode_utf16().count() <= 4096
                && !path.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
                && path
                    .split('/')
                    .all(|p| !p.is_empty() && p != "." && p != "..")
        });
    if !valid {
        return Err("Invalid Git read".into());
    }
    Ok(GitRead {
        owner: read.owner.to_ascii_lowercase(),
        commit: read.commit.map(|commit| commit.to_ascii_lowercase()),
        ..read
    })
}

struct Slot;
impl Slot {
    fn take() -> Option<Self> {
        READS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < 2).then_some(n + 1)
            })
            .ok()
            .map(|_| Slot)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        READS.fetch_sub(1, Ordering::AcqRel);
    }
}

fn reply(status: u16, body: &Value) -> RelayResponse {
    RelayResponse {
        status,
        headers: BTreeMap::from([("content-type".into(), "application/json".into())]),
        body: body.to_string(),
    }
}

#[tauri::command]
pub(crate) async fn relay_project_git(
    host: tauri::State<'_, IdentityHost>,
    community: String,
    read: GitRead,
) -> Result<RelayResponse> {
    let read = parse_read(read)?;
    let url = format!(
        "{}git/{}/{}.git",
        origin(&community)?,
        read.owner,
        read.dtag
    );
    let Some(_slot) = Slot::take() else {
        return Ok(reply(429, &json!({ "error": "Repository reads are busy" })));
    };
    let auth = host
        .sign(EventTemplate {
            kind: 27235,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock is unavailable")?
                .as_secs(),
            content: String::new(),
            tags: vec![
                vec!["u".into(), url.clone()],
                vec!["method".into(), "GET".into()],
            ],
        })
        .await?;
    let header = format!(
        "Authorization: Nostr {}",
        STANDARD.encode(
            serde_json::to_vec(&auth).map_err(|_| "Could not encode relay authentication")?
        )
    );
    let directory = tempfile::Builder::new()
        .prefix("buzz-project-read-")
        .tempdir()
        .map_err(|_| "Repository read failed")?;
    let git = Git::new(directory.path(), &header);
    let status = match tokio::time::timeout(DEADLINE, fetch_snapshot(&git, &url, &read)).await {
        Ok(Ok(snapshot)) => return Ok(reply(200, &snapshot)),
        Ok(Err(status)) => status,
        Err(_) => 503,
    };
    Ok(reply(
        status,
        &json!({ "error": "Repository content could not be read" }),
    ))
}

/// Failures are HTTP-like statuses; Git's argv and stderr never leave this module.
type Read<T> = std::result::Result<T, u16>;

struct Git {
    program: PathBuf,
    directory: PathBuf,
    env: Vec<(OsString, OsString)>,
}

impl Git {
    fn new(directory: &Path, header: &str) -> Self {
        let path = crate::host_command::effective_path();
        let settings = [
            ("http.extraHeader", header),
            ("http.followRedirects", "false"),
            ("credential.helper", ""),
            ("core.hooksPath", "/dev/null"),
            ("protocol.allow", "never"),
            ("protocol.http.allow", "always"),
            ("protocol.https.allow", "always"),
            ("fetch.fsckObjects", "true"),
            ("transfer.fsckObjects", "true"),
        ];
        let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
            .filter(|(name, _)| !name.to_string_lossy().starts_with("GIT_"))
            .filter(|(name, _)| !name.eq_ignore_ascii_case("PATH"))
            .collect();
        env.extend([
            ("PATH".into(), path.clone()),
            ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            // Git for Windows maps `/dev/null` to `NUL`.
            ("GIT_CONFIG_GLOBAL".into(), "/dev/null".into()),
            ("GIT_TERMINAL_PROMPT".into(), "0".into()),
            ("GIT_CONFIG_COUNT".into(), settings.len().to_string().into()),
        ]);
        for (index, (name, value)) in settings.iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{index}").into(), (*name).into()));
            env.push((format!("GIT_CONFIG_VALUE_{index}").into(), (*value).into()));
        }
        Self {
            program: crate::host_command::resolve_program("git", &path),
            directory: directory.into(),
            env,
        }
    }

    /// Stdout is bounded like the broker's `maxBuffer`; dropping the future kills Git.
    async fn run(&self, args: &[&str]) -> Read<Vec<u8>> {
        let mut command = Command::new(&self.program);
        command
            .args(args)
            .current_dir(&self.directory)
            .env_clear()
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|_| 502u16)?;
        let mut output = Vec::new();
        child
            .stdout
            .take()
            .ok_or(502u16)?
            .take(READ_BYTES as u64 + 1)
            .read_to_end(&mut output)
            .await
            .map_err(|_| 502u16)?;
        if output.len() > READ_BYTES || !child.wait().await.map_err(|_| 502u16)?.success() {
            return Err(502);
        }
        Ok(output)
    }
}

async fn fetch_snapshot(git: &Git, url: &str, read: &GitRead) -> Read<Value> {
    // An authenticated empty advertisement is an empty repository, not a failed
    // HEAD fetch. Discover object format before initializing the isolated repo.
    let refs = String::from_utf8_lossy(&git.run(&["ls-remote", "--symref", "--", url]).await?)
        .into_owned();
    if refs.trim().is_empty() {
        if read.commit.is_some() || read.path.is_some() {
            return Err(404);
        }
        return Ok(json!({
            "head": null, "commits": [], "files": [], "readme": null, "file": null, "diff": null
        }));
    }
    let sha256 = read.commit.as_ref().is_some_and(|c| c.len() == 64)
        || refs.lines().any(|line| {
            line.split_once('\t')
                .is_some_and(|(hash, _)| hash.len() == 64 && git_hash(hash))
        });
    let mut init = vec!["init", "--bare"];
    if sha256 {
        init.push("--object-format=sha256");
    }
    git.run(&init).await?;
    let fetch = |revision| ["fetch", "--no-tags", "--depth=101", "--", url, revision];
    let tip = match (
        git.run(&fetch(read.commit.as_deref().unwrap_or("HEAD")))
            .await,
        &read.commit,
    ) {
        (Ok(_), _) => "FETCH_HEAD",
        // Relays refuse unadvertised commits; listed history comes from HEAD.
        (Err(_), Some(commit)) => {
            git.run(&fetch("HEAD")).await?;
            commit
        }
        (Err(status), None) => return Err(status),
    };
    snapshot(git, read, tip).await
}

struct File {
    hash: String,
    size: u64,
    path: String,
}

/// Git plumbing uses NUL record boundaries; filenames never become arguments.
async fn snapshot(git: &Git, read: &GitRead, tip: &str) -> Read<Value> {
    let head = String::from_utf8_lossy(
        &git.run(&["rev-parse", "--verify", &format!("{tip}^{{commit}}")])
            .await?,
    )
    .trim()
    .to_string();
    if read.commit.as_ref().is_some_and(|commit| *commit != head) {
        return Err(502);
    }
    let tree = git.run(&["ls-tree", "-r", "-l", "-z", &head]).await?;
    let files: Vec<File> = String::from_utf8_lossy(&tree)
        .split('\0')
        .filter_map(|record| {
            let (meta, path) = record.split_once('\t')?;
            let mut meta = meta.split_whitespace();
            let (_mode, kind, hash, size) =
                (meta.next()?, meta.next()?, meta.next()?, meta.next()?);
            (kind == "blob" && hash.bytes().all(|b| b.is_ascii_hexdigit())).then_some(())?;
            Some(File {
                hash: hash.into(),
                size: size.parse().ok()?,
                path: path.into(),
            })
        })
        .collect();
    if files.len() > 20_000 {
        return Err(502);
    }
    let history = git
        .run(&[
            "log",
            "-100",
            "--format=%H%x00%an%x00%at%x00%s%x00",
            &head,
            "--",
        ])
        .await?;
    let history = String::from_utf8_lossy(&history);
    let parts: Vec<&str> = history.split('\0').collect();
    let commits: Vec<Value> = parts
        .chunks_exact(4)
        .map(|c| {
            json!({
                "hash": c[0].trim(),
                "author": c[1],
                "date": c[2].parse::<u64>().unwrap_or_default(),
                "subject": c[3],
            })
        })
        .collect();
    let selected = match &read.path {
        Some(path) => Some(files.iter().find(|f| f.path == *path).ok_or(404u16)?),
        None => None,
    };
    let readme = files.iter().find(|f| {
        let name = f.path.to_ascii_lowercase();
        ["readme", "readme.md", "readme.txt", "readme.rst"].contains(&name.as_str())
    });
    let file = match selected {
        Some(f) => {
            json!({ "path": f.path, "content": content(git, Some(f)).await?, "size": f.size })
        }
        None => Value::Null,
    };
    let diff = match read.commit {
        Some(_) => Value::String(
            String::from_utf8_lossy(
                &git.run(&[
                    "show",
                    "--format=fuller",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--no-renames",
                    &head,
                    "--",
                ])
                .await?,
            )
            .into_owned(),
        ),
        None => Value::Null,
    };
    let snapshot = json!({
        "head": head,
        "commits": commits,
        "files": files.iter().map(|f| json!({ "path": f.path, "hash": f.hash, "size": f.size })).collect::<Vec<_>>(),
        "readme": content(git, readme).await?,
        "file": file,
        "diff": diff,
    });
    if snapshot.to_string().len() > READ_BYTES {
        return Err(502);
    }
    Ok(snapshot)
}

async fn content(git: &Git, file: Option<&File>) -> Read<Option<String>> {
    let Some(file) = file.filter(|f| f.size <= TEXT_BYTES) else {
        return Ok(None);
    };
    let bytes = git.run(&["cat-file", "blob", &file.hash]).await?;
    Ok((!bytes.contains(&0))
        .then(|| String::from_utf8(bytes).ok())
        .flatten())
}

#[cfg(test)]
#[path = "project_git_tests.rs"]
mod tests;
