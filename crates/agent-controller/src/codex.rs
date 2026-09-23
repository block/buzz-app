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
        let resolve = |name: &str| -> Result<PathBuf> {
            let candidates = if Path::new(name).is_absolute() {
                vec![PathBuf::from(name)]
            } else {
                directories.iter().map(|d| d.join(name)).collect()
            };
            candidates.into_iter().find(|p| {
                #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; p.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0) }
                #[cfg(not(unix))] { p.is_file() }
            }).ok_or_else(|| format!("Install {name}, or choose the installed codex-acp executable's absolute path."))
        };
        Ok(Self {
            adapter: resolve(&harness.command)?,
            cli: resolve("codex")?,
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
