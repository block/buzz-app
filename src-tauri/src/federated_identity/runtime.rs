//! Explicit local deployment trust for builds without a compiled authority.
use super::config::Config;
use std::{fs::OpenOptions, io::Read, path::Path};

pub(super) const FILE_NAME: &str = "federated-identity.json";

pub(super) fn resolve(compiled: Option<&str>, path: &Path) -> Result<Vec<Config>, String> {
    // A managed build's authority cannot be replaced, disabled or repaired by
    // a local file. Do not even open the file when compiled policy is present.
    if let Some(raw) = compiled.filter(|raw| !raw.is_empty()) {
        return Config::parse_list(raw);
    }
    let invalid = || {
        format!(
            "Cannot load federated identity deployment: {}",
            path.display()
        )
    };
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(invalid()),
    };
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() {
        return Err(invalid());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let owner = metadata.uid();
        if (owner != nix::unistd::geteuid().as_raw() && owner != 0) || metadata.mode() & 0o022 != 0
        {
            return Err(invalid());
        }
    }
    // Bound the actual read, including a file that grows after opening. The
    // parser enforces the 8192-byte descriptor limit and HTTPS/host constraints.
    let mut raw = String::new();
    file.take(8193)
        .read_to_string(&mut raw)
        .map_err(|_| invalid())?;
    Config::parse(&raw)
        .map(|config| vec![config])
        .map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::{store, FederatedIdentity, Status};
    use std::fs;

    fn write(path: &Path, raw: impl AsRef<[u8]>) {
        fs::write(path, raw).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn descriptor() -> String {
        serde_json::json!({
            "version": 1, "id": "example",
            "identityOrigin": "https://identity.example",
            "adapterBase": "https://identity.example/nip-fa/",
            "communityHosts": ["community.example"], "apiBasePath": "/api/"
        })
        .to_string()
    }

    #[test]
    fn compiled_authority_wins_without_reading_local_policy() {
        let root = tempfile::tempdir().unwrap();
        // A directory is not a descriptor, but compiled policy ignores it.
        let loaded = resolve(Some(&descriptor()), root.path()).unwrap();
        assert_eq!(loaded[0].id, "example");
        let file = root.path().join(FILE_NAME);
        write(&file, descriptor());
        assert!(resolve(Some("invalid compiled policy"), &file).is_err());
        assert_eq!(resolve(Some(""), &file).unwrap()[0].id, "example");
    }

    #[test]
    fn compiled_registry_preserves_builtin_peers_and_session_slots() {
        let root = tempfile::tempdir().unwrap();
        // Even an invalid local descriptor cannot change the standard build's
        // server, or any server in a managed multi-server build.
        write(&root.path().join(FILE_NAME), "invalid local policy");
        let builtin = super::super::config::compiled(None, None, None).unwrap();
        let raw = serde_json::to_string(&builtin).unwrap();
        let standard = FederatedIdentity::from_root(root.path().to_owned(), Some(&raw)).unwrap();
        assert_eq!(standard.snapshot().authority.unwrap().id, "bb-public");
        assert_eq!(standard.servers().len(), 1);

        let managed = super::super::config::compiled(Some(&descriptor()), None, None).unwrap();
        let raw = serde_json::to_string(&managed).unwrap();
        let managed = FederatedIdentity::from_root(root.path().to_owned(), Some(&raw)).unwrap();
        assert_eq!(managed.servers().len(), 2);
        assert_eq!(managed.snapshot().authority.unwrap().id, "example");
        let public = managed.server_for("https://communities.buzz.xyz").unwrap();
        assert_eq!(public.snapshot().authority.unwrap().id, "bb-public");
        assert_eq!(public.0.account, standard.0.account);
        assert_ne!(managed.0.account, public.0.account);

        let relay = "wss://buzz.example.builderlab.xyz";
        let customer = managed.server_for(relay).unwrap();
        assert_eq!(customer.config().unwrap().id, "bb-example");
        let reopened = FederatedIdentity::from_root(root.path().to_owned(), Some(&raw)).unwrap();
        assert_eq!(
            reopened
                .server_for_command(None, Some("bb-example"))
                .unwrap()
                .0
                .account,
            customer.0.account
        );

        // A standard build may have left a customer list in the same bb-public slot.
        assert_eq!(
            standard.server_for(relay).unwrap().config().unwrap().id,
            "bb-example"
        );
        // A local file selects one authority, even when it describes bb-public.
        write(&root.path().join(FILE_NAME), super::super::config::BUILT_IN);
        let local = FederatedIdentity::from_root(root.path().to_owned(), Some("")).unwrap();
        assert!(local.server_for(relay).unwrap().is(&local));
        assert_eq!(local.servers().len(), 1);
    }

    #[test]
    fn absence_is_unconfigured_but_invalid_present_files_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE_NAME);
        assert!(resolve(None, &path).unwrap().is_empty());
        assert!(resolve(None, root.path()).is_err());
        for raw in [
            String::new(),
            format!("[{}]", descriptor()),
            "private-content-that-must-not-be-echoed".into(),
            descriptor().replace("https://", "http://"),
            format!("{}{}", descriptor(), " ".repeat(8193)),
        ] {
            write(&path, raw);
            assert_eq!(
                resolve(None, &path).err().unwrap(),
                format!(
                    "Cannot load federated identity deployment: {}",
                    path.display()
                )
            );
        }
        write(&path, [0xff, 0xfe]);
        assert!(resolve(None, &path).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_writable_policy_and_nonregular_files() {
        use std::os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        };
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE_NAME);
        write(&path, descriptor());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(resolve(None, &path).unwrap().len(), 1);
        let link = root.path().join("link");
        symlink(&path, &link).unwrap();
        assert!(resolve(None, &link).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o622)).unwrap();
        assert!(resolve(None, &path).is_err());
        let fifo = root.path().join("fifo");
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a live, NUL-terminated path and the mode is valid.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(resolve(None, &fifo).is_err());
    }

    #[test]
    fn native_owner_uses_same_session_slot_for_equivalent_sources() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(FILE_NAME);
        let raw = descriptor();
        write(&path, &raw);
        let compiled = FederatedIdentity::from_root(root.path().to_owned(), Some(&raw)).unwrap();
        let local = FederatedIdentity::from_root(root.path().to_owned(), None).unwrap();
        assert!(matches!(local.snapshot().status, Status::Restoring));
        assert_eq!(local.snapshot().authority.unwrap().id, "example");
        assert_eq!(compiled.0.account, local.0.account);
        let changed = raw.replace("community.example", "different.example");
        write(&path, changed);
        let other = FederatedIdentity::from_root(root.path().to_owned(), None).unwrap();
        assert_ne!(local.0.account, other.0.account);
        store::remove_all(root.path().to_owned()).unwrap();
        assert!(
            path.is_file(),
            "session cleanup must preserve deployment policy"
        );
    }
}
