//! Read-only acquisition. Preview owns immutable artifacts; installation never rereads a source.
use crate::{artifact_from_text, err, hash, Catalog, Manager, Manifest, Result, LIMIT};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 20_000;
const MAX_PLUGINS: usize = 32;
const MAX_PREVIEW_BYTES: usize = 32 * 1024 * 1024;
const MAX_REPO_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub path: String,
    pub manifest: Manifest,
    pub revision: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub source: String,
    pub commit: Option<String>,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}

pub struct PreparedImport {
    pub preview: Preview,
    artifacts: BTreeMap<String, Vec<u8>>,
}
impl PreparedImport {
    fn new(source: String, commit: Option<String>) -> Result<Self> {
        // An opaque per-preview identity, independent of plugin IDs or source paths.
        let nonce = tempfile::NamedTempFile::new().map_err(err)?;
        Ok(Self {
            preview: Preview {
                token: hash(nonce.path().as_os_str().as_encoded_bytes()),
                source,
                commit,
                candidates: vec![],
                warnings: vec![],
            },
            artifacts: BTreeMap::new(),
        })
    }
    fn add(&mut self, path: String, artifact: Result<Vec<u8>>) -> Result<()> {
        match artifact {
            Ok(bytes) => {
                if self.artifacts.contains_key(&path) {
                    return Err("Duplicate plugin folder identity".into());
                }
                if self.artifacts.len() >= MAX_PLUGINS
                    || self.artifacts.values().map(Vec::len).sum::<usize>() + bytes.len()
                        > MAX_PREVIEW_BYTES
                {
                    return Err("Too many plugin artifacts; choose a smaller folder or repository (32 plugins / 32 MiB maximum)".into());
                }
                let artifact: crate::Artifact = serde_json::from_slice(&bytes).map_err(err)?;
                self.preview.candidates.push(Candidate {
                    path: path.clone(),
                    manifest: artifact.manifest,
                    revision: hash(&bytes),
                });
                self.artifacts.insert(path, bytes);
            }
            Err(reason) => {
                if self.preview.warnings.len() < MAX_PLUGINS {
                    self.preview.warnings.push(format!("{path}: {reason}"));
                }
            }
        }
        Ok(())
    }
    pub fn install(&self, manager: &Manager, token: &str, path: &str) -> Result<Catalog> {
        if token != self.preview.token {
            return Err("This import preview expired. Choose the source again.".into());
        }
        let bytes = self
            .artifacts
            .get(path)
            .ok_or("Choose a listed plugin folder")?;
        manager.install_artifact(bytes)
    }
}

pub fn prepare_folder(directory: &Path) -> Result<PreparedImport> {
    if !fs::symlink_metadata(directory)
        .map_err(err)?
        .file_type()
        .is_dir()
    {
        return Err("Choose a regular folder, not a symbolic link".into());
    }
    let root = directory.canonicalize().map_err(err)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut prepared = PreparedImport::new(root.display().to_string(), None)?;
    let directory =
        cap_std::fs::Dir::open_ambient_dir(&root, cap_std::ambient_authority()).map_err(err)?;
    let mut pending = vec![(PathBuf::new(), 0)];
    let mut entries = 0;
    while let Some((relative, depth)) = pending.pop() {
        if Instant::now() >= deadline {
            return Err("Folder scan exceeded 60 seconds".into());
        }
        if depth > 32 {
            return Err("Folder nesting exceeds 32 levels; choose a smaller folder".into());
        }
        let mut has_manifest = false;
        for entry in directory
            .read_dir(if relative.as_os_str().is_empty() {
                Path::new(".")
            } else {
                &relative
            })
            .map_err(err)?
        {
            let entry = entry.map_err(err)?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err("Folder exceeds 20,000 entries; choose a smaller folder".into());
            }
            let kind = entry.file_type().map_err(err)?;
            let name = entry.file_name();
            if name == "manifest.json" {
                has_manifest = true;
            }
            if kind.is_dir() && name != ".git" && name != "node_modules" && name != "target" {
                pending.push((relative.join(name), depth + 1));
            }
        }
        if has_manifest {
            let path = candidate_path(&relative)?;
            let artifact = (|| {
                let manifest = read_source_file(&directory, &relative.join("manifest.json"))?;
                let code = read_source_file(&directory, &relative.join("plugin.js"))?;
                artifact_from_text(&manifest, code)
            })();
            prepared.add(path, artifact)?;
        }
    }
    prepared
        .preview
        .candidates
        .sort_by(|a, b| a.path.cmp(&b.path));
    Ok(prepared)
}

