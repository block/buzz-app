//! Established, target-only structural evidence; never credential-use authority.
use super::*;
use serde::de::{Error as _, MapAccess, Visitor};
use std::{collections::BTreeSet, marker::PhantomData};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    version: u32,
    #[serde(deserialize_with = "unique")]
    installed: BTreeMap<String, Installed>,
    #[serde(default, deserialize_with = "unique")]
    bundled_overrides: BTreeMap<String, bool>,
}
fn unique<'de, D, V>(deserializer: D) -> std::result::Result<BTreeMap<String, V>, D::Error>
where
    D: serde::Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct Entries<V>(PhantomData<V>);
    impl<'de, V: Deserialize<'de>> Visitor<'de> for Entries<V> {
        type Value = BTreeMap<String, V>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique registry map keys")
        }
        fn visit_map<M: MapAccess<'de>>(
            self,
            mut map: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut entries = BTreeMap::new();
            while let Some(key) = map.next_key::<String>()? {
                if entries.contains_key(&key) {
                    return Err(M::Error::custom("Duplicate registry map key"));
                }
                entries.insert(key, map.next_value()?);
            }
            Ok(entries)
        }
    }
    deserializer.deserialize_map(Entries(PhantomData))
}

// No guards or borrowed evidence can be carried into the returned value.
pub(super) struct Structural<'a> {
    pub(super) registry: &'a Registry,
    pub(super) installed: &'a BTreeMap<String, Installed>,
    pub(super) namespace: &'a Namespace,
    pub(super) state: &'a State,
}
fn checked(path: &Path, write: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    if !fs::symlink_metadata(path)
        .map_err(|_| UNREADABLE)?
        .is_file()
    {
        return Err(UNREADABLE.into());
    }
    let file = options.open(path).map_err(|_| UNREADABLE)?;
    if !file.metadata().map_err(|_| UNREADABLE)?.is_file() {
        return Err(UNREADABLE.into());
    }
    Ok(file)
}
fn existing_lock(path: &Path) -> Admission<Held> {
    let file = checked(path, true)?;
    match file.try_lock() {
        Ok(()) => Ok(Held(file)),
        Err(fs::TryLockError::WouldBlock) => Err(Refusal::Busy(UNREADABLE.into())),
        Err(fs::TryLockError::Error(_)) => Err(UNREADABLE.into()),
    }
}
pub(super) fn bytes(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    checked(path, false)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| UNREADABLE)?;
    if bytes.len() > limit {
        return Err(UNREADABLE.into());
    }
    Ok(bytes)
}
fn policy(policy: &Policy) -> bool {
    let slot = SecretSlot {
        id: "slot".into(),
        label: "Slot".into(),
        origins: policy.origins.clone(),
        header: policy.header.clone(),
        scheme: policy.scheme.clone(),
    };
    let manifest = Manifest {
        id: "example.structure".into(),
        name: "Structure".into(),
        api_version: 1,
        host: Some(HostGrants {
            network_origins: policy.origins.clone(),
            secrets: vec![slot.clone()],
            ..Default::default()
        }),
        description: None,
        discovery: None,
        updates: None,
    };
    manifest.validate().is_ok() && slot.policy() == *policy
}
fn validate(namespace: &Namespace, raw: &Raw) -> Result<()> {
    let mut accounts = BTreeSet::new();
    let mut owners = BTreeSet::new();
    for entry in &namespace.entries {
        let account = entry.account.strip_prefix("v1.").unwrap_or_default();
        if account.len() != 32
            || !account
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !accounts.insert(&entry.account)
            || valid_id(&entry.plugin).is_err()
            || valid_id(&entry.slot).is_err()
            || !hex64(&entry.identity)
            || valid_uuid(&entry.lineage).is_err()
            || valid_uuid(&entry.generation).is_err()
            || !policy(&entry.policy)
            || (entry.phase == Phase::Retired) != entry.cause.is_some()
        {
            return Err(UNREADABLE.into());
        }
        if entry.phase == Phase::Retired {
            continue;
        }
        let phase = if entry.phase == Phase::Live { 0 } else { 1 };
        if !owners.insert((&entry.plugin, &entry.identity, &entry.slot, phase))
            || namespace.lineage.as_ref() != Some(&entry.lineage)
            || !raw.installed.get(&entry.plugin).is_some_and(|plugin| {
                plugin.generation.as_ref() == Some(&entry.generation)
                    && slots(&plugin.manifest).get(&entry.slot) == Some(&entry.policy)
            })
        {
            return Err(UNREADABLE.into());
        }
    }
    Ok(())
}
/// A registry whose secret lineage belongs to `variant`'s inventory.
fn registry(bytes: &[u8], variant: &str) -> Result<(Registry, Raw)> {
    let text = std::str::from_utf8(bytes).map_err(|_| UNREADABLE)?;
    let raw: Raw = serde_json::from_str(text).map_err(|_| UNREADABLE)?;
    for (id, plugin) in &raw.installed {
        if id != &plugin.manifest.id
            || valid_id(id).is_err()
            || plugin.manifest.validate().is_err()
            || crate::valid_hash(&plugin.current).is_err()
            || plugin
                .previous
                .as_ref()
                .is_some_and(|v| crate::valid_hash(v).is_err())
            || plugin
                .generation
                .as_ref()
                .is_some_and(|v| raw.version != 3 || valid_uuid(v).is_err())
        {
            return Err(UNREADABLE.into());
        }
    }
    let _ = &raw.bundled_overrides; // Deserialized through the same unique-key pass.
    let registry =
        crate::parse_owned_registry(text, &|lineage| check_owned_lineage(lineage, variant))
            .map_err(|_| UNREADABLE)?;
    Ok((registry, raw))
}

