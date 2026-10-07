// `File` locking is 1.89; the credential-store and plugin-manager dependencies
// already require 1.89, so the crate's declared 1.77.2 is not the real floor.
#![allow(clippy::incompatible_msrv)]

//! Sign out of Buzz. The command records intent in a marker outside app data and
//! restarts; the next launch removes the human key (and, when asked, this
//! device's app data) before any window, service or identity read. A failure
//! before the key is gone rolls the wipe back; any failure keeps the marker and
//! Buzz exits, so the next launch retries.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const FAILED: &str = "Sign out of Buzz didn't finish. Open Buzz again to retry.";
const BUSY: &str =
    "Another Buzz window is still open. Quit it, then open Buzz again to finish signing out.";
const SIGNING_OUT: &str = "Buzz is signing out in another window. Open Buzz again in a moment.";
const NOT_PREPARED: &str = "Couldn't prepare sign out; nothing was removed. Try again.";
const REOPEN: &str = "Quit and reopen Buzz to finish signing out.";
const KEPT: &str = "agent-controller";
/// Debug and release builds share this identifier, and so every folder a wipe clears.
const SHARED_IDENTIFIER: &str = "dev.local.buzz.foundation";
/// How long a launch waits for an exiting or signing-out instance to let go.
const WAIT: Duration = if cfg!(test) {
    Duration::from_millis(100)
} else {
    Duration::from_secs(10)
};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Choices {
    wipe: bool,
    remove_agents: bool,
}

