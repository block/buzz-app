//! Relay images that survive navigation and relaunch.
//!
//! WebKit keeps no disk cache for custom-scheme responses, so every launch and
//! every lazy remount fetched each avatar and thumbnail again through a signed
//! relay read. Relay media is content-addressed (`/media/<sha256>…`), so a
//! cached response never goes stale; only a purge or the byte budget removes
//! it. Entries are grouped by community origin, so clearing or leaving one
//! community drops only its media. The identity never changes within a process,
//! and signing out deletes the whole cache directory.

use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write as _},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, SystemTime},
};
use url::Url;

/// The cache's folder in the app cache directory.
pub(crate) const DIR: &str = "media";
/// Bytes kept on disk before the least recently used entries are deleted.
const BUDGET: u64 = 256 * 1024 * 1024;
/// Larger images, such as full-size photos, are fetched each time, so a few of
/// them cannot evict the avatars and thumbnails this cache is for.
pub(super) const ENTRY_MAX: usize = 2 * 1024 * 1024;
const CLEARED: &str = ".cleared";
/// A hit refreshes its age at most this often, so reads rarely write.
const TOUCH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

#[derive(Clone)]
pub(crate) struct MediaCache(Arc<Inner>);

struct Inner {
    root: Option<PathBuf>,
    budget: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Bumped by every purge; a fetch that began before it is not stored.
    generation: u64,
    /// Bytes on disk as of the last scan, plus writes since.
    bytes: u64,
    measured: bool,
    evicting: bool,
}

impl MediaCache {
    /// Without a cache directory every read misses and nothing is stored.
    pub(crate) fn new(root: Option<PathBuf>) -> Self {
        Self::with_budget(root, BUDGET)
    }

