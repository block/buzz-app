//! Sign out of Buzz. The command only records intent in a marker outside app
//! data, stops agents and restarts. The next launch, holding the shared instance
//! lock alone, does every deletion before any window, service or identity read:
//! agent keys (when asked), the wipe, then the human key. Each step is safe to
//! repeat; any failure keeps the marker and Buzz exits, so the next launch retries.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const FAILED: &str = "Sign out of Buzz didn't finish. Open Buzz again to retry.";
const BUSY: &str =
    "Another Buzz window is still open. Quit it, then open Buzz again to finish signing out.";
const SIGNING_OUT: &str = "Buzz is signing out in another window. Open Buzz again in a moment.";
const NOT_PREPARED: &str = "Couldn't prepare sign out; nothing was removed. Try again.";
const REOPEN: &str = "Quit and reopen Buzz to finish signing out.";
const ALREADY: &str = "Buzz is already signing out.";
const LINKED: &str = "Wipe is unavailable because a Buzz storage folder is a link or couldn't be checked; nothing was removed";
const DEV_WIPE: &str = "Wipe is unavailable in development builds because they share agent keys and plugin storage with the installed Buzz";
const KEPT: &str = "agent-controller";
/// What a kept agent needs to be identified and start again: the agent list
/// with each agent's settings, and the shared agent defaults. Its keys live in
/// the keychain. Anything else in `KEPT` (saved logins, logs, run folders, and
/// whatever is added later) is wiped.
const KEPT_FILES: [&str; 2] = ["agents.json", "defaults.json"];
/// Named for the storage every Buzz shares whatever its identifier: the default
/// plugin folder and the fixed agent key service. It is the release app's name too.
const LOCK: &str = ".dev.local.buzz.foundation.instance.lock";
/// How long a launch waits for an exiting or signing-out instance to let go.
const WAIT: Duration = if cfg!(test) {
    Duration::from_secs(1)
} else {
    Duration::from_secs(10)
};

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Choices {
    wipe: bool,
    remove_agents: bool,
}

