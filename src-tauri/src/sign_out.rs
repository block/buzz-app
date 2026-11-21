//! Sign out of Buzz. The command only records intent in a marker outside app
//! data and restarts, which stops agents. The next launch, holding alone the lock for
//! its key (and, for a wipe, the lock every Buzz shares), does every deletion before any window, service or identity read:
//! agent keys (when asked), the wipe, then the human key. Each step is safe to
//! repeat; any failure keeps the marker and Buzz exits, so the next launch retries.
//! An erase also waits for every agent's supervisor to let go of its ownership lock.
//! Finishing first advances a record beside the marker that is never removed, so
//! a running copy can tell a sign-out finished while it let go of its locks.
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const FAILED: &str = "Sign out of Buzz didn't finish. Open Buzz again to retry.";
const BUSY: &str = "Another Buzz window using this sign-in is still open. Quit it, then open Buzz again to finish signing out.";
const BUSY_ALL: &str =
    "Another Buzz window is still open. Quit every Buzz window, then open Buzz again to finish erasing.";
const OTHERS: &str =
    "Quit every other Buzz window using this sign-in, then sign out again. Nothing was removed.";
const OTHERS_ALL: &str =
    "Quit every other Buzz window, then sign out and erase again. Nothing was removed.";
const SIGNING_OUT: &str = "Buzz is signing out in another window. Open Buzz again in a moment.";
const NOT_PREPARED: &str = "Couldn't prepare sign out; nothing was removed. Try again.";
const FENCED: &str = "Buzz couldn't confirm whether this sign-out request was recorded. Open Buzz again to check for pending sign-out work.";
const IDENTITY_UNAVAILABLE: &str = "Buzz couldn't start this sign-out request because your identity is busy or unavailable. Try again later.";
const AGENT_STOPPING: &str =
    "Erasing didn't finish because an agent is still stopping; nothing was removed. Open Buzz again to retry.";
const ALREADY: &str = "Buzz is already signing out.";
const H1_UNKNOWN: &str =
    "Buzz couldn't inspect all plugin storage. Saved-credential cleanup is unknown.";
const SAVING: &str = "A saved-key operation is still finishing. Try signing out again in a moment.";
const LINKED: &str = "Erasing is unavailable because a Buzz storage folder is a link or couldn't be checked; nothing was removed";
const DEV_WIPE: &str = "Erasing is unavailable in development builds because they share agent keys with the installed Buzz";
// Named from this build's side: the other build is the one that keeps custody.
const PEER_CUSTODY: &str = if cfg!(debug_assertions) {
    "Erasing is unavailable because the installed Buzz keeps saved plugin credentials in this data; nothing was removed. Clear them there first."
} else {
    "Erasing is unavailable because a development build of Buzz keeps saved plugin credentials in this data; nothing was removed. Clear them in that build first."
};
const SETUP_UNAVAILABLE: &str = "Saved-credential setup can't be finished here.";
pub(crate) mod legacy_identifier;
mod preflight;
// TEMPORARY agents rename: remove after 2026-10-18; see the migration module.
pub(crate) mod migrate_agents;
/// App data folder holding the current Agents identities.
pub(crate) const AGENTS: &str = "agents";
pub(crate) const OLD_AGENTS: &str = "agent-controller";
/// One lock per running agent, held by its supervisor until the agent has
/// stopped, even after Buzz exits. Shared by every Buzz, under the user data folder.
pub(crate) const AGENT_OWNERSHIP: &str = "dev.local.buzz.agent-ownership";
/// What kept agents need to be identified and start again, by app data folder:
/// the Agents list, and the earlier system's list and defaults to port from.
/// Their keys live in the keychain. Anything else in these folders (hosting
/// locks, saved logins, logs, run folders, and whatever is added later) is wiped.
const KEPT: Kept = &[
    (
        AGENTS,
        &[
            "identities.json",
            buzz_agent_controller::JOINED,
            "protection.json",
        ],
    ),
    (migrate_agents::LEGACY, &["identities.json"]),
    (OLD_AGENTS, &["agents.json", "defaults.json"]),
];
/// The children a wiped folder keeps, each with the files it keeps.
type Kept = &'static [(&'static str, &'static [&'static str])];
/// Held shared by every Buzz and alone only to wipe or move legacy storage.
/// Named for the storage every Buzz shares whatever its identifier: the default
/// plugin folder and the fixed agent key service. It keeps the legacy identifier
/// so builds from before 1.0 and later ones exclude each other.
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
    /// Grows by one byte each time a sign-out of this key store finishes. Named,
    /// like the key lock, for the key store alone: copies with any identifier
    /// share the key, and the record carries no choices.
    finished: PathBuf,
    lock: PathBuf,
    /// Held shared by every Buzz using this human key store, alone to sign out of it.
    key_lock: PathBuf,
    other_key_lock: PathBuf,
    /// Agent ownership locks; an erase waits until none is held.
    ownership: PathBuf,
    pub(crate) app_data: PathBuf,
    backups: PathBuf,
    /// Other app-owned folders: local data and WebView storage, caches.
    others: Vec<PathBuf>,
    /// Saved relay images, inside the caches.
    media: PathBuf,
    /// Storage the legacy identifier left, each with where it goes.
    moves: Vec<(PathBuf, PathBuf)>,
    /// Where a first development launch copies the installed app's folders, app data last.
    seeds: Vec<PathBuf>,
    plugin_home: Option<PathBuf>,
}
/// One marker per key store, so a debug launch never acts on a release sign-out.
fn marker_name(identifier: &str, service: &str) -> String {
    format!(".{identifier}--{service}.sign-out-pending")
}
fn finished_name(service: &str) -> String {
    format!(".{service}.sign-outs-finished")
}
/// How many sign-outs of this key store have finished; absent is none.
fn finished(path: &Path) -> std::io::Result<u64> {
    match fs::metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(0),
        other => other.map(|meta| meta.len()),
    }
}
/// Named for the key store alone: copies with different identifiers can share a key.
fn key_lock_name(service: &str) -> String {
    format!(".{service}.instance.lock")
}
impl Paths {
    pub(crate) fn resolve(identifier: &str) -> Option<Self> {
        let data = dirs::data_dir()?;
        let app_data = data.join(identifier);
        let cache = dirs::cache_dir()?.join(identifier);
        let media = cache.join(crate::relay::MEDIA_CACHE_DIR);
        let mut others = vec![dirs::data_local_dir()?.join(identifier), cache];
        #[cfg(target_os = "macos")]
        others.push(dirs::home_dir()?.join("Library/WebKit").join(identifier));
        others.retain(|path| *path != app_data);
        others.dedup();
        Some(Self {
            marker: data.join(marker_name(identifier, buzz_credential_store::HUMAN_STORE)),
            finished: data.join(finished_name(buzz_credential_store::HUMAN_STORE)),
            lock: data.join(LOCK),
            key_lock: data.join(key_lock_name(buzz_credential_store::HUMAN_STORE)),
            other_key_lock: data.join(key_lock_name(buzz_credential_store::human_store(!cfg!(
                debug_assertions
            )))),
            ownership: data.join(AGENT_OWNERSHIP),
            app_data,
            backups: crate::nsec_backup_choice::root()?,
            others,
            media,
            moves: legacy_identifier::moves(identifier)?,
            seeds: legacy_identifier::seeds(identifier)?,
            plugin_home: std::env::var_os("BUZZODZ_HOME").map(PathBuf::from),
        })
    }
    /// The existing build-specific inventory lives beside, never inside, wiped app homes.
    pub(crate) fn plugin_inventory(&self) -> Result<PathBuf, String> {
        self.lock
            .parent()
            .map(|data| data.join(format!(".{}", buzzodz_plugins::secrets::SERVICE)))
            .ok_or_else(|| H1_UNKNOWN.to_owned())
    }