pub(super) fn inspect_namespace(
    bytes: &[u8],
    namespace: &Namespace,
    home: &Path,
    profile: &str,
    variant: &str,
) -> Result<()> {
    let (registry, raw) = registry(bytes, variant)?;
    if !namespace.valid()
        || namespace.home != home_hash(home)?
        || namespace.profile != profile
        || valid_id(profile).is_err()
        || registry.secrets.as_ref().map(|v| &v.lineage) != namespace.lineage.as_ref()
    {
        return Err(UNREADABLE.into());
    }
    if let Some(lineage) = &registry.secrets {
        check_owned_lineage(lineage, variant)?;
    }
    validate(namespace, &raw)
}

pub(super) fn inspect_retired(namespace: &Namespace) -> Result<()> {
    if !namespace.valid()
        || valid_id(&namespace.profile).is_err()
        || namespace
            .lineage
            .as_ref()
            .is_some_and(|v| valid_uuid(v).is_err())
        || namespace
            .entries
            .iter()
            .any(|entry| entry.phase != Phase::Retired)
    {
        return Err(UNREADABLE.into());
    }
    validate(
        namespace,
        &Raw {
            version: 2,
            installed: BTreeMap::new(),
            bundled_overrides: BTreeMap::new(),
        },
    )
}

pub(super) fn with_structural<T>(
    manager: &Manager,
    continuation: impl FnOnce(Structural<'_>) -> T,
) -> Admission<T> {
    if cfg!(not(unix)) {
        return Err(UNSUPPORTED.into());
    }
    let inventory = manager.inventory().ok_or(UNAVAILABLE)?;
    let id = manager.namespace_id()?;
    let _r = existing_lock(&manager.root.join("registry.lock"))?;
    let _g = existing_lock(&inventory.root.join("state.lock"))?;
    let _i = existing_lock(&inventory.root.join(format!("ns-{id}.lock")))?;
    let registry_bytes = bytes(&manager.root.join("registry.json"), crate::LIMIT as usize)?;
    let (registry, raw) = registry(&registry_bytes, VARIANT)?;
    let state: State =
        serde_json::from_slice(&bytes(&inventory.root.join(STATE), MAX_RECORD_BYTES)?)
            .map_err(|_| UNREADABLE)?;
    let namespace: Namespace = serde_json::from_slice(&bytes(
        &inventory.root.join(format!("ns-{id}.json")),
        MAX_RECORD_BYTES,
    )?)
    .map_err(|_| UNREADABLE)?;
    let members: BTreeSet<_> = state.namespaces.iter().collect();
    if !state.valid()
        || members.len() != state.namespaces.len()
        || !members.contains(&id)
        || !namespace.valid()
        || namespace.home != home_hash(&manager.home)?
        || namespace.profile != manager.profile
        || registry.secrets.as_ref().map(|v| &v.lineage) != namespace.lineage.as_ref()
        || namespace
            .lineage
            .as_ref()
            .is_some_and(|v| valid_uuid(v).is_err())
    {
        return Err(UNREADABLE.into());
    }
    validate(&namespace, &raw)?;
    Ok(continuation(Structural {
        registry: &registry,
        installed: &raw.installed,
        namespace: &namespace,
        state: &state,
    }))
}
