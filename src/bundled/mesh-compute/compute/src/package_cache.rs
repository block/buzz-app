//! Drop Hugging Face cache refs that point at unservable layer packages.
//!
//! Mesh's catalog names layer packages by moving revision (`main`). The pinned
//! SDK resolves `main` from the local cache before asking the hub, and accepts
//! a complete schema-v1 snapshot there. Schema v1 is offline-only, so serving
//! then fails with "model inspection failed" even though the hub `main` has
//! since been republished as package v2. Removing just the stale ref makes the
//! SDK fall through to the hub, which re-resolves `main` and rewrites the ref.
//! Snapshots and blobs are left alone.

use std::{fs, path::Path};

/// The only layer-package schema the pinned runtime can serve.
const SERVABLE_SCHEMA_VERSION: u64 = 2;

/// Remove `refs/main` in `meshllm/*-layers` repos when its snapshot manifest
/// declares an unservable schema. Returns the number of refs removed.
pub fn drop_unservable_layer_package_refs(hub_cache: &Path) -> usize {
    let Ok(repos) = fs::read_dir(hub_cache) else {
        return 0;
    };
    let mut removed = 0;
    for repo in repos.flatten() {
        let name = repo.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("models--meshllm--") && name.ends_with("-layers")) {
            continue;
        }
        let repo_dir = repo.path();
        // Only the moving `main` ref goes stale; pinned branch/tag refs stay
        // usable for other offline HF consumers.
        let ref_path = repo_dir.join("refs").join("main");
        let Ok(commit) = fs::read_to_string(&ref_path) else {
            continue;
        };
        let commit = commit.trim();
        if commit.is_empty() || commit.contains(['/', '\\']) || commit.starts_with('.') {
            continue;
        }
        let manifest = repo_dir
            .join("snapshots")
            .join(commit)
            .join("model-package.json");
        if schema_version(&manifest).is_some_and(|v| v != SERVABLE_SCHEMA_VERSION)
            && fs::remove_file(&ref_path).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

/// `None` when the manifest is missing or unreadable: leave those to the SDK.
fn schema_version(manifest: &Path) -> Option<u64> {
    let bytes = fs::read(manifest).ok()?;
    serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()?
        .get("schema_version")?
        .as_u64()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(hub: &Path, repo: &str, reference: &str, commit: &str, schema: u64) {
        let repo_dir = hub.join(repo);
        let snap = repo_dir.join("snapshots").join(commit);
        fs::create_dir_all(&snap).unwrap();
        fs::create_dir_all(repo_dir.join("refs")).unwrap();
        fs::write(
            snap.join("model-package.json"),
            format!(r#"{{"schema_version":{schema}}}"#),
        )
        .unwrap();
        fs::write(repo_dir.join("refs").join(reference), commit).unwrap();
    }

    #[test]
    fn drops_only_v1_layer_refs_and_keeps_snapshots() {
        let hub = tempfile::tempdir().unwrap();
        let v1 = "models--meshllm--gemma-4-E4B-it-Q4_K_M-layers";
        let v2 = "models--meshllm--qwen-layers";
        let other = "models--unsloth--other-layers";
        snapshot(hub.path(), v1, "main", "ac0a53", 1);
        snapshot(hub.path(), v2, "main", "d7a5df", 2);
        snapshot(hub.path(), other, "main", "beef", 1);
        snapshot(hub.path(), v1, "v1-pinned", "ac0a53", 1);

        assert_eq!(drop_unservable_layer_package_refs(hub.path()), 1);
        assert!(!hub.path().join(v1).join("refs/main").exists());
        assert!(hub
            .path()
            .join(v1)
            .join("snapshots/ac0a53/model-package.json")
            .is_file());
        assert!(hub.path().join(v2).join("refs/main").is_file());
        assert!(hub.path().join(other).join("refs/main").is_file());
        assert!(hub.path().join(v1).join("refs/v1-pinned").is_file());
        // Idempotent once the stale ref is gone.
        assert_eq!(drop_unservable_layer_package_refs(hub.path()), 0);
    }

    #[test]
    fn keeps_refs_with_missing_manifest_or_unsafe_commit() {
        let hub = tempfile::tempdir().unwrap();
        let repo = hub.path().join("models--meshllm--x-layers");
        fs::create_dir_all(repo.join("refs")).unwrap();
        fs::write(repo.join("refs/main"), "missing").unwrap();
        fs::write(repo.join("refs/up"), "../escape").unwrap();
        assert_eq!(drop_unservable_layer_package_refs(hub.path()), 0);
        assert_eq!(
            drop_unservable_layer_package_refs(&hub.path().join("absent")),
            0
        );
    }
}
