//! Files a plugin that declares `host.files` reads, and directories it
//! resolves, with the user's own access, the same on every platform: no
//! program such as `base64` or `pwd` has to be on the computer for it.
use crate::host_process::expand_home;
use crate::{with_manager, PluginManager};
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// The largest file a plugin reads: the community's upload limit.
const MAX_READ_BYTES: u64 = 50 * 1024 * 1024;

async fn granted(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
) -> Result<(), String> {
    let granted = with_manager(manager, move |manager| {
        Ok(manager.host_grants(&id, &revision)?.files)
    })
    .await?;
    if granted {
        Ok(())
    } else {
        Err("Files are not declared".into())
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// `path`, absolute or `~/…`, or else relative to `cwd`, which is one of those.
fn locate(path: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    if path.is_empty() || path.contains('\0') {
        return Err(format!("Cannot read {path}"));
    }
    if path == "~" || path.starts_with("~/") || Path::new(path).is_absolute() {
        return expand_home(path);
    }
    let cwd = cwd.ok_or_else(|| format!("Cannot read {path} without a directory"))?;
    Ok(expand_home(cwd)?.join(path))
}

/// The bytes of the file at `path`, at most 50 MB.
fn read(path: &str, cwd: Option<&str>) -> Result<Vec<u8>, String> {
    let full = locate(path, cwd)?;
    let failed = |error: std::io::Error| match error.kind() {
        // Callers tell a missing file from a failed read by this wording.
        std::io::ErrorKind::NotFound => format!("{path}: No such file"),
        _ => format!("Could not read {path}: {error}"),
    };
    let file = std::fs::File::open(&full).map_err(failed)?;
    if !file.metadata().map_err(failed)?.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let mut data = Vec::new();
    // One more byte than allowed tells a file that grew past it.
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(failed)?;
    if data.len() as u64 > MAX_READ_BYTES {
        return Err(format!("{path} is larger than 50 MB"));
    }
    Ok(data)
}

/// `path`, absolute or `~/…`, as an absolute directory without symbolic
/// links, created if missing.
fn directory(path: &str) -> Result<String, String> {
    let full = expand_home(path)?;
    std::fs::create_dir_all(&full).map_err(|_| format!("Could not create {path}"))?;
    // `dunce` keeps Windows paths in their ordinary `C:\…` form, which agents
    // and the programs they run expect, rather than `\\?\C:\…`.
    let resolved = dunce::canonicalize(&full).map_err(|_| format!("Could not find {path}"))?;
    resolved
        .into_os_string()
        .into_string()
        .map_err(|_| format!("{path} is not a UTF-8 path"))
}

/// Reads a file for a plugin that declares `host.files`. `path` is absolute,
/// `~/…`, or relative to `cwd`, which is absolute or `~/…`.
#[tauri::command]
pub(crate) async fn plugin_host_read_file(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
    cwd: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    granted(manager, id, revision).await?;
    blocking(move || read(&path, cwd.as_deref()))
        .await
        .map(tauri::ipc::Response::new)
}

/// Resolves a directory for a plugin that declares `host.files`, creating it
/// if missing, as a process's `cwd` is.
#[tauri::command]
pub(crate) async fn plugin_host_resolve_directory(
    manager: tauri::State<'_, PluginManager>,
    id: String,
    revision: String,
    path: String,
) -> Result<String, String> {
    granted(manager, id, revision).await?;
    blocking(move || directory(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_files_by_absolute_or_relative_path() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("-project")).unwrap();
        let file = root.path().join("-project").join("a.bin");
        std::fs::write(&file, [0, 159, 255]).unwrap();
        let cwd = root.path().to_str().unwrap();

        assert_eq!(read(file.to_str().unwrap(), None).unwrap(), [0, 159, 255]);
        // A name starting `-` is a path, never an option.
        assert_eq!(read("-project/a.bin", Some(cwd)).unwrap(), [0, 159, 255]);
        assert!(read("-project/missing", Some(cwd))
            .unwrap_err()
            .contains("No such file"));
        assert!(read("-project", Some(cwd))
            .unwrap_err()
            .contains("not a file"));
        assert!(read("a.bin", None).is_err());
        assert!(read("", Some(cwd)).is_err());
        assert!(read("a.bin", Some("relative")).is_err());
    }

    #[test]
    fn refuses_files_over_the_limit() {
        let root = tempfile::tempdir().unwrap();
        let file = std::fs::File::create(root.path().join("large")).unwrap();
        file.set_len(MAX_READ_BYTES + 1).unwrap();
        assert!(read("large", root.path().to_str())
            .unwrap_err()
            .contains("larger than 50 MB"));
    }

    #[test]
    fn resolves_and_creates_directories() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("new").join("workspace");
        let resolved = directory(path.to_str().unwrap()).unwrap();
        assert!(Path::new(&resolved).is_dir());
        assert!(Path::new(&resolved).is_absolute());
        assert_eq!(
            resolved,
            dunce::canonicalize(&path).unwrap().to_str().unwrap()
        );
        assert!(directory("relative").is_err());
    }
}
