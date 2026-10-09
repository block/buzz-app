use super::*;
use crate::{AgentEdit, Credentials, LegacySource, NewAgent, Secret, Store};
use std::{collections::BTreeMap, sync::Arc};

struct NoCredentials;
impl Credentials for NoCredentials {
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
        panic!("preview/export must not read keys")
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret> {
        panic!("bundles must not import legacy identities")
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        panic!("controller tests do not persist keys")
    }
    fn delete(&self, _: &str, _: &str) -> Result<()> {
        panic!("bundles must not delete keys")
    }
}
fn controller(root: &std::path::Path) -> Controller {
    Controller::new(
        Store::open(root.join("store")).unwrap(),
        Arc::new(NoCredentials),
        Err("No fixture runtime".into()),
        root.join("ownership"),
    )
}
fn member() -> MemberSnapshot {
    snapshot_member(
        &crate::store::tests::fixture(),
        &crate::agent_defaults::AgentDefaults::default(),
    )
    .unwrap()
}
fn edit(root: &std::path::Path) -> AgentEdit {
    AgentEdit {
        name: "Fixture".into(),
        system_prompt: "INDIVIDUAL_MARKER".into(),
        picture: None,
        session_policy: Some(Some(SessionPolicy::Thread)),
        workspace: root.display().to_string(),
        harness: crate::store::tests::fixture().harness,
        environment: BTreeMap::new(),
    }
}
fn owner() -> String {
    let tag: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"ab".repeat(32))).unwrap();
    tag[1].clone()
}
#[test]
fn independent_imports_keep_prompts_separate_and_receipts_survive_reload() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let owner = owner();
    let first = NewAgent::prepare("https://relay.example/", &owner).unwrap();
    let second = NewAgent::prepare("wss://relay.example", &owner).unwrap();
    let mut snapshot = member();
    snapshot.definition.source_is_builtin = true;
    snapshot.profile.about = Some("Fixture profile".into());
    snapshot.definition.respond_to = Some("allowlist".into());
    snapshot.definition.respond_to_allowlist = vec!["ab".repeat(32)];
    for (request, prepared) in [("request-one", &first), ("request-two", &second)] {
        control
            .create_bundle_member(
                prepared,
                edit(root.path()),
                &crate::secret::test_attestation(prepared.key.pubkey()),
                request,
                &BundleMember {
                    team: "team-a".into(),
                    member: snapshot.clone(),
                    instructions: "TEAM_MARKER".into(),
                    keep_allowlist: false,
                },
            )
            .unwrap();
    }
    assert_ne!(first.key.pubkey(), second.key.pubkey());
    let agents = control.store.agents().unwrap();
    assert_eq!(agents.len(), 2);
    for agent in agents {
        assert_eq!(agent.system_prompt, "INDIVIDUAL_MARKER");
        assert_eq!(agent.imported["teamInstructions"], "TEAM_MARKER");
        assert_eq!(agent.respond_to(false).unwrap(), "owner-only");
        assert_eq!(agent.imported["record"]["respond_to_allowlist"], json!([]));
        assert!(!agent.enabled);
        assert!(!agent.starts_on_launch());
        assert_eq!(agent.selected_session_policy(), Some(SessionPolicy::Thread));
    }
    let exported = control
        .export_team(
            TeamMeta {
                name: "Roundtrip".into(),
                description: None,
                instructions: None,
            },
            &[first.key.pubkey().to_owned()],
            "wss://relay.example",
        )
        .unwrap();
    assert!(exported.members[0].definition.source_is_builtin);
    let target = control.creation_profile(&first.id).unwrap();
    let initial = target.event(&first.key, &[]).unwrap();
    assert_eq!(initial["kind"], 0);
    let initial_content: serde_json::Value =
        serde_json::from_str(initial["content"].as_str().unwrap()).unwrap();
    assert_eq!(initial_content["about"], "Fixture profile");
    let prior = first
        .key
        .profile(
            "Fixture",
            Some("https://example.test/avatar.png"),
            Some("stale about"),
            &target.auth,
            &[],
        )
        .unwrap();
    let retried = target.event(&first.key, &[prior]).unwrap();
    let retried_content: serde_json::Value =
        serde_json::from_str(retried["content"].as_str().unwrap()).unwrap();
    assert_eq!(retried_content["about"], "Fixture profile");
    assert_eq!(
        retried_content["picture"],
        "https://example.test/avatar.png"
    );
    control
        .profile_published(&first.id, target.revision)
        .unwrap();
    // Subsequent avatar writes do not restore the original import description.
    let avatar = control.memory_target(&first.id).unwrap();
    assert!(avatar.about.is_none());
    assert!(control.creation_profile(&first.id).is_err());
    let external = first
        .key
        .profile(
            "Fixture",
            None,
            Some("Updated elsewhere"),
            &target.auth,
            &[retried],
        )
        .unwrap();
    let avatar_event = avatar.event(&first.key, &[external]).unwrap();
    let avatar_content: serde_json::Value =
        serde_json::from_str(avatar_event["content"].as_str().unwrap()).unwrap();
    assert_eq!(avatar_content["about"], "Updated elsewhere");
    assert_eq!(
        exported.members[0].profile.about.as_deref(),
        Some("Fixture profile")
    );
    drop(control);
    let mut control = controller(root.path());
    assert_eq!(
        control
            .created_request("request-one", "https://RELAY.example/", &owner)
            .unwrap()
            .unwrap()
            .id,
        first.id
    );
    assert!(control
        .created_request("request-one", "wss://other.example", &owner)
        .is_err());
    assert!(control
        .created_request("request-one", "wss://relay.example", &"ab".repeat(32))
        .is_err());
    // A retry with a new prepared identity still recovers the original saved receipt.
    control
        .create_bundle_member(
            &second,
            edit(root.path()),
            &crate::secret::test_attestation(second.key.pubkey()),
            "request-one",
            &BundleMember {
                team: "team-a".into(),
                member: snapshot.clone(),
                instructions: "TEAM_MARKER".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    assert_eq!(control.store.agents().unwrap().len(), 2);
}
#[test]
fn export_uses_effective_workers_for_native_and_edited_imported_agents() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let mut native = crate::store::tests::fixture();
    native.harness.model.clear();
    native.harness.provider.clear();
    let defaults = crate::agent_defaults::AgentDefaults {
        model: "inherited-model".into(),
        provider: "inherited-provider".into(),
        session_policy: SessionPolicy::Channel,
        ..Default::default()
    };
    control.store.save_defaults(&defaults).unwrap();
    let mut imported = native.clone();
    imported.pubkey = "cd".repeat(32);
    imported.id = crate::config::agent_id(&imported.pubkey, &imported.relay_url);
    imported.imported = json!({"record": {"parallelism": 3}});
    control
        .store
        .insert(vec![native.clone(), imported.clone()])
        .unwrap();
    let export = |control: &Controller, key: &str| {
        control
            .export_team(
                TeamMeta {
                    name: "Workers".into(),
                    description: None,
                    instructions: None,
                },
                &[key.to_owned()],
                "wss://relay.example",
            )
            .unwrap()
            .members
            .remove(0)
            .definition
            .parallelism
    };
    assert_eq!(export(&control, &native.pubkey), Some(1));
    assert_eq!(export(&control, &imported.pubkey), Some(3));
    let inherited = control
        .export_team(
            TeamMeta {
                name: "Inherited".into(),
                description: None,
                instructions: None,
            },
            &[native.pubkey.clone()],
            &native.relay_url,
        )
        .unwrap();
    assert_eq!(
        inherited.members[0].definition.model.as_deref(),
        Some("inherited-model")
    );
    assert_eq!(
        inherited.members[0].definition.provider.as_deref(),
        Some("inherited-provider")
    );
    assert_eq!(
        inherited.members[0].definition.session_policy,
        SessionPolicy::Channel
    );
    native
        .environment
        .insert("BUZZ_ACP_AGENTS".into(), "7".into());
    imported
        .environment
        .insert("BUZZ_ACP_AGENTS".into(), "5".into());
    control.store.remove(&native.id, native.revision).unwrap();
    control
        .store
        .remove(&imported.id, imported.revision)
        .unwrap();
    control
        .store
        .insert(vec![native.clone(), imported.clone()])
        .unwrap();
    assert_eq!(export(&control, &native.pubkey), Some(7));
    assert_eq!(export(&control, &imported.pubkey), Some(5));
}

