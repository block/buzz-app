use serde::Serialize;
use std::{path::Path, process::Command};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceState {
    Clean,
    Dirty,
    Unknown,
}

impl SourceState {
    fn parse(value: Option<&str>) -> Self {
        match value {
            Some("clean") => Self::Clean,
            Some("dirty") => Self::Dirty,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Dirty => "dirty",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildIdentity {
    pub revision: Option<String>,
    pub state: SourceState,
}

pub fn compiled(revision: Option<&str>, state: Option<&str>) -> BuildIdentity {
    let revision = revision.and_then(valid_revision).map(str::to_owned);
    let state = if revision.is_some() {
        SourceState::parse(state)
    } else {
        SourceState::Unknown
    };
    BuildIdentity { revision, state }
}

pub fn configure_native_build(manifest_dir: &Path) {
    let root = manifest_dir.parent().unwrap_or(manifest_dir);
    for path in [
        "src-tauri/src",
        "src-tauri/Cargo.toml",
        "Cargo.toml",
        "Cargo.lock",
        "crates",
        "src/bundled/mesh-compute/compute",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    let identity = capture(root);
    if identity.revision.is_some() {
        // Resolve through Git: linked worktrees keep HEAD/index and refs in different directories.
        for name in ["HEAD", "index", "refs", "packed-refs"] {
            if let Some(path) = git(root, &["rev-parse", "--git-path", name]) {
                let path = root.join(path.trim());
                // Watching absent packed-refs would invalidate every Cargo invocation.
                if path.exists() {
                    println!("cargo:rerun-if-changed={}", path.display());
                }
            }
        }
    }
    println!(
        "cargo:rustc-env=BUZZ_NATIVE_SOURCE_REVISION={}",
        identity.revision.as_deref().unwrap_or_default()
    );
    println!(
        "cargo:rustc-env=BUZZ_NATIVE_SOURCE_STATE={}",
        identity.state.as_str()
    );
}

pub fn capture(root: &Path) -> BuildIdentity {
    let repository_root = git(root, &["rev-parse", "--show-toplevel"])
        .and_then(|path| Path::new(path.trim()).canonicalize().ok());
    if repository_root.is_none() || repository_root != root.canonicalize().ok() {
        return compiled(None, None);
    }
    let revision = git(root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let status = git(
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
        ],
    );
    from_git_outputs(revision.as_deref(), status.as_deref())
}

fn from_git_outputs(revision: Option<&str>, status: Option<&str>) -> BuildIdentity {
    let revision = revision.and_then(valid_revision).map(str::to_owned);
    let state = match (revision.as_ref(), status) {
        (Some(_), Some(status)) => SourceState::parse(Some(if status.trim().is_empty() {
            "clean"
        } else {
            "dirty"
        })),
        _ => SourceState::Unknown,
    };
    BuildIdentity { revision, state }
}

fn valid_revision(value: &str) -> Option<&str> {
    let value = value.trim();
    let valid_length = matches!(value.len(), 40 | 64);
    (valid_length && value.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(value)
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", root.to_str()?])
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::{capture, compiled, from_git_outputs, BuildIdentity, SourceState};
    use std::{fs, path::Path, process::Command};

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(["-C", root.to_str().unwrap()])
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", root.join(".unused-global-git-config"))
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git {:?} failed", args);
    }

    #[test]
    fn reports_distinct_source_states_without_promoting_unknown_to_clean() {
        let revision = "a".repeat(40);
        assert_eq!(
            from_git_outputs(Some(&revision), Some("")),
            BuildIdentity {
                revision: Some(revision.clone()),
                state: SourceState::Clean,
            }
        );
        assert_eq!(
            from_git_outputs(Some(&revision), Some(" M src/main.rs\n")),
            BuildIdentity {
                revision: Some(revision),
                state: SourceState::Dirty,
            }
        );
        assert_eq!(
            compiled(None, Some("clean")),
            BuildIdentity {
                revision: None,
                state: SourceState::Unknown,
            }
        );
        assert_eq!(
            compiled(Some(&"c".repeat(40)), Some("dirty")).state,
            SourceState::Dirty
        );
        assert_eq!(
            compiled(Some(&"c".repeat(40)), Some("unrecognized")).state,
            SourceState::Unknown
        );
        assert_eq!(
            from_git_outputs(Some("not-a-revision"), Some("")),
            BuildIdentity {
                revision: None,
                state: SourceState::Unknown,
            }
        );
        assert_eq!(
            from_git_outputs(Some(&"b".repeat(40)), None).state,
            SourceState::Unknown
        );
    }

    #[test]
    fn source_archives_without_git_remain_buildable_and_unknown() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            capture(directory.path()),
            BuildIdentity {
                revision: None,
                state: SourceState::Unknown,
            }
        );
        let root = directory.path();
        run_git(root, &["init", "--quiet", "--template="]);
        run_git(root, &["config", "user.name", "Build identity test"]);
        run_git(
            root,
            &["config", "user.email", "build-identity@example.org"],
        );
        run_git(root, &["config", "commit.gpgsign", "false"]);
        fs::write(root.join(".gitignore"), "archive/\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "enclosing source"]);
        let archive = root.join("archive");
        fs::create_dir(&archive).unwrap();
        assert_eq!(capture(&archive), compiled(None, None));
    }

    #[test]
    fn reports_repository_changes_outside_the_native_manifest_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let native = root.join("src-tauri");
        let crate_source = root.join("crates/build_identity.rs");
        fs::create_dir_all(&native).unwrap();
        fs::create_dir_all(crate_source.parent().unwrap()).unwrap();
        fs::write(native.join("build.rs"), "fn main() {}\n").unwrap();
        fs::write(&crate_source, "pub fn source() {}\n").unwrap();

        run_git(root, &["init", "--quiet", "--template="]);
        run_git(root, &["config", "user.name", "Build identity test"]);
        run_git(root, &["config", "commit.gpgsign", "false"]);
        run_git(
            root,
            &["config", "user.email", "build-identity@example.org"],
        );
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "initial source"]);

        fs::write(&crate_source, "pub fn source() { /* changed */ }\n").unwrap();

        assert_eq!(capture(root).state, SourceState::Dirty);
    }

