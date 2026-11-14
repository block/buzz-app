//! macOS-only detection for when Buzz is launched from installer media (a
//! mounted disk image, a read-only or App Translocation location, or some
//! other non-installed download location) rather than from an Applications
//! folder.
//!
//! When that happens we surface a native first-launch prompt offering to move
//! Buzz into `/Applications` and relaunch from there. This mirrors the
//! widely-copied Potion Factory `LetsMove` flow: never prompt when the app is
//! already installed, treat read-only/disk-image/translocated locations as
//! "running from installer media", and on acceptance copy the bundle, clear
//! quarantine metadata, relaunch the installed copy, and detach the disk image
//! if we were running from one.
//!
//! The copy already installed in `/Applications` is located, compared, quit
//! and replaced purely by bundle path. Nothing here reads a bundle identifier,
//! executable name, signing identity or data directory, so the old Buzz from
//! block/buzz (`xyz.block.buzz.app`, executable `buzz-desktop`) and a previous
//! build of this app (`xyz.block.buzz.desktop`, executable `Buzz`), which share
//! the `Buzz.app` file name, go through exactly the same flow.

use std::path::{Path, PathBuf};

/// Where the running `.app` bundle lives, classified into the buckets that
/// decide whether we prompt the user to move into `/Applications`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunLocation {
    /// Already inside an Applications directory — never prompt.
    InstalledInApplications,
    /// Running from a read-only volume under `/Volumes`: nearly always a
    /// mounted disk image, but a read-only drive or network share lands here
    /// too, so the volume is only detached once `hdiutil` confirms it is one.
    DiskImage,
    /// Running from a Gatekeeper App Translocation location (a randomized
    /// read-only path under `/private/var/folders/.../AppTranslocation/...`).
    Translocated,
    /// Running from some other read-only volume.
    ReadOnlyVolume,
    /// Running from a writable, non-installed location (e.g. `~/Downloads`).
    OtherNonInstalled,
}

impl RunLocation {
    /// Whether this location should trigger the move-to-Applications prompt.
    /// Anything other than an installed copy is treated as installer media.
    pub fn should_prompt_move(self) -> bool {
        !matches!(self, RunLocation::InstalledInApplications)
    }
}

/// Filesystem facts about the volume containing the running bundle, gathered
/// via `statfs`. Kept as a plain struct so the classification logic can be
/// unit-tested without a real mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeInfo {
    pub mount_point: PathBuf,
    /// What is mounted there: a device node for a disk, the original bundle
    /// for an App Translocation mount.
    pub mounted_from: PathBuf,
    /// The filesystem type name, such as `apfs`, `hfs` or `nullfs`.
    pub fs_type: String,
    pub read_only: bool,
    pub is_root: bool,
}

/// Classify a bundle path + its volume into a [`RunLocation`].
///
/// Conservative by design: a bundle inside any Applications directory is
/// always treated as installed (no prompt), and only unambiguous installer
/// media signals (translocation, read-only volumes) escalate above
/// `OtherNonInstalled`.
pub fn classify(bundle_path: &Path, home: Option<&Path>, volume: &VolumeInfo) -> RunLocation {
    if is_in_applications_folder(bundle_path, home) {
        return RunLocation::InstalledInApplications;
    }
    if is_translocated_path(bundle_path) {
        return RunLocation::Translocated;
    }
    if volume.read_only && !volume.is_root {
        return if volume.mount_point.starts_with("/Volumes") {
            RunLocation::DiskImage
        } else {
            RunLocation::ReadOnlyVolume
        };
    }
    RunLocation::OtherNonInstalled
}

/// Whether `path` lives inside the system `/Applications` or the per-user
/// `~/Applications` directory. Uses component-aware prefix matching so e.g.
/// `/ApplicationsOther/Foo.app` is not mistaken for an install.
fn is_in_applications_folder(path: &Path, home: Option<&Path>) -> bool {
    if path.starts_with("/Applications") {
        return true;
    }
    if let Some(home) = home {
        if path.starts_with(home.join("Applications")) {
            return true;
        }
    }
    false
}

/// Whether `path` is a Gatekeeper App Translocation mount. Translocated
/// bundles live under `/private/var/folders/.../AppTranslocation/<uuid>/...`,
/// so the `AppTranslocation` path component is a reliable, self-contained
/// signal that a simple `/Volumes/...` check would miss.
fn is_translocated_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "AppTranslocation")
}

/// The bundle that the translocated `bundle_path` is a read-only view of, read
/// from the volume it runs on. App Translocation mounts the original bundle
/// with `nullfs` at `…/AppTranslocation/<uuid>` and shows it there as
/// `d/<the original's file name>`.
///
/// `None` unless the volume has exactly that shape, so a bundle that merely
/// sits under a folder named `AppTranslocation`, or a mount laid out some
/// other way, names no original.
fn translocated_original(bundle_path: &Path, volume: &VolumeInfo) -> Option<PathBuf> {
    let original = &volume.mounted_from;
    let shown_at = volume.mount_point.join("d").join(original.file_name()?);
    (volume.fs_type == "nullfs" && original.is_absolute() && bundle_path == shown_at)
        .then(|| original.clone())
}

/// The volume to detach once Buzz has moved off it, provided `hdiutil` then
/// confirms it is an attached disk image: the volume a `DiskImage` copy runs
/// from, or the one holding the original of a translocated copy when that
/// original is itself a `DiskImage` copy. `volume_of` looks up the volume a
/// path is on.
///
/// A translocated copy whose original can't be identified, or isn't on such a
/// volume (a download in `~/Downloads`, say), has nothing to detach.
fn detach_candidate(
    location: RunLocation,
    bundle_path: &Path,
    home: Option<&Path>,
    volume: &VolumeInfo,
    volume_of: impl FnOnce(&Path) -> Option<VolumeInfo>,
) -> Option<PathBuf> {
    match location {
        RunLocation::DiskImage => Some(volume.mount_point.clone()),
        RunLocation::Translocated => {
            let original = translocated_original(bundle_path, volume)?;
            let original_volume = volume_of(&original)?;
            (classify(&original, home, &original_volume) == RunLocation::DiskImage)
                .then_some(original_volume.mount_point)
        }
        _ => None,
    }
}

/// Resolve the running `.app` bundle directory by walking up from the current
/// executable to the nearest ancestor with a `.app` extension.
fn bundle_path_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|ancestor| ancestor.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// Where a copy of the running bundle lives once installed: `/Applications/`
/// plus the running bundle's file name.
///
/// Deliberately keyed on the file name alone, never on `CFBundleIdentifier`,
/// `CFBundleExecutable`, `CFBundleName`, the signing identity or the data
/// directory. The old Buzz from block/buzz (`xyz.block.buzz.app`, executable
/// `buzz-desktop`) and this app (`xyz.block.buzz.desktop`, executable `Buzz`)
/// both install as `Buzz.app`, and replacing either must look and behave the
/// same, so the lookup must not be able to tell them apart.
fn installed_copy_path(bundle_path: &Path) -> Option<PathBuf> {
    let app_name = bundle_path.file_name()?;
    Some(Path::new("/Applications").join(app_name))
}

/// Resolve symlinks and `/private` aliasing so two spellings of the same
/// bundle directory compare equal. A path that can't be resolved (e.g. it no
/// longer exists) is compared as written.
fn normalized_bundle_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether the installed copy at `installed` is the running bundle itself, as
/// when `/Applications/Buzz.app` is a symlink to it. Launching the installed
/// copy then already launches this one, so there is nothing to move it over.
fn is_running_bundle(bundle_path: &Path, installed: &Path) -> bool {
    normalized_bundle_path(bundle_path) == normalized_bundle_path(installed)
}

/// Check that this user can replace the copy at `target`, before anything is
/// copied or asked to quit. Adding the new copy needs write access to the
/// folder. Moving an installed copy to the Trash needs write access to that
/// copy as well, because a directory can only be moved to another folder by a
/// user who can write to it, and a copy put there by a software-management
/// tool is usually owned by root. `access` can't see everything (an ACL can
/// still deny the delete), so the Trash step stays the backstop.
#[cfg(unix)]
fn check_can_replace(target: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;

    let writable = |path: &Path| {
        std::ffi::CString::new(path.as_os_str().as_bytes())
            // SAFETY: `path` is a NUL-terminated string that outlives the call.
            .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
    };
    let denied = |message| std::io::Error::new(std::io::ErrorKind::PermissionDenied, message);
    let folder = target.parent().unwrap_or(target);
    if !writable(folder) {
        return Err(denied(format!(
            "you don't have permission to add apps to {}",
            folder.display()
        )));
    }
    // Only a real directory: a symlink moves without touching what it names.
    if target.symlink_metadata().is_ok_and(|meta| meta.is_dir()) && !writable(target) {
        return Err(denied(format!(
            "you don't have permission to replace {}",
            target.display()
        )));
    }
    Ok(())
}

/// Where a move stages its copy before renaming it over `target`:
/// `/Applications/.Buzz.app.staging`. Beside the target, so the final rename
/// is same-volume and atomic; hidden, and not an `.app`, so Launch Services
/// never registers it. The name is fixed because the single-instance guard
/// lets only one move run at a time, so anything already there was left by
/// an earlier move that was interrupted.
fn staging_path(target: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(target.file_name().unwrap_or_default());
    name.push(".staging");
    target.with_file_name(name)
}