#[test]
fn export_is_portable_and_preview_does_not_create_or_start_agents() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let source = crate::store::tests::fixture();
    control.store.insert(vec![source.clone()]).unwrap();
    let exported = control
        .export_team(
            TeamMeta {
                name: "Fixture team".into(),
                description: Some("Safe fixtures".into()),
                instructions: Some("TEAM_MARKER".into()),
            },
            std::slice::from_ref(&source.pubkey),
            &source.relay_url,
        )
        .unwrap();
    let bytes = serde_json::to_vec(&exported).unwrap();
    let text = String::from_utf8(bytes.clone()).unwrap();
    for private in [
        &source.pubkey,
        &source.credential_id,
        &source.workspace,
        "secret-env-value",
        "private-attestation",
        "futureTopLevel",
    ] {
        assert!(!text.contains(private), "leaked {private}");
    }
    let decoded = TeamSnapshot::decode(&bytes).unwrap();
    assert_eq!(decoded.team.instructions.as_deref(), Some("TEAM_MARKER"));
    assert_eq!(
        decoded.members[0].definition.system_prompt.as_deref(),
        Some(source.system_prompt.as_str())
    );
    assert_eq!(decoded.members[0].memory.level, "none");
    assert_eq!(control.store.agents().unwrap().len(), 1);
    assert!(!control.store.agents().unwrap()[0].enabled);
}
#[test]
fn memory_preview_bounds_slugs_duplicates_and_selected_level() {
    let mut memory = Memory {
        level: "core".into(),
        entries: vec![MemoryEntry {
            slug: "core".into(),
            body: "safe fixture".into(),
        }],
    };
    memory.validate().unwrap();
    memory.entries.push(memory.entries[0].clone());
    assert!(memory.validate().is_err());
    memory.entries.pop();
    memory.entries[0].slug = "mem/note".into();
    assert!(memory.validate().is_err());
    memory.level = "everything".into();
    memory.validate().unwrap();
    for slug in ["mem/../note", "mem/Note", "mem/", "mem/a//b", "private"] {
        memory.entries[0].slug = slug.into();
        assert!(memory.validate().is_err(), "{slug}");
    }
    memory.entries[0].slug = "core".into();
    memory.entries[0].body = "x".repeat(1024 * 1024);
    assert!(memory.validate().is_err());
}

