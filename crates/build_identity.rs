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

pub fn capture(root: &Path) -> BuildIdentity {
    let revision = git(root, &["rev-parse", "--verify", "HEAD^{commit}"]);
    let repository_root = git(root, &["rev-parse", "--show-toplevel"]);
    let status = repository_root.as_deref().and_then(|repository_root| {
        git(
            Path::new(repository_root.trim()),
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ],
        )
    });
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

        run_git(root, &["init", "--quiet"]);
        run_git(root, &["config", "user.name", "Build identity test"]);
        run_git(
            root,
            &["config", "user.email", "build-identity@example.org"],
        );
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "--quiet", "-m", "initial source"]);

        fs::write(&crate_source, "pub fn source() { /* changed */ }\n").unwrap();

        assert_eq!(capture(&native).state, SourceState::Dirty);
    }
}
