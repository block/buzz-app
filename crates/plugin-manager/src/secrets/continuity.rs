//! Installation continuity in the existing inventory and build-specific OS store.
//! A matching pair is a completed observation, not rollback detection or use authority.
//! The other supported build's committed pair is other-owned evidence: it never
//! qualifies, enrolls or cleans anything for this build.
use super::*;
use preflight::{Observation, Scope};
use std::collections::BTreeSet;
use std::sync::Mutex;

pub(super) const ACCOUNT: &str = "installation-continuity-v1";
const FAILED: &str = "Saved credential installation continuity could not be established";

/// Exactly the two supported builds' variants: this one and its peer.
#[derive(Clone, Copy)]
pub(super) struct Build {
    this: &'static str,
    peer: &'static str,
}
impl Build {
    pub(super) const THIS: Self = Self {
        this: VARIANT,
        peer: PEER_VARIANT,
    };
    /// The other build's view, so one test binary exercises both orders.
    #[cfg(test)]
    pub(super) const OTHER: Self = Self {
        this: PEER_VARIANT,
        peer: VARIANT,
    };
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Installation {
    version: u32,
    id: String,
    variant: String,
    scope: String,
}
impl Installation {
    fn valid_for(&self, variant: &str) -> bool {
        self.version == 1
            && valid_uuid(&self.id).is_ok()
            && self.variant == variant
            && hex64(&self.scope)
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(super) struct Record {
    installation: Installation,
    committed: bool,
}
impl Record {
    pub(super) fn valid_for(&self, variant: &str) -> bool {
        self.installation.valid_for(variant)
    }
}

/// The other supported build's fixed inventory root, its own expected scope and
/// read-only witness store.
pub struct Peer {
    root: PathBuf,
    /// The scope that build binds at `root`; a pair bound elsewhere is not its own.
    expected_scope: Scope,
    store: Arc<dyn SecretStore>,
    /// What this observer last read and matched: an exact committed pair, or
    /// an explicit empty inventory with a positively absent witness. Only that
    /// same observation skips a fresh read.
    qualified: Mutex<Option<Seen>>,
}
impl Peer {
    pub fn new(root: PathBuf, expected_scope: Scope, store: Arc<dyn SecretStore>) -> Self {
        Self {
            root,
            expected_scope,
            store,
            qualified: Mutex::new(None),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
enum Seen {
    Pair(Installation),
    Empty,
}

/// What this build's own inventory must hold for a classification.
#[derive(Clone, Copy)]
enum Expect<'a> {
    Absent,
    /// The explicit empty v1 state, terminal for a cancelled setup.
    Empty,
    Record(&'a Record),
}

/// Whether a classification may read the other build's OS witness. Only a
/// caller that owns the native completion lease through the read may.
#[derive(Clone, Copy)]
enum PeerRead {
    Cached,
    Allowed,
}

/// An OS-witness-qualified installation observation. Reinspect the declared scope
/// at native destructive/admission boundaries; retaining this is not a snapshot.
pub struct Established {
    build: Build,
    root: PathBuf,
    installation: Installation,
    peer: Peer,
}
impl Established {
    /// Filesystem only: a peer installation not already read and matched refuses.
    pub fn inspect(&self, scope: &Scope) -> Result<()> {
        self.classify(scope, PeerRead::Cached)
    }
    /// As [`Self::inspect`], reading a new peer's witness synchronously. Call
    /// only where completion ownership lasts until the OS read returns.
    pub fn requalify(&self, scope: &Scope) -> Result<()> {
        self.classify(scope, PeerRead::Allowed)
    }
    fn classify(&self, scope: &Scope, peer_read: PeerRead) -> Result<()> {
        if binding(scope, &self.root)? != self.installation.scope {
            return Err(FAILED.into());
        }
        inspect(
            self.build,
            scope,
            &self.root,
            Expect::Record(&Record {
                installation: self.installation.clone(),
                committed: true,
            }),
            &self.peer,
            peer_read,
        )
    }
    /// Whether the other build indexes unretired custody under any of `homes`.
    /// This build's journal cannot discharge it, so erasing them must refuse.
    pub fn peer_custody_in(&self, homes: &[PathBuf]) -> Result<bool> {
        peer_custody_in(self.build, &self.peer, homes)
    }
}

fn peer_custody_in(build: Build, peer: &Peer, homes: &[PathBuf]) -> Result<bool> {
    let Some(state) = state(&peer.root, build.peer)? else {
        return Ok(false);
    };
    let wiped = homes
        .iter()
        .map(|home| home_hash(home))
        .collect::<Result<BTreeSet<_>>>()?;
    let inventory = Inventory { root: &peer.root };
    for id in inventory.members(&state.namespaces)? {
        let namespace = namespace(&peer.root, &id)?;
        if wiped.contains(&namespace.home)
            && namespace
                .entries
                .iter()
                .any(|entry| entry.phase != Phase::Retired)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// This build's positively empty inventory: a cancelled setup, or one found
/// already cancelled. It holds `installation.lock`, so no initializer can
/// replace the empty state while a caller relies on it. Not credential-use
/// authority, and not proof that no credential ever existed.
pub struct Empty {
    build: Build,
    root: PathBuf,
    peer: Peer,
    _writer: Held,
}
impl Empty {
    /// Filesystem only: still empty, and a peer not already observed refuses.
    pub fn inspect(&self, scope: &Scope) -> Result<()> {
        if cancellable(self.build, &self.root, &binding(scope, &self.root)?)? != Own::Empty {
            return Err(FAILED.into());
        }
        inspect(
            self.build,
            scope,
            &self.root,
            Expect::Empty,
            &self.peer,
            PeerRead::Cached,
        )
    }
    /// As [`Established::peer_custody_in`].
    pub fn peer_custody_in(&self, homes: &[PathBuf]) -> Result<bool> {
        peer_custody_in(self.build, &self.peer, homes)
    }
}

fn binding(scope: &Scope, root: &Path) -> Result<String> {
    if scope.homes.is_empty()
        || scope
            .inventories
            .iter()
            .filter(|path| *path == root)
            .count()
            != 1
        || scope.inventories.iter().collect::<BTreeSet<_>>().len() != scope.inventories.len()
        || scope.homes.iter().collect::<BTreeSet<_>>().len() != scope.homes.len()
    {
        return Err(FAILED.into());
    }
    let mut parts: Vec<&[u8]> = vec![
        b"buzz-plugin-installation-v1",
        root.as_os_str().as_encoded_bytes(),
    ];
    parts.extend(
        scope
            .inventories
            .iter()
            .map(|path| path.as_os_str().as_encoded_bytes()),
    );
    parts.push(b"homes");
    parts.extend(
        scope
            .homes
            .iter()
            .map(|path| path.as_os_str().as_encoded_bytes()),
    );
    Ok(digest(&parts))
}

fn state(root: &Path, variant: &str) -> Result<Option<State>> {
    match preflight::checked(root).map_err(|_| FAILED)? {
        None => Ok(None),
        Some(meta) if meta.is_dir() => {
            let state: State =
                serde_json::from_slice(&read::bytes(&root.join(STATE), MAX_RECORD_BYTES)?)
                    .map_err(|_| FAILED)?;
            if !state.valid_for(variant)
                || state.namespaces.iter().collect::<BTreeSet<_>>().len() != state.namespaces.len()
            {
                return Err(FAILED.into());
            }
            Ok(Some(state))
        }
        _ => Err(FAILED.into()),
    }
}

/// Explicit empty v1 state: no installation and nothing else.
fn empty(root: &Path, state: &State) -> Result<bool> {
    Ok(state.installation.is_none() && nothing_else(root, state)?)
}

/// Nothing indexed, counted, journaled or on disk beside an installation record.
fn nothing_else(root: &Path, state: &State) -> Result<bool> {
    Ok(state.namespaces.is_empty()
        && state.signed_out_seen.is_none()
        && state.journal.is_none()
        && !(Inventory { root }).has_records()?)
}

fn witness(bytes: &[u8]) -> Result<Installation> {
    if bytes.len() > MAX_VALUE_BYTES {
        return Err(FAILED.into());
    }
    serde_json::from_slice(bytes).map_err(|_| FAILED.into())
}

/// What qualification found: this build's committed pair, or its own exact
/// setup intent or empty state left unfinished only by its own witness work.
pub enum Setup {
    Established(Established),
    Unfinished(Unfinished),
}

/// This build's own exact setup intent or empty state, after the whole
/// declared scope classified around it and only an OS read, delete or add of
/// its own witness failed. Any other failure is unknown and never becomes
/// this. A later cancellation may start from it; it is not credential-use
/// authority.
pub struct Unfinished {
    build: Build,
    root: PathBuf,
    peer: Peer,
}
impl Unfinished {
    /// Filesystem only: still exactly cancellable, and a peer not already
    /// observed refuses.
    pub fn inspect(&self, scope: &Scope) -> Result<()> {
        let own = cancellable(self.build, &self.root, &binding(scope, &self.root)?)?;
        inspect(
            self.build,
            scope,
            &self.root,
            own.expect(),
            &self.peer,
            PeerRead::Cached,
        )
    }
}

/// Why a qualification stopped: only this build's own witness work, after the
/// scope classified, or anything else.
pub(super) enum Stop {
    Own(Box<Peer>),
    Other,
}
impl From<String> for Stop {
    fn from(_: String) -> Self {
        Self::Other
    }
}
impl From<&str> for Stop {
    fn from(_: &str) -> Self {
        Self::Other
    }
}

/// Read/create/delete OS work is synchronous so its caller can retain the
/// existing native creator lease through worker completion, even after a
/// bounded wait. No R/G/I metadata lock spans an OS call. This build's own
/// exact empty partial setup is cancelled, never finished, before one fresh
/// attempt; other partial or unknown evidence is never repaired.
pub fn qualify(scope: &Scope, root: &Path, store: &dyn SecretStore, peer: Peer) -> Result<Setup> {
    let build = Build::THIS;
    match qualify_or_stop(build, scope, root, store, peer) {
        Ok(established) => Ok(Setup::Established(established)),
        Err(Stop::Own(peer)) => Ok(Setup::Unfinished(Unfinished {
            build,
            root: root.to_owned(),
            peer: *peer,
        })),
        Err(Stop::Other) => Err(FAILED.into()),
    }
}

/// [`qualify`], when only a committed pair will do.
pub fn establish(
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> Result<Established> {
    establish_as(Build::THIS, scope, root, store, peer)
}

pub(super) fn establish_as(
    build: Build,
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> Result<Established> {
    qualify_or_stop(build, scope, root, store, peer).map_err(|_| FAILED.into())
}

fn qualify_or_stop(
    build: Build,
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> std::result::Result<Established, Stop> {
    if cfg!(not(unix)) {
        return Err(Stop::Other);
    }
    let expected_scope = binding(scope, root)?;
    let found = match store.read(ACCOUNT) {
        Ok(bytes) => Some(witness(&bytes)?),
        Err(Error::Absent) => None,
        _ => return Err(Stop::Other),
    };
    let existing = state(root, build.this)?;
    match (existing, found) {
        (Some(state), Some(found))
            if state
                .installation
                .as_ref()
                .is_some_and(|record| record.committed) =>
        {
            let record = state.installation.ok_or(FAILED)?;
            if !found.valid_for(build.this)
                || record.installation != found
                || found.scope != expected_scope
            {
                return Err(Stop::Other);
            }
            let observed = Established {
                build,
                root: root.to_owned(),
                installation: found,
                peer,
            };
            observed.requalify(scope)?;
            Ok(observed)
        }
        (None, None) => {
            // Positive absence of this build's custody evidence; a qualified
            // peer may coexist, anything else refuses.
            inspect(build, scope, root, Expect::Absent, &peer, PeerRead::Allowed)?;
            let inventory = Inventory { root };
            inventory.establish()?;
            // Stable completion ownership, not a structural lock. A competing
            // initializer refuses; it cannot replace an in-flight OS witness.
            let writer = try_lock(&root.join("installation.lock"))?.ok_or(BUSY)?;
            initialize(build, scope, root, store, peer, Expect::Absent, writer)
        }
        (Some(_), _) => {
            let empty = cancel_or_stop(build, scope, root, store, peer)?;
            inspect(
                build,
                scope,
                root,
                Expect::Empty,
                &empty.peer,
                PeerRead::Cached,
            )?;
            initialize(
                build,
                scope,
                root,
                store,
                empty.peer,
                Expect::Empty,
                empty._writer,
            )
        }
        _ => Err(Stop::Other),
    }
}

/// A new installation's intent over the absent or empty inventory `from`,
/// under the caller's completion ownership, then its witness and commit.
fn initialize(
    build: Build,
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
    from: Expect,
    _writer: Held,
) -> std::result::Result<Established, Stop> {
    let expected_scope = binding(scope, root)?;
    let inventory = Inventory { root };
    let record = Record {
        installation: Installation {
            version: 1,
            id: fresh(),
            variant: build.this.into(),
            scope: expected_scope.clone(),
        },
        committed: false,
    };
    {
        let _g = inventory.global()?;
        let unchanged = match from {
            Expect::Absent => {
                preflight::checked(&root.join(STATE))
                    .map_err(|_| FAILED)?
                    .is_none()
                    && !inventory.has_records()?
            }
            Expect::Empty => cancellable(build, root, &expected_scope)? == Own::Empty,
            Expect::Record(_) => false,
        };
        if !unchanged {
            return Err(Stop::Other);
        }
        let mut state = State {
            installation: Some(record.clone()),
            ..State::default()
        };
        inventory.save_state(&mut state)?;
    }
    let bytes = Zeroizing::new(serde_json::to_vec(&record.installation).map_err(|_| FAILED)?);
    // The intent is durable and the scope classified: a failed add leaves
    // only this build's own unfinished setup.
    if store.add(ACCOUNT, &bytes).is_err() {
        return Err(Stop::Own(Box::new(peer)));
    }
    Ok(commit(build, scope, root, record, peer)?)
}

/// Cancel this build's own exact empty setup intent into the explicit empty
/// v1 state, never anything else: the exact uncommitted record, with no
/// namespace, journal, count or custody evidence anywhere in the declared
/// scope. Only its exact witness is deleted, and only confirmed absence lets
/// the record go. An already empty inventory with an absent witness is
/// persisted again, so a retry acknowledges its durability. Uncertainty,
/// denial, mismatch or change refuses and leaves the intent as it is.
pub fn cancel(scope: &Scope, root: &Path, store: &dyn SecretStore, peer: Peer) -> Result<Empty> {
    cancel_as(Build::THIS, scope, root, store, peer)
}

pub(super) fn cancel_as(
    build: Build,
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> Result<Empty> {
    cancel_or_stop(build, scope, root, store, peer).map_err(|_| FAILED.into())
}

fn cancel_or_stop(
    build: Build,
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> std::result::Result<Empty, Stop> {
    if cfg!(not(unix)) {
        return Err(Stop::Other);
    }
    let expected_scope = binding(scope, root)?;
    let before = cancellable(build, root, &expected_scope)?;
    // The initializer holds this through its OS add; a late one refuses here.
    let writer = try_lock(&root.join("installation.lock"))?.ok_or(BUSY)?;
    if cancellable(build, root, &expected_scope)? != before {
        return Err(Stop::Other);
    }
    let expect = before.expect();
    inspect(build, scope, root, expect, &peer, PeerRead::Allowed)?;
    // The scope classified: a failed read or delete of this build's own exact
    // witness leaves only its own unfinished setup. A mismatched one does not.
    let cleared = match store.read(ACCOUNT) {
        Err(Error::Absent) => true,
        Ok(bytes) => match &before {
            Own::Intent(record) if witness(&bytes)? == record.installation => {
                store.delete(ACCOUNT).is_ok() && matches!(store.read(ACCOUNT), Err(Error::Absent))
            }
            _ => return Err(Stop::Other),
        },
        Err(_) => false,
    };
    if !cleared {
        return Err(Stop::Own(Box::new(peer)));
    }
    inspect(build, scope, root, expect, &peer, PeerRead::Cached)?;
    {
        let inventory = Inventory { root };
        let _g = inventory.global()?;
        if cancellable(build, root, &expected_scope)? != before {
            return Err(Stop::Other);
        }
        let mut state = state(root, build.this)?.ok_or(FAILED)?;
        state.installation = None;
        inventory.save_state(&mut state)?;
    }
    Ok(Empty {
        build,
        root: root.to_owned(),
        peer,
        _writer: writer,
    })
}

/// This build's inventory and its OS witness, both positively absent, with the
/// rest of the declared scope classified. Nothing is created: a pending
/// removal holds this instead of initializing, and a later setup refuses it.
pub struct Absent {
    build: Build,
    root: PathBuf,
    peer: Peer,
}
impl Absent {
    /// Filesystem only: still absent, and a peer not already observed refuses.
    pub fn inspect(&self, scope: &Scope) -> Result<()> {
        binding(scope, &self.root)?;
        inspect(
            self.build,
            scope,
            &self.root,
            Expect::Absent,
            &self.peer,
            PeerRead::Cached,
        )
    }
}

/// What a pending removal holds, instead of initializing, until it finishes:
/// this build's cancelled setup, or its positively absent inventory.
pub enum Departing {
    Empty(Empty),
    Absent(Absent),
}
impl Departing {
    /// Filesystem only, as [`Empty::inspect`] or [`Absent::inspect`].
    pub fn inspect(&self, scope: &Scope) -> Result<()> {
        match self {
            Self::Empty(empty) => empty.inspect(scope),
            Self::Absent(absent) => absent.inspect(scope),
        }
    }
    /// As [`Established::peer_custody_in`].
    pub fn peer_custody_in(&self, homes: &[PathBuf]) -> Result<bool> {
        let (build, peer) = match self {
            Self::Empty(empty) => (empty.build, &empty.peer),
            Self::Absent(absent) => (absent.build, &absent.peer),
        };
        peer_custody_in(build, peer, homes)
    }
}

/// For a pending removal: observe this build's absent inventory, or cancel
/// its own exact empty setup. Never initializes.
pub fn depart(
    scope: &Scope,
    root: &Path,
    store: &dyn SecretStore,
    peer: Peer,
) -> Result<Departing> {
    let build = Build::THIS;
    if cfg!(not(unix)) {
        return Err(UNSUPPORTED.into());
    }
    binding(scope, root)?;
    if state(root, build.this)?.is_some() {
        return cancel_as(build, scope, root, store, peer).map(Departing::Empty);
    }
    if !matches!(store.read(ACCOUNT), Err(Error::Absent)) {
        return Err(FAILED.into());
    }
    inspect(build, scope, root, Expect::Absent, &peer, PeerRead::Allowed)?;
    Ok(Departing::Absent(Absent {
        build,
        root: root.to_owned(),
        peer,
    }))
}

/// Read-only: whether this build's own inventory is absent or exactly a
/// cancellable setup intent or empty state. Not authority to delete or skip
/// anything; a caller must still `depart` and rely only on what it returns.
pub fn departable_setup(scope: &Scope, root: &Path) -> bool {
    binding(scope, root).is_ok_and(|expected_scope| {
        matches!(state(root, Build::THIS.this), Ok(None))
            || cancellable(Build::THIS, root, &expected_scope).is_ok()
    })
}

#[derive(PartialEq, Eq)]
enum Own {
    Intent(Record),
    Empty,
}
impl Own {
    fn expect(&self) -> Expect<'_> {
        match self {
            Self::Intent(record) => Expect::Record(record),
            Self::Empty => Expect::Empty,
        }
    }
}

/// This build's exact uncommitted record or explicit empty state, with
/// nothing else indexed. A bare directory is neither.
fn cancellable(build: Build, root: &Path, expected_scope: &str) -> Result<Own> {
    let state = state(root, build.this)?.ok_or(FAILED)?;
    match state.installation.clone() {
        None if empty(root, &state)? => Ok(Own::Empty),
        Some(record)
            if !record.committed
                && record.installation.scope == expected_scope
                && nothing_else(root, &state)? =>
        {
            Ok(Own::Intent(record))
        }
        _ => Err(FAILED.into()),
    }
}

/// Revalidate the whole scope, then commit exactly `record` if nothing changed.
fn commit(
    build: Build,
    scope: &Scope,
    root: &Path,
    mut record: Record,
    peer: Peer,
) -> Result<Established> {
    inspect(
        build,
        scope,
        root,
        Expect::Record(&record),
        &peer,
        PeerRead::Allowed,
    )?;
    {
        let inventory = Inventory { root };
        let _g = inventory.global()?;
        let mut state = state(root, build.this)?.ok_or(FAILED)?;
        if state.installation.as_ref() != Some(&record)
            || !state.namespaces.is_empty()
            || state.signed_out_seen.is_some()
            || state.journal.is_some()
            || inventory.has_records()?
        {
            return Err(FAILED.into());
        }
        record.committed = true;
        state.installation = Some(record.clone());
        inventory.save_state(&mut state)?;
    }
    let observed = Established {
        build,
        root: root.to_owned(),
        installation: record.installation,
        peer,
    };
    observed.requalify(scope)?;
    Ok(observed)
}

fn namespace(root: &Path, id: &str) -> Result<Namespace> {
    let namespace: Namespace = serde_json::from_slice(&read::bytes(
        &root.join(format!("ns-{id}.json")),
        MAX_RECORD_BYTES,
    )?)
    .map_err(|_| FAILED)?;
    if !namespace.valid() {
        return Err(FAILED.into());
    }
    Ok(namespace)
}

/// The namespace records an inventory indexes, each validated against its id
/// and the declared homes.
fn namespaces(scope: &Scope, root: &Path, state: &State) -> Result<BTreeMap<String, Namespace>> {
    let mut namespaces = BTreeMap::new();
    for id in (Inventory { root }).members(&state.namespaces)? {
        let namespace = namespace(root, &id)?;
        if id
            != digest(&[
                b"buzz-plugin-secret-namespace-v1",
                namespace.home.as_bytes(),
                namespace.profile.as_bytes(),
            ])
            || valid_id(&namespace.profile).is_err()
            || !scope
                .homes
                .iter()
                .any(|home| home_hash(home).is_ok_and(|hash| hash == namespace.home))
        {
            return Err(FAILED.into());
        }
        namespaces.insert(id, namespace);
    }
    Ok(namespaces)
}

/// One owner's indexed evidence: its variant, record and validated namespaces.
/// Only `listed` ids are authority; other discovered records are cleanup debt.
struct Owner {
    variant: &'static str,
    record: Option<Record>,
    listed: BTreeSet<String>,
    namespaces: BTreeMap<String, Namespace>,
}

/// A present peer inventory qualifies only as the other build's committed pair,
/// bound to its own expected scope at its fixed root, or as its explicit empty
/// inventory with a positively absent witness. The witness is read afresh,
/// when `peer_read` allows, unless this exact observation already matched.
fn qualify_peer(
    build: Build,
    scope: &Scope,
    peer: &Peer,
    peer_read: PeerRead,
) -> Result<Option<Owner>> {
    let Some(state) = state(&peer.root, build.peer)? else {
        return Ok(None);
    };
    if !scope.inventories.contains(&peer.root) {
        return Err(FAILED.into());
    }
    let seen = match &state.installation {
        None if empty(&peer.root, &state)? => Seen::Empty,
        Some(record)
            if record.committed
                && record.installation.scope == binding(&peer.expected_scope, &peer.root)? =>
        {
            Seen::Pair(record.installation.clone())
        }
        _ => return Err(FAILED.into()),
    };
    let cached = peer
        .qualified
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if cached.as_ref() != Some(&seen) {
        if matches!(peer_read, PeerRead::Cached) || read_peer(peer)? != seen {
            return Err(FAILED.into());
        }
        *peer.qualified.lock().unwrap_or_else(|e| e.into_inner()) = Some(seen);
    }
    Ok(Some(Owner {
        variant: build.peer,
        record: state.installation.clone(),
        listed: state.namespaces.iter().cloned().collect(),
        namespaces: namespaces(scope, &peer.root, &state)?,
    }))
}

/// Synchronous, so the native caller's completion lease spans the OS read.
fn read_peer(peer: &Peer) -> Result<Seen> {
    match peer.store.read(ACCOUNT) {
        Ok(bytes) => Ok(Seen::Pair(witness(&bytes)?)),
        Err(Error::Absent) => Ok(Seen::Empty),
        Err(_) => Err(FAILED.into()),
    }
}

/// The one owner-aware classification of the declared scope. `expected` is
/// what this build's inventory at `root` must hold.
/// Every v3 registry must validate against the namespace of the inventory that
/// indexes it, under that inventory's variant; unobserved namespaces may hold
/// only retired debt. Unknown, partial or unowned evidence refuses.
fn inspect(
    build: Build,
    scope: &Scope,
    root: &Path,
    expected: Expect,
    peer: &Peer,
    peer_read: PeerRead,
) -> Result<()> {
    if peer.root == root {
        return Err(FAILED.into());
    }
    let current = match expected {
        Expect::Record(expected) => {
            let current = state(root, build.this)?.ok_or(FAILED)?;
            if current.installation.as_ref() != Some(expected) {
                return Err(FAILED.into());
            }
            Some(current)
        }
        Expect::Empty => {
            let current = state(root, build.this)?.ok_or(FAILED)?;
            if !empty(root, &current)? {
                return Err(FAILED.into());
            }
            Some(current)
        }
        Expect::Absent if state(root, build.this)?.is_some() => return Err(FAILED.into()),
        Expect::Absent => None,
    };
    let expected = match expected {
        Expect::Record(record) => Some(record),
        Expect::Absent | Expect::Empty => None,
    };
    let own = Owner {
        variant: build.this,
        record: expected.cloned(),
        listed: current
            .iter()
            .flat_map(|current| current.namespaces.iter().cloned())
            .collect(),
        namespaces: match &current {
            Some(current) => namespaces(scope, root, current)?,
            None => BTreeMap::new(),
        },
    };
    if let (Some(expected), Some(current)) = (expected, &current) {
        if !expected.committed
            && (!own.namespaces.is_empty()
                || current.signed_out_seen.is_some()
                || current.journal.is_some())
        {
            return Err(FAILED.into());
        }
    }
    let other = qualify_peer(build, scope, peer, peer_read)?;
    let mut home = None;
    let mut observed = BTreeSet::new();
    preflight::walk(scope, |observation| {
        let mut validate = || -> Result<()> {
            match observation {
                Observation::InventoryPresent(path) if path == root && current.is_some() => {}
                Observation::InventoryAbsent(path) if path == root && current.is_none() => {}
                Observation::InventoryPresent(path) if path == peer.root && other.is_some() => {}
                Observation::InventoryAbsent(path)
                    if path != root && (path != peer.root || other.is_none()) => {}
                Observation::InventoryPresent(_) | Observation::InventoryAbsent(_) => {
                    return Err(FAILED.into())
                }
                Observation::Profiles(path) => {
                    home = Some(path.to_owned());
                }
                Observation::NoProfiles(_) | Observation::End => {
                    home = None;
                }
                Observation::Profile { name, registry } => {
                    let home = home.as_ref().ok_or(FAILED)?;
                    let profile = name.to_str().ok_or(FAILED)?;
                    valid_id(profile)?;
                    let Some(bytes) = registry else {
                        return Ok(());
                    };
                    if preflight::legacy(bytes).is_ok() {
                        return Ok(());
                    }
                    let id = digest(&[
                        b"buzz-plugin-secret-namespace-v1",
                        home_hash(home)?.as_bytes(),
                        profile.as_bytes(),
                    ]);
                    let owner = [Some(&own), other.as_ref()]
                        .into_iter()
                        .flatten()
                        .find(|owner| {
                            owner.listed.contains(&id) && owner.namespaces.contains_key(&id)
                        })
                        .ok_or(FAILED)?;
                    read::inspect_namespace(
                        bytes,
                        &owner.namespaces[&id],
                        home,
                        profile,
                        owner.variant,
                    )?;
                    observed.insert((owner.variant, id));
                }
                Observation::Unresolved => return Err(FAILED.into()),
            }
            Ok(())
        };
        validate().map_err(std::io::Error::other)
    })
    .map_err(|_| FAILED)?;
    for owner in [Some(&own), other.as_ref()].into_iter().flatten() {
        for (id, namespace) in &owner.namespaces {
            if !observed.contains(&(owner.variant, id.clone())) {
                // Lost/erased homes may leave only retired cleanup debt. Neither
                // those nor unlisted records can qualify a live generation.
                read::inspect_retired(namespace)?;
            }
        }
    }
    // Neither owner's inventory presence or installation may have changed
    // during the walk.
    for (path, variant, present, record) in [
        (root, build.this, current.is_some(), &own.record),
        (
            peer.root.as_path(),
            build.peer,
            other.is_some(),
            &other.as_ref().and_then(|owner| owner.record.clone()),
        ),
    ] {
        let still = state(path, variant)?;
        if still.is_some() != present || still.and_then(|state| state.installation) != *record {
            return Err(FAILED.into());
        }
    }
    Ok(())
}