#[test]
fn malformed_snapshots_are_rejected_before_creation() {
    let mut snapshot = TeamSnapshot {
        format: "buzz-team-snapshot".into(),
        version: 1,
        team: TeamMeta {
            name: "Fixture".into(),
            description: None,
            instructions: None,
        },
        members: vec![member()],
    };
    snapshot.validate().unwrap();
    snapshot.members[0].memory.entries.push(MemoryEntry {
        slug: "core".into(),
        body: "Fixture".into(),
    });
    assert!(snapshot.validate().is_err());
    snapshot.members[0].memory.entries.clear();
    snapshot.members[0].definition.runtime = Some("/private/local/executable".into());
    assert!(snapshot.validate().is_err());
    snapshot.members[0].definition.runtime = None;
    snapshot.team.instructions = Some("bad\0instructions".into());
    assert!(snapshot.validate().is_err());
}

#[test]
fn memory_authorization_requires_exact_saved_owner_and_valid_member_attestation() {
    let root = tempfile::tempdir().unwrap();
    let mut control = controller(root.path());
    let prepared = NewAgent::prepare("https://relay.example/", &owner()).unwrap();
    let auth = crate::secret::test_attestation(prepared.key.pubkey());
    control
        .create_bundle_member(
            &prepared,
            edit(root.path()),
            &auth,
            "memory-owner",
            &BundleMember {
                team: "team-a".into(),
                member: member(),
                instructions: "TEAM".into(),
                keep_allowlist: false,
            },
        )
        .unwrap();
    assert_eq!(
        control
            .team_member_authorization(&prepared.id, &owner())
            .unwrap(),
        auth
    );
    assert!(control
        .verify_team_member_owner(&prepared.id, &"ab".repeat(32))
        .is_err());
    assert!(control
        .team_member_authorization(&prepared.id, &"ab".repeat(32))
        .is_err());
    assert!(control
        .team_member_authorization("missing", &owner())
        .is_err());
    let mut saved = control.store.agents().unwrap();
    saved[0].auth_tag = Some(json!(["auth", owner(), "", "invalid-signature"]).to_string());
    std::fs::write(
        root.path().join("store/agents.json"),
        serde_json::to_vec(&json!({"version": 1, "agents": saved})).unwrap(),
    )
    .unwrap();
    drop(control);
    let control = controller(root.path());
    assert!(control
        .team_member_authorization(&prepared.id, &owner())
        .is_err());
}

fn catalog(created_at: u64, members: Vec<String>) -> crate::TeamCatalogEntry {
    crate::TeamCatalogEntry {
        created_at,
        event_id: format!("{created_at:064x}"),
        members,
    }
}

