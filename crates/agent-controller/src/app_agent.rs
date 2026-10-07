//! Identities for agents the app runs through a plugin (Agents2). They are not
//! harness agents: there is no process, harness setting or controller record.
//! Native keeps each key and its owner attestation and signs only bounded kinds.
use crate::config::{agent_id, canonical_key, canonical_relay};
use crate::secret::validate_attestation;
use crate::{Credentials, Result, Secret};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What a plugin agent may publish: its profile (0), a deletion (5), a reaction
/// (7), a message (9) or an edit of its own message (40003).
const KINDS: [u16; 5] = [0, 5, 7, 9, 40003];

/// One saved identity. The key itself stays in the OS credential store.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AppAgent {
    pub pubkey: String,
    /// Canonical `wss://` community origin the agent was created for.
    pub relay: String,
    pub owner: String,
    /// The owner's NIP-OA `auth` tag as a JSON array string.
    pub auth: String,
}
impl AppAgent {
    fn credential_id(&self) -> String {
        agent_id(&self.pubkey, &self.relay)
    }
    /// The community's HTTP event endpoint; nothing else is ever posted to.
    pub fn events_url(&self) -> String {
        format!("{}/events", self.relay.replacen("wss://", "https://", 1))
    }
    pub fn read_key(&self, credentials: &dyn Credentials) -> Result<Secret> {
        credentials
            .read(&self.credential_id(), &self.pubkey)?
            .ok_or_else(|| "Agent key unavailable".into())
    }
    /// Signs one bounded event as this agent with its owner attestation attached.
    pub fn sign(
        &self,
        key: &Secret,
        kind: u16,
        content: String,
        mut tags: Vec<Vec<String>>,
    ) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        if !KINDS.contains(&kind) {
            return Err(
                "Agents can sign profiles, messages, edits, reactions and deletions only".into(),
            );
        }
        if content.len() > 64 * 1024
            || tags.len() > 256
            || tags
                .iter()
                .any(|tag| tag.is_empty() || tag.iter().map(String::len).sum::<usize>() > 4096)
        {
            return Err("Agent event is too large".into());
        }
        let auth: Vec<String> =
            serde_json::from_str(&self.auth).map_err(|_| "Invalid owner authorization")?;
        tags.retain(|tag| tag.first().map(String::as_str) != Some("auth"));
        tags.push(auth);
        key.signed(kind, content, tags)
    }
    /// NIP-98 authorization for posting `body` to this agent's community.
    pub fn http_auth(&self, key: &Secret, body: &[u8]) -> Result<serde_json::Value> {
        if key.pubkey() != self.pubkey {
            return Err("Agent identity changed".into());
        }
        key.profile_auth(&self.events_url(), body)
    }
}

/// A generated key awaiting its owner attestation. Dropping it discards the key.
pub struct NewAppAgent {
    key: Secret,
    relay: String,
    owner: String,
}
impl NewAppAgent {
    pub fn pubkey(&self) -> &str {
        self.key.pubkey()
    }
    pub fn owner(&self) -> &str {
        &self.owner
    }
}

/// The saved identities, one JSON file under app data. Reads see a whole file
/// (writes rename into place); each read-modify-write holds a file lock beside it,
/// since more than one app instance can share the directory.
#[derive(Clone)]
pub struct AppAgents {
    path: PathBuf,
}
impl AppAgents {
    pub fn open(path: PathBuf) -> Self {
        Self { path }
    }
    pub fn list(&self) -> Result<Vec<AppAgent>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "Saved agent identities are malformed".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err("Could not read saved agent identities".into()),
        }
    }
    pub fn get(&self, pubkey: &str) -> Result<AppAgent> {
        self.list()?
            .into_iter()
            .find(|agent| agent.pubkey == pubkey)
            .ok_or_else(|| "No such agent on this device".into())
    }
    /// Runs `change` on the saved list while holding the cross-process lock, and
    /// saves what it returns.
    fn update<T>(&self, change: impl FnOnce(&mut Vec<AppAgent>) -> Result<T>) -> Result<T> {
        let dir = self.path.parent().ok_or("Invalid agent identity storage")?;
        std::fs::create_dir_all(dir).map_err(|_| "Could not create agent identity storage")?;
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(self.path.with_extension("lock"))
            .map_err(|_| "Could not open agent identity lock")?;
        lock.lock().map_err(|_| "Could not lock agent identities")?;
        let mut agents = self.list()?;
        let result = change(&mut agents)?;
        self.write(&agents)?;
        Ok(result)
    }
    fn write(&self, agents: &[AppAgent]) -> Result<()> {
        let bytes =
            serde_json::to_vec_pretty(agents).map_err(|_| "Could not encode agent identities")?;
        let temp = self.path.with_extension("tmp");
        std::fs::write(&temp, bytes).map_err(|_| "Could not save agent identities")?;
        std::fs::rename(&temp, &self.path).map_err(|_| "Could not save agent identities".into())
    }
    pub fn prepare(destination: &str, owner: &str) -> Result<NewAppAgent> {
        if !canonical_key(owner) {
            return Err("Choose a signed-in owner".into());
        }
        Ok(NewAppAgent {
            relay: canonical_relay(destination)?,
            key: Secret::generate()?,
            owner: owner.into(),
        })
    }
    /// Saves the key, then the identity. An attestation for another key or owner is refused.
    pub fn commit(
        &self,
        prepared: NewAppAgent,
        auth: &[String],
        credentials: &dyn Credentials,
    ) -> Result<AppAgent> {
        let auth = serde_json::to_string(auth).map_err(|_| "Invalid owner authorization")?;
        validate_attestation(&auth, prepared.key.pubkey())?;
        let tag: Vec<String> =
            serde_json::from_str(&auth).map_err(|_| "Invalid owner authorization")?;
        if tag[1] != prepared.owner {
            return Err("Agent authorization belongs to another owner".into());
        }
        let agent = AppAgent {
            pubkey: prepared.key.pubkey().into(),
            relay: prepared.relay,
            owner: prepared.owner,
            auth,
        };
        let id = agent.credential_id();
        credentials.add(&id, &prepared.key)?;
        agent
            .read_key(credentials)
            .map_err(|_| "New agent key could not be verified")?;
        self.update(|agents| {
            agents.retain(|saved| saved.pubkey != agent.pubkey);
            agents.push(agent.clone());
            Ok(())
        })?;
        Ok(agent)
    }
    /// Forgets the identity, then deletes its key. Absence is success.
    pub fn remove(&self, pubkey: &str, credentials: &dyn Credentials) -> Result<()> {
        let removed = self.update(|agents| {
            Ok(agents
                .iter()
                .position(|agent| agent.pubkey == pubkey)
                .map(|index| agents.remove(index)))
        })?;
        match removed {
            Some(agent) => credentials.delete(&agent.credential_id(), &agent.pubkey),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests;