fn candidate_path(relative: &Path) -> Result<String> {
    if relative.as_os_str().is_empty() {
        return Ok(".".into());
    }
    Ok(relative
        .components()
        .map(|c| {
            c.as_os_str()
                .to_str()
                .ok_or("Plugin folder names must be UTF-8")
        })
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("/"))
}

// All descendant resolution is relative to an opened directory capability: an ancestor
// swapped for an escaping symlink cannot redirect reads outside the selected folder.
fn read_source_file(directory: &cap_std::fs::Dir, path: &Path) -> Result<String> {
    if !directory
        .symlink_metadata(path)
        .map_err(err)?
        .file_type()
        .is_file()
    {
        return Err("Plugin files must be regular files, not symbolic links".into());
    }
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = directory.open_with(path, &options).map_err(err)?;
    if !file.metadata().map_err(err)?.is_file() {
        return Err("Plugin files must be regular files".into());
    }
    crate::read_file_limited(file.into_std())
}

/// Only explicit HTTPS/SSH transports. No local paths, URL helpers, credentials in HTTPS,
/// GitHub web tree URLs, or shell interpretation. A separate ref avoids ambiguous slash parsing.
pub fn repository_url(input: &str) -> Result<String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err("Repository URL is too long".into());
    }
    let expanded = if input.starts_with("git@") && !input.contains("://") {
        let (host, path) = input
            .split_once(':')
            .ok_or("Expected git@host:owner/repository.git")?;
        format!("ssh://{host}/{path}")
    } else if input.starts_with("github.com/") {
        format!("https://{input}")
    } else if !input.contains(':') && input.split('/').count() == 2 {
        format!("https://github.com/{input}")
    } else {
        input.into()
    };
    let url = url::Url::parse(&expanded).map_err(|_| "Enter an HTTPS or SSH repository URL")?;
    if !["https", "ssh"].contains(&url.scheme())
        || url.host_str().is_none()
        || url.host_str().is_some_and(|host| host.starts_with('-'))
        || url.username().starts_with('-')
        || url.password().is_some()
        || (url.scheme() == "https" && !url.username().is_empty())
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path().trim_matches('/').is_empty()
        || expanded
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(
            "Use an HTTPS or SSH repository URL without a password, query or fragment".into(),
        );
    }
    if url.host_str() == Some("github.com") && url.path().trim_matches('/').split('/').count() != 2
    {
        return Err("Use the GitHub repository URL, not a tree/file URL. Enter the branch or tag separately, then select a plugin folder.".into());
    }
    Ok(url.to_string())
}