    /// The other supported build's fixed inventory: other-owned evidence only.
    fn plugin_peer_inventory(&self) -> Result<PathBuf, String> {
        self.lock
            .parent()
            .map(|data| data.join(format!(".{}", buzzodz_plugins::secrets::PEER_SERVICE)))
            .ok_or_else(|| H1_UNKNOWN.to_owned())
    }

    pub(crate) fn plugin_slots<'a>(
        &self,
        root: &'a Path,
        store: Arc<dyn buzzodz_plugins::SecretStore>,
    ) -> Result<Slots<'a>, String> {
        self.plugin_slots_with_peer(
            root,
            store,
            Arc::new(buzzodz_plugins::secrets::PeerStore),
            self.peer_inspection_scope()?,
        )
    }

    /// `peer_scope` is the scope the other build binds at its fixed inventory.
    pub(crate) fn plugin_slots_with_peer<'a>(
        &self,
        root: &'a Path,
        store: Arc<dyn buzzodz_plugins::SecretStore>,
        peer_store: Arc<dyn buzzodz_plugins::SecretStore>,
        peer_scope: buzzodz_plugins::secrets::preflight::Scope,
    ) -> Result<Slots<'a>, String> {
        use buzzodz_plugins::secrets::continuity::{self, Peer};
        let scope = self.inspection_scope(Some(root))?;
        let peer_root = self.plugin_peer_inventory()?;
        let peer = {
            let (root, store) = (peer_root.clone(), peer_store.clone());
            move || Peer::new(root.clone(), peer_scope.clone(), store.clone())
        };
        let (witness_root, witness_store) = (root.to_owned(), store.clone());
        let (finish_scope, finish_root, finish_store) =
            (scope.clone(), root.to_owned(), store.clone());
        let finish_peer = peer.clone();
        let cleanup_root = root.to_owned();
        Ok(Slots {
            inventory: Some(root),
            continuity: Some(Box::new(move || {
                continuity::establish(&scope, &witness_root, witness_store.as_ref(), peer())
            })),
            finish: Some(Arc::new(move || {
                continuity::finish(
                    &finish_scope,
                    &finish_root,
                    finish_store.as_ref(),
                    finish_peer(),
                )
            })),
            pending: Box::new(move || buzzodz_plugins::secrets::sign_out_pending(root)),
            cleanup: Some(Box::new(move || {
                buzzodz_plugins::secrets::finish_sign_out(
                    &cleanup_root,
                    store.as_ref(),
                    buzzodz_plugins::secrets::CLEANUP_BUDGET,
                )
            })),
            wait: buzzodz_plugins::secrets::CLEANUP_BUDGET,
        })
    }

    /// Every folder an erase empties, with its trash.
    fn wiped_homes(&self) -> Vec<PathBuf> {
        let erase = Choices {
            wipe: true,
            remove_agents: false,
        };
        self.targets(erase)
            .into_iter()
            .flat_map(|(path, _)| [path.to_owned(), trash(path)])
            .collect()
    }

    /// Each wiped folder, and the children it keeps (the agent registries) unless agents go too.
    fn targets(&self, choices: Choices) -> Vec<(&Path, Kept)> {
        let kept = if choices.remove_agents { &[] } else { KEPT };
        std::iter::once((self.app_data.as_path(), kept))
            .chain(self.others.iter().map(|path| (path.as_path(), &[] as Kept)))
            .chain(std::iter::once((self.backups.as_path(), &[] as Kept)))
            .collect()
    }
    /// The wipe never deletes through a link: every folder it moves, opens or
    /// removes, its trash and the kept registries must be a real folder or absent.
    fn unlinked(&self, choices: Choices) -> std::io::Result<()> {
        if choices.remove_agents {
            for (registry, _) in KEPT {
                real_dir(&self.app_data.join(registry))?;
            }
        }
        if !choices.wipe {
            return Ok(());
        }
        // This target is outside app data; refuse links in its shared parents too.
        for parent in self.backups.ancestors().take(3) {
            real_dir(parent)?;
        }
        for (path, kept) in self.targets(choices) {
            for path in [path.to_owned(), trash(path)] {
                if real_dir(&path)? {
                    for (child, _) in kept {
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

/// Every running Buzz holds both locks shared. Signing out needs this key's lock
/// alone, so no copy using the key runs; a wipe also needs the all-Buzz lock
/// alone, so no copy using shared storage runs. Locks are taken key first, then
/// all-Buzz, and released in reverse, never waiting while holding one alone.
/// Admission closes before any handle changes. Completion-owned creator leases
/// pin the shared handles, including after the caller or Instance is dropped.
/// `seen` detects a sign-out completed while ownership was handed off.
pub(crate) struct Instance {
    shared: Arc<Shared>,
    other_key_lock: PathBuf,
    marker: PathBuf,
    finished: PathBuf,
    seen: u64,
    h1_unknown: bool,
    inventory: Option<PathBuf>,
    /// Shared so a completion-owned worker can requalify after the Instance is gone.
    continuity: Option<(
        buzzodz_plugins::secrets::preflight::Scope,
        Arc<buzzodz_plugins::secrets::continuity::Established>,
    )>,
    finish: Option<FinishSetup>,
    wait: Duration,
}
type FinishSetup = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;
struct Shared {
    locks: Mutex<Locks>,
    gate: Mutex<Gate>,
}
impl Shared {
    fn mark_h1_unknown(&self) {
        self.gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .h1_unknown = true;
    }
}
#[derive(Default)]
struct Gate {
    closed: bool,
    active: usize,
    // Unlike the immutable boot observation, prepare can raise this later.
    h1_unknown: bool,
}
struct Creator {
    shared: Arc<Shared>,
    other: Option<File>,
}
impl Drop for Creator {
    fn drop(&mut self) {
        drop(self.other.take()); // Gate becomes idle only after other-K release.
        self.shared
            .gate
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active -= 1;
    }
}
struct Locks {
    key: File,
    all: File,
    other: Option<File>,
}
#[allow(clippy::incompatible_msrv)]
fn other_key(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(|_| SAVING.to_owned())?;
    file.try_lock_shared().map_err(|_| SAVING.to_owned())?;
    Ok(file)
}
// `File` locking is Rust 1.89; credential-store and plugin-manager already need it.
#[allow(clippy::incompatible_msrv)]
impl Instance {
    /// Before establishment/metadata; never wait for the other build's K under
    /// inherited K/A handles. The lease pins those handles through completion,
    /// including the requalification's OS read of a new peer witness: the caller
    /// waits a bounded time, while the worker keeps the lease until the read
    /// returns. A timeout is sticky unknown; late success changes nothing.
    fn creator(&self) -> Result<Creator, String> {
        self.requalified(self.lease(true)?)
    }

    /// Before sign-out admission: owns the requalification like `creator`, so
    /// sign-out cannot close over a peer read, with the established refusal
    /// order (unknown, then already signing out). It takes no other-K: it
    /// writes nothing, and sign-out stays independent of the other build.
    fn requalify_before_sign_out(&self) -> Result<(), String> {
        let lease = {
            let mut gate = self.shared.gate.lock().unwrap_or_else(|e| e.into_inner());
            if self.h1_unknown || gate.h1_unknown {
                return Err(H1_UNKNOWN.into());
            }
            if gate.closed {
                return Err(ALREADY.into());
            }
            gate.active += 1;
            Creator {
                shared: self.shared.clone(),
                other: None,
            }
        };
        self.requalified(lease).map(drop)
    }

    /// Requalifies under `lease`, handing the same lease back on timely success.
    fn requalified(&self, lease: Creator) -> Result<Creator, String> {
        let Some((scope, established)) = self.continuity.clone() else {
            return Ok(lease);
        };
        let (done, result) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("plugin installation requalify".into())
            .spawn(move || {
                let qualified = established.requalify(&scope).is_ok();
                if !qualified {
                    lease.shared.mark_h1_unknown();
                }
                let _ = done.send(qualified.then_some(lease));
            })
            .map_err(|_| SAVING.to_owned())?;
        match result.recv_timeout(self.wait) {
            Ok(Some(lease)) => Ok(lease),
            _ => {
                self.mark_h1_unknown();
                Err(H1_UNKNOWN.into())
            }
        }
    }

    /// `creator` without continuity: setup recovery runs while custody is unknown.
    fn lease(&self, unknown_refuses: bool) -> Result<Creator, String> {
        let mut gate = self.shared.gate.lock().unwrap_or_else(|e| e.into_inner());
        if unknown_refuses && (self.h1_unknown || gate.h1_unknown) {
            return Err(H1_UNKNOWN.into());
        }
        if gate.closed {
            return Err(SAVING.into());
        }
        let other = other_key(&self.other_key_lock)?;
        gate.active += 1;
        Ok(Creator {
            shared: self.shared.clone(),
            other: Some(other),
        })
    }

    /// Whether this unqualified launch found its own unfinished setup intent.
    fn setup_unfinished(&self) -> bool {
        self.continuity.is_none()
            && self.finish.is_some()
            && self
                .inventory
                .as_deref()
                .is_some_and(buzzodz_plugins::secrets::continuity::unfinished)
    }

    /// Explicit recovery of this build's failed fresh setup, under the same
    /// completion-owned lease as enrollment. It never qualifies this launch:
    /// custody stays unknown until a restart qualifies the committed pair.
    /// A timeout is outcome-unknown; the lease lasts until the work finishes.
    pub(crate) fn finish_credential_setup(&self) -> Result<(), String> {
        let finish = match (&self.continuity, &self.finish) {
            (None, Some(finish)) if cfg!(unix) => finish.clone(),
            _ => return Err(SETUP_UNAVAILABLE.into()),
        };
        let lease = self.lease(false)?;
        let (done, result) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("plugin installation setup".into())
            .spawn(move || {
                let outcome = finish();
                drop(lease);
                let _ = done.send(outcome);
            })
            .map_err(|_| SAVING.to_owned())?;
        result
            .recv_timeout(self.wait)
            .map_err(|_| SAVING.to_owned())?
    }

    fn inspect_continuity(&self) -> Result<(), String> {
        if let Some((scope, established)) = &self.continuity {
            if established.inspect(scope).is_err() {
                self.mark_h1_unknown();
                return Err(H1_UNKNOWN.into());
            }
        }
        Ok(())
    }

    fn h1_unknown(&self) -> bool {
        self.h1_unknown
            || self
                .shared
                .gate
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .h1_unknown
    }

    fn mark_h1_unknown(&self) {
        self.shared.mark_h1_unknown();
    }

    /// Only a qualified installation supplies the production journal/count root.
    pub(crate) fn plugin_inventory(&self) -> Option<&Path> {
        self.continuity.as_ref().and(self.inventory.as_deref())
    }

    /// Count observation precedes exposing storage to any plugin-facing caller.
    /// Failure keeps ordinary launch available, with custody disabled and unknown sticky.
    pub(crate) fn configure_plugin_secrets(
        &self,
        manager: buzzodz_plugins::Manager,
        store: Arc<dyn buzzodz_plugins::SecretStore>,
    ) -> buzzodz_plugins::Manager {
        let Some(root) = self.plugin_inventory() else {
            return manager;
        };
        if self.observe_sign_outs(Some(root)).is_err() {
            return manager;
        }
        manager.with_secret_storage(root.to_owned(), store)
    }

    pub(crate) fn check_secret_admission(&self) -> Result<(), String> {
        self.creator().map(drop)
    }

    /// Concrete native enrollment boundary; callers snapshot identity first.
    /// Blocking caller wait; a timeout is outcome-unknown, not cancellation.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn set_secret(
        &self,
        manager: buzzodz_plugins::Manager,
        identity: crate::identity::IdentityHost,
        snapshot: String,
        plugin: String,
        revision: String,
        slot: String,
        value: zeroize::Zeroizing<String>,
        still_current: Arc<dyn Fn() -> bool + Send + Sync>,
        wait: Duration,
    ) -> Result<(), String> {
        if !cfg!(unix) || self.h1_unknown() {
            return Err(H1_UNKNOWN.into());
        }
        let lease = self.creator()?;
        let (done, result) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("plugin credential set".into())
            .spawn(move || {
                let result =
                    manager.secret_set(&plugin, &revision, &slot, &snapshot, &value, &|| {
                        still_current()
                            && identity.current_viewer().ok().flatten().as_deref()
                                == Some(snapshot.as_str())
                    });
                drop(lease); // Includes promotion/revalidation and the operation's own cleanup.
                let _ = done.send(result);
            })
            .map_err(|_| SAVING.to_owned())?;
        result.recv_timeout(wait).map_err(|_| SAVING.to_owned())?
    }

    pub(crate) fn observe_sign_outs(&self, root: Option<&Path>) -> Result<(), String> {
        #[cfg(not(unix))]
        let root = {
            let _ = root;
            None::<&Path>
        };
        if let Some(root) = root {
            if self.h1_unknown() {
                return Err(H1_UNKNOWN.into());
            }
            let result = (|| {
                let _lease = self.creator()?;
                buzzodz_plugins::secrets::observe_sign_outs(root, self.seen)
            })();
            if result.is_err() {
                // Before metadata: no write. After entry: an error may follow commit.
                self.mark_h1_unknown();
            }
            result?;
        }
        Ok(())
    }

    /// Admit this instance's one sign-out, holding the locks it needs alone.
    fn begin(&self, choices: Choices, journal: Option<&Journal>) -> Result<(), Failure> {
        {
            let mut gate = self.shared.gate.lock().unwrap_or_else(|e| e.into_inner());
            if gate.closed {
                return Err(refuse(ALREADY));
            }
            if gate.h1_unknown {
                return Err(refuse(H1_UNKNOWN));
            }
            gate.closed = true;
            if gate.active != 0 {
                gate.closed = false; // No handle changed; this attempt committed nothing.
                return Err(refuse(SAVING));
            }
        }
        let mut locks = self.shared.locks.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(error) = locks.key.unlock() {
            return Err(lost(error));
        }
        if locks.key.try_lock().is_err() {
            handoff();
            return Err(self.share(&locks, false, OTHERS, journal));
        }
        if !choices.wipe {
            if journal.is_some() {
                match other_key(&self.other_key_lock) {
                    Ok(other) => locks.other = Some(other),
                    Err(_) => {
                        locks.key.unlock().map_err(lost)?;
                        handoff();
                        return Err(self.share(&locks, false, SAVING, journal));
                    }
                }
            }
            return Ok(());
        }
        if let Err(error) = locks.all.unlock() {
            return Err(lost(error));
        }
        if locks.all.try_lock().is_ok() {
            return Ok(());
        }
        if let Err(error) = locks.key.unlock() {
            return Err(lost(error));
        }
        handoff();
        Err(self.share(&locks, true, OTHERS_ALL, journal))
    }
    /// Withdraw a sign-out that committed nothing, returning why.
    fn abort(&self, choices: Choices, failure: Failure, journal: Option<&Journal>) -> Failure {
        let mut locks = self.shared.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.other.take();
        let released = if choices.wipe {
            locks.all.unlock()
        } else {
            Ok(())
        };
        match released.and_then(|()| locks.key.unlock()) {
            Ok(()) => {
                handoff();
                self.share(&locks, choices.wipe, &failure.message, journal)
            }
            Err(error) => lost(error),
        }
    }
    /// Share the unlocked key lock again, and the all-Buzz lock when `all` was
    /// let go too. Another process may have committed, or even finished, a
    /// sign-out meanwhile, perhaps only its journal; only with none of these
    /// can this instance carry on.
    fn share(&self, locks: &Locks, all: bool, message: &str, journal: Option<&Journal>) -> Failure {
        // Bounded: a stuck owner must not hang the refusal; not sharing again means exiting.
        if !wait_for(|| locks.key.try_lock_shared())
            || (all && !wait_for(|| locks.all.try_lock_shared()))
        {
            return fenced();
        }
        let changed = self
            .marker
            .try_exists()
            .and_then(|pending| Ok(pending || finished(&self.finished)? != self.seen));
        match changed {
            // A journal alone, or not knowing, is a sign-out to leave for the next launch.
            Ok(false) if journal.map_or(Ok(false), |journal| (journal.pending)()) == Ok(false) => {
                self.shared
                    .gate
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .closed = false;
                refuse(message)
            }
            Ok(_) => fenced(),
            Err(error) => lost(error),
        }
    }
}
fn lost(error: std::io::Error) -> Failure {
    eprintln!("buzz: instance lock: {error}");
    fenced()
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

/// Plugin secret cleanup, which a sign-out journals before its marker. `None`
/// leaves boot as it was, which proves no cleanup.
pub(crate) struct Slots<'a> {
    /// Injected negative-evidence candidate, never a continuity witness.
    inventory: Option<&'a Path>,
    /// Optional existing-owner qualification; never substitutes for journal cleanup.
    continuity: Option<
        Box<
            dyn FnOnce() -> Result<buzzodz_plugins::secrets::continuity::Established, String>
                + Send,
        >,
    >,
    /// Explicit completion of this build's own failed fresh setup; never run at boot.
    finish: Option<FinishSetup>,
    /// Whether a journaled sign-out still owes cleanup; reads only.
    pending: Box<dyn Fn() -> Result<bool, String> + 'a>,
    /// This launch's one attempt, which may ask for secure storage access.
    /// It owns what it uses, as it may outlive the launch's wait for it.
    cleanup: Option<Box<dyn FnOnce() -> Result<(), String> + Send>>,
    /// How long the launch waits for that attempt; nonzero.
    wait: Duration,
}
fn owed(slots: &Option<Slots>) -> Result<bool, String> {
    slots.as_ref().map_or(Ok(false), |slots| (slots.pending)())
}
/// Settle owed cleanup with this launch's attempt, which owns `locks` until it
/// returns. Owed again after it, by a sign-out committed while this launch let
/// go of its locks, it waits for the next deliberate launch rather than asking
/// twice. An attempt still running when the wait ends keeps the locks until it
/// returns or Buzz exits, and nothing continues after it: the launch stays fenced.
fn settle(slots: &mut Option<Slots>, locks: Locks) -> Result<Locks, String> {
    if !owed(slots)? {
        return Ok(locks);
    }
    let Some((cleanup, wait)) = slots
        .as_mut()
        .and_then(|slots| Some((slots.cleanup.take()?, slots.wait)))
    else {
        return Err(FAILED.into());
    };
    let (done, attempt) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("sign-out cleanup".into())
        .spawn(move || {
            let result = cleanup();
            // Dropped with the locks only now, if the launch stopped waiting.
            let _ = done.send((locks, result));
        })
        .map_err(|error| {
            eprintln!("buzz: could not start sign-out cleanup: {error}");
            FAILED.to_owned()
        })?;
    match attempt.recv_timeout(wait) {
        Ok((locks, result)) => result.map(|()| locks),
        Err(_) => Err(buzzodz_plugins::secrets::SIGN_OUT_INCOMPLETE.into()),
    }
}

/// Keep all inherited ownership through OS-witness read/create completion,
/// including when launch stops waiting. No structural metadata lock is held.
fn qualify_continuity<'a>(
    paths: &Paths,
    slots: &mut Option<Slots<'a>>,
    mut locks: Locks,
    ready: impl Fn(&Option<Slots<'a>>) -> Result<bool, String>,
) -> Result<
    (
        Locks,
        Option<buzzodz_plugins::secrets::continuity::Established>,
        bool,
    ),
    String,
> {
    let Some((qualify, wait)) = slots
        .as_mut()
        .and_then(|s| Some((s.continuity.take()?, s.wait)))
    else {
        return Ok((locks, None, false));
    };
    if !wait_for(|| locks.key.try_lock_shared()) || !wait_for(|| locks.all.try_lock_shared()) {
        return Err(SIGNING_OUT.into());
    }
    // Reuse boot's fresh journal classification, including its sticky unknown.
    if !ready(slots)? {
        locks.all.unlock().map_err(|_| SAVING.to_owned())?;
        locks.key.unlock().map_err(|_| SAVING.to_owned())?;
        return Ok((locks, None, true));
    }
    match other_key(&paths.other_key_lock) {
        Ok(other) => locks.other = Some(other),
        Err(_) => {
            locks.all.unlock().map_err(|_| SAVING.to_owned())?;
            locks.key.unlock().map_err(|_| SAVING.to_owned())?;
            return Ok((locks, None, true));
        }
    }
    let (done, result) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("plugin installation continuity".into())
        .spawn(move || {
            let observed = qualify();
            let _ = done.send((locks, observed));
        })
        .map_err(|_| SAVING.to_owned())?;
    let (mut locks, observed) = result.recv_timeout(wait).map_err(|_| SAVING.to_owned())?;
    locks.other.take();
    locks.all.unlock().map_err(|_| SAVING.to_owned())?;
    locks.key.unlock().map_err(|_| SAVING.to_owned())?;
    Ok(match observed {
        Ok(observed) => (locks, Some(observed), false),
        Err(_) => (locks, None, true),
    })
}

/// K exclusive then A shared (plain) or exclusive (erase), always releasing K
/// before retrying A. No K acquisition occurs inside an A-exclusive transaction.
#[allow(clippy::incompatible_msrv)]
fn cleanup_locks(locks: &Locks, wipe: bool) -> Result<(), String> {
    let mut busy = BUSY;
    let mut stuck = None;
    let taken = wait_for(|| {
        busy = BUSY;
        locks.key.try_lock().map_err(drop)?;
        let all = if wipe {
            locks.all.try_lock()
        } else {
            locks.all.try_lock_shared()
        };
        if all.is_err() {
            busy = if wipe { BUSY_ALL } else { SIGNING_OUT };
            return match locks.key.unlock() {
                Ok(()) => Err(()),
                Err(error) => {
                    stuck = Some(error);
                    Ok(())
                }
            };
        }
        Ok(())
    });
    if let Some(error) = stuck {
        eprintln!("buzz: instance lock: {error}");
        return Err(FAILED.into());
    }
    if taken {
        Ok(())
    } else {
        Err(busy.into())
    }
}

/// Run at launch, before anything else. Returns this instance's lock, or the
/// message to show before exiting.
#[allow(clippy::incompatible_msrv)] // `File` locking; see `Instance`.
pub(crate) fn boot(
    paths: &Paths,
    mut slots: Option<Slots<'_>>,
    mut remove_agent_keys: impl FnMut(&Path) -> Result<(), String>,
    mut remove_key: impl FnMut() -> Result<(), String>,
) -> Result<Instance, String> {
    #[cfg(not(unix))]
    {
        let _ = slots.take();
    }
    let open = |path: &Path| {
        OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(path)
            .map_err(|error| {
                eprintln!("buzz: could not open instance lock: {error}");
                FAILED.to_owned()
            })
    };
    // A first launch may find no user-data folder yet; the locks live in it.
    if let Some(data) = paths.lock.parent() {
        fs::create_dir_all(data).map_err(|error| {
            eprintln!("buzz: could not create user data folder: {error}");
            FAILED.to_owned()
        })?;
    }
    let mut locks = Locks {
        key: open(&paths.key_lock)?,
        all: open(&paths.lock)?,
        other: None,
    };
    let failed = |error: std::io::Error| {
        eprintln!("buzz: instance lock: {error}");
        FAILED.to_owned()
    };
    let h1_unknown = std::cell::Cell::new(false);
    let pending_slots = |slots: &Option<Slots>| match owed(slots) {
        Ok(pending) => Ok(pending),
        Err(error) => {
            h1_unknown.set(true);
            // Read uncertainty is not positive journal authority. A real marker
            // still fences; without intent, ordinary launch remains available.
            if pending(&paths.marker)?.is_some() {
                Err(error)
            } else {
                Ok(false)
            }
        }
    };
    let mut owned_cleanup = false;
    // A journal commits before its marker, so cleanup may be owed without one:
    // settle it before moving storage, holding K exclusive and A shared.
    if pending_slots(&slots)? {
        cleanup_locks(&locks, false)?;
        let available = slots.as_ref().is_some_and(|s| s.cleanup.is_some());
        locks = settle(&mut slots, locks)?;
        owned_cleanup = available && slots.as_ref().is_some_and(|s| s.cleanup.is_none());
        locks.all.unlock().map_err(failed)?;
        locks.key.unlock().map_err(failed)?;
    }
    let (qualified_locks, continuity, unknown) =
        qualify_continuity(paths, &mut slots, locks, |slots| {
            // A newly committed readable journal belongs to the next deliberate attempt.
            if pending_slots(slots)? {
                return Err(buzzodz_plugins::secrets::SIGN_OUT_INCOMPLETE.into());
            }
            Ok(!h1_unknown.get())
        })?;
    locks = qualified_locks;
    if unknown {
        h1_unknown.set(true);
    }
    let observe = |slots: &Option<Slots>| {
        if paths
            .inspect_continuity(
                slots.as_ref().and_then(|s| s.inventory),
                continuity.as_ref(),
            )
            .is_err()
        {
            h1_unknown.set(true);
        }
    };
    observe(&slots);
    // Before looking for a marker: a pending sign-out may be the legacy one.
    legacy_identifier::migrate(
        &paths.moves,
        &paths.seeds,
        &locks.all,
        &paths.ownership,
        || {
            observe(&slots);
            pending_slots(&slots)
        },
    )?;
    // Shared first, then look: a sign-out that commits after this sees our locks.
    // Every time they are taken again, look again.
    loop {
        if !wait_for(|| locks.key.try_lock_shared()) || !wait_for(|| locks.all.try_lock_shared()) {
            return Err(SIGNING_OUT.into());
        }
        observe(&slots);
        // Plain cleanup takes K exclusive plus A shared; erase takes both exclusive.
        let marker = pending_wipe(&paths.marker).map_err(failed)?;
        let Some(wipe) = marker.or(pending_slots(&slots)?.then_some(false)) else {
            break;
        };
        // A restarting instance may still be exiting; wait for it to let go.
        locks.all.unlock().map_err(failed)?;
        locks.key.unlock().map_err(failed)?;
        cleanup_locks(&locks, wipe)?;
        // Before anything a sign-out moves or deletes.
        let available = slots.as_ref().is_some_and(|s| s.cleanup.is_some());
        locks = settle(&mut slots, locks)?;
        owned_cleanup |= available && slots.as_ref().is_some_and(|s| s.cleanup.is_none());
        // Read intent afresh before deciding whether inspection uncertainty
        // can stop destructive work: a competing finish may have removed it.
        let current = pending(&paths.marker)?;
        observe(&slots);
        // Run only what these locks cover; a newly committed wipe must loop.
        match current {
            // Now a wipe: let go and loop to take every lock.
            Some(choices) if choices.wipe && !wipe => {}
            Some(choices) => {
                if h1_unknown.get() && !owned_cleanup {
                    return Err(H1_UNKNOWN.into());
                }
                if choices.wipe {
                    agents_stopped(&paths.ownership)?;
                }
                finish(paths, choices, &mut remove_agent_keys, &mut remove_key).map_err(
                    |error| {
                        eprintln!("buzz: sign out did not finish: {error}");
                        FAILED.to_owned()
                    },
                )?
            }
            None => {}
        }
        locks.all.unlock().map_err(failed)?;
        locks.key.unlock().map_err(failed)?;
        handoff();
    }
    observe(&slots);
    migrate_agents::migrate(paths, &locks, || observe(&slots))?;
    observe(&slots);
    Ok(Instance {
        shared: Arc::new(Shared {
            locks: Mutex::new(locks),
            gate: Mutex::new(Gate::default()),
        }),
        other_key_lock: paths.other_key_lock.clone(),
        marker: paths.marker.clone(),
        finished: paths.finished.clone(),
        seen: finished(&paths.finished).map_err(failed)?,
        h1_unknown: h1_unknown.get(),
        inventory: slots.as_ref().and_then(|s| s.inventory.map(Path::to_owned)),
        finish: slots.as_ref().and_then(|s| s.finish.clone()),
        wait: slots.as_ref().map_or(WAIT, |s| s.wait),
        continuity: continuity
            .map(|established| {
                paths
                    .inspection_scope(slots.as_ref().and_then(|s| s.inventory))
                    .map(|scope| (scope, Arc::new(established)))
            })
            .transpose()?,
    })
}

/// Builds from before 1.0 sign out by deleting the human key under its previous
/// service only, so the copy reads made under the current one outlives it. A
/// record beside the finished one keeps the count this function last saw: when
/// a sign-out finished since, the current key goes too. Runs after `boot`,
/// before any identity read; on failure it records nothing and Buzz exits.
/// Copies launching together share the key lock, so each decides holding the
/// record's own lock alone: one that waited sees the count another recorded,
/// and never deletes a key saved since.
pub(crate) fn forget_signed_out_key(
    instance: &Instance,
    paths: &Paths,
    remove_current_key: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let forget = || {
        // Another copy signed out of the key this one shares, so the next
        // identity here must not see the saved images (see `finish`).
        missing(fs::remove_dir_all(&paths.media))
            .map_err(|error| format!("delete saved images: {error}"))?;
        remove_current_key()
    };
    // std can't sync a folder on Windows.
    reconcile_sign_outs(instance, forget, |folder| {
        if cfg!(unix) {
            File::open(folder)?.sync_all()
        } else {
            Ok(())
        }
    })
}

#[allow(clippy::incompatible_msrv)] // `File` locking; see `Instance`.
fn reconcile_sign_outs(
    instance: &Instance,
    remove_current_key: impl FnOnce() -> Result<(), String>,
    sync_folder: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), String> {
    use std::io::Write;
    let failed = |error: String| {
        eprintln!("buzz: sign out did not finish: {error}");
        FAILED.to_owned()
    };
    let name = format!(".{}.sign-outs-seen", buzz_credential_store::HUMAN_STORE);
    let [path, lock, staged] = ["", ".lock", ".staged"]
        .map(|suffix| instance.finished.with_file_name(format!("{name}{suffix}")));
    let io = |error: std::io::Error| failed(format!("{}: {error}", path.display()));
    // A separate lock file, never replaced, so a waiter holds the same one.
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock)
        .map_err(io)?;
    lock.lock().map_err(io)?;
    // Absent, empty or unreadable as a count: start counting from now.
    let recorded = match fs::read(&path) {
        Ok(bytes) => std::str::from_utf8(&bytes)
            .ok()
            .and_then(|text| text.trim().parse::<u64>().ok()),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(io(error)),
    };
    if recorded.is_some_and(|recorded| recorded < instance.seen) {
        remove_current_key().map_err(failed)?;
    }
    if recorded != Some(instance.seen) {
        // Replaced whole, so an interrupted write leaves the old count.
        File::create(&staged)
            .and_then(|mut file| {
                file.write_all(instance.seen.to_string().as_bytes())?;
                file.sync_all()
            })
            .and_then(|()| fs::rename(&staged, &path))
            .map_err(io)?;
    }
    // Durable before any key is saved, as a lost rename would replay this
    // deletion on a newer key. Synced on every launch: a count read back may
    // be one whose sync failed.
    path.parent().map_or(Ok(()), sync_folder).map_err(io)
}

/// An erase deletes storage agents use, so it waits until no supervisor holds an
/// agent's ownership lock. A plain sign-out removes only the human key and skips
/// this: the folder is shared with every Buzz, so another copy's agents would block it.
#[allow(clippy::incompatible_msrv)] // `File` locking; see `Instance`.
fn agents_stopped(ownership: &Path) -> Result<(), String> {
    let failed = |error: std::io::Error| {
        eprintln!("buzz: agent ownership: {error}");
        FAILED.to_owned()
    };
    let entries = match fs::read_dir(ownership) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        other => other.map_err(failed)?,
    };
    for entry in entries {
        let path = entry.map_err(failed)?.path();
        if path.extension() != Some("lock".as_ref()) {
            continue;
        }
        // Closing the file releases a lock taken here.
        let file = File::open(&path).map_err(failed)?;
        match file.try_lock() {
            Ok(()) => {}
            Err(fs::TryLockError::WouldBlock) => return Err(AGENT_STOPPING.into()),
            Err(fs::TryLockError::Error(error)) => return Err(failed(error)),
        }
    }
    Ok(())
}

/// Whether a pending sign-out wipes, to choose the locks; `None` when none is
/// pending. Malformed JSON counts as a wipe, so every lock is taken before
/// `pending` reports it; a read error returns at once and nothing is deleted.
fn pending_wipe(marker: &Path) -> std::io::Result<Option<bool>> {
    match fs::read(marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(raw) => Ok(Some(
            serde_json::from_slice::<Choices>(&raw).map_or(true, |choices| choices.wipe),
        )),
    }
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

/// Move `path` to its trash name, then return its kept children. Resumes an
/// earlier attempt that stopped part-way.
fn move_aside(path: &Path, kept: Kept) -> std::io::Result<()> {
    let moved = trash(path);
    if !real_dir(&moved)? {
        real_dir(path)?;
        missing(fs::rename(path, &moved))?;
    }
    for (child, _) in kept {
        if real_dir(&moved.join(child))? && !(real_dir(path)? && real_dir(&path.join(child))?) {
            fs::create_dir_all(path)?;
            fs::rename(moved.join(child), path.join(child))?;
        }
    }
    Ok(())
}

fn move_back(path: &Path, kept: Kept) -> std::io::Result<()> {
    let moved = trash(path);
    if !real_dir(&moved)? {
        return Ok(());
    }
    for (child, _) in kept {
        if real_dir(path)? && real_dir(&path.join(child))? {
            real_dir(&moved.join(child))?;
            fs::rename(path.join(child), moved.join(child))?;
        }
    }
    // Only the kept children were returned, so anything else here is unexpected; keep it.
    if real_dir(path)? {
        missing(fs::remove_dir(path))?;
    }
    fs::rename(moved, path)
}

/// Delete `path` except its kept children's kept files, whether it is the
/// original or was recreated.
fn clear(path: &Path, kept: Kept) -> std::io::Result<()> {
    if kept.is_empty() {
        return remove_real_dir(path);
    }
    let children: Vec<&str> = kept.iter().map(|(child, _)| *child).collect();
    clear_except(path, &children)?;
    for (child, files) in kept {
        clear_except(&path.join(child), files)?;
    }
    Ok(())
}

/// Delete a real folder; absent is done, and a link is refused, never followed or unlinked.
fn remove_real_dir(path: &Path) -> std::io::Result<()> {
    if !real_dir(path)? {
        return Ok(());
    }
    missing(fs::remove_dir_all(path))
}

/// Delete `path`'s trash, refusing a link at the trash or a kept child.
fn remove_trash(path: &Path, kept: Kept) -> std::io::Result<()> {
    let moved = trash(path);
    if real_dir(&moved)? {
        for (child, _) in kept {
            real_dir(&moved.join(child))?;
        }
    }
    remove_real_dir(&moved)
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

/// The pending sign-out's choices, if any. Unreadable or malformed is the
/// message shown before exiting, never absence.
fn pending(marker: &Path) -> Result<Option<Choices>, String> {
    let raw = match fs::read(marker) {
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        other => other,
    };
    raw.map_err(|error| error.to_string())
        .and_then(|raw| serde_json::from_slice(&raw).map_err(|e| e.to_string()))
        .map(Some)
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
    // Agent keys go first, while their registries in app data are still in
    // place; nothing is moved until every key is gone, so a registry confirmed
    // absent means it's done. Failing to look is not absence: stop before moving anything.
    paths
        .unlinked(choices)
        .map_err(|error| format!("check wipe folders: {error}"))?;
    if choices.remove_agents {
        remove_agent_keys(&paths.app_data)
            .map_err(|error| format!("remove agent keys: {error}"))?;
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
        remove_trash(path, kept)
            .and_then(|()| clear(path, kept))
            .map_err(|error| format!("delete wiped {}: {error}", path.display()))?;
    }
    // Saved images are keyed by URL alone and served without the relay, so the
    // next identity on this device would see this one's private images.
    missing(fs::remove_dir_all(&paths.media))
        .map_err(|error| format!("delete saved images: {error}"))?;
    // Record it before the marker goes; a resumed attempt records it again.
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.finished)
        .and_then(|mut record| std::io::Write::write_all(&mut record, b"."))
        .map_err(|error| format!("record finished: {error}"))?;
    fs::remove_file(&paths.marker).map_err(|error| format!("remove marker: {error}"))
}

fn write_marker(path: &Path, choices: Choices) -> std::io::Result<()> {
    let staged = path.with_extension("staged");
    fs::write(&staged, serde_json::to_vec(&choices)?)?;
    fs::rename(&staged, path)
}

/// A refusal the dialog shows. `fenced` means this instance can't continue (its
/// locks or agents are in an unknown state): Buzz exits natively instead, and
/// it never reaches the dialog.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Failure {
    message: String,
    #[serde(skip)]
    fenced: bool,
    /// This build's own setup is unfinished; offer the explicit recovery.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    finish_setup: bool,
}
fn refuse(message: &str) -> Failure {
    Failure {
        message: message.into(),
        fenced: false,
        finish_setup: false,
    }
}
fn fenced() -> Failure {
    Failure {
        message: FENCED.into(),
        fenced: true,
        finish_setup: false,
    }
}

/// Plugin secret cleanup, which a sign-out journals before its marker.
struct Journal<'a> {
    /// Commit this sign-out's cleanup; one that failed may have committed.
    commit: &'a (dyn Fn() -> Result<(), String> + Sync),
    /// Whether any committed sign-out still owes cleanup; reads only.
    pending: &'a (dyn Fn() -> Result<bool, String> + Sync),
    /// A refusal this journal's scope can't discharge; checked before revoking.
    admit: &'a (dyn Fn() -> Result<(), String> + Sync),
}

/// Revoke paired tools, journal plugin cleanup, commit intent, close signing,
/// then run `shutdown`. Deleting is left to the next launch.
async fn prepare<V, S>(
    paths: &Paths,
    choices: Choices,
    revoke: impl FnOnce() -> V,
    journal: Option<&Journal<'_>>,
    close: impl FnOnce(),
    shutdown: impl FnOnce() -> S,
) -> Result<(), Failure>
where
    V: Future<Output = Result<(), Failure>>,
    S: Future<Output = Result<(), String>>,
{
    if let Err(error) = paths.unlinked(choices) {
        eprintln!("buzz: sign out refused: {error}");
        return Err(refuse(LINKED));
    }
    match journal {
        None => paths.preflight().map_err(|_| refuse(H1_UNKNOWN))?,
        Some(journal) => (journal.admit)().map_err(|message| refuse(&message))?,
    }
    // After every refusal, so a refusal keeps paired tools, and before the
    // journal: once it may have committed, only fenced failures remain.
    revoke().await?;
    // A journal is never withdrawn, and one that failed may have committed.
    if let Some(journal) = journal {
        (journal.commit)().map_err(|error| {
            eprintln!("buzz: could not journal sign-out: {error}");
            fenced()
        })?;
    }
    #[cfg(all(test, unix))]
    tests::slots::creators::phase("marker");
    write_marker(&paths.marker, choices).map_err(|error| {
        eprintln!("buzz: could not write sign-out marker: {error}");
        if journal.is_some() {
            fenced()
        } else {
            refuse(NOT_PREPARED)
        }
    })?;
    // Committed: the key is removed at the next launch, so it signs or pairs nothing more.
    close();
    shutdown().await.map_err(|error| {
        eprintln!("buzz: agents did not stop: {error}");
        fenced()
    })
}

/// Admit, commit and shut down. A refusal before the marker withdraws; any
/// fenced failure, before or after it, closes signing and goes to `exit`, never
/// to the dialog.
#[allow(clippy::too_many_arguments)] // Paired-tool revocation joins the journaled sign-out path.
async fn attempt<V, S, E>(
    instance: &Instance,
    paths: &Paths,
    choices: Choices,
    revoke: impl FnOnce() -> V,
    journal: Option<&Journal<'_>>,
    close: impl Fn(),
    shutdown: impl FnOnce() -> S,
    exit: impl FnOnce() -> E,
) -> Result<(), Failure>
where
    V: Future<Output = Result<(), Failure>>,
    S: Future<Output = Result<(), String>>,
    E: Future<Output = Result<(), Failure>>,
{
    if journal.is_none() && instance.h1_unknown() {
        return Err(refuse(H1_UNKNOWN));
    }
    #[cfg(all(test, unix))]
    tests::slots::creators::phase("begin");
    let result = match instance.begin(choices, journal) {
        Ok(()) => {
            #[cfg(test)]
            tests::creators::before_commit();
            prepare(paths, choices, revoke, journal, &close, shutdown)
                .await
                .map_err(|failure| {
                    // N1: keep the exact message + nonfenced mapping coupled to
                    // prepare's scanner refusal; latch before abort reopens admission.
                    if failure == refuse(H1_UNKNOWN) {
                        instance.mark_h1_unknown();
                    }
                    if failure.fenced {
                        failure
                    } else {
                        instance.abort(choices, failure, journal)
                    }
                })
        }
        Err(failure) => Err(failure),
    };
    match result {
        Err(failure) if failure.fenced => {
            close();
            exit().await
        }
        other => other,
    }
}

/// Native journal adapter: borrow begin's closed-phase ownership; never recurse
/// through ordinary creator admission while current K is exclusive.
/// Before live-root wiring, distinguish a pre-write busy identity refusal from
/// a possibly committed journal error; the current conservative error fences.
#[allow(clippy::too_many_arguments)]
async fn attempt_native<V, S, E>(
    instance: &Instance,
    paths: &Paths,
    choices: Choices,
    root: Option<&Path>,
    identity: &crate::identity::IdentityHost,
    revoke: impl FnOnce() -> V,
    close: impl Fn(),
    shutdown: impl FnOnce() -> S,
    exit: impl FnOnce() -> E,
) -> Result<(), Failure>
where
    V: Future<Output = Result<(), Failure>>,
    S: Future<Output = Result<(), String>>,
    E: Future<Output = Result<(), Failure>>,
{
    // Windows has no plugin secrets in this release. Never establish inventory
    // or journal there; the no-journal route uses the same read-only predicate.
    #[cfg(not(unix))]
    let root = {
        let _ = root;
        None::<&Path>
    };
    if root.is_some() {
        // Owned requalification of any new peer, before admission closes.
        instance
            .requalify_before_sign_out()
            .map_err(|message| refuse(&message))?;
        if instance.h1_unknown() {
            return Err(refuse(H1_UNKNOWN));
        }
    }
    // A busy/unread identity is not known absent.
    let snapshot = if root.is_some() {
        identity
            .current_viewer()
            .map_err(|_| refuse(IDENTITY_UNAVAILABLE))?
    } else {
        None
    };
    let commit = || {
        #[cfg(all(test, unix))]
        tests::slots::creators::phase("commit");
        instance.inspect_continuity()?;
        let current = identity.current_viewer()?;
        if current != snapshot {
            return Err(SAVING.into());
        }
        buzzodz_plugins::secrets::begin_sign_out(
            root.ok_or(SAVING)?,
            current.as_deref(),
            choices.wipe.then_some(paths.app_data.as_path()),
        )
    };
    let pending = || buzzodz_plugins::secrets::sign_out_pending(root.ok_or(SAVING)?);
    // Closed phase: filesystem-only, so evidence changed since the owned
    // requalification refuses before revocation. This journal covers only this
    // build's root; erase refuses rather than wipe homes where the other build
    // keeps custody.
    let admit = || {
        instance.inspect_continuity()?;
        match &instance.continuity {
            Some((_, established)) if choices.wipe => {
                match established.peer_custody_in(&paths.wiped_homes()) {
                    Ok(false) => Ok(()),
                    _ => Err(PEER_CUSTODY.to_owned()),
                }
            }
            _ => Ok(()),
        }
    };
    let journal = Journal {
        commit: &commit,
        pending: &pending,
        admit: &admit,
    };
    attempt(
        instance,
        paths,
        choices,
        revoke,
        root.map(|_| &journal),
        close,
        shutdown,
        exit,
    )
    .await
    .map_err(|mut failure| {
        failure.finish_setup =
            !failure.fenced && failure.message == H1_UNKNOWN && instance.setup_unfinished();
        failure
    })
}

/// Tear down as Quit does, however that goes, then explain and exit. Agent
/// processes stop when Buzz exits; a pending erase waits for any ownership lock at launch.
async fn exit_fenced<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), Failure> {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        crate::shut_down(&handle);
        exit_with(FENCED)
    }) {
        eprintln!("buzz: could not reach the main thread: {error}");
        exit_with(FENCED)
    }
    // The dialog waits while the main thread tears down and exits.
    std::future::pending().await
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
        Some("Removing agents is part of erasing this device")
    } else if wipe && debug {
        // Debug builds have their own human key, but share agent keys with the
        // installed app, so only plain sign-out is safe.
        Some(DEV_WIPE)
    } else if wipe && plugin_home {
        Some("Erasing is unavailable while BUZZODZ_HOME moves plugin storage")
    } else {
        None
    }
}

