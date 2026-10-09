use super::*;
use crate::{Credentials, Imports, Secret, Store};
use serde_json::json;
use std::{path::Path, sync::Arc};

struct NoCredentials;
impl Credentials for NoCredentials {
    fn read(&self, _: &str, _: &str) -> Result<Option<Secret>> {
        panic!("team migration must not read keys")
    }
    fn read_legacy(&self, _: LegacySource, _: &str) -> Result<Secret> {
        panic!("team migration must not read legacy keys")
    }
    fn add(&self, _: &str, _: &Secret) -> Result<()> {
        panic!("team migration must not write keys")
    }
    fn delete(&self, _: &str, _: &str) -> Result<()> {
        panic!("team migration must not delete keys")
    }
}
const RELAY: &str = "wss://relay.example";
fn owner() -> String {
    let tag: Vec<String> =
        serde_json::from_str(&crate::secret::test_attestation(&"ab".repeat(32))).unwrap();
    tag[1].clone()
}
fn beta(status: &str, text: &str) -> Value {
    json!({"sourceId": "crew", "teamId": beta_team_id("crew"), "name": "Crew",
        "existed": true, "source": "installed", "betaText": text, "status": status})
}
fn agent(key: &str, imported: Value) -> Agent {
    let mut agent = crate::store::tests::fixture();
    agent.pubkey = key.repeat(32);
    agent.id = crate::config::agent_id(&agent.pubkey, RELAY);
    agent.credential_id = agent.id.clone();
    agent.auth_tag = Some(crate::secret::test_attestation(&agent.pubkey));
    agent.imported = imported;
    agent
}
fn controller(root: &Path, agents: Vec<Agent>) -> Controller {
    let mut control = Controller::new(
        Store::open(root.join("store")).unwrap(),
        Arc::new(NoCredentials),
        Err("No fixture runtime".into()),
        root.join("ownership"),
    );
    control.store.insert(agents).unwrap();
    control
}
fn heads(rosters: &[(&str, Vec<&Agent>)]) -> BTreeMap<String, TeamCatalogEntry> {
    rosters
        .iter()
        .map(|(team, members)| {
            let members: Vec<String> = members.iter().map(|a| a.pubkey.clone()).collect();
            // Each distinct roster is a later head.
            let entry = TeamCatalogEntry {
                created_at: 1 + members.len() as u64,
                event_id: format!("{:x}", Sha256::digest(format!("{team}{members:?}"))),
                members,
            };
            (team.to_string(), entry)
        })
        .collect()
}
fn texts(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(team, text)| (team.to_string(), text.to_string()))
        .collect()
}
fn saved(control: &Controller, id: &str) -> Agent {
    control
        .store
        .agents()
        .unwrap()
        .into_iter()
        .find(|a| a.id == id)
        .unwrap()
}
fn finish(
    control: &mut Controller,
    agent: &Agent,
    outcome: BetaTeamStatus,
    heads: &BTreeMap<String, TeamCatalogEntry>,
    texts: &BTreeMap<String, String>,
) -> Result<()> {
    let revision = saved(control, &agent.id).revision;
    control.finish_beta_team(
        &Imports::default(),
        &agent.id,
        revision,
        outcome,
        RELAY,
        &owner(),
        heads,
        texts,
        None,
    )
}

#[test]
fn beta_team_ids_are_valid_distinct_one_point_oh_ids() {
    let welcome = beta_team_id("builtin-team:welcome");
    let fizz = beta_team_id("builtin-team:fizz");
    assert_ne!(welcome, fizz);
    assert_eq!(fizz, beta_team_id("builtin-team:fizz"));
    for id in [welcome, fizz, beta_team_id("0b9f7c1e-uuid")] {
        assert_eq!(id.len(), 69);
        assert!(id.starts_with("beta-"));
        assert!(id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b)));
    }
    assert_eq!(team_name("  "), FALLBACK_NAME);
    assert_eq!(team_name(&"é".repeat(130)).chars().count(), 120);
}

#[test]
fn finishing_binds_without_replacing_existing_bindings_and_delivers_once() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = json!({"teamInstructions": "BETA", "teamBindings": ["other"]});
    imported[KEY] = beta("pending", "BETA");
    let me = agent("ab", imported);
    let mut control = controller(root.path(), vec![me.clone()]);
    let team = beta_team_id("crew");
    let heads = heads(&[(&team, vec![&me]), ("other", vec![])]);
    let texts = texts(&[(&team, "BETA")]);
    finish(&mut control, &me, BetaTeamStatus::Completed, &heads, &texts).unwrap();
    let done = saved(&control, &me.id);
    assert_eq!(done.imported["teamBindings"], json!(["other", team]));
    assert_eq!(done.imported["teamInstructions"], "BETA");
    assert_eq!(done.imported[KEY]["status"], "completed");
    assert_eq!(done.revision, me.revision);
    // A rerun of the team step finishing an already finished agent is a no-op.
    finish(&mut control, &me, BetaTeamStatus::Completed, &heads, &texts).unwrap();
    assert_eq!(saved(&control, &me.id).imported, done.imported);
    assert_eq!(
        control.snapshot().unwrap().agents[0].beta_team,
        Some(BetaTeamView {
            team_id: team,
            name: "Crew".into(),
            status: BetaTeamStatus::Completed
        })
    );
}