    fn with_budget(root: Option<PathBuf>, budget: u64) -> Self {
        Self(Arc::new(Inner {
            root,
            budget,
            state: Mutex::default(),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn partition(&self, origin: &str) -> Option<PathBuf> {
        let digest = Sha256::digest(origin.as_bytes());
        Some(self.0.root.as_ref()?.join(format!("{digest:x}")))
    }

    fn path(&self, url: &Url) -> Option<PathBuf> {
        let digest = Sha256::digest(url.as_str().as_bytes());
        Some(
            self.partition(&url.origin().ascii_serialization())?
                .join(format!("{digest:x}")),
        )
    }

    /// Taken before a fetch and passed to `put`.
    pub(super) fn ticket(&self) -> u64 {
        self.lock().generation
    }

    /// The cached `Content-Type` and body for `url`.
    pub(super) fn get(&self, url: &Url) -> Option<(String, Vec<u8>)> {
        let path = self.path(url)?;
        let mut bytes = fs::read(&path).ok()?;
        let split = bytes.iter().position(|&b| b == b'\n')?;
        let kind = std::str::from_utf8(&bytes[..split]).ok()?.to_owned();
        bytes.drain(..=split);
        let stale = fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|at| at.elapsed().is_ok_and(|age| age > TOUCH_AFTER));
        if stale {
            let _ = fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(SystemTime::now()));
        }
        Some((kind, bytes))
    }

    /// Stores a complete image response unless a purge ran since `ticket`.
    pub(super) fn put(&self, url: &Url, ticket: u64, kind: &str, body: &[u8]) -> io::Result<()> {
        let (Some(root), Some(path)) = (self.0.root.as_ref(), self.path(url)) else {
            return Ok(());
        };
        let Some(dir) = path.parent().filter(|_| body.len() <= ENTRY_MAX) else {
            return Ok(());
        };
        fs::create_dir_all(dir)?;
        // Written whole and synced, then renamed: entries are never refetched,
        // so a torn one would be served until evicted. A temporary file
        // orphaned by a crash ages out with the entries beside it.
        let mut file = tempfile::Builder::new().prefix(".tmp").tempfile_in(dir)?;
        file.write_all(kind.as_bytes())?;
        file.write_all(b"\n")?;
        file.write_all(body)?;
        file.as_file().sync_data()?;
        let size = (kind.len() + 1 + body.len()) as u64;
        let evict = {
            let mut state = self.lock();
            if state.generation != ticket {
                return Ok(());
            }
            file.persist(&path).map_err(|error| error.error)?;
            state.bytes += size;
            let evict = (!state.measured || state.bytes > self.0.budget) && !state.evicting;
            state.evicting |= evict;
            evict
        };
        if evict {
            self.evict(root);
        }
        Ok(())
    }

    /// Measures the cache and, over budget, deletes the least recently used
    /// entries.
    fn evict(&self, root: &Path) {
        let mut entries = Vec::new();
        for dir in fs::read_dir(root).into_iter().flatten().flatten() {
            if !dir.file_type().is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            // A purge's leftovers, if it was interrupted.
            if dir.file_name().to_string_lossy().starts_with(CLEARED) {
                let _ = fs::remove_dir_all(dir.path());
                continue;
            }
            for file in fs::read_dir(dir.path()).into_iter().flatten().flatten() {
                if let Ok(meta) = file.metadata() {
                    let at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                    entries.push((at, meta.len(), file.path()));
                }
            }
        }
        let mut total: u64 = entries.iter().map(|(_, len, _)| len).sum();
        if total > self.0.budget {
            // Down to 80%, so a full cache is not rescanned on every write.
            let low = self.0.budget / 10 * 8;
            entries.sort_unstable_by_key(|(at, _, _)| *at);
            for (_, len, path) in entries {
                if total <= low {
                    break;
                }
                if fs::remove_file(path).is_ok() {
                    total -= len;
                }
            }
        }
        let mut state = self.lock();
        state.bytes = total;
        state.measured = true;
        state.evicting = false;
    }

    /// Forgets one community's media. Fetches already in flight are not stored.
    pub(crate) fn clear(&self, origin: &Url) -> io::Result<()> {
        let Some(dir) = self.partition(&origin.origin().ascii_serialization()) else {
            return Ok(());
        };
        let trash = {
            let mut state = self.lock();
            state.generation += 1;
            state.measured = false;
            let Some(root) = self.0.root.as_ref().filter(|_| dir.exists()) else {
                return Ok(());
            };
            // Moved aside under the lock, so no write lands in it; deleting
            // many small files then runs without blocking media requests.
            let trash = tempfile::Builder::new().prefix(CLEARED).tempdir_in(root)?;
            fs::rename(&dir, trash.path().join("entries"))?;
            trash
        };
        trash.close()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(name: &str) -> Url {
        Url::parse(&format!(
            "https://relay.example.org/media/{}.thumb.webp",
            name.repeat(64)
        ))
        .unwrap()
    }

    #[test]
    fn stores_and_reads_back_an_image() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        assert!(cache.get(&url("a")).is_none());
        cache
            .put(&url("a"), cache.ticket(), "image/webp", b"bytes\nmore")
            .unwrap();
        assert_eq!(
            cache.get(&url("a")),
            Some(("image/webp".into(), b"bytes\nmore".to_vec()))
        );
    }

    #[test]
    fn clearing_a_community_keeps_others_and_drops_in_flight_fetches() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        let other = Url::parse(&format!(
            "https://other.example.org/media/{}",
            "b".repeat(64)
        ))
        .unwrap();
        cache
            .put(&url("a"), cache.ticket(), "image/webp", b"a")
            .unwrap();
        cache
            .put(&other, cache.ticket(), "image/png", b"b")
            .unwrap();
        let in_flight = cache.ticket();
        cache
            .clear(&Url::parse("https://relay.example.org").unwrap())
            .unwrap();
        assert!(cache.get(&url("a")).is_none());
        assert!(cache.get(&other).is_some());
        cache.put(&url("c"), in_flight, "image/webp", b"c").unwrap();
        assert!(cache.get(&url("c")).is_none());
        cache
            .put(&url("c"), cache.ticket(), "image/webp", b"c")
            .unwrap();
        assert!(cache.get(&url("c")).is_some());
    }

    #[test]
    fn evicts_least_recently_used_entries_over_budget() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::with_budget(Some(dir.path().into()), 160);
        let old = SystemTime::now() - Duration::from_secs(3 * 24 * 60 * 60);
        for name in ["a", "b", "c"] {
            cache
                .put(&url(name), cache.ticket(), "image/webp", &[0; 30])
                .unwrap();
        }
        // Each entry is 41 bytes. `a` is older but was read again; `b` was not.
        for name in ["a", "b"] {
            let path = cache.path(&url(name)).unwrap();
            fs::File::options()
                .write(true)
                .open(path)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }
        assert!(cache.get(&url("a")).is_some());
        cache
            .put(&url("d"), cache.ticket(), "image/webp", &[0; 30])
            .unwrap();
        assert!(cache.get(&url("b")).is_none());
        for name in ["a", "c", "d"] {
            assert!(cache.get(&url(name)).is_some(), "{name}");
        }
    }

    #[test]
    fn skips_oversized_entries_and_missing_directories() {
        let dir = tempfile::tempdir().unwrap();
        let cache = MediaCache::new(Some(dir.path().into()));
        cache
            .put(
                &url("a"),
                cache.ticket(),
                "image/png",
                &vec![0; ENTRY_MAX + 1],
            )
            .unwrap();
        assert!(cache.get(&url("a")).is_none());
        let none = MediaCache::new(None);
        none.put(&url("a"), none.ticket(), "image/png", b"a")
            .unwrap();
        assert!(none.get(&url("a")).is_none());
    }
}