#[test]
fn late_catalog_read_cannot_release_a_newer_binding_even_after_reopen() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), json!({}));
    let me = vec![agent.pubkey.clone()];
    sync(
        &mut control,
        &[("team-a", 2, me.clone())],
        &[("team-a", "SHARED")],
    )
    .unwrap();
    drop(control);
    let mut control = controller(root.path());
    // An older roster read that finishes late is refused and changes nothing.
    let late = sync(
        &mut control,
        &[("team-a", 1, vec![])],
        &[("team-a", "SHARED")],
    );
    assert!(late.is_err_and(|error| error.contains("Team catalog changed")));
    let saved = control.store.agents().unwrap().remove(0);
    assert_eq!(saved.imported["teamBindings"], json!(["team-a"]));
    assert_eq!(saved.imported["teamInstructions"], "SHARED");
    // Same timestamp uses the NIP-01 lower-event-ID winner; a late loser is refused.
    let texts = std::collections::BTreeMap::from([("team-a".to_string(), "SHARED".to_string())]);
    let mut winner = catalog(2, me.clone());
    winner.event_id = "00".repeat(32);
    let winner = std::collections::BTreeMap::from([("team-a".to_string(), winner)]);
    control
        .sync_team_instructions("wss://relay.example", &owner(), &winner, &texts)
        .unwrap();
    assert!(sync(&mut control, &[("team-a", 2, me)], &[("team-a", "SHARED")]).is_err());
    // Another owner's sync never touches this owner's agent.
    let other = std::collections::BTreeMap::from([("team-a".to_string(), "OTHER".to_string())]);
    control
        .sync_team_instructions("wss://relay.example", &"ab".repeat(32), &winner, &other)
        .unwrap();
    assert_eq!(control.store.agents().unwrap()[0].imported, saved.imported);
}

fn synced_agent(
    root: &std::path::Path,
    imported: serde_json::Value,
) -> (Controller, crate::config::Agent) {
    let mut control = controller(root);
    let mut agent = crate::store::tests::fixture();
    agent.auth_tag = Some(crate::secret::test_attestation(&agent.pubkey));
    agent.imported = imported;
    control.store.insert(vec![agent.clone()]).unwrap();
    (control, agent)
}
fn sync(
    control: &mut Controller,
    rosters: &[(&str, u64, Vec<String>)],
    texts: &[(&str, &str)],
) -> Result<crate::config::Agent> {
    let heads = rosters
        .iter()
        .map(|(team, at, members)| (team.to_string(), catalog(*at, members.clone())))
        .collect();
    let texts = texts
        .iter()
        .map(|(team, text)| (team.to_string(), text.to_string()))
        .collect();
    control.sync_team_instructions("wss://relay.example", &owner(), &heads, &texts)?;
    Ok(control.store.agents().unwrap().remove(0))
}

#[test]
fn team_sync_binds_writes_and_clears_text_without_counting_empty_teams() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), serde_json::Value::Null);
    let me = vec![agent.pubkey.clone()];
    // Link repair: the only team with text that lists the agent binds it.
    let saved = sync(
        &mut control,
        &[("crew", 1, me.clone()), ("mentions", 1, me.clone())],
        &[("crew", " SHARED\n"), ("mentions", "")],
    )
    .unwrap();
    assert_eq!(saved.imported["teamBindings"], serde_json::json!(["crew"]));
    assert_eq!(saved.imported["teamInstructions"], "SHARED");
    assert_eq!(saved.revision, agent.revision + 1);
    // Unchanged text and a second team with identical text write no revision.
    let same = sync(
        &mut control,
        &[("crew", 1, me.clone()), ("pair", 1, me.clone())],
        &[("crew", "SHARED"), ("pair", "SHARED")],
    )
    .unwrap();
    assert_eq!(
        same.imported["teamBindings"],
        serde_json::json!(["crew", "pair"])
    );
    assert_eq!(same.revision, saved.revision);
    // Removal from the last team with text clears the copy and the binding.
    let cleared = sync(
        &mut control,
        &[
            ("crew", 2, vec![]),
            ("pair", 2, vec![]),
            ("mentions", 1, me),
        ],
        &[("crew", "SHARED"), ("pair", "SHARED"), ("mentions", "")],
    )
    .unwrap();
    assert_eq!(cleared.imported["teamBindings"], serde_json::json!([]));
    assert_eq!(cleared.imported["teamInstructions"], "");
    assert_eq!(cleared.revision, same.revision + 1);
}