/// Remove a leftover staging copy so the next copy starts from nothing.
/// Nothing to remove is fine. A leftover that can't be removed is an error:
/// `ditto` would merge into it, and the stale files would break the new
/// copy's code signature.
fn clear_staging(staging: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(staging) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(std::io::Error::new(
            error.kind(),
            format!(
                "failed to remove leftover staging copy {}: {error}",
                staging.display()
            ),
        )),
    }
}

/// Rename the staged copy to `target`, then run `finish`. A copy already at
/// `target` is passed to `trash` first, which moves it to the Trash and returns
/// where it went. If the rename or `finish` fails, the new copy is taken back
/// out and the trashed copy renamed back to `target`, so a failed move leaves
/// `target` as it found it. If the trashed copy can't be put back, the error
/// says where in the Trash it is. `trash` is a parameter so tests can stand in
/// for the real Trash.
fn replace_installed_copy(
    staging: &Path,
    target: &Path,
    trash: impl FnOnce(&Path) -> std::io::Result<PathBuf>,
    finish: impl FnOnce() -> std::io::Result<()>,
) -> std::io::Result<()> {
    let trashed = if target.exists() {
        match trash(target) {
            Ok(trashed) => Some(trashed),
            Err(error) => {
                let _ = std::fs::remove_dir_all(staging);
                return Err(error);
            }
        }
    } else {
        None
    };
    let result = std::fs::rename(staging, target).and_then(|()| {
        finish().inspect_err(|_| {
            let _ = std::fs::rename(target, staging);
        })
    });
    let Err(error) = result else {
        return Ok(());
    };
    let _ = std::fs::remove_dir_all(staging);
    let Some(trashed) = trashed else {
        return Err(error);
    };
    match std::fs::rename(&trashed, target) {
        Ok(()) => Err(error),
        Err(restore_error) => Err(std::io::Error::new(
            error.kind(),
            format!(
                "{error}; the previous copy couldn't be put back at {} ({restore_error}) \
                 and is in the Trash at {}",
                target.display(),
                trashed.display()
            ),
        )),
    }
}

/// Version identity read from a bundle's `Contents/Info.plist`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleVersion {
    /// `CFBundleShortVersionString`, e.g. `"0.7.0"`.
    pub short: String,
    /// `CFBundleVersion`, the build identifier.
    pub build: String,
}

/// How the running copy's version relates to a copy already in `/Applications`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRelation {
    /// The running copy is a newer version than the installed one.
    RunningNewer,
    /// The running copy is an older version than the installed one.
    RunningOlder,
    /// Both copies report the same version.
    Same,
    /// At least one version string could not be parsed.
    Unknown,
}

/// Compare two bundle versions by their `CFBundleShortVersionString`, parsed as
/// semver. If either side fails to parse we return [`VersionRelation::Unknown`]
/// rather than guessing — the caller degrades to neutral "replace" wording.
fn compare_versions(running: &BundleVersion, installed: &BundleVersion) -> VersionRelation {
    use semver::Version;

    let (Ok(running), Ok(installed)) = (
        Version::parse(&running.short),
        Version::parse(&installed.short),
    ) else {
        return VersionRelation::Unknown;
    };

    match running.cmp(&installed) {
        std::cmp::Ordering::Greater => VersionRelation::RunningNewer,
        std::cmp::Ordering::Less => VersionRelation::RunningOlder,
        std::cmp::Ordering::Equal => VersionRelation::Same,
    }
}

/// What moving into `/Applications` actually means given what's already there.
/// Folding "does an install exist" and the version relation into one value
/// keeps the dialog copy and the action that follows it from ever disagreeing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MoveScenario {
    /// Nothing in `/Applications` — a plain first install.
    FreshInstall,
    /// An older copy is installed; this copy is newer.
    Upgrade { from: String, to: String },
    /// A newer copy is installed; this copy is older.
    Downgrade { from: String, to: String },
    /// The same version is already installed.
    Reinstall { version: String },
    /// A copy is installed but its version couldn't be determined.
    ExistingUnknown,
}

/// Derive the [`MoveScenario`] from whether `/Applications/Buzz.app` exists and
/// the two versions. Pure so it can be unit-tested over the full truth table.
fn scenario_for(
    target_exists: bool,
    running: Option<&BundleVersion>,
    installed: Option<&BundleVersion>,
) -> MoveScenario {
    if !target_exists {
        return MoveScenario::FreshInstall;
    }
    let (Some(running), Some(installed)) = (running, installed) else {
        return MoveScenario::ExistingUnknown;
    };
    match compare_versions(running, installed) {
        VersionRelation::RunningNewer => MoveScenario::Upgrade {
            from: installed.short.clone(),
            to: running.short.clone(),
        },
        VersionRelation::RunningOlder => MoveScenario::Downgrade {
            from: installed.short.clone(),
            to: running.short.clone(),
        },
        VersionRelation::Same => MoveScenario::Reinstall {
            version: running.short.clone(),
        },
        VersionRelation::Unknown => MoveScenario::ExistingUnknown,
    }
}

/// The text a native `NSAlert` needs, and which of its two buttons Return
/// presses.
struct AlertCopy {
    message: String,
    informative: String,
    primary_button: String,
    /// Whether Return presses the primary button rather than "Do Not Move".
    /// False when the move may replace a newer installed copy. An older build
    /// can refuse data the newer one wrote, as the archive store does for a
    /// newer schema, so that replacement has to be chosen on purpose, not by
    /// a stray Return.
    move_is_default: bool,
}

/// A trailing note describing how the app is currently being run, appended to
/// every scenario's informative text so the user understands the prompt's
/// trigger regardless of the version situation.
fn location_note(location: RunLocation) -> &'static str {
    match location {
        RunLocation::DiskImage => "\n\nYou're currently running Buzz from a disk image.",
        RunLocation::Translocated => {
            "\n\nmacOS is running this copy from a temporary, read-only location."
        }
        RunLocation::ReadOnlyVolume => "\n\nYou're currently running Buzz from a read-only volume.",
        RunLocation::OtherNonInstalled => {
            "\n\nYou're currently running Buzz from outside your Applications folder."
        }
        RunLocation::InstalledInApplications => "",
    }
}

