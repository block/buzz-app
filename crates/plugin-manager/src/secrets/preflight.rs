//! Completed-scan observation for sign-out without an established inventory.
//! The read-only filesystem adapter feeds the ordered strict predicate below.
//! This is not absence maintained through a later destructive boundary: public
//! Manager/CLI and historical pathname writers do not participate in admission.
use crate::{parse_registry, valid_hash, valid_id, Installed, Result, LIMIT};
use serde::de::{Error, MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// Immediate entries one home's `profiles` folder may hold; one more refuses.
pub const MAX_PROFILES: usize = 1024;

const UNRESOLVED: &str = "A location in the sign-out scope could not be inspected";
const OUT_OF_SCOPE: &str =
    "An inspection reported a location outside the declared sign-out scope or out of its order";
const INCOMPLETE: &str = "The declared sign-out scope was not completely inspected";
const TOO_MANY: &str = "A plugin home has more profile entries than a sign-out can inspect";
const UNREADABLE: &str = "Plugin settings could not be validated as an older version's";
const EVIDENCE: &str = "Plugin settings hold saved-credential state";

/// The fixed locations a preflight inspects completely, reported in this
/// order: each inventory root, then each plugin home.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub inventories: Vec<PathBuf>,
    pub homes: Vec<PathBuf>,
}

