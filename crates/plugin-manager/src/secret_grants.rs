//! Saved "Always Allow" answers for one plugin using another plugin's secret.
//! Stored beside the registry under the same lock, in a separate file so older
//! registries stay readable.
use std::collections::BTreeSet;
use std::fs::File;

use serde::{Deserialize, Serialize};

use crate::{atomic_write, err, read_file_limited, valid_id, Manager, Result};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretGrant {
    /// The plugin that uses the secret.
    pub consumer: String,
    /// The plugin that saved the secret.
    pub provider: String,
    pub name: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Grants {
    version: u32,
    grants: BTreeSet<SecretGrant>,
}

const FILE: &str = "secret-grants.json";

impl Manager {
    fn read_grants(&self) -> Result<Grants> {
        let file = match File::open(self.root.join(FILE)) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Grants {
                    version: 1,
                    grants: BTreeSet::new(),
                })
            }
            Err(error) => return Err(err(error)),
        };
        let grants: Grants = serde_json::from_str(&read_file_limited(file)?).map_err(err)?;
        if grants.version != 1 {
            return Err("Unsupported credential access version".into());
        }
        Ok(grants)
    }
    fn save_grants(&self, grants: &Grants) -> Result<()> {
        atomic_write(
            &self.root.join(FILE),
            &serde_json::to_vec_pretty(grants).map_err(err)?,
        )
    }
    pub fn secret_grants(&self) -> Result<Vec<SecretGrant>> {
        let _lock = self.lock()?;
        Ok(self.read_grants()?.grants.into_iter().collect())
    }
    pub fn has_secret_grant(&self, grant: &SecretGrant) -> Result<bool> {
        Ok(self.secret_grants()?.contains(grant))
    }
    pub fn grant_secret(&self, grant: SecretGrant) -> Result<()> {
        valid_id(&grant.consumer)?;
        valid_id(&grant.provider)?;
        let _lock = self.lock()?;
        let mut grants = self.read_grants()?;
        if grants.grants.insert(grant) {
            self.save_grants(&grants)?;
        }
        Ok(())
    }
    pub fn revoke_secret(&self, grant: &SecretGrant) -> Result<()> {
        let _lock = self.lock()?;
        let mut grants = self.read_grants()?;
        if grants.grants.remove(grant) {
            self.save_grants(&grants)?;
        }
        Ok(())
    }
    /// Called while the registry lock is held: drop every grant naming a removed plugin.
    pub(crate) fn forget_secret_grants_locked(&self, plugin: &str) -> Result<()> {
        let mut grants = self.read_grants()?;
        let before = grants.grants.len();
        grants
            .grants
            .retain(|grant| grant.consumer != plugin && grant.provider != plugin);
        if grants.grants.len() != before {
            self.save_grants(&grants)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn grant(consumer: &str, provider: &str) -> SecretGrant {
        SecretGrant {
            consumer: consumer.into(),
            provider: provider.into(),
            name: "token".into(),
        }
    }

    #[test]
    fn grants_persist_revoke_and_follow_plugin_removal() {
        let temp = tempfile::tempdir().unwrap();
        let manager = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        let source = temp.path().join("build");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("plugin.js"), "export function apply() {}").unwrap();
        fs::write(
            source.join("manifest.json"),
            r#"{"id":"example.adapter","name":"Adapter","apiVersion":1}"#,
        )
        .unwrap();
        manager.install(&source).unwrap();

        manager
            .grant_secret(grant("example.adapter", "example.provider"))
            .unwrap();
        manager
            .grant_secret(grant("example.other", "example.provider"))
            .unwrap();
        let reopened = Manager::open(Some(temp.path().into()), "test", false).unwrap();
        assert!(reopened
            .has_secret_grant(&grant("example.adapter", "example.provider"))
            .unwrap());
        assert!(!reopened
            .has_secret_grant(&grant("example.provider", "example.adapter"))
            .unwrap());

        reopened
            .revoke_secret(&grant("example.other", "example.provider"))
            .unwrap();
        assert_eq!(
            manager.secret_grants().unwrap(),
            [grant("example.adapter", "example.provider")]
        );

        manager.change("remove", "example.adapter").unwrap();
        assert!(manager.secret_grants().unwrap().is_empty());
        assert!(manager
            .grant_secret(grant("Bad/Id", "example.provider"))
            .is_err());
    }
}