/// Produce the alert's message, informative text, and primary-button label for
/// a given scenario and run location. Pure and unit-tested so the wording can
/// never drift from the action it describes.
fn alert_copy(scenario: &MoveScenario, location: RunLocation) -> AlertCopy {
    let note = location_note(location);
    match scenario {
        MoveScenario::FreshInstall => AlertCopy {
            message: "Move to Applications folder?".to_string(),
            informative: format!(
                "Buzz can move itself to your Applications folder and relaunch from there. \
                 This keeps automatic updates working and avoids problems with running from \
                 installer media.{note}"
            ),
            primary_button: "Move to Applications Folder".to_string(),
            move_is_default: true,
        },
        MoveScenario::Upgrade { from, to } => AlertCopy {
            message: "Upgrade Buzz in your Applications folder?".to_string(),
            informative: format!(
                "You have Buzz {from} installed. This copy is the newer version {to}. \
                 Buzz can replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Upgrade and Relaunch".to_string(),
            move_is_default: true,
        },
        MoveScenario::Downgrade { from, to } => AlertCopy {
            message: "Replace the newer version in your Applications folder?".to_string(),
            informative: format!(
                "You have Buzz {from} installed, which is newer than this copy ({to}). \
                 Buzz can replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Replace and Relaunch".to_string(),
            move_is_default: false,
        },
        MoveScenario::Reinstall { version } => AlertCopy {
            message: format!("Reinstall Buzz {version} in your Applications folder?"),
            informative: format!(
                "Buzz {version} is already installed in your Applications folder. Buzz can \
                 replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Reinstall and Relaunch".to_string(),
            move_is_default: true,
        },
        MoveScenario::ExistingUnknown => AlertCopy {
            message: "Replace the copy in your Applications folder?".to_string(),
            informative: format!(
                "Buzz is already installed in your Applications folder. Buzz can replace the \
                 installed copy and relaunch from it.{note}"
            ),
            primary_button: "Replace and Relaunch".to_string(),
            // The installed version is unknown, so it may be the newer one.
            move_is_default: false,
        },
    }
}

/// Message and informative text for the alert shown when a move the user
/// confirmed fails partway through. Without privilege escalation a standard
/// user on a locked-down `/Applications` will reliably land here, so the
/// failure must be visible rather than swallowed into a log line. Pure so the
/// wording stays testable alongside the rest of the dialog copy.
fn move_failed_alert_copy(error: &str) -> (String, String) {
    (
        "Couldn't move Buzz to your Applications folder".to_string(),
        format!(
            "Buzz will keep running from its current location. You can move it yourself by \
             dragging Buzz into your Applications folder, then opening it from there.\n\n\
             Details: {error}"
        ),
    )
}

/// Quote `value` for safe interpolation into a `/bin/sh -c` command string.
/// Wraps it in single quotes and rewrites any embedded single quote as the
/// classic `'\''` sequence (close quote, escaped literal quote, reopen quote),
/// so a path containing shell metacharacters — or a bundle deliberately renamed
/// to contain a quote — can't break out of the quoting and run arbitrary
/// commands. Pure so the escaping is unit-testable.
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The `/bin/sh -c` script that waits for process `pid` (this one) to exit,
/// launches the copy installed at `target`, and then detaches `detach_mount`,
/// the disk image this copy ran from, if there is one.
///
/// It launches with `open -n`. A copy of the bundle that was just replaced can
/// still be running, because it is asked to quit and never waited for, and
/// LaunchServices keeps that process registered under `target`. Plain `open`
/// hands the request to that process instead of launching the bundle now at
/// `target`, so once it finishes quitting no Buzz is running at all. `-n`
/// starts the installed copy whatever else is registered at that path. This
/// process has exited by then, so the new copy's single-instance guard has
/// nothing to hand off to.
///
/// The paths are single-quote escaped before interpolation: the only reason a
/// shell is involved at all is the wait-for-pid loop, and a bundle whose name
/// contains shell metacharacters must not be able to turn that loop into
/// arbitrary command execution.
fn relaunch_script(pid: u32, target: &Path, detach_mount: Option<&Path>) -> String {
    let target = shell_single_quote(&target.to_string_lossy());
    let mut script = format!(
        "while /bin/kill -0 {pid} >/dev/null 2>&1; do /bin/sleep 0.2; done; \
         /usr/bin/open -n {target}"
    );
    if let Some(mount) = detach_mount {
        let mount = shell_single_quote(&mount.to_string_lossy());
        script.push_str(&format!(
            "; /bin/sleep 1; /usr/bin/hdiutil detach {mount} >/dev/null 2>&1"
        ));
    }
    script
}

/// The mount points of the attached disk images, read from the output of
/// `hdiutil info -plist`: `images[].system-entities[].mount-point`. An image
/// lists every device it provides, and only one holding a mounted filesystem
/// has a mount point. Anything that doesn't have that shape is skipped.
#[cfg(target_os = "macos")]
fn image_mount_points(info: &plist::Value) -> Vec<PathBuf> {
    fn items<'a>(value: &'a plist::Value, key: &str) -> &'a [plist::Value] {
        value
            .as_dictionary()
            .and_then(|dict| dict.get(key))
            .and_then(plist::Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }
    items(info, "images")
        .iter()
        .flat_map(|image| items(image, "system-entities"))
        .filter_map(|entity| entity.as_dictionary()?.get("mount-point")?.as_string())
        .map(PathBuf::from)
        .collect()
}

/// Whether `mount` is where one of the disk images in `info`, the output of
/// `hdiutil info -plist`, is mounted. A read-only drive or network share
/// under `/Volumes` isn't, and must not be detached.
#[cfg(target_os = "macos")]
fn is_image_mount_point(info: &plist::Value, mount: &Path) -> bool {
    image_mount_points(info)
        .iter()
        .any(|image_mount| image_mount == mount)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::process::Command;
    use tauri::{AppHandle, Manager};

    const SUPPRESSION_MARKER: &str = "suppress-move-to-applications";

    /// Detect whether Buzz is running from installer media and, if so, offer
    /// to move it into `/Applications`. Runs once per launch, on the main
    /// thread, from a main-queue block scheduled at `RunEvent::Ready`: the
    /// modal alert redraws the visible main window, which re-enters tao, so it
    /// must not be called from inside a tao event-loop callback (see the call
    /// site in `lib.rs`). On acceptance this tears down as Quit does,
    /// relaunches from the installed copy and exits the current process.
    pub(crate) fn maybe_prompt_move_to_applications(app: &AppHandle) {
        // Never interrupt development builds, which legitimately run from
        // `target/` and similar non-installed locations.
        if cfg!(debug_assertions) {
            return;
        }

        let Some(bundle_path) = running_app_bundle_path() else {
            return;
        };
        let Some(target) = installed_copy_path(&bundle_path) else {
            return;
        };
        let Some(volume) = volume_info(&bundle_path) else {
            return;
        };
        let home = dirs::home_dir();
        let location = classify(&bundle_path, home.as_deref(), &volume);
        if !location.should_prompt_move() {
            return;
        }
        // The classification only looks at this copy's path; if the installed
        // copy resolves to this same bundle, this copy is the installed one,
        // and a move would replace it with a copy of itself.
        if is_running_bundle(&bundle_path, &target) {
            eprintln!(
                "{} resolves to this copy of Buzz ({}); not prompting to move it",
                target.display(),
                bundle_path.display()
            );
            return;
        }

        // Respect a prior "Do not show this message again" choice.
        let marker = suppression_marker_path(app);
        if marker.as_ref().is_some_and(|path| path.exists()) {
            return;
        }

        // Read both versions from disk (rather than trusting the compiled-in
        // version) so the running and installed copies are always compared
        // apples-to-apples. Only `CFBundleShortVersionString` is compared;
        // whatever is installed under this file name is treated the same.
        let running = read_bundle_version(&bundle_path);
        let installed = target
            .exists()
            .then(|| read_bundle_version(&target))
            .flatten();
        let scenario = scenario_for(target.exists(), running.as_ref(), installed.as_ref());

        eprintln!(
            "Buzz appears to be running from installer media ({location:?}, {scenario:?}); \
             prompting to move to /Applications"
        );

        let Some(decision) = show_move_alert(&scenario, location) else {
            return;
        };

        if decision.suppress {
            if let Some(marker) = marker {
                if let Some(parent) = marker.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&marker, b"");
            }
        }

        if !decision.move_requested {
            return;
        }

        let detach = detach_candidate(
            location,
            &bundle_path,
            home.as_deref(),
            &volume,
            volume_info,
        );
        match move_to_applications_and_relaunch(&bundle_path, detach) {
            Ok(()) => {
                eprintln!("Relaunching Buzz from /Applications");
                // Tear down as Quit does, so terminals, plugin processes and
                // agent runtimes don't outlive us. Only now: had the move or
                // the relaunch failed, the app would keep running and still
                // need them.
                crate::shut_down(app);
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("Failed to move Buzz to /Applications: {error}");
                show_move_failed_alert(&error.to_string());
            }
        }
    }

    fn suppression_marker_path(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(SUPPRESSION_MARKER))
    }

    fn running_app_bundle_path() -> Option<PathBuf> {
        let executable = std::env::current_exe().ok()?;
        bundle_path_from_executable(&executable)
    }

    /// Read `CFBundleShortVersionString` and `CFBundleVersion` from a bundle's
    /// `Contents/Info.plist`. Returns `None` if the plist is missing/unreadable
    /// or lacks a short version string; the build identifier is best-effort and
    /// falls back to the short version when absent.
    fn read_bundle_version(bundle_path: &Path) -> Option<BundleVersion> {
        let info_plist = bundle_path.join("Contents/Info.plist");
        let value = plist::Value::from_file(&info_plist).ok()?;
        let dict = value.as_dictionary()?;
        let short = dict.get("CFBundleShortVersionString")?.as_string()?;
        let build = dict
            .get("CFBundleVersion")
            .and_then(plist::Value::as_string)
            .unwrap_or(short);
        Some(BundleVersion {
            short: short.to_string(),
            build: build.to_string(),
        })
    }

    /// Gather volume facts for `path` via `statfs`.
    fn volume_info(path: &Path) -> Option<VolumeInfo> {
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: `stat` is fully initialized by `statfs` on success; we only
        // read it when the call returns 0.
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c_path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        let mount_point = c_string_field_to_path(&stat.f_mntonname);
        let read_only = (stat.f_flags & libc::MNT_RDONLY as u32) != 0;
        let is_root = mount_point == Path::new("/");
        Some(VolumeInfo {
            mount_point,
            mounted_from: c_string_field_to_path(&stat.f_mntfromname),
            fs_type: c_string_field_to_path(&stat.f_fstypename)
                .to_string_lossy()
                .into_owned(),
            read_only,
            is_root,
        })
    }

    fn c_string_field_to_path(field: &[libc::c_char]) -> PathBuf {
        let bytes: Vec<u8> = field
            .iter()
            .take_while(|&&byte| byte != 0)
            .map(|&byte| byte as u8)
            .collect();
        PathBuf::from(std::ffi::OsStr::from_bytes(&bytes))
    }

    struct MoveDecision {
        move_requested: bool,
        suppress: bool,
    }

    fn show_move_alert(scenario: &MoveScenario, location: RunLocation) -> Option<MoveDecision> {
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSControlStateValueOn};
        use objc2_foundation::{MainThreadMarker, NSString};

        let copy = alert_copy(scenario, location);

        // AppKit calls here are only valid on the main thread, proven by the
        // `mtm` marker we just obtained.
        let mtm = MainThreadMarker::new()?;
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&copy.message));
        alert.setInformativeText(&NSString::from_str(&copy.informative));
        let primary = alert.addButtonWithTitle(&NSString::from_str(&copy.primary_button));
        let do_not_move = alert.addButtonWithTitle(&NSString::from_str("Do Not Move"));
        if !copy.move_is_default {
            // An alert gives Return to its first button. Hand it to "Do Not
            // Move" instead; the buttons keep their order and return codes.
            primary.setKeyEquivalent(&NSString::from_str(""));
            do_not_move.setKeyEquivalent(&NSString::from_str("\r"));
        }
        alert.setShowsSuppressionButton(true);

        let move_requested = alert.runModal() == NSAlertFirstButtonReturn;
        let suppress = alert
            .suppressionButton()
            .is_some_and(|button| button.state() == NSControlStateValueOn);

        Some(MoveDecision {
            move_requested,
            suppress,
        })
    }

    /// Tell the user a confirmed move failed, so the app silently continuing
    /// from installer media isn't the only signal. Best-effort: if we can't get
    /// onto the main thread the warning log is the fallback.
    fn show_move_failed_alert(error: &str) {
        use objc2_app_kit::NSAlert;
        use objc2_foundation::{MainThreadMarker, NSString};

        let (message, informative) = move_failed_alert_copy(error);

        // AppKit calls here are only valid on the main thread, proven by the
        // `mtm` marker.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&message));
        alert.setInformativeText(&NSString::from_str(&informative));
        let _ = alert.addButtonWithTitle(&NSString::from_str("OK"));
        let _ = alert.runModal();
    }

    fn move_to_applications_and_relaunch(
        bundle_path: &Path,
        detach: Option<PathBuf>,
    ) -> std::io::Result<()> {
        let target = installed_copy_path(bundle_path)
            .ok_or_else(|| std::io::Error::other("app bundle path has no file name"))?;

        // Stop before copying or quitting anything if the replacement can't
        // succeed, as with an installed copy owned by root.
        check_can_replace(&target)?;

        // Stage the copy under a hidden name on the same volume as the
        // target, so a failed or interrupted `ditto` (disk full, killed
        // mid-copy) can never leave a working installed copy trashed and the
        // target a half-written bundle. Only once the copy fully succeeds do
        // we trash the old copy and rename the staged one into place — an
        // atomic, same-volume rename. The move the dialog promised therefore
        // either happens completely or not at all.
        let staging = staging_path(&target);
        // At most one staging copy exists. One left by an interrupted earlier
        // move is removed first; if it can't be, the move stops here rather
        // than copying into it.
        clear_staging(&staging)?;

        // `ditto` is the macOS-blessed way to copy an app bundle while
        // preserving its structure and metadata.
        let status = Command::new("/usr/bin/ditto")
            .arg(bundle_path)
            .arg(&staging)
            .status()?;
        if !status.success() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(std::io::Error::other(format!("ditto exited with {status}")));
        }

        // The copy is complete and on the target's volume, so the remaining
        // steps are fast and the rename is atomic. An installed copy, if one
        // exists, goes to the Trash (recoverable and Finder-undoable) rather
        // than being overwritten in place. If trashing still fails after the
        // write-access check above (e.g. an ACL denies the delete) we stop
        // before the rename and discard the staged copy, leaving the existing
        // install untouched; if a later step fails, the trashed copy is put
        // back. Any running instance of the installed bundle is asked to quit
        // first, without waiting for it: trashing a running bundle still
        // succeeds, so a copy that is still quitting, or won't quit, never
        // blocks the move.
        // The candidate is any read-only volume under `/Volumes`, so only
        // detach it when it really is an attached disk image.
        let detach_mount = detach.filter(|mount| is_attached_image(mount));
        replace_installed_copy(
            &staging,
            &target,
            |installed| {
                terminate_running_copies(installed);
                move_to_trash(installed)
            },
            || {
                // Clear quarantine so Gatekeeper doesn't re-prompt or
                // translocate the freshly installed copy.
                let _ = Command::new("/usr/bin/xattr")
                    .args(["-r", "-d", "com.apple.quarantine"])
                    .arg(&target)
                    .status();
                relaunch_after_exit(&target, detach_mount)
            },
        )
    }

    /// Move `path` to the user's Trash via `NSFileManager` and return where it
    /// went, which can differ from its name when the Trash already holds one.
    /// Preferred over `rm -rf` because it's recoverable and Finder-undoable if
    /// the user changes their mind about replacing the installed copy.
    fn move_to_trash(path: &Path) -> std::io::Result<PathBuf> {
        use objc2_foundation::{NSFileManager, NSString, NSURL};

        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        let mut trashed = None;
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, Some(&mut trashed))
            .map_err(|error| {
                std::io::Error::other(format!(
                    "failed to move {} to Trash: {error:?}",
                    path.display()
                ))
            })?;
        // macOS reports the new location whenever the move succeeds.
        trashed
            .and_then(|url| url.path())
            .map(|trashed| PathBuf::from(trashed.to_string()))
            .ok_or_else(|| {
                std::io::Error::other(format!(
                    "moved {} to the Trash, but macOS didn't say where",
                    path.display()
                ))
            })
    }

    /// Ask every running application whose bundle is `target` to quit, so the
    /// copy about to be trashed doesn't linger with a stale tray icon or write
    /// a later self-update into the Trash. Matched by bundle *path*, not bundle
    /// identifier: `tauri_plugin_single_instance` already guarantees a previous
    /// build of this app isn't running, but the old block/buzz Buzz uses a
    /// different identifier, keeps running after its window is closed, and
    /// must be quit the same way without naming it.
    ///
    /// A copy that accepts `terminate()` is left to finish quitting on its own,
    /// from the Trash if need be, because trashing a running bundle succeeds on
    /// macOS. Old Buzz closes its terminals and stops its agents and their
    /// workers before it exits, and that takes as long as it takes, so
    /// force-quitting it after any fixed wait could orphan agents that nothing
    /// would ever clean up. Only a copy that doesn't accept the request is
    /// force-quit. The outcome is logged and the move continues regardless.
    ///
    /// This process is never asked to quit, even if `target` resolves to its
    /// own bundle.
    fn terminate_running_copies(target: &Path) {
        use objc2_app_kit::NSWorkspace;

        let target = normalized_bundle_path(target);
        let own_pid = std::process::id();
        let running = NSWorkspace::sharedWorkspace().runningApplications();
        for app in running.iter() {
            if u32::try_from(app.processIdentifier()) == Ok(own_pid) {
                continue;
            }
            let Some(path) = app.bundleURL().and_then(|url| url.path()) else {
                continue;
            };
            if normalized_bundle_path(Path::new(&path.to_string())) != target {
                continue;
            }
            let outcome = if app.terminate() {
                "asked to quit before replacement"
            } else if app.forceTerminate() {
                "force-quit before replacement"
            } else {
                "would not quit; replacing it anyway"
            };
            eprintln!(
                "Running copy of {} (pid {}): {outcome}",
                target.display(),
                app.processIdentifier()
            );
        }
    }

    /// Whether `mount` is the mount point of a disk image that is attached
    /// now, according to `hdiutil info`. `false` whenever that can't be
    /// established, so a failure here means the volume is left mounted.
    fn is_attached_image(mount: &Path) -> bool {
        let Ok(output) = Command::new("/usr/bin/hdiutil")
            .args(["info", "-plist"])
            .output()
        else {
            return false;
        };
        output.status.success()
            && plist::Value::from_reader(std::io::Cursor::new(output.stdout))
                .is_ok_and(|info| is_image_mount_point(&info, mount))
    }

    /// Spawn a detached shell that waits for this process to exit, launches the
    /// installed copy, and (optionally) detaches the disk image we ran from.
    fn relaunch_after_exit(target: &Path, detach_mount: Option<PathBuf>) -> std::io::Result<()> {
        let script = relaunch_script(std::process::id(), target, detach_mount.as_deref());
        Command::new("/bin/sh").arg("-c").arg(script).spawn()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::maybe_prompt_move_to_applications;

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(mount_point: &str, read_only: bool) -> VolumeInfo {
        VolumeInfo {
            mount_point: PathBuf::from(mount_point),
            mounted_from: PathBuf::from("/dev/disk9s1"),
            fs_type: "apfs".to_string(),
            read_only,
            is_root: mount_point == "/",
        }
    }

    #[test]
    fn bundle_path_resolves_to_dot_app_ancestor() {
        let exe = Path::new("/Applications/Buzz.app/Contents/MacOS/Buzz");
        assert_eq!(
            bundle_path_from_executable(exe),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
    }

    #[test]
    fn bundle_path_is_none_without_dot_app() {
        let exe = Path::new("/Users/someone/code/buzz-app/target/release/Buzz");
        assert_eq!(bundle_path_from_executable(exe), None);
    }

    #[test]
    fn applications_folder_detection_is_component_aware() {
        let home = Path::new("/Users/someone");
        assert!(is_in_applications_folder(
            Path::new("/Applications/Buzz.app"),
            Some(home)
        ));
        assert!(is_in_applications_folder(
            Path::new("/Users/someone/Applications/Buzz.app"),
            Some(home)
        ));
        // A directory that merely starts with the same characters is not a match.
        assert!(!is_in_applications_folder(
            Path::new("/ApplicationsOther/Buzz.app"),
            Some(home)
        ));
        assert!(!is_in_applications_folder(
            Path::new("/Volumes/Buzz/Buzz.app"),
            Some(home)
        ));
    }

    #[test]
    fn translocation_detected_by_path_component() {
        let translocated =
            Path::new("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app");
        assert!(is_translocated_path(translocated));
        assert!(!is_translocated_path(Path::new("/Volumes/Buzz/Buzz.app")));
    }

    #[test]
    fn classify_installed_app_does_not_prompt() {
        let location = classify(
            Path::new("/Applications/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::InstalledInApplications);
        assert!(!location.should_prompt_move());
    }

    #[test]
    fn classify_user_applications_counts_as_installed() {
        let location = classify(
            Path::new("/Users/someone/Applications/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::InstalledInApplications);
        // Without a known home, ~/Applications is just another writable folder.
        let location = classify(
            Path::new("/Users/someone/Applications/Buzz.app"),
            None,
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
    }

    #[test]
    fn classify_disk_image() {
        let location = classify(
            Path::new("/Volumes/Buzz/Buzz.app"),
            None,
            &volume("/Volumes/Buzz", true),
        );
        assert_eq!(location, RunLocation::DiskImage);
        assert!(location.should_prompt_move());
    }

    #[test]
    fn classify_translocation_takes_priority_over_volume() {
        let location = classify(
            Path::new("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app"),
            None,
            &volume("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d", true),
        );
        assert_eq!(location, RunLocation::Translocated);
    }

    const TRANSLOCATION_MOUNT: &str =
        "/private/var/folders/ab/cdef/T/AppTranslocation/2AAF5ABB-C3C1-4670-A76A-29A02FE4FA5D";

    /// The volume of a translocated copy of `original`, as `statfs` reports
    /// it for a real Gatekeeper launch.
    fn translocation_volume(original: &str) -> VolumeInfo {
        VolumeInfo {
            mount_point: PathBuf::from(TRANSLOCATION_MOUNT),
            mounted_from: PathBuf::from(original),
            fs_type: "nullfs".to_string(),
            read_only: true,
            is_root: false,
        }
    }

    fn translocated_bundle() -> PathBuf {
        Path::new(TRANSLOCATION_MOUNT).join("d/Buzz.app")
    }

    #[test]
    fn translocated_original_is_the_bundle_the_translocation_mount_shows() {
        for original in [
            "/Volumes/Buzz/Buzz.app",
            "/Volumes/Buzz 1/Sub Folder/Buzz.app",
            "/Users/someone/Downloads/Buzz.app",
        ] {
            assert_eq!(
                translocated_original(&translocated_bundle(), &translocation_volume(original)),
                Some(PathBuf::from(original)),
            );
        }
    }

    #[test]
    fn translocated_original_is_none_for_a_volume_of_another_shape() {
        let on_image = translocation_volume("/Volumes/Buzz/Buzz.app");
        let mount = Path::new(TRANSLOCATION_MOUNT);

        // A bundle on an ordinary volume, under a folder named
        // `AppTranslocation`, is classified `Translocated` without being so.
        let folder = Path::new("/Volumes/Buzz/AppTranslocation/d/Buzz.app");
        let ordinary = VolumeInfo {
            mount_point: PathBuf::from("/Volumes/Buzz/AppTranslocation"),
            mounted_from: PathBuf::from("/Volumes/Other/Buzz.app"),
            ..volume("/Volumes/Buzz", true)
        };
        assert_eq!(classify(folder, None, &ordinary), RunLocation::Translocated);
        assert_eq!(translocated_original(folder, &ordinary), None);

        // The bundle isn't where the mount shows its original.
        for bundle in [
            mount.join("Buzz.app"),
            mount.join("e/Buzz.app"),
            mount.join("d/Buzz.app/Contents/Helpers/Buzz.app"),
            PathBuf::from("/private/var/folders/ab/cdef/T/AppTranslocation/OTHER/d/Buzz.app"),
        ] {
            assert_eq!(translocated_original(&bundle, &on_image), None);
        }

        // The mount's source doesn't name this bundle: another name (as a
        // source cut short would have), no file name, or not a full path.
        for source in [
            "/Volumes/Buzz/Other.app",
            "/Volumes/Buzz/Buz",
            "/",
            "Buzz.app",
        ] {
            assert_eq!(
                translocated_original(&translocated_bundle(), &translocation_volume(source)),
                None,
                "{source}"
            );
        }
    }

    /// Runs `detach_candidate` for a `Translocated` copy of `original`, whose
    /// own volume is `original_volume`.
    fn translocated_detach_candidate(
        original: &str,
        original_volume: Option<VolumeInfo>,
    ) -> Option<PathBuf> {
        detach_candidate(
            RunLocation::Translocated,
            &translocated_bundle(),
            Some(Path::new("/Users/someone")),
            &translocation_volume(original),
            |path| {
                assert_eq!(path, Path::new(original));
                original_volume
            },
        )
    }

    #[test]
    fn detach_candidate_for_a_disk_image_copy_is_its_own_volume() {
        assert_eq!(
            detach_candidate(
                RunLocation::DiskImage,
                Path::new("/Volumes/Buzz 1/Buzz.app"),
                None,
                &volume("/Volumes/Buzz 1", true),
                |_| unreachable!("only a translocated copy has another volume to look up"),
            ),
            Some(PathBuf::from("/Volumes/Buzz 1")),
        );
    }

    #[test]
    fn detach_candidate_for_a_translocated_copy_is_the_disk_image_holding_its_original() {
        assert_eq!(
            translocated_detach_candidate(
                "/Volumes/Buzz 1/Buzz.app",
                Some(volume("/Volumes/Buzz 1", true)),
            ),
            Some(PathBuf::from("/Volumes/Buzz 1")),
        );
        assert_eq!(
            translocated_detach_candidate(
                "/Volumes/Buzz/Sub Folder/Buzz.app",
                Some(volume("/Volumes/Buzz", true)),
            ),
            Some(PathBuf::from("/Volumes/Buzz")),
        );
    }

    #[test]
    fn detach_candidate_is_none_for_a_translocated_copy_that_is_not_from_a_disk_image() {
        // A quarantined download, on the writable data volume.
        assert_eq!(
            translocated_detach_candidate(
                "/Users/someone/Downloads/Buzz.app",
                Some(volume("/System/Volumes/Data", false)),
            ),
            None,
        );
        // A writable volume, a read-only one outside `/Volumes`, and an
        // original in an Applications folder: none is a `DiskImage` copy.
        assert_eq!(
            translocated_detach_candidate(
                "/Volumes/Drive/Buzz.app",
                Some(volume("/Volumes/Drive", false)),
            ),
            None,
        );
        assert_eq!(
            translocated_detach_candidate(
                "/private/mnt/Buzz.app",
                Some(volume("/private/mnt", true)),
            ),
            None,
        );
        assert_eq!(
            translocated_detach_candidate(
                "/Users/someone/Applications/Buzz.app",
                Some(volume("/Volumes/Home", true)),
            ),
            None,
        );
        // The original's volume can't be read.
        assert_eq!(
            translocated_detach_candidate("/Volumes/Buzz/Buzz.app", None),
            None
        );
    }

    #[test]
    fn detach_candidate_is_none_without_an_identified_original_or_a_disk_image() {
        let never = |_: &Path| -> Option<VolumeInfo> {
            unreachable!("no original was identified, so there is no volume to look up")
        };
        // Classified `Translocated`, but the volume isn't a translocation
        // mount, even though it is itself a read-only volume under `/Volumes`.
        assert_eq!(
            detach_candidate(
                RunLocation::Translocated,
                Path::new("/Volumes/Buzz/AppTranslocation/d/Buzz.app"),
                None,
                &volume("/Volumes/Buzz", true),
                never,
            ),
            None,
        );
        for location in [
            RunLocation::ReadOnlyVolume,
            RunLocation::OtherNonInstalled,
            RunLocation::InstalledInApplications,
        ] {
            assert_eq!(
                detach_candidate(
                    location,
                    &translocated_bundle(),
                    None,
                    &translocation_volume("/Volumes/Buzz/Buzz.app"),
                    never,
                ),
                None,
                "{location:?}"
            );
        }
    }

    #[test]
    fn classify_read_only_non_volume() {
        let location = classify(
            Path::new("/mnt/ro/Buzz.app"),
            None,
            &volume("/mnt/ro", true),
        );
        assert_eq!(location, RunLocation::ReadOnlyVolume);
    }

    #[test]
    fn classify_read_only_root_is_not_installer_media() {
        // A sealed system volume mounted at `/` is read-only, but a bundle on
        // it is just a non-installed copy, not a disk image.
        let location = classify(
            Path::new("/ApplicationsOther/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", true),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
    }

    #[test]
    fn classify_writable_download_is_other_non_installed() {
        let location = classify(
            Path::new("/Users/someone/Downloads/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
        assert!(location.should_prompt_move());
    }

    #[test]
    fn installed_copy_path_uses_only_the_bundle_file_name() {
        // Whatever the running copy's identifier or executable, the installed
        // copy is `/Applications/<same file name>`.
        assert_eq!(
            installed_copy_path(Path::new("/Volumes/Buzz/Buzz.app")),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
        assert_eq!(
            installed_copy_path(Path::new(
                "/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app"
            )),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
        assert_eq!(installed_copy_path(Path::new("/")), None);
    }

    #[cfg(unix)]
    #[test]
    fn normalized_bundle_path_matches_through_symlinks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bundle = dir.path().join("Buzz.app");
        std::fs::create_dir(&bundle).expect("create bundle");
        let link = dir.path().join("Linked.app");
        std::os::unix::fs::symlink(&bundle, &link).expect("symlink");
        // `NSRunningApplication` reports a resolved bundle URL while the target
        // is built from the file name; both must normalise to one path (on
        // macOS this also folds `/var` onto `/private/var`).
        assert_eq!(
            normalized_bundle_path(&link),
            normalized_bundle_path(&bundle)
        );
        assert_ne!(
            normalized_bundle_path(&link),
            normalized_bundle_path(&dir.path().join("Other.app"))
        );
        // A path that doesn't exist is compared as written rather than dropped.
        assert_eq!(
            normalized_bundle_path(Path::new("/Applications/Missing.app")),
            PathBuf::from("/Applications/Missing.app")
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_copy_symlinked_to_the_running_bundle_is_the_running_bundle() {
        let dir = tempfile::tempdir().expect("tempdir");
        let running = dir.path().join("Downloads/Buzz.app");
        std::fs::create_dir_all(&running).expect("create running bundle");
        let installed = dir.path().join("Applications/Buzz.app");
        std::fs::create_dir(installed.parent().expect("parent")).expect("create Applications");
        std::os::unix::fs::symlink(&running, &installed).expect("symlink");
        assert!(is_running_bundle(&running, &installed));

        // A real installed copy, or none at all, is a different bundle.
        let other = dir.path().join("Other/Buzz.app");
        std::fs::create_dir_all(&other).expect("create other copy");
        assert!(!is_running_bundle(&running, &other));
        assert!(!is_running_bundle(
            &running,
            &dir.path().join("Missing/Buzz.app")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn check_can_replace_accepts_a_writable_folder_and_copy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("Buzz.app");
        std::fs::create_dir(&target).expect("create installed copy");

        check_can_replace(&target).expect("a writable copy can be replaced");
    }

    #[cfg(unix)]
    #[test]
    fn check_can_replace_accepts_a_missing_copy() {
        let dir = tempfile::tempdir().expect("tempdir");

        check_can_replace(&dir.path().join("Buzz.app")).expect("nothing to replace");
    }

    #[cfg(unix)]
    #[test]
    fn check_can_replace_fails_for_a_copy_that_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("Buzz.app");
        std::fs::create_dir(&target).expect("create installed copy");
        // As a software-management tool leaves it: readable, not writable.
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o555))
            .expect("lock installed copy");
        let link = dir.path().join("Linked.app");
        std::os::unix::fs::symlink(&target, &link).expect("symlink");

        let error = check_can_replace(&target).expect_err("the copy can't be moved to the Trash");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "{error}"
        );
        assert_eq!(
            error.to_string(),
            format!("you don't have permission to replace {}", target.display())
        );
        // A symlink to that copy can be: only the link itself would move.
        check_can_replace(&link).expect("a symlink can be replaced");
    }

    #[cfg(unix)]
    #[test]
    fn check_can_replace_fails_for_a_folder_that_is_not_writable() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let applications = dir.path().join("Applications");
        let target = applications.join("Buzz.app");
        std::fs::create_dir_all(&target).expect("create installed copy");
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555))
            .expect("lock folder");
        let result = check_can_replace(&target);
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755))
            .expect("unlock folder");

        let error = result.expect_err("nothing can be added to the folder");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "{error}"
        );
        assert_eq!(
            error.to_string(),
            format!(
                "you don't have permission to add apps to {}",
                applications.display()
            )
        );
    }

    #[test]
    fn staging_path_is_hidden_fixed_and_beside_the_target() {
        // No pid or other per-run part, so a later move finds an earlier
        // move's leftover; never an `.app`, so Launch Services ignores it.
        assert_eq!(
            staging_path(Path::new("/Applications/Buzz.app")),
            PathBuf::from("/Applications/.Buzz.app.staging")
        );
        assert_eq!(
            staging_path(Path::new("/Applications/Buzz Preview.app")),
            PathBuf::from("/Applications/.Buzz Preview.app.staging")
        );
    }

    #[test]
    fn clear_staging_removes_a_leftover_copy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let staging = dir.path().join(".Buzz.app.staging");
        std::fs::create_dir_all(staging.join("Contents/MacOS")).expect("create leftover");
        std::fs::write(staging.join("Contents/MacOS/Buzz"), b"stale").expect("write leftover");

        clear_staging(&staging).expect("clear leftover");

        assert!(!staging.exists());
    }

    #[test]
    fn clear_staging_accepts_nothing_to_clear() {
        let dir = tempfile::tempdir().expect("tempdir");
        clear_staging(&dir.path().join(".Buzz.app.staging")).expect("nothing to clear");
    }

    #[cfg(unix)]
    #[test]
    fn clear_staging_fails_when_a_leftover_cannot_be_removed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let staging = dir.path().join(".Buzz.app.staging");
        let contents = staging.join("Contents");
        std::fs::create_dir_all(&contents).expect("create leftover");
        std::fs::write(contents.join("x"), b"stale").expect("write leftover");
        // Entries of a read-only directory can't be unlinked, even by its owner.
        std::fs::set_permissions(&contents, std::fs::Permissions::from_mode(0o555))
            .expect("lock leftover");
        let result = clear_staging(&staging);
        std::fs::set_permissions(&contents, std::fs::Permissions::from_mode(0o755))
            .expect("unlock leftover");

        let error = result.expect_err("a leftover that can't be removed stops the move");
        assert!(
            error.to_string().contains(&staging.display().to_string()),
            "{error}"
        );
        assert!(contents.join("x").exists());
    }

    /// An installed `Applications/Buzz.app` holding `old`, its staged
    /// replacement holding `new`, and an empty stand-in Trash.
    fn installed_and_staged() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("Applications/Buzz.app");
        let staging = staging_path(&target);
        let trash = dir.path().join("Trash");
        std::fs::create_dir_all(&target).expect("create installed copy");
        std::fs::write(target.join("old"), b"").expect("write installed copy");
        std::fs::create_dir_all(&staging).expect("create staged copy");
        std::fs::write(staging.join("new"), b"").expect("write staged copy");
        std::fs::create_dir(&trash).expect("create trash");
        (dir, target, staging, trash)
    }

    /// Stand-in for the Trash: moves the installed copy into `trash`, like
    /// `NSFileManager` does, and returns where it went.
    fn move_into(trash: &Path, installed: &Path) -> std::io::Result<PathBuf> {
        let trashed = trash.join(installed.file_name().expect("file name"));
        std::fs::rename(installed, &trashed)?;
        Ok(trashed)
    }

    #[test]
    fn replace_installed_copy_trashes_the_old_copy_and_installs_the_new_one() {
        let (_dir, target, staging, trash) = installed_and_staged();
        let mut finished = false;

        replace_installed_copy(
            &staging,
            &target,
            |installed| move_into(&trash, installed),
            || {
                finished = true;
                Ok(())
            },
        )
        .expect("replace");

        assert!(finished);
        assert!(target.join("new").exists());
        assert!(!target.join("old").exists());
        assert!(trash.join("Buzz.app/old").exists());
        assert!(!staging.exists());
    }

    #[test]
    fn replace_installed_copy_puts_the_old_copy_back_when_the_rename_fails() {
        let (_dir, target, staging, trash) = installed_and_staged();

        let error = replace_installed_copy(
            &staging,
            &target,
            |installed| {
                let trashed = move_into(&trash, installed)?;
                // The staged copy is gone by the time it's renamed.
                std::fs::remove_dir_all(&staging)?;
                Ok(trashed)
            },
            || panic!("finish runs only after the rename"),
        )
        .expect_err("the rename fails");

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound, "{error}");
        assert!(target.join("old").exists());
        assert!(!trash.join("Buzz.app").exists());
    }

    #[test]
    fn replace_installed_copy_puts_the_old_copy_back_when_finishing_fails() {
        let (_dir, target, staging, trash) = installed_and_staged();

        let error = replace_installed_copy(
            &staging,
            &target,
            |installed| move_into(&trash, installed),
            || Err(std::io::Error::other("relaunch failed")),
        )
        .expect_err("finishing fails");

        assert_eq!(error.to_string(), "relaunch failed");
        assert!(target.join("old").exists());
        assert!(!target.join("new").exists());
        assert!(!trash.join("Buzz.app").exists());
        assert!(!staging.exists());
    }

    #[cfg(unix)]
    #[test]
    fn replace_installed_copy_names_the_trashed_copy_when_it_cannot_be_put_back() {
        use std::os::unix::fs::PermissionsExt;

        let (_dir, target, staging, trash) = installed_and_staged();
        let applications = target.parent().expect("parent").to_path_buf();

        let result = replace_installed_copy(
            &staging,
            &target,
            |installed| {
                let trashed = move_into(&trash, installed)?;
                // Nothing more can be renamed into or out of the folder.
                std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o555))?;
                Ok(trashed)
            },
            || panic!("finish runs only after the rename"),
        );
        std::fs::set_permissions(&applications, std::fs::Permissions::from_mode(0o755))
            .expect("unlock folder");

        let error = result.expect_err("the rename and the restore both fail");
        let trashed = trash.join("Buzz.app");
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::PermissionDenied,
            "{error}"
        );
        assert!(
            error
                .to_string()
                .contains(&format!("is in the Trash at {}", trashed.display())),
            "{error}"
        );
        assert!(trashed.join("old").exists());
        assert!(!target.exists());
    }

    fn version(short: &str, build: &str) -> BundleVersion {
        BundleVersion {
            short: short.to_string(),
            build: build.to_string(),
        }
    }

    #[test]
    fn compare_versions_orders_by_short_semver() {
        assert_eq!(
            compare_versions(&version("0.8.0", "8"), &version("0.7.12", "712")),
            VersionRelation::RunningNewer
        );
        assert_eq!(
            compare_versions(&version("0.7.12", "712"), &version("0.8.0", "8")),
            VersionRelation::RunningOlder
        );
        assert_eq!(
            compare_versions(&version("1.2.3", "10"), &version("1.2.3", "20")),
            VersionRelation::Same
        );
    }

    #[test]
    fn compare_versions_unparseable_is_unknown() {
        assert_eq!(
            compare_versions(&version("not-a-version", "1"), &version("0.7.12", "712")),
            VersionRelation::Unknown
        );
        assert_eq!(
            compare_versions(&version("0.8.0", "8"), &version("", "0")),
            VersionRelation::Unknown
        );
    }

    /// The `CFBundleShortVersionString` this build ships, read from the same
    /// `tauri.conf.json` the bundler reads so the old-Buzz cases track the real
    /// current version instead of a copy of it.
    fn current_version() -> String {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        conf["version"].as_str().expect("version").to_string()
    }

    /// Every version family the old Buzz from block/buzz has shipped, as the
    /// (`CFBundleShortVersionString`, `CFBundleVersion`) pairs found in its
    /// bundles: the OSS and Block-signed (`-block`) 0.5.x releases, canary and
    /// Intel-canary builds, and the Sprout-era test builds.
    const OLD_BUZZ_VERSIONS: &[(&str, &str)] = &[
        ("0.5.28", "0.5.28"),
        ("0.5.28", "0.5.28-block"),
        ("0.5.9", "0.5.9-block"),
        ("0.3.18", "0.3.18"),
        ("0.5.29-test.123", "0.5.29-test.123"),
        ("0.5.28-intel-test.45", "0.5.28-intel-test.45"),
        ("0.0.1-test.3", "0.0.1-test.3"),
    ];

    #[test]
    fn old_buzz_from_block_buzz_is_always_an_upgrade() {
        let current = current_version();
        let running = version(&current, &current);
        for (short, build) in OLD_BUZZ_VERSIONS {
            let installed = version(short, build);
            assert_eq!(
                compare_versions(&running, &installed),
                VersionRelation::RunningNewer,
                "{short} / {build}"
            );
            assert_eq!(
                scenario_for(true, Some(&running), Some(&installed)),
                MoveScenario::Upgrade {
                    from: short.to_string(),
                    to: current.clone(),
                },
                "{short} / {build}"
            );
        }
    }

    #[test]
    fn old_buzz_prerelease_suffix_never_degrades_to_replace() {
        // `CFBundleVersion` is read but never compared, so a `-block` or
        // `-test.N` suffix there changes nothing; the same suffix on the short
        // string parses as a semver prerelease rather than falling into
        // `ExistingUnknown`.
        let running = version("0.7.1", "0.7.1");
        let clean = scenario_for(true, Some(&running), Some(&version("0.5.28", "0.5.28")));
        assert_eq!(
            scenario_for(
                true,
                Some(&running),
                Some(&version("0.5.28", "0.5.28-block"))
            ),
            clean
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&running),
                Some(&version("0.5.28", "0.5.29-test.123"))
            ),
            clean
        );
        for short in ["0.5.28-block", "0.5.29-test.123", "0.5.28-intel-test.45"] {
            assert_eq!(
                scenario_for(true, Some(&running), Some(&version(short, short))),
                MoveScenario::Upgrade {
                    from: short.to_string(),
                    to: "0.7.1".to_string(),
                },
                "{short}"
            );
        }
    }

    #[test]
    fn old_buzz_and_previous_buzz_app_build_get_the_same_upgrade_dialog() {
        // Same scenario variant, same message and button, and informative text
        // identical apart from the version numbers: the dialog can't tell
        // whether `/Applications/Buzz.app` is block/buzz's Buzz or an earlier
        // build of this app.
        let running = version("0.7.1", "0.7.1");
        let old_buzz = scenario_for(
            true,
            Some(&running),
            Some(&version("0.5.28", "0.5.28-block")),
        );
        let previous_buzz_app =
            scenario_for(true, Some(&running), Some(&version("0.7.0", "0.7.0")));
        assert_eq!(
            old_buzz,
            MoveScenario::Upgrade {
                from: "0.5.28".to_string(),
                to: "0.7.1".to_string(),
            }
        );
        assert_eq!(
            previous_buzz_app,
            MoveScenario::Upgrade {
                from: "0.7.0".to_string(),
                to: "0.7.1".to_string(),
            }
        );

        let old = alert_copy(&old_buzz, RunLocation::DiskImage);
        let previous = alert_copy(&previous_buzz_app, RunLocation::DiskImage);
        assert_eq!(old.message, previous.message);
        assert_eq!(old.primary_button, previous.primary_button);
        assert_eq!(
            old.informative.replace("0.5.28", "0.7.0"),
            previous.informative
        );
    }

    #[test]
    fn scenario_for_no_install_is_fresh() {
        assert_eq!(
            scenario_for(false, Some(&version("0.8.0", "8")), None),
            MoveScenario::FreshInstall
        );
    }

    #[test]
    fn scenario_for_existing_install_maps_relation() {
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.8.0", "8")),
                Some(&version("0.7.12", "712"))
            ),
            MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            }
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.7.12", "712")),
                Some(&version("0.8.0", "8"))
            ),
            MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            }
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.8.0", "8")),
                Some(&version("0.8.0", "8"))
            ),
            MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            }
        );
    }

    #[test]
    fn scenario_for_unreadable_existing_is_existing_unknown() {
        // Target exists but we couldn't read one (or both) versions.
        assert_eq!(
            scenario_for(true, Some(&version("0.8.0", "8")), None),
            MoveScenario::ExistingUnknown
        );
        assert_eq!(
            scenario_for(true, None, Some(&version("0.7.12", "712"))),
            MoveScenario::ExistingUnknown
        );
        // Both readable but at least one short string isn't semver.
        assert_eq!(
            scenario_for(
                true,
                Some(&version("nightly", "8")),
                Some(&version("0.7.12", "712"))
            ),
            MoveScenario::ExistingUnknown
        );
    }

    #[test]
    fn alert_copy_reflects_scenario() {
        let fresh = alert_copy(&MoveScenario::FreshInstall, RunLocation::DiskImage);
        assert_eq!(fresh.message, "Move to Applications folder?");
        assert_eq!(fresh.primary_button, "Move to Applications Folder");
        assert!(fresh.move_is_default);
        assert!(fresh.informative.starts_with("Buzz can move itself"));

        let upgrade = alert_copy(
            &MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(upgrade.message, "Upgrade Buzz in your Applications folder?");
        assert_eq!(upgrade.primary_button, "Upgrade and Relaunch");
        assert!(upgrade.move_is_default);
        assert!(upgrade
            .informative
            .contains("You have Buzz 0.7.12 installed"));
        assert!(upgrade.informative.contains("newer version 0.8.0"));

        let downgrade = alert_copy(
            &MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(
            downgrade.message,
            "Replace the newer version in your Applications folder?"
        );
        assert_eq!(downgrade.primary_button, "Replace and Relaunch");
        // Return must not replace a newer installed copy.
        assert!(!downgrade.move_is_default);
        assert!(downgrade
            .informative
            .contains("0.8.0 installed, which is newer than this copy (0.7.12)"));

        let reinstall = alert_copy(
            &MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(
            reinstall.message,
            "Reinstall Buzz 0.8.0 in your Applications folder?"
        );
        assert_eq!(reinstall.primary_button, "Reinstall and Relaunch");
        assert!(reinstall.move_is_default);
        assert!(reinstall
            .informative
            .starts_with("Buzz 0.8.0 is already installed"));

        let unknown = alert_copy(&MoveScenario::ExistingUnknown, RunLocation::DiskImage);
        assert_eq!(
            unknown.message,
            "Replace the copy in your Applications folder?"
        );
        assert_eq!(unknown.primary_button, "Replace and Relaunch");
        // An unknown installed version may be the newer one.
        assert!(!unknown.move_is_default);
        assert!(unknown
            .informative
            .starts_with("Buzz is already installed in your Applications folder."));
    }

    #[test]
    fn alert_copy_appends_location_note() {
        // The per-location note is appended regardless of scenario.
        for scenario in [
            MoveScenario::FreshInstall,
            MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            },
            MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            },
            MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            },
            MoveScenario::ExistingUnknown,
        ] {
            assert!(alert_copy(&scenario, RunLocation::DiskImage)
                .informative
                .ends_with("\n\nYou're currently running Buzz from a disk image."));
            assert!(alert_copy(&scenario, RunLocation::Translocated)
                .informative
                .ends_with("\n\nmacOS is running this copy from a temporary, read-only location."));
            assert!(alert_copy(&scenario, RunLocation::ReadOnlyVolume)
                .informative
                .ends_with("\n\nYou're currently running Buzz from a read-only volume."));
            assert!(alert_copy(&scenario, RunLocation::OtherNonInstalled)
                .informative
                .ends_with(
                    "\n\nYou're currently running Buzz from outside your Applications folder."
                ));
            assert!(!alert_copy(&scenario, RunLocation::InstalledInApplications)
                .informative
                .ends_with('\n'));
        }
    }

    #[test]
    fn move_failed_alert_copy_surfaces_error_and_manual_path() {
        let (message, informative) = move_failed_alert_copy("ditto exited with exit status: 1");
        assert_eq!(message, "Couldn't move Buzz to your Applications folder");
        // The user is told the app keeps working and how to move it by hand.
        assert!(informative.starts_with("Buzz will keep running from its current location."));
        assert!(informative.contains("dragging Buzz into your Applications folder"));
        // The underlying error is included for support/debugging.
        assert!(informative.ends_with("\n\nDetails: ditto exited with exit status: 1"));
    }

    #[test]
    fn shell_single_quote_wraps_plain_paths() {
        assert_eq!(
            shell_single_quote("/Applications/Buzz.app"),
            "'/Applications/Buzz.app'"
        );
        // Spaces and shell metacharacters are inert inside single quotes.
        assert_eq!(
            shell_single_quote("/Volumes/My Buzz & Co/Buzz.app"),
            "'/Volumes/My Buzz & Co/Buzz.app'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_single_quote_neutralizes_embedded_quotes() {
        // A bundle renamed to break out of double quotes stays a single inert
        // argument under single-quote escaping.
        let malicious = r#"/Volumes/x/Buzz";rm -rf ~;".app"#;
        let quoted = shell_single_quote(malicious);
        assert_eq!(quoted, r#"'/Volumes/x/Buzz";rm -rf ~;".app'"#);
        // A literal single quote becomes the classic close/escape/reopen
        // sequence rather than ending the quoted string early.
        assert_eq!(shell_single_quote("a'b"), r#"'a'\''b'"#);

        // The escaping round-trips through a real shell: the quoted string,
        // echoed back, must equal the original path verbatim with no splitting
        // or command execution.
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf %s {}", shell_single_quote(malicious)))
            .output()
            .expect("spawn /bin/sh");
        assert_eq!(String::from_utf8_lossy(&output.stdout), malicious);
    }

    #[test]
    fn relaunch_script_launches_a_new_instance_once_this_process_exits() {
        // `-n`: a copy of the replaced bundle that is still quitting stays
        // registered at this path, and plain `open` would hand the launch to
        // it instead of starting the installed copy.
        assert_eq!(
            relaunch_script(4711, Path::new("/Applications/Buzz.app"), None),
            "while /bin/kill -0 4711 >/dev/null 2>&1; do /bin/sleep 0.2; done; \
             /usr/bin/open -n '/Applications/Buzz.app'"
        );
    }

    #[test]
    fn relaunch_script_detaches_the_disk_image_after_launching() {
        // A second mounted image gets a space in its mount point, and neither
        // path may break out of its quoting.
        assert_eq!(
            relaunch_script(
                4711,
                Path::new("/Applications/Buzz's.app"),
                Some(Path::new("/Volumes/Buzz 1")),
            ),
            "while /bin/kill -0 4711 >/dev/null 2>&1; do /bin/sleep 0.2; done; \
             /usr/bin/open -n '/Applications/Buzz'\\''s.app'; \
             /bin/sleep 1; /usr/bin/hdiutil detach '/Volumes/Buzz 1' >/dev/null 2>&1"
        );
    }

    /// `hdiutil info -plist` with three images attached, cut down to the keys
    /// that matter: an HFS+ image, whose partition is the mounted entity; an
    /// APFS image, whose mounted entity is the synthesized volume; and an
    /// image attached without mounting it.
    #[cfg(target_os = "macos")]
    const HDIUTIL_INFO: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>framework</key>
    <string>710</string>
    <key>images</key>
    <array>
        <dict>
            <key>image-path</key>
            <string>/Users/example/Downloads/Buzz.dmg</string>
            <key>system-entities</key>
            <array>
                <dict>
                    <key>content-hint</key>
                    <string>GUID_partition_scheme</string>
                    <key>dev-entry</key>
                    <string>/dev/disk8</string>
                </dict>
                <dict>
                    <key>content-hint</key>
                    <string>48465300-0000-11AA-AA11-00306543ECAC</string>
                    <key>dev-entry</key>
                    <string>/dev/disk8s1</string>
                    <key>mount-point</key>
                    <string>/Volumes/Buzz</string>
                </dict>
            </array>
        </dict>
        <dict>
            <key>image-path</key>
            <string>/Users/example/Downloads/Buzz (1).dmg</string>
            <key>system-entities</key>
            <array>
                <dict>
                    <key>content-hint</key>
                    <string>GUID_partition_scheme</string>
                    <key>dev-entry</key>
                    <string>/dev/disk9</string>
                </dict>
                <dict>
                    <key>content-hint</key>
                    <string>7C3457EF-0000-11AA-AA11-00306543ECAC</string>
                    <key>dev-entry</key>
                    <string>/dev/disk9s1</string>
                </dict>
                <dict>
                    <key>content-hint</key>
                    <string>EF57347C-0000-11AA-AA11-00306543ECAC</string>
                    <key>dev-entry</key>
                    <string>/dev/disk10</string>
                </dict>
                <dict>
                    <key>content-hint</key>
                    <string>41504653-0000-11AA-AA11-00306543ECAC</string>
                    <key>dev-entry</key>
                    <string>/dev/disk10s1</string>
                    <key>mount-point</key>
                    <string>/Volumes/Buzz 1</string>
                </dict>
            </array>
        </dict>
        <dict>
            <key>image-path</key>
            <string>/Users/example/Downloads/Other.dmg</string>
            <key>system-entities</key>
            <array>
                <dict>
                    <key>content-hint</key>
                    <string>GUID_partition_scheme</string>
                    <key>dev-entry</key>
                    <string>/dev/disk11</string>
                </dict>
                <dict>
                    <key>content-hint</key>
                    <string>48465300-0000-11AA-AA11-00306543ECAC</string>
                    <key>dev-entry</key>
                    <string>/dev/disk11s1</string>
                </dict>
            </array>
        </dict>
    </array>
    <key>revision</key>
    <string>710</string>
    <key>vendor</key>
    <string>Apple</string>
</dict>
</plist>
"#;

    #[cfg(target_os = "macos")]
    fn plist_value(xml: &str) -> plist::Value {
        plist::Value::from_reader(std::io::Cursor::new(xml.as_bytes())).expect("parse plist")
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn image_mount_points_lists_the_mounted_entity_of_each_image() {
        assert_eq!(
            image_mount_points(&plist_value(HDIUTIL_INFO)),
            [
                PathBuf::from("/Volumes/Buzz"),
                PathBuf::from("/Volumes/Buzz 1")
            ]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn image_mount_points_is_empty_for_output_of_another_shape() {
        // No images attached, and values of the wrong type at each level.
        for xml in [
            "<plist><dict><key>images</key><array/></dict></plist>",
            "<plist><dict><key>vendor</key><string>Apple</string></dict></plist>",
            "<plist><string>images</string></plist>",
            "<plist><dict><key>images</key><string>/Volumes/Buzz</string></dict></plist>",
            "<plist><dict><key>images</key><array><string>/Volumes/Buzz</string>\
             <dict><key>system-entities</key><string>/Volumes/Buzz</string></dict>\
             <dict><key>system-entities</key><array><string>/Volumes/Buzz</string>\
             <dict><key>mount-point</key><true/></dict></array></dict></array></dict></plist>",
        ] {
            assert_eq!(
                image_mount_points(&plist_value(xml)),
                Vec::<PathBuf>::new(),
                "{xml}"
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_the_mount_point_of_an_attached_image_is_an_image_mount_point() {
        let info = plist_value(HDIUTIL_INFO);
        assert!(is_image_mount_point(&info, Path::new("/Volumes/Buzz")));
        assert!(is_image_mount_point(&info, Path::new("/Volumes/Buzz 1")));
        // A read-only drive or share under `/Volumes` is classified as
        // `DiskImage` too, but no attached image is mounted there.
        assert!(!is_image_mount_point(&info, Path::new("/Volumes/NTFS")));
        // Only a whole mount point matches.
        assert!(!is_image_mount_point(&info, Path::new("/Volumes")));
        assert!(!is_image_mount_point(
            &info,
            Path::new("/Volumes/Buzz/Buzz.app")
        ));
        assert!(!is_image_mount_point(&info, Path::new("/dev/disk8s1")));
    }
}