    #[test]
    fn incremental_native_build_refreshes_dependency_and_git_only_changes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("repository");
        let native = root.join("src-tauri");
        fs::create_dir_all(native.join("src")).unwrap();
        fs::create_dir_all(root.join("dependency/src")).unwrap();
        fs::create_dir_all(root.join("crates")).unwrap();
        fs::create_dir_all(root.join("src/bundled/mesh-compute/compute")).unwrap();
        fs::write(root.join(".gitignore"), "/target/\n").unwrap();
        fs::write(
            root.join("Cargo.toml"),
            "[workspace]\nmembers = [\"src-tauri\", \"dependency\"]\nresolver = \"2\"\n",
        )
        .unwrap();
        fs::write(
            native.join("Cargo.toml"),
            "[package]\nname = \"identity-fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\
             [dependencies]\nidentity-dependency = { path = \"../dependency\" }\n\
             [build-dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\n",
        )
        .unwrap();
        let dependency_manifest = root.join("dependency/Cargo.toml");
        let manifest =
            "[package]\nname = \"identity-dependency\"\nversion = \"0.1.0\"\nedition = \"2021\"\n";
        fs::write(&dependency_manifest, manifest).unwrap();
        fs::write(
            root.join("dependency/src/lib.rs"),
            "pub fn version() -> &'static str { env!(\"CARGO_PKG_VERSION\") }\n",
        )
        .unwrap();
        fs::write(
            root.join("crates/build_identity.rs"),
            include_str!("build_identity.rs"),
        )
        .unwrap();
        fs::write(root.join("src/bundled/mesh-compute/compute/.keep"), "").unwrap();
        fs::write(
            native.join("build.rs"),
            "#[path = \"../crates/build_identity.rs\"] mod build_identity;\n\
             fn main() { build_identity::configure_native_build(std::path::Path::new(env!(\"CARGO_MANIFEST_DIR\"))); }\n",
        )
        .unwrap();
        fs::write(
            native.join("src/main.rs"),
            "fn main() { println!(\"{} {} {}\", env!(\"BUZZ_NATIVE_SOURCE_REVISION\"), \
             env!(\"BUZZ_NATIVE_SOURCE_STATE\"), identity_dependency::version()); }\n",
        )
        .unwrap();
        let cargo = |root: &Path, command: &str| {
            let output = Command::new(env!("CARGO"))
                .args([command, "--offline", "--quiet", "-p", "identity-fixture"])
                .current_dir(root)
                .env_remove("CARGO_TARGET_DIR")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", root.join(".unused-global-git-config"))
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "cargo {command} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        cargo(&root, "build");
        run_git(&root, &["init", "--quiet", "--template="]);
        run_git(&root, &["config", "user.name", "Build identity test"]);
        run_git(
            &root,
            &["config", "user.email", "build-identity@example.org"],
        );
        run_git(&root, &["config", "commit.gpgsign", "false"]);
        run_git(&root, &["add", "."]);
        run_git(&root, &["commit", "--quiet", "-m", "initial source"]);
        let worktree = directory.path().join("worktree");
        run_git(
            &root,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "fixture",
                worktree.to_str().unwrap(),
            ],
        );
        let revision = capture(&worktree).revision.unwrap();
        assert_eq!(cargo(&worktree, "run"), format!("{revision} clean 0.1.0"));

        // Cargo relinks a normal dependency, without changing the build script or Rust sources.
        fs::write(
            worktree.join("dependency/Cargo.toml"),
            manifest.replace("0.1.0", "0.2.0"),
        )
        .unwrap();
        assert_eq!(cargo(&worktree, "run"), format!("{revision} dirty 0.2.0"));

        run_git(&worktree, &["add", "."]);
        run_git(&worktree, &["commit", "--quiet", "-m", "update dependency"]);
        let revision = capture(&worktree).revision.unwrap();
        assert_eq!(cargo(&worktree, "run"), format!("{revision} clean 0.2.0"));
        run_git(&worktree, &["pack-refs", "--all"]);
        assert_eq!(cargo(&worktree, "run"), format!("{revision} clean 0.2.0"));
        run_git(
            &worktree,
            &[
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "move packed ref",
            ],
        );
        let revision = capture(&worktree).revision.unwrap();
        assert_eq!(cargo(&worktree, "run"), format!("{revision} clean 0.2.0"));
    }
}