#[test]
fn removed_or_unreadable_member_stays_pending_without_a_write() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = json!({"teamInstructions": "BETA"});
    imported[KEY] = beta("pending", "BETA");
    let me = agent("ab", imported);
    let mut control = controller(root.path(), vec![me.clone()]);
    let team = beta_team_id("crew");
    let saved_file = root.path().join("store/agents.json");
    let before = std::fs::read(&saved_file).unwrap();
    // Removed from the roster just before finishing.
    let removed = finish(
        &mut control,
        &me,
        BetaTeamStatus::Completed,
        &heads(&[(&team, vec![])]),
        &texts(&[(&team, "BETA")]),
    );
    assert!(removed.unwrap_err().contains("doesn't list"));
    // Listed, but its text couldn't be read.
    assert!(finish(
        &mut control,
        &me,
        BetaTeamStatus::Completed,
        &heads(&[(&team, vec![&me])]),
        &texts(&[]),
    )
    .is_err());
    // A live team that lists the agent is not a deleted team.
    assert!(finish(
        &mut control,
        &me,
        BetaTeamStatus::Skipped,
        &heads(&[(&team, vec![&me])]),
        &texts(&[(&team, "BETA")]),
    )
    .is_err());
    // Stale revision.
    assert!(control
        .finish_beta_team(
            &Imports::default(),
            &me.id,
            me.revision + 1,
            BetaTeamStatus::Completed,
            RELAY,
            &owner(),
            &heads(&[(&team, vec![&me])]),
            &texts(&[(&team, "BETA")]),
            None,
        )
        .is_err());
    assert_eq!(std::fs::read(&saved_file).unwrap(), before);
}

#[test]
fn a_cleared_team_is_not_refilled_and_a_deleted_team_is_skipped() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = json!({"teamInstructions": "BETA"});
    imported[KEY] = beta("pending", "BETA");
    let cleared = agent("ab", imported.clone());
    let deleted = agent("cd", imported);
    let mut control = controller(root.path(), vec![cleared.clone()]);
    let team = beta_team_id("crew");
    // The owner cleared the team's text: the empty head wins over beta text.
    finish(
        &mut control,
        &cleared,
        BetaTeamStatus::Completed,
        &heads(&[(&team, vec![&cleared])]),
        &texts(&[(&team, "")]),
    )
    .unwrap();
    let done = saved(&control, &cleared.id);
    assert_eq!(done.imported["teamInstructions"], "");
    assert_eq!(done.imported[KEY]["status"], "completed");
    assert_eq!(done.imported[KEY]["betaText"], "BETA");
    // The owner deleted the team: it stays deleted and beta text stops.
    let other = tempfile::tempdir().unwrap();
    let mut control = controller(other.path(), vec![deleted.clone()]);
    finish(
        &mut control,
        &deleted,
        BetaTeamStatus::Skipped,
        &heads(&[(&team, vec![])]),
        &texts(&[(&team, "")]),
    )
    .unwrap();
    let skipped = saved(&control, &deleted.id);
    assert_eq!(skipped.imported[KEY]["status"], "skipped");
    assert_eq!(skipped.imported["teamBindings"], json!([]));
    assert_eq!(skipped.imported["teamInstructions"], "");
}

#[test]
fn team_sync_never_changes_beta_text_and_pending_teams_group_by_owner_and_relay() {
    let root = tempfile::tempdir().unwrap();
    let mut imported = json!({"teamInstructions": "BETA"});
    imported[KEY] = beta("pending", "BETA");
    let first = agent("ab", imported.clone());
    let second = agent("cd", imported.clone());
    let mut foreign = agent("ef", imported);
    foreign.auth_tag = Some(json!(["auth", "12".repeat(32), "", "sig"]).to_string());
    let mut control = controller(root.path(), vec![first.clone(), second.clone(), foreign]);
    let pending = control.pending_beta_teams(RELAY, &owner()).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].texts, vec!["BETA".to_owned()]);
    assert_eq!(
        pending[0].members.iter().map(|m| &m.id).collect::<Vec<_>>(),
        vec![&first.id, &second.id]
    );
    assert!(control
        .pending_beta_teams("wss://other.example", &owner())
        .unwrap()
        .is_empty());
    control
        .sync_team_instructions(
            RELAY,
            &owner(),
            &heads(&[("unrelated", vec![&first])]),
            &texts(&[("unrelated", "NEW")]),
        )
        .unwrap();
    let synced = saved(&control, &first.id);
    assert_eq!(synced.imported["teamInstructions"], "NEW");
    assert_eq!(synced.imported[KEY]["betaText"], "BETA");
}