/// One thing an inspection found. A location it could not positively
/// classify — any read error, a link, an unexpected type or a present
/// inventory — is [`Observation::Unresolved`].
#[derive(Clone, Copy, Debug)]
pub enum Observation<'a> {
    /// The next declared inventory root is positively absent.
    InventoryAbsent(&'a Path),
    /// A present real inventory; the no-H1 predicate always refuses it.
    InventoryPresent(&'a Path),
    /// The next declared home's `profiles` folder is positively absent.
    NoProfiles(&'a Path),
    /// The next declared home's `profiles` folder is a real folder whose
    /// listing follows, one [`Observation::Profile`] per entry, then
    /// [`Observation::End`].
    Profiles(&'a Path),
    /// An immediate entry that is a real folder, with its `registry.json`:
    /// `None` when positively absent, else every byte of a regular file, read
    /// up to one byte past the 8 MiB registry limit.
    Profile {
        name: &'a OsStr,
        registry: Option<&'a [u8]>,
    },
    /// The open listing ended without error.
    End,
    Unresolved,
}

/// "No H1 evidence found in the completely inspected, declared scope."
///
/// Nothing more: not that the scope was never enrolled, that anything was
/// deleted, that no credentials exist, or that cleanup completed.
#[derive(Debug, PartialEq, Eq)]
pub struct NoH1EvidenceFound(());
impl NoH1EvidenceFound {
    pub const MEANING: &'static str =
        "No H1 evidence found in the completely inspected, declared scope.";
}

/// Folds an inspection's observations; the first refusal is final.
pub struct Inspection<'s> {
    scope: &'s Scope,
    /// Declared locations reported so far.
    reported: usize,
    /// Entries counted in the open listing.
    listing: Option<usize>,
    refused: Option<&'static str>,
}
impl<'s> Inspection<'s> {
    pub fn new(scope: &'s Scope) -> Self {
        Self {
            scope,
            reported: 0,
            listing: None,
            refused: None,
        }
    }
    pub fn observe(&mut self, observation: Observation<'_>) {
        if self.refused.is_none() {
            self.refused = self.check(observation).err();
        }
    }
    /// Only every declared location reported, each listing ended and nothing
    /// refused affirms: a truncated inspection is incomplete.
    pub fn conclude(self) -> Result<NoH1EvidenceFound> {
        let Scope { inventories, homes } = self.scope;
        if let Some(refused) = self.refused {
            return Err(refused.into());
        }
        if inventories.is_empty()
            || homes.is_empty()
            || self.listing.is_some()
            || self.reported != inventories.len() + homes.len()
        {
            return Err(INCOMPLETE.into());
        }
        Ok(NoH1EvidenceFound(()))
    }
    fn check(&mut self, observation: Observation<'_>) -> std::result::Result<(), &'static str> {
        match (observation, self.listing.as_mut()) {
            (Observation::Unresolved, _) => Err(UNRESOLVED),
            (Observation::Profile { name, registry }, Some(count)) => {
                *count += 1;
                if *count > MAX_PROFILES {
                    return Err(TOO_MANY);
                }
                name.to_str()
                    .filter(|name| valid_id(name).is_ok())
                    .ok_or(UNRESOLVED)?;
                registry.map_or(Ok(()), legacy)
            }
            (Observation::End, Some(_)) => {
                self.listing = None;
                Ok(())
            }
            (Observation::InventoryAbsent(path), None) => self.next(path, true),
            (Observation::InventoryPresent(_), _) => Err(EVIDENCE),
            (Observation::NoProfiles(path), None) => self.next(path, false),
            (Observation::Profiles(path), None) => {
                self.next(path, false)?;
                self.listing = Some(0);
                Ok(())
            }
            _ => Err(OUT_OF_SCOPE),
        }
    }
    /// Accept `path` only as the next declared location of its kind.
    fn next(&mut self, path: &Path, inventory: bool) -> std::result::Result<(), &'static str> {
        let Scope { inventories, homes } = self.scope;
        let declared = (inventories.iter().map(|root| (true, root.as_path())))
            .chain(homes.iter().map(|home| (false, home.as_path())))
            .nth(self.reported);
        if declared != Some((inventory, path)) {
            return Err(OUT_OF_SCOPE);
        }
        self.reported += 1;
        Ok(())
    }
}

// This pass checks entries before the compatibility parser can collapse map
// keys or remove former installs. It deliberately reuses Installed's strict
// schema; parse_registry still checks the complete registry schema and version.
#[derive(Deserialize)]
struct RawRegistry {
    #[serde(rename = "installed", deserialize_with = "raw_installed")]
    _installed: (),
}

fn raw_installed<'de, D: Deserializer<'de>>(deserializer: D) -> std::result::Result<(), D::Error> {
    struct Entries;
    impl<'de> Visitor<'de> for Entries {
        type Value = ();

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("installed plugins with unique keys and valid entries")
        }

        fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> std::result::Result<(), M::Error> {
            let mut seen = BTreeSet::new();
            while let Some(id) = map.next_key::<String>()? {
                if !seen.insert(id.clone()) {
                    return Err(M::Error::custom("Duplicate installed plugin identity"));
                }
                let entry: Installed = map.next_value()?;
                entry.manifest.validate().map_err(M::Error::custom)?;
                // Former installs may now be reserved, but must still have
                // matched identities and valid revisions before removal.
                if id != entry.manifest.id {
                    return Err(M::Error::custom("Invalid installed plugin identity"));
                }
                valid_hash(&entry.current).map_err(M::Error::custom)?;
                if let Some(previous) = &entry.previous {
                    valid_hash(previous).map_err(M::Error::custom)?;
                }
            }
            Ok(())
        }
    }
    deserializer.deserialize_map(Entries)
}

/// Registry bytes every reader accepts, as version 1 or 2: no lineage, and no
/// installation generation.
pub(super) fn legacy(bytes: &[u8]) -> std::result::Result<(), &'static str> {
    if bytes.len() as u64 > LIMIT {
        return Err(UNREADABLE);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| UNREADABLE)?;
    let _: RawRegistry = serde_json::from_str(text).map_err(|_| UNREADABLE)?;
    let registry = parse_registry(text).map_err(|_| UNREADABLE)?;
    if registry.version == 3 || registry.secrets.is_some() {
        return Err(EVIDENCE);
    }
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod filesystem_tests;

/// Inspect the declared locations sequentially, retaining at most one bounded
/// registry. No Manager read, catalog, cleanup, lock or write is performed.
/// Pathname replacement after inspection remains possible; success is only the
/// completed-scan observation, not a filesystem snapshot or a future guarantee.
pub fn inspect(scope: &Scope) -> Result<NoH1EvidenceFound> {
    let mut inspection = Inspection::new(scope);
    walk(scope, |observation| {
        inspection.observe(observation);
        inspection
            .refused
            .map_or(Ok(()), |error| Err(std::io::Error::other(error)))
    })
    .map_err(|error| format!("{UNRESOLVED}: {error}"))?;
    inspection.conclude()
}

pub(super) fn walk(
    scope: &Scope,
    mut visit: impl FnMut(Observation<'_>) -> std::io::Result<()>,
) -> std::io::Result<()> {
    for root in &scope.inventories {
        visit(if checked(root)?.is_some() {
            Observation::InventoryPresent(root)
        } else {
            Observation::InventoryAbsent(root)
        })?;
    }
    for home in &scope.homes {
        let profiles = home.join("profiles");
        if !directory(&profiles)? {
            visit(Observation::NoProfiles(home))?;
            continue;
        }
        visit(Observation::Profiles(home))?;
        #[cfg(test)]
        filesystem_tests::io(&profiles, "listing")?;
        for (count, entry) in std::fs::read_dir(&profiles)?.enumerate() {
            // Count every immediate entry, without filtering or materializing
            // the listing. Stop before opening entry 1,025's registry.
            if count == MAX_PROFILES {
                return Err(std::io::Error::other(TOO_MANY));
            }
            #[cfg(test)]
            filesystem_tests::io(&profiles, "entry")?;
            let entry = entry?;
            if !directory(&entry.path())? {
                return Err(std::io::Error::other(UNRESOLVED));
            }
            let path = entry.path().join("registry.json");
            let bytes = match checked(&path)? {
                None => None,
                Some(meta) if meta.is_file() => {
                    use std::io::Read;
                    #[cfg(test)]
                    filesystem_tests::io(&path, "read")?;
                    let mut bytes = Vec::new();
                    let mut options = std::fs::OpenOptions::new();
                    options.read(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                    }
                    let file = options.open(&path)?;
                    if !file.metadata()?.is_file() {
                        return Err(std::io::Error::other(UNRESOLVED));
                    }
                    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
                    if bytes.len() as u64 > LIMIT {
                        return Err(std::io::Error::other(UNREADABLE));
                    }
                    Some(bytes)
                }
                _ => return Err(std::io::Error::other(UNRESOLVED)),
            };
            visit(Observation::Profile {
                name: &entry.file_name(),
                registry: bytes.as_deref(),
            })?;
        }
        visit(Observation::End)?;
    }
    Ok(())
}

fn directory(path: &Path) -> std::io::Result<bool> {
    match checked(path)? {
        None => Ok(false),
        Some(meta) if meta.is_dir() => Ok(true),
        _ => Err(std::io::Error::other(UNRESOLVED)),
    }
}

// Check from the root down, even when a leaf is absent. NotFound after a
// positively inspected real parent establishes observed absence; ENOTDIR,
// denied reads, links (including dangling ones) and other errors never do.
pub(super) fn checked(path: &Path) -> std::io::Result<Option<std::fs::Metadata>> {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(std::io::Error::other(UNRESOLVED));
    }
    let mut current = PathBuf::new();
    let mut result = None;
    for part in path.components() {
        current.push(part);
        // A Windows prefix alone (C: or UNC/device prefix) is not yet an
        // absolute ancestor. Probe only once its RootDir has been appended.
        if matches!(part, Component::Prefix(_)) {
            continue;
        }
        #[cfg(test)]
        filesystem_tests::io(&current, "metadata")?;
        match std::fs::symlink_metadata(&current) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
            Ok(meta) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        // FILE_ATTRIBUTE_REPARSE_POINT
                        return Err(std::io::Error::other(UNRESOLVED));
                    }
                }
                if meta.file_type().is_symlink() || (current != path && !meta.is_dir()) {
                    return Err(std::io::Error::other(UNRESOLVED));
                }
                result = Some(meta);
            }
        }
    }
    Ok(result)
}