/// The marker, the shared instance lock and the folders a wipe clears, resolved like Tauri's app paths.
pub(crate) struct Paths {
    marker: PathBuf,
    lock: PathBuf,
    app_data: PathBuf,
    /// Other app-owned folders: local data and WebView storage, caches.
    others: Vec<PathBuf>,
}
/// One marker per key store, so a debug launch never acts on a release sign-out.
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
        others.retain(|path| *path != app_data);
        others.dedup();
        Some(Self {
            marker: data.join(marker_name(
                identifier,
                buzz_credential_store::HUMAN_SERVICE,
            )),
            lock: data.join(LOCK),
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
    /// The wipe never deletes through a link: every folder it moves, opens or
    /// removes, its trash and the kept registry must be a real folder or absent.
    fn unlinked(&self, choices: Choices) -> std::io::Result<()> {
        if choices.remove_agents {
            real_dir(&self.app_data.join(KEPT))?;
        }
        if !choices.wipe {
            return Ok(());
        }
        for (path, kept) in self.targets(choices) {
            for path in [path.to_owned(), trash(path)] {
                if real_dir(&path)? {
                    if let Some(child) = kept {
                        real_dir(&path.join(child))?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Whether `path` is a real folder; absent is `false`. A link, anything else
/// or failing to look is an error, never absence.
fn real_dir(path: &Path) -> std::io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
        Ok(meta) if meta.is_dir() => Ok(true),
        Ok(_) => Err(std::io::Error::other(format!(
            "{} is a link or not a folder",
            path.display()
        ))),
    }
}

/// Every running Buzz holds the lock shared; signing out and finishing a pending
/// sign-out need it exclusively, so no other instance can hold the key or data.
/// `started` admits one sign-out per instance: after it commits, Buzz restarts
/// or must be reopened, so it is never cleared.
pub(crate) struct Instance {
    lock: Mutex<File>,
    marker: PathBuf,
    started: AtomicBool,
}
// `File` locking is Rust 1.89; credential-store and plugin-manager already need it.
#[allow(clippy::incompatible_msrv)]
impl Instance {
    /// Admit this instance's one sign-out, holding the lock alone.
    fn begin(&self) -> Result<(), Failure> {
        if self.started.swap(true, Ordering::SeqCst) {
            return Err(refuse(ALREADY));
        }
        let file = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(error) = file.unlock() {
            return Err(lost(error));
        }
        if file.try_lock().is_ok() {
            return Ok(());
        }
        handoff();
        Err(self.share(
            &file,
            "Quit every other Buzz window, then sign out again. Nothing was removed.",
        ))
    }
    /// Withdraw a sign-out that committed nothing, returning why.
    fn abort(&self, failure: Failure) -> Failure {
        let file = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        match file.unlock() {
            Ok(()) => self.share(&file, &failure.message),
            Err(error) => lost(error),
        }
    }
    /// Share the unlocked lock again. Another process may have committed a
    /// sign-out meanwhile; only with none pending can this instance carry on.
    fn share(&self, file: &File, message: &str) -> Failure {
        match file.lock_shared().and_then(|()| self.marker.try_exists()) {
            Ok(false) => {
                self.started.store(false, Ordering::SeqCst);
                refuse(message)
            }
            Ok(true) => reopen(),
            Err(error) => lost(error),
        }
    }
}
fn lost(error: std::io::Error) -> Failure {
    eprintln!("buzz: instance lock: {error}");
    reopen()
}
// Test seam: runs wherever ownership is briefly let go, and after the first
// failed attempt to take it while waiting.
#[cfg(test)]
thread_local!(static HANDOFF: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = Default::default());
fn handoff() {
    #[cfg(test)]
    if let Some(gap) = HANDOFF.take() {
        gap();
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
        handoff();
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Run at launch, before anything else. Returns this instance's lock, or the
/// message to show before exiting.
#[allow(clippy::incompatible_msrv)] // `File` locking; see `Instance`.
pub(crate) fn boot(
    paths: &Paths,
    mut remove_agent_keys: impl FnMut(&Path) -> Result<(), String>,
    mut remove_key: impl FnMut() -> Result<(), String>,
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
    let failed = |error: std::io::Error| {
        eprintln!("buzz: instance lock: {error}");
        FAILED.to_owned()
    };
    // Shared first, then look: a sign-out that commits after this sees our lock.
    // Every time it is taken again, look again.
    loop {
        if !wait_for(|| file.try_lock_shared()) {
            return Err(SIGNING_OUT.into());
        }
        if !paths.marker.try_exists().map_err(failed)? {
            break;
        }
        // A restarting instance may still be exiting; wait for it to let go.
        file.unlock().map_err(failed)?;
        if !wait_for(|| file.try_lock()) {
            return Err(BUSY.into());
        }
        // Read again under exclusive ownership; another launch may have finished it.
        finish_pending(paths, &mut remove_agent_keys, &mut remove_key)?;
        file.unlock().map_err(failed)?;
        handoff();
    }
    Ok(Instance {
        lock: Mutex::new(file),
        marker: paths.marker.clone(),
        started: AtomicBool::new(false),
    })
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
    if !real_dir(&moved)? {
        real_dir(path)?;
        missing(fs::rename(path, &moved))?;
    }
    if let Some(child) = kept {
        if real_dir(&moved.join(child))? && !(real_dir(path)? && real_dir(&path.join(child))?) {
            fs::create_dir_all(path)?;
            fs::rename(moved.join(child), path.join(child))?;
        }
    }
    Ok(())
}

fn move_back(path: &Path, kept: Option<&str>) -> std::io::Result<()> {
    let moved = trash(path);
    if !real_dir(&moved)? {
        return Ok(());
    }
    if let Some(child) = kept {
        if real_dir(path)? && real_dir(&path.join(child))? {
            real_dir(&moved.join(child))?;
            fs::rename(path.join(child), moved.join(child))?;
        }
    }
    // Only the kept child was returned, so anything else here is unexpected; keep it.
    if real_dir(path)? {
        missing(fs::remove_dir(path))?;
    }
    fs::rename(moved, path)
}

/// Delete `path` except its kept child's `KEPT_FILES`, whether it is the
/// original or was recreated.
fn clear(path: &Path, kept: Option<&str>) -> std::io::Result<()> {
    let Some(kept) = kept else {
        return remove_real_dir(path);
    };
    clear_except(path, &[kept])?;
    clear_except(&path.join(kept), &KEPT_FILES)
}

/// Delete a real folder; absent is done, and a link is refused, never followed or unlinked.
fn remove_real_dir(path: &Path) -> std::io::Result<()> {
    if !real_dir(path)? {
        return Ok(());
    }
    missing(fs::remove_dir_all(path))
}

fn clear_except(path: &Path, keep: &[&str]) -> std::io::Result<()> {
    if !real_dir(path)? {
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if keep.iter().any(|name| entry.file_name() == *name) {
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
    remove_agent_keys: impl FnOnce(&Path) -> Result<(), String>,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let raw = match fs::read(&paths.marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        other => other,
    };
    raw.map_err(|error| error.to_string())
        .and_then(|raw| serde_json::from_slice::<Choices>(&raw).map_err(|e| e.to_string()))
        .and_then(|choices| finish(paths, choices, remove_agent_keys, remove_key))
        .map_err(|error| {
            eprintln!("buzz: sign out did not finish: {error}");
            FAILED.to_owned()
        })
}

fn finish(
    paths: &Paths,
    choices: Choices,
    remove_agent_keys: impl FnOnce(&Path) -> Result<(), String>,
    remove_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    // Agent keys go first, while their registry is still in place; nothing is
    // moved until every key is gone, so a registry confirmed absent means it's done.
    // Failing to look is not absence: stop before moving anything.
    paths
        .unlinked(choices)
        .map_err(|error| format!("check wipe folders: {error}"))?;
    let registry = paths.app_data.join(KEPT);
    if choices.remove_agents
        && registry
            .try_exists()
            .map_err(|error| format!("check agent registry: {error}"))?
    {
        remove_agent_keys(&registry).map_err(|error| format!("remove agent keys: {error}"))?;
    }
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
        remove_real_dir(&trash(path))
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

/// `reopen` means this instance can't continue (agents may be stopped); the UI
/// asks the user to reopen Buzz instead of retrying.
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
fn reopen() -> Failure {
    Failure {
        message: REOPEN.into(),
        reopen: true,
    }
}

/// Commit intent, then stop agents. Deleting is left to the next launch.
async fn prepare<S>(
    paths: &Paths,
    choices: Choices,
    shutdown: impl FnOnce() -> S,
) -> Result<(), Failure>
where
    S: Future<Output = Result<(), String>>,
{
    if let Err(error) = paths.unlinked(choices) {
        eprintln!("buzz: sign out refused: {error}");
        return Err(refuse(LINKED));
    }
    write_marker(&paths.marker, choices).map_err(|error| {
        eprintln!("buzz: could not write sign-out marker: {error}");
        refuse(NOT_PREPARED)
    })?;
    shutdown().await.map_err(|error| {
        eprintln!("buzz: agents did not stop: {error}");
        reopen()
    })
}

/// Why this build can't sign out, if it can't.
fn refusal(
    debug: bool,
    dev_viewer: bool,
    plugin_home: bool,
    wipe: bool,
    remove_agents: bool,
) -> Option<&'static str> {
    if dev_viewer {
        Some("Sign out is unavailable while the development broker supplies your identity")
    } else if remove_agents && !wipe {
        Some("Removing agents is part of wiping this device")
    } else if wipe && debug {
        // Debug builds have their own human key, but share agent keys and plugin
        // storage with the installed app, so only plain sign-out is safe.
        Some(DEV_WIPE)
    } else if wipe && plugin_home {
        Some("Wipe is unavailable while BUZZODZ_HOME moves plugin storage")
    } else {
        None
    }
}

/// Records the choices, stops agents and restarts; the next launch deletes.
#[tauri::command]
pub(crate) async fn sign_out<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    wipe: bool,
    remove_agents: bool,
) -> Result<(), Failure> {
    let set = |name| std::env::var_os(name).is_some_and(|value| !value.is_empty());
    if let Some(message) = refusal(
        cfg!(debug_assertions),
        set("BUZZ_DEV_VIEWER"),
        set("BUZZODZ_HOME"),
        wipe,
        remove_agents,
    ) {
        return Err(refuse(message));
    }
    let paths = Paths::resolve(&app.config().identifier);
    let (Some(paths), Some(instance)) = (paths, app.try_state::<Instance>()) else {
        return Err(refuse(
            "Couldn't find this app's local storage; nothing was removed",
        ));
    };
    instance.begin()?;
    let stop = app.clone();
    let result = prepare(
        &paths,
        Choices {
            wipe,
            remove_agents,
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
        Err(failure) if !failure.reopen => Err(instance.abort(failure)),
        Err(failure) => Err(failure),
        Ok(()) => {
            app.request_restart();
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests;