/// Why this build can't sign out with these choices, from its build and environment.
fn current_refusal(wipe: bool, remove_agents: bool) -> Option<&'static str> {
    let set = |name| std::env::var_os(name).is_some_and(|value| !value.is_empty());
    refusal(
        cfg!(debug_assertions),
        set("BUZZ_DEV_VIEWER"),
        set("BUZZODZ_HOME"),
        wipe,
        remove_agents,
    )
}

/// Why wipe is unavailable here, if it is, so the dialog can say so up front;
/// `sign_out` still enforces it.
#[tauri::command]
pub(crate) fn sign_out_wipe_refusal() -> Option<&'static str> {
    current_refusal(true, false)
}

/// Paired tools act as this human, whose key a plain sign-out keeps, so it
/// needs their revoke-all at least owed: once the marker is saved, the next
/// launch finishes it. Sign out and erase needs it done.
pub(crate) fn pairings_allow(
    cleared: &Result<(), crate::credential_service::Unrevoked>,
    wipe: bool,
) -> bool {
    match cleared {
        Ok(()) => true,
        Err(unrevoked) => !wipe && unrevoked.recorded,
    }
}

/// Records the choices and restarts; the next launch deletes.
#[tauri::command]
pub(crate) async fn sign_out<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    wipe: bool,
    remove_agents: bool,
) -> Result<(), Failure> {
    if let Some(message) = current_refusal(wipe, remove_agents) {
        return Err(refuse(message));
    }
    let paths = Paths::resolve(&app.config().identifier);
    let (Some(paths), Some(instance)) = (paths, app.try_state::<Instance>()) else {
        return Err(refuse(
            "Couldn't find this app's local storage; nothing was removed",
        ));
    };
    let choices = Choices {
        wipe,
        remove_agents,
    };
    // Agents run as plugin host processes, which stop when Buzz exits.
    let shutdown = || async { Ok(()) };
    let revoke = || async {
        match app.try_state::<crate::credential_service::CredentialService>() {
            Some(credentials) if !pairings_allow(&credentials.clear_pairings().await, wipe) => Err(
                refuse("Couldn't revoke paired command-line tools; nothing was signed out"),
            ),
            _ => Ok(()),
        }
    };
    let identity = app.state::<crate::identity::IdentityHost>().inner().clone();
    let pairing = app.state::<crate::pairing::Pairing>().inner().clone();
    let backup = app
        .state::<crate::nsec_backup::NsecBackupHost>()
        .inner()
        .clone();
    // Close the signer and any pairing that already holds a copy of the key.
    let close = || {
        backup.close();
        app.state::<crate::federated_identity::FederatedIdentity>()
            .close();
        identity.close();
        pairing.close();
    };
    attempt_native(
        &instance,
        &paths,
        choices,
        instance.plugin_inventory(),
        &identity,
        revoke,
        close,
        shutdown,
        || exit_fenced(app.clone()),
    )
    .await?;
    crate::relaunch::request(&app);
    Ok(())
}

