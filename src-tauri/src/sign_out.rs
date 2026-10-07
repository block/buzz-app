//! Sign out of Buzz. The command records intent in a marker outside app data and
//! restarts; the next launch removes the human key (and, when asked, this
//! device's app data) before any window or identity read. A failure rolls the
//! wipe back and keeps the marker, so the next launch retries.
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::Manager;

const FAILED: &str = "Sign out of Buzz didn't finish. Quit and reopen Buzz to try again.";
const KEPT: &str = "agent-controller";

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Choices {
    wipe: bool,
    remove_agents: bool,
}

/// The marker and the folders a wipe moves aside, resolved like Tauri's app paths.
pub(crate) struct Paths {
    marker: PathBuf,
    app_data: PathBuf,
    /// Other app-owned folders: local data and WebView storage, and caches.
    others: Vec<PathBuf>,
}
impl Paths {
    pub(crate) fn resolve(identifier: &str) -> Option<Self> {
        let data = dirs::data_dir()?;
        let app_data = data.join(identifier);
        let mut others = vec![
            dirs::data_local_dir()?.join(identifier),
            dirs::cache_dir()?.join(identifier),
        ];
        #[cfg(target_os = "macos")]
        others.push(dirs::home_dir()?.join("Library/WebKit").join(identifier));
        others.retain(|path| *path != app_data);
        others.dedup();
        Some(Self {
            marker: data.join(format!(".{identifier}.sign-out-pending")),
            app_data,
            others,
        })
    }
    /// Each wiped folder, and the child it keeps (the agent registry) unless agents go too.
    fn targets(&self, choices: Choices) -> Vec<(&Path, Option<&str>)> {
        let kept = (!choices.remove_agents).then_some(KEPT);
        std::iter::once((self.app_data.as_path(), kept))
            .chain(self.others.iter().map(|path| (path.as_path(), None)))
            .collect()
    }
}

fn trash(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".sign-out-trash");
    path.with_file_name(name)
}

fn missing(result: std::io::Result<()>) -> std::io::Result<()> {
    match result {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Move `path` to its trash name, then return its kept child. Resumes an
/// earlier attempt that stopped part-way.
fn move_aside(path: &Path, kept: Option<&str>) -> std::io::Result<()> {
    let moved = trash(path);
    if !moved.exists() {
        missing(fs::rename(path, &moved))?;
    }
    if let Some(child) = kept {
        if moved.join(child).exists() && !path.join(child).exists() {
            fs::create_dir_all(path)?;
            fs::rename(moved.join(child), path.join(child))?;
        }
    }
    Ok(())
}

fn move_back(path: &Path, kept: Option<&str>) -> std::io::Result<()> {
    let moved = trash(path);
    if !moved.exists() {
        return Ok(());
    }
    if let Some(child) = kept {
        if path.join(child).exists() {
            fs::rename(path.join(child), moved.join(child))?;
        }
    }
    // Only the kept child was returned, so anything else here is unexpected; keep it.
    missing(fs::remove_dir(path))?;
    fs::rename(moved, path)
}

/// Run a pending sign-out. `None` means no marker or success; `Some` is the
/// error the identity screen shows instead of first run.
pub(crate) fn finish_pending(
    paths: &Paths,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Option<String> {
    let raw = match fs::read(&paths.marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        other => other,
    };
    let result = raw
        .map_err(|error| error.to_string())
        .and_then(|raw| serde_json::from_slice::<Choices>(&raw).map_err(|e| e.to_string()))
        .and_then(|choices| finish(paths, choices, remove_key));
    result.err().map(|error| {
        eprintln!("buzz: sign out did not finish: {error}");
        FAILED.to_owned()
    })
}

fn finish(
    paths: &Paths,
    choices: Choices,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let targets = if choices.wipe {
        paths.targets(choices)
    } else {
        Vec::new()
    };
    let mut moved = Vec::new();
    let mut outcome = Ok(());
    for &(path, kept) in &targets {
        moved.push((path, kept));
        if let Err(error) = move_aside(path, kept) {
            outcome = Err(format!("move {} aside: {error}", path.display()));
            break;
        }
    }
    if outcome.is_ok() {
        outcome = remove_key();
    }
    if let Err(error) = outcome {
        // Partially moved folders go back; the marker stays so the next launch retries.
        for &(path, kept) in moved.iter().rev() {
            if let Err(undo) = move_back(path, kept) {
                eprintln!("buzz: could not restore {}: {undo}", path.display());
            }
        }
        return Err(error);
    }
    // The key is gone, so there is nothing left to roll back to. Until the trash
    // and then the marker are gone, the identity stays blocked and each launch
    // retries: no new identity can write data that a retry would wipe.
    for (path, _) in targets {
        missing(fs::remove_dir_all(trash(path)))
            .map_err(|error| format!("delete wiped {}: {error}", path.display()))?;
    }
    fs::remove_file(&paths.marker).map_err(|error| format!("remove marker: {error}"))
}

fn write_marker(path: &Path, choices: Choices) -> Result<(), String> {
    let staged = path.with_extension("staged");
    let body = serde_json::to_vec(&choices).map_err(|error| error.to_string())?;
    fs::write(&staged, body)
        .and_then(|()| fs::rename(&staged, path))
        .map_err(|_| "Couldn't prepare sign out; nothing was removed. Try again.".to_owned())
}

/// Stops agents (deleting them first when asked), records the choices and restarts.
#[tauri::command]
pub(crate) async fn sign_out<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    wipe: bool,
    remove_agents: bool,
) -> Result<(), String> {
    if std::env::var("BUZZ_DEV_VIEWER").is_ok_and(|viewer| !viewer.trim().is_empty()) {
        return Err(
            "Sign out is unavailable while the development broker supplies your identity".into(),
        );
    }
    if remove_agents && !wipe {
        return Err("Removing agents is part of wiping this device".into());
    }
    let paths = Paths::resolve(&app.config().identifier)
        .ok_or("Couldn't find this app's local storage; nothing was removed")?;
    if remove_agents {
        app.state::<crate::AgentHost>()
            .remove_local_agents()
            .await?;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle.state::<crate::agent_models::ModelHost>().shutdown();
        handle.state::<crate::AgentHost>().shutdown()
    })
    .await
    .map_err(|_| "Agent shutdown could not be confirmed".to_owned())?
    .map_err(|error| format!("Agents didn't stop, so Buzz wasn't signed out: {error}"))?;
    write_marker(
        &paths.marker,
        Choices {
            wipe,
            remove_agents,
        },
    )?;
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests;
