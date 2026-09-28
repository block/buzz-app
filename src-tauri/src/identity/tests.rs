use super::*;
#[derive(Default)]
struct Memory {
    saved: Mutex<Option<Vec<u8>>>,
    denied: Mutex<bool>,
    write_denied: Mutex<bool>,
    reads: Mutex<usize>,
}
impl Store for Arc<Memory> {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        *self.reads.lock().unwrap() += 1;
        if *self.denied.lock().unwrap() {
            return Err("denied".into());
        }
        Ok(self.saved.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn add(&self, value: &[u8]) -> Result<()> {
        if *self.write_denied.lock().unwrap() {
            return Err("write denied".into());
        }
        let mut saved = self.saved.lock().unwrap();
        if saved.is_some() {
            return Err("occupied".into());
        }
        *saved = Some(value.to_vec());
        Ok(())
    }
}
fn identity(store: &Arc<Memory>) -> Identity {
    Identity {
        state: State::Unread,
        store: Box::new(store.clone()),
    }
}
fn fixture() -> Key {
    Key(Zeroizing::new([1; 32]))
}

#[test]
fn imports_exact_key_then_restores_and_exports_without_repeated_reads() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    let public = fixture().viewer().unwrap();
    assert_eq!(owner.save(Some(&nsec)).unwrap(), public);
    assert_eq!(owner.export().unwrap(), nsec);
    assert_eq!(owner.restore().unwrap(), Some(public.clone()));
    assert_eq!(*store.reads.lock().unwrap(), 1);
    let mut restarted = identity(&store);
    assert_eq!(restarted.restore().unwrap(), Some(public));
    assert_eq!(restarted.export().unwrap(), nsec);
    assert_eq!(*store.reads.lock().unwrap(), 2);
}
#[test]
fn denied_and_corrupt_reads_cannot_create_or_overwrite() {
    for corrupt in [false, true] {
        let store = Arc::new(Memory::default());
        *store.denied.lock().unwrap() = !corrupt;
        if corrupt {
            *store.saved.lock().unwrap() = Some(b"corrupt".to_vec());
        }
        let before = store.saved.lock().unwrap().clone();
        let mut owner = identity(&store);
        assert!(owner.restore().is_err());
        assert!(owner.save(None).is_err());
        assert!(owner.save(Some(&fixture().nsec().unwrap())).is_err());
        assert_eq!(*store.saved.lock().unwrap(), before);
        assert!(matches!(owner.state, State::Unread));
    }
}
#[test]
fn failed_persistence_never_adopts_candidate_and_retry_uses_imported_key() {
    let store = Arc::new(Memory::default());
    *store.write_denied.lock().unwrap() = true;
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    assert!(owner.save(Some(&nsec)).is_err());
    assert!(owner.export().is_err());
    assert!(store.saved.lock().unwrap().is_none());
    *store.write_denied.lock().unwrap() = false;
    assert_eq!(
        owner.save(Some(&nsec)).unwrap(),
        fixture().viewer().unwrap()
    );
}
#[test]
fn cached_absence_cannot_overwrite_an_identity_created_by_another_process() {
    let store = Arc::new(Memory::default());
    let mut first = identity(&store);
    let mut second = identity(&store);
    assert!(first.restore().unwrap().is_none());
    let public = second.save(None).unwrap();
    assert!(first.save(None).is_err());
    assert_eq!(identity(&store).restore().unwrap(), Some(public));
}
#[test]
fn invalid_imports_do_not_create_keys_and_saved_identity_is_immutable() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    for text in [
        "",
        "ab",
        &"ab".repeat(32),
        &bech32::encode::<Bech32>(Hrp::parse("npub").unwrap(), &[1; 32]).unwrap(),
        &Key(Zeroizing::new([0; 32])).nsec().unwrap(),
    ] {
        assert!(owner.save(Some(text)).is_err());
        assert!(store.saved.lock().unwrap().is_none());
    }
    let public = owner.save(None).unwrap();
    assert!(owner.save(None).is_err());
    assert!(owner.save(Some(&fixture().nsec().unwrap())).is_err());
    assert_eq!(owner.restore().unwrap(), Some(public));
}
#[test]
fn default_test_host_cannot_access_real_credentials() {
    assert!(IdentityHost::default().0.lock().unwrap().restore().is_err());
}

#[test]
fn uppercase_import_keeps_the_exact_key_and_mixed_case_is_rejected() {
    let store = Arc::new(Memory::default());
    let mut owner = identity(&store);
    let nsec = fixture().nsec().unwrap();
    assert!(owner.save(Some(&nsec.replacen("nsec", "NSEC", 1))).is_err());
    assert!(store.saved.lock().unwrap().is_none());
    assert_eq!(
        owner.save(Some(&nsec.to_uppercase())).unwrap(),
        fixture().viewer().unwrap()
    );
    assert_eq!(identity(&store).export().unwrap(), nsec);
}

#[test]
fn development_and_release_items_are_separate() {
    assert_eq!(
        SERVICE,
        if cfg!(debug_assertions) {
            "dev.local.buzz.foundation.identity.debug"
        } else {
            "dev.local.buzz.foundation.identity"
        }
    );
    assert!(!SERVICE.starts_with("buzz-desktop"));
}
