//! Read-only import of one explicitly configured legacy agent. Secrets stay native.
use nostr::{
    hashes::{sha256, Hash},
    secp256k1::{schnorr::Signature, Message},
    Keys, PublicKey, SECP256K1,
};
use serde_json::Value;
use std::{
    collections::HashMap, fs::OpenOptions, io::Read, path::Path, process::Command, str::FromStr,
};

pub struct Profile {
    pub name: String,
    pub prompt: String,
    pub model: String,
    pub auth: String,
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "Cannot read the configured agent library")?;
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect agent library")?
        .is_file()
    {
        return Err("Agent library must be a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read agent library")?;
    let result = if bytes.len() > 8 * 1024 * 1024 {
        Err("Agent library is too large".into())
    } else {
        serde_json::from_slice(&bytes).map_err(|_| "Invalid agent library".into())
    };
    bytes.fill(0);
    result
}

pub fn project(raw: &Value, agent: &str, owner: &str) -> Result<Profile, String> {
    let rows = raw.as_array().ok_or("Invalid agent library")?;
    let mut matches = rows.iter().filter(|r| r["pubkey"].as_str() == Some(agent));
    let row = matches.next().ok_or("Configured agent was not found")?;
    if matches.next().is_some() {
        return Err("Duplicate agent identity".into());
    }
    if row["agent_command"].as_str() != Some("buzz-agent")
        || row["respond_to"].as_str() != Some("owner-only")
    {
        return Err("This runner supports owner-only Buzz agents".into());
    }
    let definition = match row["persona_id"].as_str() {
        Some(id) => rows
            .iter()
            .find(|r| r["pubkey"].as_str() == Some("") && r["slug"].as_str() == Some(id))
            .ok_or("Agent definition is missing")?,
        None => row,
    };
    if definition["provider"].as_str() != Some("relay-mesh") {
        return Err("Choose shared compute for this agent before starting it".into());
    }
    let auth = row["auth_tag"]
        .as_str()
        .ok_or("Agent owner attestation is missing")?;
    verify_owner(auth, agent, owner)?;
    let stored = definition["model"].as_str().unwrap_or("auto").trim();
    Ok(Profile {
        name: row["name"].as_str().unwrap_or("Agent").to_string(),
        prompt: definition["system_prompt"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        model: if stored.is_empty() || stored == "auto" {
            "mesh"
        } else {
            stored
        }
        .to_string(),
        auth: auth.to_string(),
    })
}

fn verify_owner(auth: &str, agent: &str, owner: &str) -> Result<(), String> {
    let fail = || "Agent owner attestation does not match this account".to_string();
    let parts: Vec<String> = serde_json::from_str(auth).map_err(|_| fail())?;
    // Initial compatibility scope is unconditional credentials. Never silently
    // discard delegated restrictions we do not implement.
    if parts.len() != 4
        || parts[0] != "auth"
        || parts[1] != owner
        || !parts[2].is_empty()
        || agent == owner
    {
        return Err(fail());
    }
    let key = PublicKey::from_hex(owner).map_err(|_| fail())?;
    let sig = Signature::from_str(&parts[3]).map_err(|_| fail())?;
    let digest = sha256::Hash::hash(format!("nostr:agent-auth:{agent}:").as_bytes());
    let msg = Message::from_digest(digest.to_byte_array());
    SECP256K1
        .verify_schnorr(&sig, &msg, &key.xonly().map_err(|_| fail())?)
        .map_err(|_| fail())
}

pub fn agent_secret(service: &str, agent: &str) -> Result<String, String> {
    if !service.starts_with("buzz-desktop") || service.len() > 128 {
        return Err("Invalid agent Keychain service".into());
    }
    let mut output = Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            service,
            "-a",
            "secrets",
            "-w",
        ])
        .output()
        .map_err(|_| "Cannot access the agent Keychain")?;
    if !output.status.success() {
        return Err("Agent Keychain access failed".into());
    }
    let parsed: Result<HashMap<String, String>, _> = serde_json::from_slice(&output.stdout);
    output.stdout.fill(0);
    let mut secrets = parsed.map_err(|_| "Invalid agent Keychain data")?;
    let result = secrets
        .remove(&format!("agent:{agent}"))
        .ok_or("Agent credential is unavailable")?;
    if Keys::parse(&result)
        .map_err(|_| "Invalid agent credential")?
        .public_key()
        .to_hex()
        != agent
    {
        return Err("Agent credential identity mismatch".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (Value, String, String) {
        let owner = Keys::generate();
        let agent = Keys::generate().public_key().to_hex();
        let message = Message::from_digest(
            sha256::Hash::hash(format!("nostr:agent-auth:{agent}:").as_bytes()).to_byte_array(),
        );
        let auth = json!([
            "auth",
            owner.public_key().to_hex(),
            "",
            owner.sign_schnorr(&message).to_string()
        ])
        .to_string();
        let raw = json!([
            {"pubkey":"", "slug":"definition", "provider":"relay-mesh", "model":"auto", "system_prompt":"current prompt"},
            {"pubkey":agent, "name":"Moonpal", "agent_command":"buzz-agent", "respond_to":"owner-only", "persona_id":"definition", "system_prompt":"stale prompt", "auth_tag":auth}
        ]);
        (raw, agent, owner.public_key().to_hex())
    }
    #[test]
    fn uses_linked_definition_and_verifies_owner() {
        let (raw, agent, owner) = fixture();
        let p = project(&raw, &agent, &owner).unwrap();
        assert_eq!(p.model, "mesh");
        assert_eq!(p.prompt, "current prompt");
        assert!(project(&raw, &agent, &Keys::generate().public_key().to_hex()).is_err());
    }
    #[test]
    fn refuses_invalid_credentials_missing_definition_and_other_providers() {
        let (raw, agent, owner) = fixture();
        let mut forged = raw.clone();
        forged[1]["auth_tag"] = json!(json!(["auth", owner, "", "0".repeat(128)]).to_string());
        assert!(project(&forged, &agent, &owner).is_err());
        let mut missing = raw.clone();
        missing[1]["persona_id"] = json!("missing");
        assert!(project(&missing, &agent, &owner).is_err());
        let mut other = raw.clone();
        other[0]["provider"] = json!("openai");
        assert!(project(&other, &agent, &owner).is_err());
        let mut access = raw.clone();
        access[1]["respond_to"] = json!("anyone");
        assert!(project(&access, &agent, &owner).is_err());
    }
}
