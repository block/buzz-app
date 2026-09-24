//! Shared discovery and launch context for an installed Codex adapter.
use crate::{HarnessEdit, Result};
use std::{
    collections::BTreeMap,
    io::Read,
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
    /// Explicit CLI override, or the adapter used to invoke its bundled CLI.
    pub cli: PathBuf,
    /// Adapter arguments, identical to launch.
    pub args: Vec<String>,
    /// Effective workspace.
    pub workspace: PathBuf,
    bundled_cli: bool,
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
        let adapter = resolve_executable(&harness.command, &directories)?;
        let bundled_cli = !environment.contains_key("CODEX_PATH");
        let cli = if let Some(path) = environment.get("CODEX_PATH") {
            if !Path::new(path).is_absolute() {
                return Err("CODEX_PATH must be an absolute Codex CLI executable path.".into());
            }
            let cli = resolve_executable(path, &directories)?;
            validate_interpreter(&cli, &directories)?;
            cli
        } else {
            adapter.clone()
        };
        validate_interpreter(&adapter, &directories)?;
        let mut effective = BTreeMap::new();
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
            if let Ok(value) = std::env::var(name) {
                effective.insert(name.to_owned(), value);
            }
        }
        effective.extend(environment.clone());
        Ok(Self {
            adapter,
            cli,
            bundled_cli,
            args: harness.args.clone(),
            workspace: PathBuf::from(workspace),
            environment: effective,
            path: std::env::join_paths(directories).map_err(|_| "Invalid Codex executable path")?,
        })
    }
    /// Probe the same CLI the adapter uses, including its bundled default.
    pub fn cli_command(&self) -> Result<Command> {
        let mut command = self.command(&self.cli)?;
        if self.bundled_cli {
            command.arg("cli");
        }
        Ok(command)
    }
    /// Apply the same isolated environment to probes and the running harness.
    pub fn apply_environment(&self, command: &mut Command) -> Result<()> {
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

// Inspect only the bounded shebang, never load an entire adapter bundle.
fn validate_interpreter(executable: &Path, directories: &[PathBuf]) -> Result<()> {
    let mut prefix = [0; 256];
    let count = std::fs::File::open(executable)
        .and_then(|mut file| file.read(&mut prefix))
        .map_err(|_| "Could not inspect the Codex executable. Check installation permissions.")?;
    if !prefix[..count].starts_with(b"#!") {
        return Ok(());
    }
    let end = prefix[..count]
        .iter()
        .position(|b| *b == b'\n')
        .ok_or("Codex executable has an invalid or oversized interpreter line.")?;
    let line = std::str::from_utf8(&prefix[2..end])
        .map_err(|_| "Codex executable has an invalid interpreter line.")?;
    let mut words = line.split_whitespace();
    let interpreter = words.next().ok_or("Codex executable has no interpreter.")?;
    if interpreter == "/usr/bin/env" {
        // The supported npm shim uses env node. Do not evaluate shell syntax or
        // silently accept env options with different resolution semantics.
        let name = words.next().filter(|name| *name == "node").ok_or(
            "Unsupported Codex interpreter. Choose the installed Node-based codex-acp executable.",
        )?;
        if words.next().is_some() {
            return Err("Unsupported Codex interpreter arguments. Choose the installed codex-acp executable.".into());
        }
        resolve_executable(name, directories)
            .map_err(|_| "Codex requires Node. Install Node alongside codex-acp or in a supported executable directory.".to_owned())?;
    } else {
        if !Path::new(interpreter).is_absolute() {
            return Err("Codex requires an absolute interpreter path.".into());
        }
        resolve_executable(interpreter, directories).map_err(|_| {
            "Codex interpreter is missing or not executable. Repair the installation.".to_owned()
        })?;
    }
    Ok(())
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
    #[test]
    fn interpreter_checks_are_bounded_and_use_the_resolved_path() {
        let dir = tempfile::Builder::new()
            .prefix("codex tools ")
            .tempdir()
            .unwrap();
        let adapter = dir.path().join("codex-acp");
        std::fs::write(&adapter, "#!/usr/bin/env node\n").unwrap();
        assert!(validate_interpreter(&adapter, &[])
            .unwrap_err()
            .contains("Node"));
        let node = dir.path().join("node");
        std::fs::write(&node, "fixture").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap();
        validate_interpreter(&adapter, &[dir.path().into()]).unwrap();
        for invalid in [
            "#!/missing/interpreter\n",
            "#!/usr/bin/env -S node\n",
            "#!relative\n",
            "#!",
        ] {
            std::fs::write(&adapter, invalid).unwrap();
            assert!(validate_interpreter(&adapter, &[dir.path().into()]).is_err());
        }
        std::fs::write(&adapter, "#!/bin/sh\n").unwrap();
        validate_interpreter(&adapter, &[]).unwrap();
        assert!(resolve_executable("codex", &[])
            .unwrap_err()
            .contains("Install codex"));
        assert!(resolve_executable("codex-acp", &[])
            .unwrap_err()
            .contains("Install codex-acp"));
    }

    #[test]
    fn bundled_cli_is_probed_through_adapter_without_standalone_override() {
        let dir = tempfile::tempdir().unwrap();
        let adapter = dir.path().join("codex-acp");
        std::fs::write(&adapter, "#!/bin/sh\n[ -z \"$CODEX_PATH\" ] && [ \"$1\" = cli ] && [ \"$2\" = -V ] || exit 1\necho 'codex-cli 1.2.3'\n").unwrap();
        std::fs::set_permissions(&adapter, std::fs::Permissions::from_mode(0o700)).unwrap();
        let harness = HarnessEdit {
            command: adapter.to_string_lossy().into_owned(),
            args: vec![],
            model: String::new(),
            provider: String::new(),
            databricks: None,
            configuration: None,
        };
        let context =
            Context::new(&harness, &BTreeMap::new(), dir.path().to_str().unwrap()).unwrap();
        let output = context.cli_command().unwrap().arg("-V").output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"codex-cli 1.2.3\n");
        assert!(!context
            .command(&context.adapter)
            .unwrap()
            .get_envs()
            .any(|(key, _)| key == "CODEX_PATH"));
    }

    #[test]
    fn explicit_cli_and_home_are_shared_by_probe_and_adapter() {
        let dir = tempfile::Builder::new()
            .prefix("codex tools ")
            .tempdir()
            .unwrap();
        let adapter = dir.path().join("codex-acp");
        let cli = dir.path().join("custom-codex");
        for path in [&adapter, &cli] {
            std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let harness = HarnessEdit {
            command: adapter.to_str().unwrap().into(),
            args: vec!["literal space".into()],
            model: String::new(),
            provider: String::new(),
            databricks: None,
            configuration: None,
        };
        let mut env = BTreeMap::from([
            ("CODEX_PATH".into(), cli.to_str().unwrap().into()),
            ("HOME".into(), dir.path().to_str().unwrap().into()),
            ("CODEX_HOME".into(), "relative-config".into()),
        ]);
        let context = Context::new(&harness, &env, dir.path().to_str().unwrap()).unwrap();
        assert_eq!(context.cli, cli);
        assert_eq!(context.args, ["literal space"]);
        let probe = context.command(&context.cli).unwrap();
        let adapter_command = context.command(&context.adapter).unwrap();
        assert_eq!(
            probe.get_envs().collect::<Vec<_>>(),
            adapter_command.get_envs().collect::<Vec<_>>()
        );
        assert_eq!(probe.get_current_dir(), Some(dir.path()));
        assert!(!probe.get_envs().any(|(key, _)| key == "OPENAI_API_KEY"));
        env.insert("CODEX_PATH".into(), "relative/custom-codex".into());
        assert!(Context::new(&harness, &env, dir.path().to_str().unwrap()).is_err());
    }
}
