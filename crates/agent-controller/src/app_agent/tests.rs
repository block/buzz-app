use super::*;
use std::collections::BTreeMap;
use std::sync::Mutex;

#[derive(Default)]
struct Memory(Mutex<BTreeMap<String, String>>);
impl Credentials for Memory {
    fn read_legacy(&self, _: crate::LegacySource, _: &str) -> Result<Secret> {
        panic!("App agents never import")
    }
    fn read(&self, id: &str, pubkey: &str) -> Result<Option<Secret>> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .map(|hex| Secret::parse(hex, pubkey))
            .transpose()
    }
    fn add(&self, id: &str, key: &Secret) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .insert(id.into(), key.hex().to_string());
        Ok(())
    }
    fn delete(&self, id: &str, _: &str) -> Result<()> {
        self.0.lock().unwrap().remove(id);
        Ok(())
    }
}

/// The owner `test_attestation` signs with.
fn owner() -> String {
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"a".repeat(64))).unwrap();
    auth[1].clone()
}
fn created(dir: &std::path::Path, credentials: &Memory) -> (AppAgents, AppAgent) {
    let agents = AppAgents::open(dir.join("agents2/identities.json"));
    let prepared = AppAgents::prepare("https://relay.example/", &owner()).unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    let agent = agents.commit(prepared, &auth, credentials).unwrap();
    (agents, agent)
}

#[test]
fn creates_saves_and_removes_an_identity_with_its_key() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (agents, agent) = created(dir.path(), &credentials);
    assert_eq!(agent.relay, "wss://relay.example");
    assert_eq!(agent.events_url(), "https://relay.example/events");
    assert_eq!(agents.list().unwrap(), [agent.clone()]);
    assert_eq!(agents.get(&agent.pubkey).unwrap(), agent);
    assert!(agent.read_key(&credentials).is_ok());
    agents.remove(&agent.pubkey, &credentials).unwrap();
    assert!(agents.list().unwrap().is_empty());
    assert!(agent.read_key(&credentials).is_err());
    // Removing again is success.
    agents.remove(&agent.pubkey, &credentials).unwrap();
}

#[test]
fn refuses_an_attestation_for_another_key_or_owner() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let agents = AppAgents::open(dir.path().join("identities.json"));
    let prepared = AppAgents::prepare("wss://relay.example", &owner()).unwrap();
    let other: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"b".repeat(64))).unwrap();
    assert!(agents.commit(prepared, &other, &credentials).is_err());
    let prepared = AppAgents::prepare("wss://relay.example", &"c".repeat(64)).unwrap();
    let auth: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey())).unwrap();
    assert!(agents.commit(prepared, &auth, &credentials).is_err());
    assert!(agents.list().unwrap().is_empty());
    assert!(credentials.0.lock().unwrap().is_empty());
}

#[test]
fn signs_only_bounded_kinds_with_the_saved_attestation() {
    let dir = tempfile::tempdir().unwrap();
    let credentials = Memory::default();
    let (_, agent) = created(dir.path(), &credentials);
    let key = agent.read_key(&credentials).unwrap();
    let saved: Vec<String> = serde_json::from_str(&agent.auth).unwrap();
    for kind in [0, 5, 7, 9, 40003] {
        let tags = vec![
            vec!["auth".to_owned(), "forged".to_owned()],
            vec!["h".to_owned(), "channel".to_owned()],
        ];
        let event = agent.sign(&key, kind, "hi".into(), tags).unwrap();
        assert_eq!(event["kind"], kind);
        assert_eq!(event["pubkey"], agent.pubkey);
        let mut tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
        let ms = tags.remove(tags.iter().position(|tag| tag[0] == "ms").unwrap());
        assert_eq!(ms[0], "ms");
        assert!(ms[1].parse::<u16>().unwrap() < 1000);
        assert_eq!(
            tags,
            [vec!["h".to_owned(), "channel".to_owned()], saved.clone()]
        );
    }
    // A plugin cannot pick its own `ms`, and events outside a channel get none.
    let forged = vec![
        vec!["h".to_owned(), "channel".to_owned()],
        vec!["ms".to_owned(), "999".to_owned()],
    ];
    let event = agent.sign(&key, 9, "hi".into(), forged).unwrap();
    let tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
    assert_eq!(tags.iter().filter(|tag| tag[0] == "ms").count(), 1);
    let event = agent.sign(&key, 0, "{}".into(), vec![]).unwrap();
    let tags: Vec<Vec<String>> = serde_json::from_value(event["tags"].clone()).unwrap();
    assert!(tags.iter().all(|tag| tag[0] != "ms"));
    for kind in [1, 3, 9000, 30078, 40002] {
        assert!(agent.sign(&key, kind, String::new(), vec![]).is_err());
    }
    assert!(agent
        .sign(&key, 9, "x".repeat(64 * 1024 + 1), vec![])
        .is_err());
    assert!(agent.sign(&key, 9, String::new(), vec![vec![]]).is_err());
    let other = Secret::generate().unwrap();
    assert!(agent.sign(&other, 9, String::new(), vec![]).is_err());
    assert!(agent.http_auth(&other, b"{}").is_err());
    let auth = agent.http_auth(&key, b"{}").unwrap();
    assert_eq!(auth["kind"], 27235);
}

#[test]
fn concurrent_writers_on_one_file_keep_every_identity() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("agents2/identities.json");
    let credentials = std::sync::Arc::new(Memory::default());
    let threads: Vec<_> = (0..8)
        .map(|_| {
            // Separate handles stand in for separate app instances.
            let agents = AppAgents::open(path.clone());
            let credentials = credentials.clone();
            std::thread::spawn(move || {
                let prepared = AppAgents::prepare("https://relay.example/", &owner()).unwrap();
                let auth: Vec<String> =
                    serde_json::from_str(&crate::secret::test_attestation(prepared.pubkey()))
                        .unwrap();
                agents
                    .commit(prepared, &auth, credentials.as_ref())
                    .unwrap()
                    .pubkey
            })
        })
        .collect();
    let mut made: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let mut saved: Vec<_> = AppAgents::open(path)
        .list()
        .unwrap()
        .into_iter()
        .map(|agent| agent.pubkey)
        .collect();
    made.sort();
    saved.sort();
    assert_eq!(saved, made);
}
