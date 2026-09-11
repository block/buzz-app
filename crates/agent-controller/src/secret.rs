use crate::Result;
use bech32::{primitives::decode::CheckedHrpstring, Bech32};
use secp256k1::{PublicKey, Secp256k1, SecretKey};
use zeroize::Zeroizing;

/// No Debug/Serialize: secret bytes never belong in a command result or log.
pub struct Secret {
    bytes: Zeroizing<[u8; 32]>,
    pubkey: String,
}
impl Secret {
    pub fn parse(text: &str, expected: &str) -> Result<Self> {
        let mut bytes = Zeroizing::new([0; 32]);
        if text.len() == 64 && text.bytes().all(|c| c.is_ascii_hexdigit()) {
            for (i, pair) in text.as_bytes().chunks_exact(2).enumerate() {
                let digit = |c: u8| {
                    if c <= b'9' {
                        c - b'0'
                    } else {
                        c.to_ascii_lowercase() - b'a' + 10
                    }
                };
                bytes[i] = digit(pair[0]) * 16 + digit(pair[1]);
            }
        } else {
            if text.len() != 63 || !text.starts_with("nsec1") {
                return Err("Agent key is malformed".into());
            }
            let checked =
                CheckedHrpstring::new::<Bech32>(text).map_err(|_| "Agent key is malformed")?;
            let mut values = checked.byte_iter();
            for b in bytes.iter_mut() {
                *b = values.next().ok_or("Agent key is malformed")?;
            }
            if values.next().is_some() {
                return Err("Agent key is malformed".into());
            }
        }
        let mut key = SecretKey::from_byte_array(*bytes).map_err(|_| "Agent key is malformed")?;
        let pubkey = PublicKey::from_secret_key(&Secp256k1::signing_only(), &key)
            .x_only_public_key()
            .0
            .to_string();
        key.non_secure_erase();
        if pubkey != expected {
            return Err("Agent key does not match the selected identity".into());
        }
        Ok(Self { bytes, pubkey })
    }
    pub fn pubkey(&self) -> &str {
        &self.pubkey
    }
    pub fn hex(&self) -> Zeroizing<String> {
        use std::fmt::Write;
        let mut output = Zeroizing::new(String::with_capacity(64));
        for byte in self.bytes.iter() {
            write!(&mut *output, "{byte:02x}").expect("string formatting");
        }
        output
    }
}
/// Native OS adapter; tests inject isolated memory credentials. No silent fallback
/// to plaintext private-key files and no overwrite of existing or legacy entries.
pub trait Credentials: Send + Sync {
    fn read_legacy(&self, pubkey: &str) -> Result<Secret>;
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>>;
    fn add(&self, id: &str, key: &Secret) -> Result<()>;
}

/// V1 starts only unrestricted, verified NIP-OA credentials. Conditional grants
/// remain saved but need event-aware readiness rather than a misleading Ready.
pub(crate) fn validate_attestation(raw: &str, agent: &str) -> Result<()> {
    use secp256k1::{schnorr::Signature, XOnlyPublicKey};
    use sha2::{Digest, Sha256};
    if raw.len() > 4096 {
        return Err("Saved owner attestation is too large".into());
    }
    let tag: Vec<String> =
        serde_json::from_str(raw).map_err(|_| "Saved owner attestation is malformed")?;
    if tag.len() != 4
        || tag[0] != "auth"
        || tag[1] == agent
        || !crate::config::canonical_key(&tag[1])
        || tag[3].len() != 128
        || !tag[3]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Saved owner attestation is malformed".into());
    }
    let owner: XOnlyPublicKey = tag[1].parse().map_err(|_| "Invalid attestation owner")?;
    let signature: Signature = tag[3]
        .parse()
        .map_err(|_| "Invalid owner attestation signature")?;
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:{}", tag[2]));
    Secp256k1::verification_only()
        .verify_schnorr(&signature, &digest, &owner)
        .map_err(|_| "Owner attestation does not authorize this agent key")?;
    if !tag[2].is_empty() {
        return Err("Conditional owner attestations need event-aware readiness; this controller cannot start them yet".into());
    }
    Ok(())
}
#[cfg(test)]
pub(crate) fn test_attestation(agent: &str) -> String {
    use secp256k1::Keypair;
    use sha2::{Digest, Sha256};
    let secp = Secp256k1::new();
    let mut bytes = [0; 32];
    bytes[31] = 2;
    let pair = Keypair::from_secret_key(&secp, &SecretKey::from_byte_array(bytes).unwrap());
    let digest = Sha256::digest(format!("nostr:agent-auth:{agent}:"));
    let sig = secp.sign_schnorr_no_aux_rand(&digest, &pair);
    serde_json::to_string(&[
        "auth",
        &pair.x_only_public_key().0.to_string(),
        "",
        &sig.to_string(),
    ])
    .unwrap()
}
