//! Fixed desktop-known discovery, not arbitrary CLI `--home` or backup history.
//! Never canonicalize/deduplicate aliases through links: uncertainty refuses.
use super::{
    legacy_identifier::{CURRENT, DEV, LEGACY},
    trash, Paths,
};
use buzzodz_plugins::secrets::{
    continuity::Established,
    preflight::{inspect, Scope},
};
use std::path::PathBuf;

impl Paths {
    pub(super) fn preflight_scope(&self) -> Result<Scope, String> {
        let data = self.lock.parent().ok_or(super::FAILED)?;
        let mut homes: Vec<PathBuf> = vec![self.app_data.clone()];
        if let Some(home) = &self.plugin_home {
            homes.push(home.clone());
        }
        homes.extend(self.others.iter().cloned());
        homes.push(self.backups.clone());
        // The last move is the marker FILE pair, not a home. All other move
        // endpoints are directory candidates (including their existing trash).
        for (from, to) in &self.moves {
            if to != &self.marker {
                homes.extend([from.clone(), to.clone()]);
            }
        }
        // Include all identifier homes even if migration/seed is not due for
        // this identifier; stale partial copies must not be silently discarded.
        for base in std::iter::once(data).chain(self.seeds.iter().map(PathBuf::as_path)) {
            for name in [CURRENT, LEGACY, DEV] {
                homes.push(base.join(name));
            }
            homes.push(base.join(format!("{DEV}.seeding")));
        }
        let trash_homes: Vec<_> = homes.iter().map(|home| trash(home)).collect();
        homes.extend(trash_homes);
        // Exact spelling only. Do not let an absent unrelated ancestor hide an
        // invalid relative/parent-traversing candidate; the scanner refuses it.
        homes.sort();
        homes.dedup();
        Ok(Scope {
            inventories: [
                ".xyz.block.buzz.desktop.plugin-secret",
                ".xyz.block.buzz.desktop.plugin-secret.debug",
            ]
            .map(|name| data.join(name))
            .to_vec(),
            homes,
        })
    }
    pub(super) fn preflight(&self) -> Result<(), String> {
        self.preflight_with_inventory(None)
    }
    pub(super) fn preflight_with_inventory(
        &self,
        inventory: Option<&std::path::Path>,
    ) -> Result<(), String> {
        self.inspect_continuity(inventory, None)
    }
    pub(super) fn inspection_scope(
        &self,
        inventory: Option<&std::path::Path>,
    ) -> Result<Scope, String> {
        let mut scope = self.preflight_scope()?;
        if let Some(root) = inventory {
            if !scope.inventories.iter().any(|known| known == root) {
                scope.inventories.push(root.to_owned());
            }
        }
        Ok(scope)
    }
    /// The scope the other supported build binds at its fixed inventory: its own
    /// identifier's recipe and backup home under this user's backup parent, in
    /// this environment. Scope only; the temporary value never migrates or
    /// cleans up. A pair the peer bound elsewhere or differently refuses.
    pub(super) fn peer_inspection_scope(&self) -> Result<Scope, String> {
        let identifier = if cfg!(debug_assertions) { CURRENT } else { DEV };
        let mut peer = Paths::resolve(identifier).ok_or(super::FAILED)?;
        peer.backups = self
            .backups
            .with_file_name(buzz_credential_store::human_store(!cfg!(debug_assertions)));
        peer.inspection_scope(Some(&self.plugin_peer_inventory()?))
    }
    pub(super) fn inspect_continuity(
        &self,
        inventory: Option<&std::path::Path>,
        established: Option<&Established>,
    ) -> Result<(), String> {
        #[cfg(test)]
        if super::tests::preflight::INJECT_ERROR.get() {
            return Err("Injected H1 inspection error".into());
        }
        let scope = self.inspection_scope(inventory)?;
        match established {
            Some(observed) => observed.inspect(&scope),
            // A present injected candidate alone supplies no positive witness.
            None => inspect(&scope).map(|_| ()),
        }
    }
}
