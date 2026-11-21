//! Device keys and proof construction stay in the native host. No signing command is exposed to IPC.
use super::config::DpopMode;
#[cfg(target_os = "macos")]
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
#[cfg(target_os = "macos")]
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

// The legacy macOS Keychain can return errSecItemNotFound from overlapping
// SecKeyCreateRandomKey calls. Serialize creation in the host, including real sign-ins.
#[cfg(target_os = "macos")]
static KEY_CREATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(super) struct DeviceKey {
    handle: String,
    #[cfg(target_os = "macos")]
    jwk: serde_json::Value,
    thumbprint: String,
    retained: AtomicBool,
    #[cfg(target_os = "macos")]
    mode: DpopMode,
    #[cfg(target_os = "macos")]
    key: security_framework::key::SecKey,
}
impl DeviceKey {
    pub(super) fn handle(&self) -> &str {
        &self.handle
    }
    pub(super) fn thumbprint(&self) -> &str {
        &self.thumbprint
    }
    pub(super) fn retain(&self) {
        self.retained.store(true, Ordering::Release);
    }

    #[cfg(target_os = "macos")]
    pub(super) fn create(mode: DpopMode) -> Result<Self, &'static str> {
        use security_framework::{
            access_control::{ProtectionMode, SecAccessControl},
            item::Location,
            key::{GenerateKeyOptions, KeyType, SecKey, Token},
        };
        let _creation = super::lock(&KEY_CREATION);
        let handle = format!("xyz.buzz.native-dpop.{}", uuid::Uuid::new_v4());
        let mut options = GenerateKeyOptions::default();
        options
            .set_key_type(KeyType::ec_sec_prime_random())
            .set_size_in_bits(256)
            .set_label(&handle)
            .set_location(match mode {
                DpopMode::SecureEnclave => Location::DataProtectionKeychain,
                DpopMode::Software => Location::DefaultFileKeychain,
            });
        match mode {
            DpopMode::SecureEnclave => {
                options.set_token(Token::SecureEnclave).set_access_control(
                    SecAccessControl::create_with_protection(
                        Some(ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly),
                        security_framework_sys::access_control::kSecAccessControlPrivateKeyUsage,
                    )
                    .map_err(|_| "device-key-unavailable")?,
                );
            }
            DpopMode::Software => {
                options.set_token(Token::Software);
            }
        }
        let key = SecKey::new(&options).map_err(|error| {
            eprintln!(
                "DPoP SecKeyCreateRandomKey failed: domain={} code={}",
                error.domain(),
                error.code()
            );
            "device-key-unavailable"
        })?;
        Self::from_key(handle, key, mode, false)
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn create(_: DpopMode) -> Result<Self, &'static str> {
        Err("device-key-unsupported")
    }

    #[cfg(target_os = "macos")]
    pub(super) fn load(handle: &str, mode: DpopMode) -> Result<Self, &'static str> {
        use security_framework::item::{
            ItemClass, ItemSearchOptions, KeyClass, Reference, SearchResult,
        };
        if !valid_handle(handle) {
            return Err("device-key-unavailable");
        }
        let mut query = ItemSearchOptions::new();
        query
            .class(ItemClass::key())
            .key_class(KeyClass::private())
            .label(handle)
            .load_refs(true)
            .limit(security_framework::item::Limit::All);
        if mode == DpopMode::SecureEnclave {
            query.ignore_legacy_keychains();
        }
        let mut found = query.search().map_err(|error| {
            if error.code() == -25300 {
                "device-key-unavailable"
            } else {
                "device-key-temporarily-unavailable"
            }
        })?;
        if found.len() != 1 {
            return Err("device-key-unavailable");
        }
        let SearchResult::Ref(Reference::Key(key)) = found.remove(0) else {
            return Err("device-key-unavailable");
        };
        Self::from_key(handle.into(), key, mode, true)
    }
    #[cfg(not(target_os = "macos"))]
    pub(super) fn load(_: &str, _: DpopMode) -> Result<Self, &'static str> {
        Err("device-key-unsupported")
    }

    #[cfg(target_os = "macos")]
    fn from_key(
        handle: String,
        key: security_framework::key::SecKey,
        mode: DpopMode,
        retained: bool,
    ) -> Result<Self, &'static str> {
        use core_foundation::{
            base::{TCFType, ToVoid},
            string::CFString,
        };
        use security_framework_sys::item::{kSecAttrTokenID, kSecAttrTokenIDSecureEnclave};
        let token = key
            .attributes()
            .find(unsafe { kSecAttrTokenID.to_void() })
            .map(|value| unsafe { CFString::wrap_under_get_rule(value.cast()) }.to_string());
        let enclave =
            unsafe { CFString::wrap_under_get_rule(kSecAttrTokenIDSecureEnclave) }.to_string();
        if mode == DpopMode::SecureEnclave && token.as_deref() != Some(enclave.as_str()) {
            return Err("device-key-unavailable");
        }
        let public = key
            .public_key()
            .and_then(|key| key.external_representation())
            .ok_or("device-key-unavailable")?
            .to_vec();
        if public.len() != 65 || public[0] != 4 {
            return Err("device-key-unavailable");
        }
        let x = URL_SAFE_NO_PAD.encode(&public[1..33]);
        let y = URL_SAFE_NO_PAD.encode(&public[33..]);
        let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
        let thumbprint = hash(canonical.as_bytes());
        Ok(Self {
            handle,
            jwk: serde_json::from_str(&canonical).map_err(|_| "device-key-unavailable")?,
            thumbprint,
            retained: AtomicBool::new(retained),
            mode,
            key,
        })
    }

    #[cfg(target_os = "macos")]
    pub(super) fn proof(
        &self,
        method: &str,
        target: &url::Url,
        token: Option<&str>,
    ) -> Result<String, &'static str> {
        if target.scheme() != "https" && !(cfg!(test) && target.host_str() == Some("127.0.0.1")) {
            return Err("invalid-dpop-target");
        }
        let mut target = target.clone();
        target.set_query(None);
        target.set_fragment(None);
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| "device-key-unavailable")?;
        let header = serde_json::json!({"typ":"dpop+jwt","alg":"ES256","jwk":self.jwk});
        let mut claims = serde_json::json!({"htm":method,"htu":target.as_str(),"iat":super::protocol::now()?,"jti":URL_SAFE_NO_PAD.encode(random)});
        if let Some(token) = token {
            claims["ath"] = serde_json::Value::String(hash(token.as_bytes()));
        }
        let signing = format!(
            "{}.{}",
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&header).map_err(|_| "device-key-unavailable")?),
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&claims).map_err(|_| "device-key-unavailable")?)
        );
        let signature = self
            .key
            .create_signature(
                security_framework::key::Algorithm::ECDSASignatureMessageX962SHA256,
                signing.as_bytes(),
            )
            .map_err(|_| "device-key-signing-unavailable")?;
        Ok(format!(
            "{signing}.{}",
            URL_SAFE_NO_PAD.encode(raw_signature(&signature)?)
        ))
    }

    #[cfg(not(target_os = "macos"))]
    pub(super) fn proof(
        &self,
        _: &str,
        _: &url::Url,
        _: Option<&str>,
    ) -> Result<String, &'static str> {
        Err("device-key-unsupported")
    }

    /// Called only after the secure session record no longer references this handle.
    pub(super) fn retire(&self) -> Result<(), &'static str> {
        #[cfg(target_os = "macos")]
        {
            use security_framework::item::{ItemClass, ItemSearchOptions};
            let mut query = ItemSearchOptions::new();
            query
                .class(ItemClass::key())
                .label(&self.handle)
                .limit(security_framework::item::Limit::All);
            if self.mode == DpopMode::SecureEnclave {
                query.ignore_legacy_keychains();
            }
            match query.delete() {
                Ok(()) => {}
                Err(error) if error.code() == -25300 => {}
                Err(_) => return Err("device-key-cleanup-required"),
            }
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        Err("device-key-unsupported")
    }
}
impl Drop for DeviceKey {
    fn drop(&mut self) {
        if !self.retained.load(Ordering::Acquire) {
            let _ = self.retire();
        }
    }
}
#[cfg(target_os = "macos")]
fn hash(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}
#[cfg(target_os = "macos")]
fn valid_handle(value: &str) -> bool {
    value
        .strip_prefix("xyz.buzz.native-dpop.")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

// Security.framework signs ASN.1 DER; JWS ES256 requires exactly 32-byte r followed by 32-byte s.
#[cfg(target_os = "macos")]
fn raw_signature(der: &[u8]) -> Result<[u8; 64], &'static str> {
    if der.len() < 8 || der.len() > 72 || der[0] != 0x30 || der[1] as usize + 2 != der.len() {
        return Err("device-key-unavailable");
    }
    let mut at = 2;
    let mut output = [0u8; 64];
    for slot in output.chunks_mut(32) {
        if der.get(at) != Some(&2) {
            return Err("device-key-unavailable");
        }
        at += 1;
        let length = *der.get(at).ok_or("device-key-unavailable")? as usize;
        at += 1;
        let integer = der.get(at..at + length).ok_or("device-key-unavailable")?;
        at += length;
        if integer.is_empty() || integer[0] & 0x80 != 0 {
            return Err("device-key-unavailable");
        }
        let unsigned = if integer[0] == 0 {
            &integer[1..]
        } else {
            integer
        };
        if unsigned.len() > 32 {
            return Err("device-key-unavailable");
        }
        slot[32 - unsigned.len()..].copy_from_slice(unsigned);
    }
    if at != der.len() {
        return Err("device-key-unavailable");
    }
    Ok(output)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn concurrent_software_key_creation_keeps_distinct_restorable_signers() {
        let start = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    DeviceKey::create(DpopMode::Software)
                })
            })
            .collect();
        // Join all callers before dropping keys, isolating concurrent creation from deletion.
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let keys: Vec<_> = results
            .into_iter()
            .map(|result| result.expect("concurrent software key"))
            .collect();
        let handles: std::collections::BTreeSet<_> = keys.iter().map(DeviceKey::handle).collect();
        let thumbprints: std::collections::BTreeSet<_> =
            keys.iter().map(DeviceKey::thumbprint).collect();
        assert_eq!(handles.len(), 8);
        assert_eq!(thumbprints.len(), 8);
        let target = url::Url::parse("https://issuer.example/prefix/v1/session").unwrap();
        for key in &keys {
            let restored = DeviceKey::load(key.handle(), DpopMode::Software).unwrap();
            assert_eq!(restored.thumbprint(), key.thumbprint());
            assert!(restored.proof("GET", &target, Some("test-token")).is_ok());
            key.retire().unwrap();
            assert!(DeviceKey::load(key.handle(), DpopMode::Software).is_err());
        }
    }
    #[test]
    fn software_key_persists_and_signs_distinct_bound_proofs_then_retires() {
        let cold = std::time::Instant::now();
        let key = DeviceKey::create(DpopMode::Software).expect("explicit software key");
        let target = url::Url::parse("https://issuer.example/prefix/v1/session?ignored=1").unwrap();
        let first = key.proof("GET", &target, Some("test-token")).unwrap();
        let cold = cold.elapsed();
        key.retain();
        let restored = DeviceKey::load(key.handle(), DpopMode::Software).unwrap();
        assert_eq!(restored.thumbprint(), key.thumbprint());
        let warm = std::time::Instant::now();
        let second = restored.proof("GET", &target, Some("test-token")).unwrap();
        eprintln!("DPoP software cold={cold:?} warm={:?}", warm.elapsed());
        assert_ne!(first, second);
        let decode = |proof: &str| -> serde_json::Value {
            serde_json::from_slice(
                &URL_SAFE_NO_PAD
                    .decode(proof.split('.').nth(1).unwrap())
                    .unwrap(),
            )
            .unwrap()
        };
        assert_eq!(
            decode(&first)["htu"],
            "https://issuer.example/prefix/v1/session"
        );
        assert_eq!(decode(&first)["ath"], hash(b"test-token"));
        assert_ne!(decode(&first)["jti"], decode(&second)["jti"]);
        let parts: Vec<_> = first.split('.').collect();
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(signature.len(), 64);
        assert!(restored
            .proof(
                "GET",
                &url::Url::parse("http://issuer.example").unwrap(),
                Some("test-token")
            )
            .is_err());
        if let Ok(path) = std::env::var("DPOP_PROOF_VECTOR_OUT") {
            let token = "v".repeat(43);
            let target = url::Url::parse("https://identity.example/prefix/v1/session").unwrap();
            let proof = restored.proof("GET", &target, Some(&token)).unwrap();
            std::fs::write(path, serde_json::to_vec_pretty(&serde_json::json!({"thumbprint":restored.thumbprint(),"token":token,"proof":proof,"iat":decode(&proof)["iat"]})).unwrap()).unwrap();
        }
        restored.retire().unwrap();
        assert!(DeviceKey::load(key.handle(), DpopMode::Software).is_err());
    }
}