fn legacy(root: &Path, members: &[&Agent], teams: Value) {
    let dir = root
        .join(LegacySource::Installed.app_directory())
        .join("agents");
    std::fs::create_dir_all(&dir).unwrap();
    let records: Vec<Value> = members
        .iter()
        .map(|a| json!({"pubkey": a.pubkey, "name": a.name, "team_id": "crew"}))
        .collect();
    std::fs::write(
        dir.join("managed-agents.json"),
        serde_json::to_vec(&records).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.join("teams.json"), serde_json::to_vec(&teams).unwrap()).unwrap();
}
fn older(key: &str, text: &str) -> Agent {
    agent(
        key,
        json!({"record": {"team_id": "crew"}, "teamInstructions": text}),
    )
}

#[test]
fn restore_reads_old_buzz_and_starts_migration_through_finish() {
    let root = tempfile::tempdir().unwrap();
    let first = older("ab", "BETA");
    let second = older("cd", "BETA");
    legacy(
        root.path(),
        &[&first, &second],
        json!([{"id": "crew", "name": "Crew", "instructions": "  BETA  "}]),
    );
    let mut control = controller(root.path(), vec![first.clone(), second.clone()]);
    let mut imports = Imports::default();
    let ids = [first.id.clone(), second.id.clone()];
    let preview = control
        .restore_beta_teams_preview(
            &mut imports,
            LegacySource::Installed,
            root.path().into(),
            &ids,
        )
        .unwrap();
    let [group] = preview.groups.as_slice() else {
        panic!("one group")
    };
    assert!(!group.inferred);
    assert_eq!(group.name, "Crew");
    assert_eq!(group.texts, vec!["BETA".to_owned()]);
    assert_eq!(group.team_id, beta_team_id("crew"));
    let team = group.team_id.clone();
    let finish_with = |control: &mut Controller, text: &str| {
        control.finish_beta_team(
            &imports,
            &first.id,
            first.revision,
            BetaTeamStatus::Completed,
            RELAY,
            &owner(),
            &heads(&[(&team, vec![&first, &second])]),
            &texts(&[(&team, "BETA")]),
            Some(&RestoreChoice {
                token: preview.token.clone(),
                text: text.into(),
            }),
        )
    };
    assert!(finish_with(&mut control, "OTHER").is_err());
    finish_with(&mut control, "BETA").unwrap();
    let done = saved(&control, &first.id);
    assert_eq!(done.imported[KEY]["status"], "completed");
    assert_eq!(done.imported[KEY]["existed"], true);
    assert_eq!(done.imported[KEY]["source"], "installed");
    assert_eq!(done.imported["teamBindings"], json!([team]));
    // Once started, the same restore can't initialize it again.
    assert!(finish_with(&mut control, "BETA").is_err());
}

#[test]
fn restore_infers_without_old_buzz_and_never_offers_an_empty_inferred_group() {
    let root = tempfile::tempdir().unwrap();
    let first = older("ab", "ONE");
    let second = older("cd", "TWO");
    let mut bound = older("ef", "FROM 1.0");
    bound.imported["teamBindings"] = json!(["other"]);
    let empty = agent(
        "12",
        json!({"record": {"team_id": "gone"}, "teamInstructions": ""}),
    );
    let control = controller(
        root.path(),
        vec![first.clone(), second.clone(), bound.clone(), empty.clone()],
    );
    let ids = [
        first.id.clone(),
        second.id.clone(),
        bound.id.clone(),
        empty.id.clone(),
    ];
    let preview = control
        .restore_beta_teams_preview(
            &mut Imports::default(),
            LegacySource::Installed,
            root.path().into(),
            &ids,
        )
        .unwrap();
    let [group] = preview.groups.as_slice() else {
        panic!("only the crew group")
    };
    assert!(group.inferred);
    assert_eq!(group.name, FALLBACK_NAME);
    // Two members disagree; the user picks. A copy bound to a 1.0 team isn't beta text.
    assert_eq!(group.texts, vec!["ONE".to_owned(), "TWO".to_owned()]);
    assert_eq!(group.members.len(), 3);
}

#[test]
fn restore_offers_a_real_empty_beta_team_and_skips_a_deleted_one() {
    let root = tempfile::tempdir().unwrap();
    let first = older("ab", "");
    legacy(
        root.path(),
        &[&first],
        json!([{"id": "crew", "name": "Crew"}]),
    );
    let control = controller(root.path(), vec![first.clone()]);
    let preview = control
        .restore_beta_teams_preview(
            &mut Imports::default(),
            LegacySource::Installed,
            root.path().into(),
            std::slice::from_ref(&first.id),
        )
        .unwrap();
    assert_eq!(preview.groups[0].texts, vec![String::new()]);
    assert!(!preview.groups[0].inferred);
    legacy(root.path(), &[&first], json!([]));
    assert!(control
        .restore_beta_teams_preview(
            &mut Imports::default(),
            LegacySource::Installed,
            root.path().into(),
            std::slice::from_ref(&first.id),
        )
        .unwrap()
        .groups
        .is_empty());
}
