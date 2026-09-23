//! Shared discovery and launch context for an installed Codex adapter.
use crate::{HarnessEdit, Result};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Command,
};

/// Recognize the supported adapter without interpreting arbitrary commands.
pub fn is_codex(command: &str) -> bool {
    Path::new(command).file_name().and_then(|s| s.to_str()) == Some("codex-acp")
}

/// Native-only execution settings; never serialize credential-bearing values.
#[derive(Clone)]
pub struct Context {
    /// Resolved adapter executable.
    pub adapter: PathBuf,
    /// Resolved CLI used for the separate login check.
    pub cli: PathBuf,
    /// Adapter arguments, identical to launch.
    pub args: Vec<String>,
    /// Effective workspace.
    pub workspace: PathBuf,
    environment: BTreeMap<String, String>,
    path: std::ffi::OsString,
}
impl Context {
    /// Resolve the installed tools and effective configuration without spawning.
    pub fn new(
        harness: &HarnessEdit,
        environment: &BTreeMap<String, String>,
        workspace: &str,
    ) -> Result<Self> {
        if harness.command != "codex-acp" && !Path::new(&harness.command).is_absolute() {
            return Err("Choose codex-acp or an absolute adapter executable path.".into());
        }
        if !harness.provider.is_empty() {
            return Err(
                "Codex uses its own provider configuration. Clear the Provider field.".into(),
            );
        }
        if !Path::new(workspace).is_dir() {
            return Err("Choose an existing workspace for Codex.".into());
        }
        let mut directories = Vec::new();
        if Path::new(&harness.command).is_absolute() {
            if let Some(parent) = Path::new(&harness.command).parent() {
                directories.push(parent.to_path_buf());
            }
        }
        // Reuse the original Buzz installation before system-wide adapters.
        // An explicit adapter path above still wins for isolated/custom contexts.
        directories.extend(buzz_managed_directories());
        if let Some(home) = std::env::var_os("HOME") {
            directories.push(PathBuf::from(home).join(".local/bin"));
        }
        directories.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .map(PathBuf::from),
        );
        Ok(Self {
            adapter: resolve_executable(&harness.command, &directories)?,
            cli: resolve_executable("codex", &directories)?,
            args: harness.args.clone(),
            workspace: PathBuf::from(workspace),
            environment: environment.clone(),
            path: std::env::join_paths(directories).map_err(|_| "Invalid Codex executable path")?,
        })
    }
    /// Apply the same isolated environment to probes and the running harness.
    pub fn apply_environment(&self, command: &mut Command) -> Result<()> {
        for name in [
            "HOME",
            "CODEX_HOME",
            "TMPDIR",
            "USER",
            "LOGNAME",
            "LANG",
            "SSH_AUTH_SOCK",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.envs(&self.environment).env("PATH", &self.path);
        Ok(())
    }
    /// Build an isolated command without launching it.
    pub fn command(&self, executable: &Path) -> Result<Command> {
        let mut command = Command::new(executable);
        command.env_clear().current_dir(&self.workspace);
        self.apply_environment(&mut command)?;
        Ok(command)
    }
}

fn buzz_managed_directories() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    let data = home.join("Library/Application Support");
    #[cfg(not(target_os = "macos"))]
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".local/share"));
    managed_directories(&data)
}

fn managed_directories(data: &Path) -> Vec<PathBuf> {
    let root = data.join("Buzz");
    let mut paths = vec![root.join("node-tools/bin")];
    let platform = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        _ => None,
    };
    if let Some(platform) = platform {
        // Same pinned managed Node layout as Buzz's managed_node_paths.rs.
        paths.push(
            root.join("runtimes/node/v24.18.0")
                .join(platform)
                .join("bin"),
        );
    }
    paths
}

fn resolve_executable(name: &str, directories: &[PathBuf]) -> Result<PathBuf> {
    let candidates = if Path::new(name).is_absolute() {
        vec![PathBuf::from(name)]
    } else {
        directories.iter().map(|d| d.join(name)).collect()
    };
    candidates
        .into_iter()
        .find(|p| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                p.metadata()
                    .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                p.is_file()
            }
        })
        .ok_or_else(|| {
            format!("Install {name}, or choose the installed codex-acp executable's absolute path.")
        })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn managed_adapter_wins_and_absolute_override_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let mut paths = managed_directories(dir.path());
        let system = dir.path().join("system");
        paths.push(system.clone());
        for path in [&paths[0], &system] {
            std::fs::create_dir_all(path).unwrap();
            let executable = path.join("codex-acp");
            std::fs::write(&executable, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            resolve_executable("codex-acp", &paths).unwrap(),
            paths[0].join("codex-acp")
        );
        let explicit = system.join("codex-acp");
        assert_eq!(
            resolve_executable(explicit.to_str().unwrap(), &paths).unwrap(),
            explicit
        );
        std::fs::remove_file(paths[0].join("codex-acp")).unwrap();
        assert_eq!(resolve_executable("codex-acp", &paths).unwrap(), explicit);
    }
}