#[test]
fn team_sync_releases_deleted_teams_sent_as_empty_text() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), serde_json::Value::Null);
    let me = vec![agent.pubkey.clone()];
    sync(
        &mut control,
        &[("crew", 1, me.clone()), ("pair", 1, me.clone())],
        &[("crew", "SHARED"), ("pair", "SHARED")],
    )
    .unwrap();
    // A deleted team arrives with the empty roster of its tombstone and no
    // text. The surviving team with identical text keeps the copy.
    let kept = sync(
        &mut control,
        &[("crew", 2, vec![]), ("pair", 1, me)],
        &[("crew", ""), ("pair", "SHARED")],
    )
    .unwrap();
    assert_eq!(kept.imported["teamBindings"], serde_json::json!(["pair"]));
    assert_eq!(kept.imported["teamInstructions"], "SHARED");
    // Deleting the last team with text clears it.
    let cleared = sync(
        &mut control,
        &[("crew", 2, vec![]), ("pair", 2, vec![])],
        &[("crew", ""), ("pair", "")],
    )
    .unwrap();
    assert_eq!(cleared.imported["teamBindings"], serde_json::json!([]));
    assert_eq!(cleared.imported["teamInstructions"], "");
}

#[test]
fn team_sync_refuses_conflicts_and_keeps_unreadable_teams() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), serde_json::Value::Null);
    let me = vec![agent.pubkey.clone()];
    let saved = sync(
        &mut control,
        &[("crew", 1, me.clone())],
        &[("crew", "SHARED")],
    )
    .unwrap();
    let error = sync(
        &mut control,
        &[("crew", 1, me.clone()), ("other", 1, me.clone())],
        &[("crew", "SHARED"), ("other", "DIFFERENT")],
    )
    .err()
    .unwrap();
    assert!(error.contains("crew") && error.contains("other"), "{error}");
    assert_eq!(control.store.agents().unwrap()[0].revision, saved.revision);
    // A team the app could not read is left out: binding and text survive.
    let kept = sync(&mut control, &[("crew", 1, me)], &[]).unwrap();
    assert_eq!(kept.imported["teamBindings"], serde_json::json!(["crew"]));
    assert_eq!(kept.imported["teamInstructions"], "SHARED");
}

#[test]
fn team_sync_keeps_unbound_legacy_text_until_a_team_with_text_claims_it() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(
        root.path(),
        serde_json::json!({"teamInstructions": "LEGACY"}),
    );
    let me = vec![agent.pubkey.clone()];
    let untouched = sync(
        &mut control,
        &[("mentions", 1, me.clone())],
        &[("mentions", "")],
    )
    .unwrap();
    assert_eq!(untouched.imported, agent.imported);
    let adopted = sync(
        &mut control,
        &[("crew", 1, me.clone())],
        &[("crew", " LEGACY ")],
    )
    .unwrap();
    assert_eq!(
        adopted.imported["teamBindings"],
        serde_json::json!(["crew"])
    );
    assert_eq!(adopted.revision, agent.revision);
    // A team with different text replaces the imported copy.
    let other = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(
        other.path(),
        serde_json::json!({"teamInstructions": "LEGACY"}),
    );
    let replaced = sync(&mut control, &[("crew", 1, me)], &[("crew", "NEW")]).unwrap();
    assert_eq!(replaced.imported["teamInstructions"], "NEW");
    assert_eq!(replaced.revision, agent.revision + 1);
}

#[test]
fn refused_team_sync_leaves_the_saved_document_byte_for_byte() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), serde_json::Value::Null);
    let me = vec![agent.pubkey.clone()];
    sync(
        &mut control,
        &[("crew", 1, me.clone()), ("old", 1, me.clone())],
        &[("crew", "SHARED"), ("old", "SHARED")],
    )
    .unwrap();
    let saved = root.path().join("store/agents.json");
    let before = std::fs::read(&saved).unwrap();
    // A newer roster that would drop "old" and new heads would be staged, but
    // the conflict refuses the whole sync.
    assert!(sync(
        &mut control,
        &[
            ("crew", 2, me.clone()),
            ("old", 2, vec![]),
            ("other", 1, me)
        ],
        &[
            ("crew", "SHARED"),
            ("old", "SHARED"),
            ("other", "DIFFERENT")
        ],
    )
    .is_err());
    assert_eq!(std::fs::read(&saved).unwrap(), before);
}

#[test]
fn unreadable_team_keeps_link_and_text_when_its_roster_drops_the_agent() {
    let root = tempfile::tempdir().unwrap();
    let (mut control, agent) = synced_agent(root.path(), serde_json::Value::Null);
    let me = vec![agent.pubkey.clone()];
    sync(&mut control, &[("crew", 1, me)], &[("crew", "SHARED")]).unwrap();
    let kept = sync(&mut control, &[("crew", 2, vec![])], &[]).unwrap();
    assert_eq!(kept.imported["teamBindings"], serde_json::json!(["crew"]));
    assert_eq!(kept.imported["teamInstructions"], "SHARED");
}