/// The marker, the instance lock and the folders a wipe clears, resolved like Tauri's app paths.
pub(crate) struct Paths {
    marker: PathBuf,
    lock: PathBuf,
    app_data: PathBuf,
    /// Other app-owned folders: local data and WebView storage, caches, plugin storage.
    others: Vec<PathBuf>,
}
/// One marker per key store, so a debug sign-out can never delete the release key or the reverse.
fn marker_name(identifier: &str, service: &str) -> String {
    format!(".{identifier}--{service}.sign-out-pending")
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
        // Plugin storage lives in app data unless BUZZODZ_HOME moves it.
        others.extend(
            std::env::var_os("BUZZODZ_HOME")
                .map(PathBuf::from)
                .filter(|home| home.is_absolute() && !home.starts_with(&app_data))
                .map(|home| home.join("profiles")),
        );
        others.retain(|path| *path != app_data);
        others.dedup();
        Some(Self {
            marker: data.join(marker_name(
                identifier,
                buzz_credential_store::HUMAN_SERVICE,
            )),
            lock: data.join(format!(".{identifier}.instance.lock")),
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

/// Every running Buzz holds the lock shared; signing out and finishing a pending
/// sign-out need it exclusively, so no other instance can hold the key or data.
pub(crate) struct Instance(Mutex<File>);
impl Instance {
    fn claim(&self) -> bool {
        let file = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let _ = file.unlock();
        let claimed = file.try_lock().is_ok();
        if !claimed {
            let _ = file.lock_shared();
        }
        claimed
    }
    fn release(&self) {
        let file = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let _ = file.unlock();
        let _ = file.lock_shared();
    }
}
fn wait_for<E>(mut attempt: impl FnMut() -> Result<(), E>) -> bool {
    let start = Instant::now();
    loop {
        if attempt().is_ok() {
            return true;
        }
        if start.elapsed() >= WAIT {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Run at launch, before anything else. Returns this instance's lock, or the
/// message to show before exiting.
pub(crate) fn boot(
    paths: &Paths,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<Instance, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&paths.lock)
        .map_err(|error| {
            eprintln!("buzz: could not open instance lock: {error}");
            FAILED.to_owned()
        })?;
    if paths.marker.exists() {
        // A restarting instance may still be exiting; wait for it to let go.
        if !wait_for(|| file.try_lock()) {
            return Err(BUSY.into());
        }
        finish_pending(paths, remove_key)?;
        let _ = file.unlock();
    }
    if !wait_for(|| file.try_lock_shared()) {
        return Err(SIGNING_OUT.into());
    }
    Ok(Instance(Mutex::new(file)))
}

/// Shown when `boot` fails: no window opens, so nothing recreates wiped storage.
pub(crate) fn exit_with(message: &str) -> ! {
    eprintln!("buzz: {message}");
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Buzz")
        .set_description(message)
        .show();
    std::process::exit(1)
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

/// Delete `path` except its kept child, whether it is the original or was recreated.
fn clear(path: &Path, kept: Option<&str>) -> std::io::Result<()> {
    let Some(kept) = kept else {
        return missing(fs::remove_dir_all(path));
    };
    let entries = match fs::read_dir(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        other => other?,
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name() == kept {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

/// Run a pending sign-out, if any. The error is the message shown before exiting.
fn finish_pending(
    paths: &Paths,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let raw = match fs::read(&paths.marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        other => other,
    };
    raw.map_err(|error| error.to_string())
        .and_then(|raw| serde_json::from_slice::<Choices>(&raw).map_err(|e| e.to_string()))
        .and_then(|choices| finish(paths, choices, remove_key))
        .map_err(|error| {
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
        // Idempotent: an absent key is success, so a resumed attempt passes here.
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
    // The key is gone, so nothing is rolled back from here: clear what was moved
    // aside and anything in place now, then the marker.
    for (path, kept) in targets {
        missing(fs::remove_dir_all(trash(path)))
            .and_then(|()| clear(path, kept))
            .map_err(|error| format!("delete wiped {}: {error}", path.display()))?;
    }
    fs::remove_file(&paths.marker).map_err(|error| format!("remove marker: {error}"))
}

fn write_marker(path: &Path, choices: Choices) -> std::io::Result<()> {
    let staged = path.with_extension("staged");
    fs::write(&staged, serde_json::to_vec(&choices)?)?;
    fs::rename(&staged, path)
}

/// `reopen` means this instance can't continue (agents may be stopped or
/// partly removed); the UI asks the user to reopen Buzz instead of retrying.
#[derive(Debug, PartialEq, Serialize)]
pub(crate) struct Failure {
    message: String,
    reopen: bool,
}
fn refuse(message: &str) -> Failure {
    Failure {
        message: message.into(),
        reopen: false,
    }
}

/// Commit intent before anything irreversible, then remove agents and stop them.
async fn prepare<R, S>(
    marker: &Path,
    choices: Choices,
    remove_agents: impl FnOnce() -> R,
    shutdown: impl FnOnce() -> S,
) -> Result<(), Failure>
where
    R: Future<Output = Result<(), String>>,
    S: Future<Output = Result<(), String>>,
{
    write_marker(marker, choices).map_err(|error| {
        eprintln!("buzz: could not write sign-out marker: {error}");
        refuse(NOT_PREPARED)
    })?;
    let reopen = Failure {
        message: REOPEN.into(),
        reopen: true,
    };
    if choices.remove_agents {
        if let Err(error) = remove_agents().await {
            eprintln!("buzz: could not remove agents: {error}");
            // Agents still run, so withdrawing the marker leaves this instance usable.
            return Err(match fs::remove_file(marker) {
                Ok(()) => refuse(
                    "Couldn't remove every agent; some may already be gone. You're still signed in. Try again.",
                ),
                Err(_) => reopen,
            });
        }
    }
    shutdown().await.map_err(|error| {
        eprintln!("buzz: agents did not stop: {error}");
        reopen
    })
}

/// Stops agents (deleting them first when asked), records the choices and restarts.
#[tauri::command]
pub(crate) async fn sign_out<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    wipe: bool,
    remove_agents: bool,
) -> Result<(), Failure> {
    if std::env::var("BUZZ_DEV_VIEWER").is_ok_and(|viewer| !viewer.trim().is_empty()) {
        return Err(refuse(
            "Sign out is unavailable while the development broker supplies your identity",
        ));
    }
    if remove_agents && !wipe {
        return Err(refuse("Removing agents is part of wiping this device"));
    }
    if wipe && cfg!(debug_assertions) && app.config().identifier == SHARED_IDENTIFIER {
        return Err(refuse(
            "Development builds share the release app's folders, so they can't wipe this device",
        ));
    }
    let paths = Paths::resolve(&app.config().identifier);
    let (Some(paths), Some(instance)) = (paths, app.try_state::<Instance>()) else {
        return Err(refuse(
            "Couldn't find this app's local storage; nothing was removed",
        ));
    };
    if !instance.claim() {
        return Err(refuse(
            "Quit every other Buzz window, then sign out again. Nothing was removed.",
        ));
    }
    let agents = app.clone();
    let stop = app.clone();
    let result = prepare(
        &paths.marker,
        Choices {
            wipe,
            remove_agents,
        },
        || async move {
            agents
                .state::<crate::AgentHost>()
                .remove_local_agents()
                .await
        },
        || async move {
            tauri::async_runtime::spawn_blocking(move || {
                stop.state::<crate::agent_models::ModelHost>().shutdown();
                stop.state::<crate::AgentHost>().shutdown()
            })
            .await
            .map_err(|error| error.to_string())?
        },
    )
    .await;
    match result {
        Err(failure) if !failure.reopen => {
            instance.release();
            Err(failure)
        }
        Err(failure) => Err(failure),
        Ok(()) => {
            app.request_restart();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;