/// Finish this build's own failed fresh saved-credential setup, then restart:
/// only the next launch can qualify it and enable saved credentials.
#[tauri::command]
pub(crate) async fn finish_credential_setup<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), Failure> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .try_state::<Instance>()
            .ok_or_else(|| SETUP_UNAVAILABLE.to_owned())?
            .finish_credential_setup()
    })
    .await
    .map_err(|_| refuse(SAVING))?
    .map_err(|message| refuse(&message))?;
    crate::relaunch::request(&app);
    Ok(())
}

#[cfg(test)]
mod tests;

/// A genuinely absence-qualified temporary launch, never machine-resolved paths.
#[cfg(test)]
pub(crate) fn fixture_instance(root: &Path) -> Instance {
    let paths = tests::paths_for(root, "identity");
    boot(
        &paths,
        None,
        |_| panic!("no agents"),
        || panic!("no marker"),
    )
    .unwrap()
}

/// Exercise production caller construction with temporary paths and an injected store.
#[cfg(test)]
pub(crate) fn fixture_instance_with_custody(
    root: &Path,
    home: &Path,
    store: Arc<dyn buzzodz_plugins::SecretStore>,
) -> Instance {
    let mut paths = tests::paths_for(root, "identity");
    paths.plugin_home = Some(
        fs::canonicalize(root)
            .unwrap()
            .join(home.strip_prefix(root).unwrap()),
    );
    let inventory = paths.plugin_inventory().unwrap();
    let slots = paths.plugin_slots(&inventory, store).unwrap();
    boot(
        &paths,
        Some(slots),
        |_| panic!("no agents"),
        || panic!("no marker"),
    )
    .unwrap()
}
