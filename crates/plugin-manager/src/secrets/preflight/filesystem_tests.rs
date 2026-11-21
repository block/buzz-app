use super::*;
use std::fs;

fn fixture() -> (tempfile::TempDir, Scope) {
    let temp = tempfile::tempdir().unwrap();
    // macOS's /var is itself a link; the declared test roots must be real.
    let base = fs::canonicalize(temp.path()).unwrap();
    let scope = Scope {
        inventories: vec![base.join("inventory"), base.join("inventory.debug")],
        homes: vec![base.join("home"), base.join("other")],
    };
    (temp, scope)
}
fn registry(scope: &Scope, home: usize, profile: &str, bytes: &[u8]) -> PathBuf {
    let path = scope.homes[home].join("profiles").join(profile);
    fs::create_dir_all(&path).unwrap();
    let path = path.join("registry.json");
    fs::write(&path, bytes).unwrap();
    path
}
const V2: &[u8] = br#"{"version":2,"bundledEnabled":true,"installed":{}}"#;

#[test]
fn filesystem_positive_absence_and_all_profiles_are_read_only() {
    let (_temp, scope) = fixture();
    assert!(inspect(&scope).is_ok());
    assert!(!scope.homes[0].exists());
    for home in 0..scope.homes.len() {
        for profile in ["default", "not-selected"] {
            let path = registry(&scope, home, profile, V2);
            assert!(inspect(&scope).is_ok());
            assert_eq!(fs::read(&path).unwrap(), V2);
            assert!(!path.with_file_name("registry.lock").exists());
            fs::write(&path, b"broken").unwrap();
            assert!(inspect(&scope).is_err(), "{path:?}");
            fs::write(path, V2).unwrap();
        }
    }
    for root in &scope.inventories {
        fs::create_dir(root).unwrap();
        assert!(inspect(&scope).is_err(), "even an empty inventory refuses");
        fs::remove_dir(root).unwrap();
    }
}

#[test]
fn filesystem_entry_and_registry_bounds_are_exact() {
    let (_temp, scope) = fixture();
    let profiles = scope.homes[0].join("profiles");
    fs::create_dir_all(&profiles).unwrap();
    for i in 0..MAX_PROFILES {
        fs::create_dir(profiles.join(format!("profile-{i}"))).unwrap();
    }
    assert!(inspect(&scope).is_ok());
    let extra = profiles.join("extra");
    fs::create_dir(&extra).unwrap();
    assert!(inspect(&scope).is_err());
    fs::remove_dir(extra).unwrap();
    let mut bytes = V2.to_vec();
    bytes.resize(LIMIT as usize, b' ');
    let path = registry(&scope, 0, "profile-0", &bytes);
    assert!(inspect(&scope).is_ok());
    bytes.push(b' ');
    fs::write(path, bytes).unwrap();
    assert!(inspect(&scope).is_err());
}

#[test]
fn filesystem_wrong_types_and_unresolved_paths_are_not_absence() {
    let (_temp, mut scope) = fixture();
    for path in [
        scope.homes[0].clone(),
        scope.homes[0].join("profiles"),
        scope.homes[0].join("profiles/default"),
        scope.homes[0].join("profiles/default/registry.json"),
    ] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, V2).unwrap();
        if path.file_name().unwrap() == "registry.json" {
            fs::remove_file(&path).unwrap();
            fs::create_dir(&path).unwrap();
        }
        assert!(inspect(&scope).is_err(), "{path:?}");
        if path.is_dir() {
            fs::remove_dir(&path).unwrap();
        } else {
            fs::remove_file(&path).unwrap();
        }
    }
    scope.homes[0] = "relative".into();
    assert!(inspect(&scope).is_err());
    scope.homes[0] = scope.homes[1].join("../other");
    assert!(inspect(&scope).is_err());
}

#[cfg(unix)]
#[test]
fn filesystem_links_including_absent_leaf_ancestors_refuse() {
    use std::os::unix::fs::symlink;
    let (_temp, scope) = fixture();
    for path in [
        scope.homes[0].clone(),
        scope.homes[0].join("profiles"),
        scope.homes[0].join("profiles/default"),
        scope.homes[0].join("profiles/default/registry.json"),
        scope.inventories[0].clone(),
    ] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        symlink("missing-target", &path).unwrap();
        assert!(inspect(&scope).is_err(), "{path:?}");
        fs::remove_file(path).unwrap();
    }
}

// One calling thread only; neither real permissions nor runner identity decide
// whether metadata/read/listing/iteration faults happen.
thread_local! {
    static FAULT: std::cell::RefCell<Option<(PathBuf, &'static str)>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn io(path: &Path, operation: &str) -> std::io::Result<()> {
    let fail = FAULT.with_borrow(|fault| {
        fault
            .as_ref()
            .is_some_and(|(p, op)| p == path && *op == operation)
    });
    if fail {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "injected filesystem failure",
        ))
    } else {
        Ok(())
    }
}

#[test]
fn filesystem_injected_read_metadata_listing_and_iteration_errors_refuse() {
    let (_temp, scope) = fixture();
    let registry = registry(&scope, 0, "default", V2);
    let profiles = scope.homes[0].join("profiles");
    for (path, operation) in [
        (scope.homes[1].clone(), "metadata"),
        (registry.clone(), "read"),
        (profiles.clone(), "listing"),
        (profiles, "entry"),
    ] {
        FAULT.set(Some((path.clone(), operation)));
        let result = inspect(&scope);
        FAULT.set(None);
        assert!(result.is_err(), "{operation} {path:?}");
        assert_eq!(fs::read(&registry).unwrap(), V2);
        assert!(inspect(&scope).is_ok());
    }
}
