//! Provider-backed agents. Identity, custody and owner attestation stay here; a
//! provider plugin decides what an admitted mention does and may run one-shot
//! processes as the agent. These agents never have an ACP listener.
use crate::config::Agent;
use crate::{Controller, Result, Secret};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use zeroize::Zeroizing;

const PROVIDER: &str = "provider";
const PROVIDER_CONFIG: &str = "providerConfig";

/// Chosen once at creation. Config is non-secret provider settings, visible in snapshots.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderBinding {
    pub provider: String,
    #[serde(default)]
    pub config: BTreeMap<String, String>,
}
impl ProviderBinding {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_provider(&self.provider)?;
        if self.config.len() > 32 {
            return Err("Too many provider settings".into());
        }
        for (key, value) in &self.config {
            if key.is_empty()
                || key.len() > 128
                || !key
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
            {
                return Err("Invalid provider setting name".into());
            }
            if value.len() > 8192 || value.contains('\0') {
                return Err("Provider setting is too long or contains a NUL byte".into());
            }
        }
        Ok(())
    }
    pub(crate) fn bind(&self, agent: &mut Agent) -> Result<()> {
        self.validate()?;
        agent
            .extra
            .insert(PROVIDER.into(), Value::String(self.provider.clone()));
        agent.extra.insert(
            PROVIDER_CONFIG.into(),
            serde_json::to_value(&self.config).map_err(|_| "Invalid provider settings")?,
        );
        Ok(())
    }
}
/// `plugin.id/provider-id`, the contribution key of the registering plugin.
fn validate_provider(value: &str) -> Result<()> {
    let part = |s: &str| {
        !s.is_empty()
            && s.as_bytes()[0].is_ascii_alphanumeric()
            && s.bytes().all(|c| {
                c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
            })
    };
    match value.split_once('/') {
        Some((plugin, id)) if value.len() <= 256 && part(plugin) && part(id) => Ok(()),
        _ => Err("Invalid agent provider".into()),
    }
}
impl Agent {
    pub(crate) fn provider(&self) -> Option<&str> {
        self.extra.get(PROVIDER)?.as_str()
    }
    pub(crate) fn provider_config(&self) -> BTreeMap<String, String> {
        self.extra
            .get(PROVIDER_CONFIG)
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default()
    }
}

/// The key's encodings, removed from anything a provider process prints back.
pub struct Redaction(Vec<Zeroizing<String>>);
impl Redaction {
    pub fn apply(&self, text: String) -> String {
        self.0.iter().fold(text, |text, secret| {
            text.replace(secret.as_str(), "[redacted]")
        })
    }
}

/// Native-only launch input for one provider invocation. Never serialized.
pub struct Invocation {
    pub credential_id: String,
    pub pubkey: String,
    relay_url: String,
    auth_tag: String,
    workspace: PathBuf,
    tools: PathBuf,
    runs: PathBuf,
    resolved: PathBuf,
}
impl Controller {
    /// Only the provider that owns this agent may run processes as it.
    pub fn invocation(&self, id: &str, provider: &str, program: &str) -> Result<Invocation> {
        let agent = self
            .store
            .agents()?
            .into_iter()
            .find(|a| a.id == id)
            .ok_or("Agent no longer exists")?;
        if agent.provider() != Some(provider) {
            return Err("This agent is not handled by that provider".into());
        }
        let auth_tag = agent
            .auth_tag
            .clone()
            .ok_or("This identity has no saved owner attestation")?;
        crate::secret::validate_attestation(&auth_tag, &agent.pubkey)?;
        let workspace = PathBuf::from(&agent.workspace);
        if !workspace.is_dir() {
            return Err("Agent workspace does not exist".into());
        }
        let bundle = self.bundle.as_ref().map_err(Clone::clone)?;
        // Only integrity-checked bundled tools: an arbitrary program could hand the key back.
        if program.contains('/') || program.contains('\\') {
            return Err("Provider programs must be bundled tools".into());
        }
        let resolved = bundle.executable(program)?;
        let runs = self.store.root().join("runs");
        crate::connection::private_directory(&runs)?;
        Ok(Invocation {
            credential_id: agent.credential_id,
            pubkey: agent.pubkey,
            relay_url: agent.relay_url,
            auth_tag,
            workspace,
            tools: bundle.directory.clone(),
            runs,
            resolved,
        })
    }
}
impl Invocation {
    /// The returned directory must outlive the process: it is the child's TMPDIR.
    pub fn command(
        &self,
        key: &Secret,
        args: &[String],
    ) -> Result<(Command, tempfile::TempDir, Redaction)> {
        if key.pubkey() != self.pubkey {
            return Err("Credential does not match the saved agent".into());
        }
        if args.len() > 128 || args.iter().any(|a| a.len() > 32 * 1024 || a.contains('\0')) {
            return Err("Invalid provider program arguments".into());
        }
        let temporary = tempfile::Builder::new()
            .prefix("invoke-")
            .tempdir_in(&self.runs)
            .map_err(|_| "Could not create private runtime directory")?;
        let mut command = Command::new(&self.resolved);
        command
            .args(args)
            .env_clear()
            .current_dir(&self.workspace)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for name in [
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "SSL_CERT_FILE",
            "SSL_CERT_DIR",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let path = std::env::join_paths(
            std::iter::once(self.tools.clone())
                .chain(std::env::split_paths("/usr/bin:/bin:/usr/sbin:/sbin")),
        )
        .map_err(|_| "Invalid runtime tools path")?;
        let key_hex = key.hex();
        command
            .env("PATH", path)
            .env("TMPDIR", temporary.path())
            .env("BUZZ_PRIVATE_KEY", &*key_hex)
            .env("NOSTR_PRIVATE_KEY", &*key_hex)
            .env("BUZZ_RELAY_URL", &self.relay_url)
            .env("BUZZ_AUTH_TAG", &self.auth_tag);
        let upper = Zeroizing::new(key_hex.to_ascii_uppercase());
        let redaction = Redaction(vec![key_hex, upper, key.nsec()?]);
        Ok((command, temporary, redaction))
    }
    pub fn workspace(&self) -> &Path {
        &self.workspace
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_contribution_keys() {
        for ok in ["buzz.ackbot/ackbot", "a/b", "x-1.y/codex_native"] {
            assert!(validate_provider(ok).is_ok(), "{ok}");
        }
        for bad in ["", "ackbot", "/x", "x/", "A/b", "a/b/c", "a/.b", "a b/c"] {
            assert!(validate_provider(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn binding_rejects_unsafe_settings() {
        let binding = |key: &str, value: &str| ProviderBinding {
            provider: "buzz.ackbot/ackbot".into(),
            config: BTreeMap::from([(key.into(), value.into())]),
        };
        assert!(binding("reply", "ack").validate().is_ok());
        assert!(binding("", "ack").validate().is_err());
        assert!(binding("bad key", "ack").validate().is_err());
        assert!(binding("reply", "a\0").validate().is_err());
    }
}