struct Git {
    scratch: tempfile::TempDir,
    deadline: Instant,
}
impl Git {
    fn new() -> Result<Self> {
        Ok(Self {
            scratch: tempfile::tempdir().map_err(err)?,
            deadline: Instant::now() + Duration::from_secs(60),
        })
    }
    fn command(&self) -> Command {
        let mut command = Command::new("git");
        command.env_clear();
        // Retain SSH-agent authentication and platform tool lookup, but not Git's ambient
        // repository/config/transport overrides. No credential helpers or interactive prompts.
        for key in ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "SSH_AUTH_SOCK"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env(
                "GIT_SSH_COMMAND",
                format!("ssh -F {null} -oBatchMode=yes -oStrictHostKeyChecking=yes"),
            )
            .args([
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "protocol.ssh.allow=always",
                "-c",
                "core.fsmonitor=false",
                "-c",
                &format!("core.hooksPath={null}"),
            ])
            .current_dir(self.scratch.path());
        command
    }
    fn run(&self, args: &[&str], limit: u64) -> Result<Vec<u8>> {
        let mut command = self.command();
        command.args(args);
        self.run_command(command, limit)
    }
    fn run_command(&self, mut command: Command, limit: u64) -> Result<Vec<u8>> {
        let output = tempfile::tempfile().map_err(err)?;
        let errors = tempfile::tempfile().map_err(err)?;
        command
            .stdin(Stdio::null())
            .stdout(output.try_clone().map_err(err)?)
            .stderr(errors.try_clone().map_err(err)?);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start Git: {e}. Install Git to load repositories."))?;
        let result = (|| loop {
            if Instant::now() >= self.deadline {
                return Err("Repository import exceeded 60 seconds".into());
            }
            if output.metadata().map_err(err)?.len() > limit
                || errors.metadata().map_err(err)?.len() > LIMIT
            {
                return Err("Git output exceeds the import size limit".into());
            }
            if directory_size(self.scratch.path())? > MAX_REPO_BYTES {
                return Err("Repository exceeds the 256 MiB import limit".into());
            }
            if let Some(status) = child.try_wait().map_err(err)? {
                if !status.success() {
                    let text = read_output(errors, 4096)?;
                    return Err(format!(
                        "Git could not read this repository: {}",
                        String::from_utf8_lossy(&text).trim()
                    ));
                }
                return read_output(output, limit);
            }
            thread::sleep(Duration::from_millis(50));
        })();
        if result.is_err() {
            // Stop the complete Git/SSH transport group, not just its parent, before cleanup.
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        result
    }
    fn read_plugins(&self, source: String) -> Result<PreparedImport> {
        let commit = String::from_utf8(self.run(&["-C", "repository", "rev-parse", "HEAD"], 1024)?)
            .map_err(err)?
            .trim()
            .to_string();
        let tree = self.run(
            &["-C", "repository", "ls-tree", "-rz", "--full-tree", "HEAD"],
            2 * 1024 * 1024,
        )?;
        let mut blobs = BTreeMap::new();
        for (index, entry) in tree
            .split(|b| *b == 0)
            .filter(|b| !b.is_empty())
            .enumerate()
        {
            if index >= MAX_ENTRIES {
                return Err("Repository exceeds 20,000 files; use a smaller repository".into());
            }
            let entry =
                std::str::from_utf8(entry).map_err(|_| "Repository filenames must be UTF-8")?;
            let (meta, path) = entry.split_once('\t').ok_or("Invalid Git tree")?;
            let mut meta = meta.split(' ');
            let mode = meta.next().unwrap_or_default();
            let kind = meta.next().unwrap_or_default();
            let oid = meta.next().unwrap_or_default();
            // Never check out a working tree: symlinks, submodules, attributes/filters and
            // repository scripts cannot become executable acquisition steps.
            if kind == "blob" && (mode == "100644" || mode == "100755") {
                blobs.insert(path.to_string(), oid.to_string());
            }
        }
        let mut prepared = PreparedImport::new(source, Some(commit))?;
        for (path, manifest_oid) in &blobs {
            if path != "manifest.json" && !path.ends_with("/manifest.json") {
                continue;
            }
            if path
                .split('/')
                .any(|s| s == "node_modules" || s == "target")
            {
                continue;
            }
            let parent = path.strip_suffix("manifest.json").unwrap();
            let display = if parent.is_empty() {
                "."
            } else {
                parent.trim_end_matches('/')
            };
            let Some(code_oid) = blobs.get(&format!("{parent}plugin.js")) else {
                prepared.add(
                    display.into(),
                    Err("No built plugin.js beside manifest.json; build the plugin first".into()),
                )?;
                continue;
            };
            let mut contents = vec![];
            let mut oversized = false;
            for oid in [manifest_oid, code_oid] {
                let size = String::from_utf8(
                    self.run(&["-C", "repository", "cat-file", "-s", oid], 1024)?,
                )
                .map_err(err)?;
                if size.trim().parse::<u64>().map_err(err)? > LIMIT {
                    oversized = true;
                    break;
                }
                let bytes = self.run(&["-C", "repository", "cat-file", "blob", oid], LIMIT)?;
                contents.push(String::from_utf8(bytes).map_err(err)?);
            }
            let artifact = if oversized {
                Err("File exceeds 8 MiB".into())
            } else {
                let code = contents.pop().unwrap();
                artifact_from_text(&contents[0], code)
            };
            prepared.add(display.into(), artifact)?;
        }
        Ok(prepared)
    }
}

pub fn prepare_git(repository: &str, reference: &str) -> Result<PreparedImport> {
    let url = repository_url(repository)?;
    let reference = reference.trim();
    if !reference.is_empty()
        && (reference.starts_with('-')
            || reference.len() > 200
            || !reference
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._/-".contains(c)))
    {
        return Err("Enter a branch or tag name using letters, digits, dots, underscores, slashes or hyphens".into());
    }
    let git = Git::new()?;
    let mut args = vec![
        "clone",
        "--depth=1",
        "--single-branch",
        "--no-tags",
        "--no-checkout",
        "--template=",
    ];
    if !reference.is_empty() {
        args.extend(["--branch", reference]);
    }
    args.extend(["--", &url, "repository"]);
    git.run(&args, LIMIT)?;
    git.read_plugins(url)
}
fn read_output(mut file: File, limit: u64) -> Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0)).map_err(err)?;
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("Git output exceeds the import size limit".into());
    }
    Ok(bytes)
}
fn directory_size(root: &Path) -> Result<u64> {
    let mut pending = vec![root.to_path_buf()];
    let mut bytes = 0;
    let mut count = 0;
    while let Some(path) = pending.pop() {
        for entry in fs::read_dir(path).map_err(err)? {
            let entry = entry.map_err(err)?;
            count += 1;
            if count > MAX_ENTRIES {
                return Err("Repository exceeds the import entry limit".into());
            }
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(err(e)),
            };
            if meta.is_dir() {
                pending.push(entry.path());
            } else {
                bytes += meta.len();
            }
            if bytes > MAX_REPO_BYTES {
                return Ok(bytes);
            }
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plugin(root: &Path, folder: &str, id: &str) -> PathBuf {
        let path = root.join(folder);
        fs::create_dir_all(&path).unwrap();
        fs::write(
            path.join("manifest.json"),
            format!(r#"{{"id":"{id}","name":"{id}","apiVersion":1}}"#),
        )
        .unwrap();
        fs::write(
            path.join("plugin.js"),
            "export function apply() {} // first",
        )
        .unwrap();
        path
    }
    #[test]
    fn folder_discovers_nested_dist_and_installs_exact_preview_without_execution() {
        let root = tempfile::tempdir().unwrap();
        let source = plugin(root.path(), "pages/one/dist", "example.one");
        plugin(root.path(), "panels/two", "example.two");
        plugin(root.path(), "node_modules/skipped", "example.skipped");
        fs::write(root.path().join("manifest.json"), "{}").unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.preview.candidates[0].path, "pages/one/dist");
        assert_eq!(prepared.preview.warnings.len(), 1);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        assert!(prepared
            .install(&manager, "wrong", "pages/one/dist")
            .is_err());
        assert!(prepared
            .install(&manager, &prepared.preview.token, "../escape")
            .is_err());
        fs::write(
            source.join("plugin.js"),
            "throw Error('changed'); while(true) {}",
        )
        .unwrap();
        let catalog = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        let installed = catalog
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(!installed.enabled);
        manager.change("enable", "example.one").unwrap();
        assert!(manager
            .module("example.one", &installed.revision)
            .unwrap()
            .contains("first"));
        // Repeating the exact preview is idempotent; update/rollback retain ordinary semantics.
        let again = prepared
            .install(&manager, &prepared.preview.token, "pages/one/dist")
            .unwrap();
        assert!(again
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap()
            .previous
            .is_none());
        let update = prepare_folder(root.path()).unwrap();
        let next = update
            .install(&manager, &update.preview.token, "pages/one/dist")
            .unwrap();
        let installed = next
            .plugins
            .iter()
            .find(|p| p.manifest.id == "example.one")
            .unwrap();
        assert!(installed.enabled);
        assert!(installed.previous.is_some());
    }
    #[cfg(unix)]
    #[test]
    fn folder_never_follows_symlinks_or_reads_special_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "outside", "example.outside");
        symlink(outside.path(), root.path().join("escape")).unwrap();
        let folder = plugin(root.path(), "bad", "example.bad");
        fs::remove_file(folder.join("plugin.js")).unwrap();
        symlink(
            outside.path().join("outside/plugin.js"),
            folder.join("plugin.js"),
        )
        .unwrap();
        let fifo = plugin(root.path(), "fifo", "example.fifo");
        fs::remove_file(fifo.join("plugin.js")).unwrap();
        let name =
            std::ffi::CString::new(fifo.join("plugin.js").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 2);
    }
    #[cfg(unix)]
    #[test]
    fn folder_identity_is_lossless_and_capability_rejects_replaced_ancestors() {
        use std::os::unix::{ffi::OsStringExt, fs::symlink};
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "a\\b", "example.backslash");
        plugin(root.path(), "a/b", "example.slash");
        let prepared = prepare_folder(root.path()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.artifacts.len(), 2);
        let home = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(home.path().into()), "test", false).unwrap();
        for candidate in &prepared.preview.candidates {
            let catalog = prepared
                .install(&manager, &prepared.preview.token, &candidate.path)
                .unwrap();
            assert!(catalog.plugins.iter().any(
                |p| p.manifest.id == candidate.manifest.id && p.revision == candidate.revision
            ));
        }
        let outside = tempfile::tempdir().unwrap();
        plugin(outside.path(), "b", "example.outside");
        let directory =
            cap_std::fs::Dir::open_ambient_dir(root.path(), cap_std::ambient_authority()).unwrap();
        fs::rename(root.path().join("a"), root.path().join("old-a")).unwrap();
        symlink(outside.path(), root.path().join("a")).unwrap();
        assert!(read_source_file(&directory, Path::new("a/b/plugin.js")).is_err());
        let invalid = root
            .path()
            .join(std::ffi::OsString::from_vec(vec![b'p', 0xff]));
        // macOS filesystems reject invalid UTF-8 names at creation; exercise the production
        // key conversion directly so this check is meaningful on Linux and macOS.
        assert!(candidate_path(&invalid).is_err());
    }
    #[test]
    fn rejects_invalid_artifacts_and_bounds_preview_size() {
        let root = tempfile::tempdir().unwrap();
        plugin(root.path(), "bundled", "buzz.channels");
        let bad = plugin(root.path(), "unsupported", "example.bad");
        fs::write(
            bad.join("manifest.json"),
            r#"{"id":"example.bad","name":"Bad","apiVersion":2}"#,
        )
        .unwrap();
        let empty = plugin(root.path(), "empty", "example.empty");
        fs::write(empty.join("plugin.js"), " ").unwrap();
        let large = plugin(root.path(), "large", "example.large");
        File::create(large.join("plugin.js"))
            .unwrap()
            .set_len(LIMIT + 1)
            .unwrap();
        let prepared = prepare_folder(root.path()).unwrap();
        assert!(prepared.preview.candidates.is_empty());
        assert_eq!(prepared.preview.warnings.len(), 4);
        for n in 0..=MAX_PLUGINS {
            plugin(root.path(), &format!("many/{n}"), &format!("example.p{n}"));
        }
        assert!(prepare_folder(root.path()).is_err());
    }
    #[test]
    fn accepts_explicit_transports_and_github_shorthand_only() {
        assert_eq!(
            repository_url("block/plugins").unwrap(),
            "https://github.com/block/plugins"
        );
        assert_eq!(
            repository_url("git@github.com:block/plugins.git").unwrap(),
            "ssh://git@github.com/block/plugins.git"
        );
        assert!(repository_url("https://git.example.org/team/repo.git").is_ok());
        for input in [
            "/tmp/repo",
            "file:///tmp/repo",
            "ext::sh -c bad",
            "git://example.com/repo",
            "https://me:secret@example.com/repo",
            "https://example.com/repo?token=secret",
            "https://github.com/block/repo/tree/main/plugins",
            "--upload-pack=bad",
            "ssh://-oProxyCommand=bad/repo",
        ] {
            assert!(repository_url(input).is_err(), "{input}");
        }
        assert!(prepare_git("block/plugins", "--upload-pack=bad").is_err());
    }
    #[test]
    fn git_reads_committed_blobs_without_checkout_filters_symlinks_or_scripts() {
        let git = Git::new().unwrap();
        git.run(&["init", "--template=", "repository"], LIMIT)
            .unwrap();
        let repo = git.scratch.path().join("repository");
        plugin(&repo, "plugins/one/dist", "example.one");
        plugin(&repo, "plugins/two", "example.two");
        fs::write(
            repo.join("package.json"),
            r#"{"scripts":{"postinstall":"exit 1"}}"#,
        )
        .unwrap();
        fs::write(repo.join(".gitattributes"), "*.js filter=must-not-run").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", repo.join("outside")).unwrap();
        git.run(&["-C", "repository", "add", "."], LIMIT).unwrap();
        git.run(
            &[
                "-C",
                "repository",
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "fixture",
            ],
            LIMIT,
        )
        .unwrap();
        fs::write(
            repo.join("plugins/one/dist/plugin.js"),
            "uncommitted change",
        )
        .unwrap();
        let prepared = git.read_plugins("fixture".into()).unwrap();
        assert_eq!(prepared.preview.candidates.len(), 2);
        assert_eq!(prepared.preview.commit.as_ref().unwrap().len(), 40);
        let text = String::from_utf8(prepared.artifacts["plugins/one/dist"].clone()).unwrap();
        assert!(text.contains("first"));
        assert!(!text.contains("uncommitted"));
    }
    #[test]
    fn git_deadline_and_output_limits_fail() {
        let mut git = Git::new().unwrap();
        assert!(git.run(&["--version"], 1).is_err());
        git.deadline = Instant::now();
        assert!(git
            .run(&["--version"], LIMIT)
            .unwrap_err()
            .contains("60 seconds"));
    }
    #[cfg(unix)]
    #[test]
    fn timeout_terminates_spawned_descendant_before_it_can_write() {
        let mut git = Git::new().unwrap();
        git.deadline = Instant::now() + Duration::from_millis(500);
        let mut command = Command::new("sh");
        command
            .current_dir(git.scratch.path())
            .args(["-c", "(touch child-started; sleep 1; touch escaped) & wait"]);
        let result = git.run_command(command, LIMIT);
        assert!(result.unwrap_err().contains("60 seconds"));
        assert!(git.scratch.path().join("child-started").exists());
        thread::sleep(Duration::from_millis(1200));
        assert!(!git.scratch.path().join("escaped").exists());
        // Positive control: the same delayed descendant really can write without a timeout.
        git.deadline = Instant::now() + Duration::from_secs(5);
        let mut control = Command::new("sh");
        control
            .current_dir(git.scratch.path())
            .args(["-c", "(sleep 1; touch escaped) & wait"]);
        git.run_command(control, LIMIT).unwrap();
        assert!(git.scratch.path().join("escaped").exists());
    }
}
