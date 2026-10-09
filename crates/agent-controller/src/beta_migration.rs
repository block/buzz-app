//! Teams carried over from old Buzz. Each imported agent keeps its beta team in
//! `imported.betaTeam`; there is no per-team record. The app's team step reads
//! the current catalog and fills in what is missing, so a rerun is harmless.
//! `betaText` is written once and never touched by team sync.
use crate::{config::Agent, Controller, LegacySource, Result, TeamCatalogEntry};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub(crate) const KEY: &str = "betaTeam";
const NAME_LIMIT: usize = 120;
pub(crate) const FALLBACK_NAME: &str = "Team from old Buzz";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BetaTeamStatus {
    Pending,
    Completed,
    Skipped,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BetaTeam {
    pub source_id: String,
    pub team_id: String,
    pub name: String,
    /// `None` when old Buzz could not be read and the team was inferred.
    pub existed: Option<bool>,
    pub source: Option<LegacySource>,
    pub beta_text: String,
    pub status: BetaTeamStatus,
}
impl BetaTeam {
    pub(crate) fn read(agent: &Agent) -> Result<Option<Self>> {
        match agent.imported.get(KEY) {
            None | Some(Value::Null) => Ok(None),
            Some(raw) => serde_json::from_value(raw.clone())
                .map(Some)
                .map_err(|_| "Invalid saved team from old Buzz".into()),
        }
    }
    pub(crate) fn view(&self) -> BetaTeamView {
        BetaTeamView {
            team_id: self.team_id.clone(),
            name: self.name.clone(),
            status: self.status,
        }
    }
}
/// What the app may show about an agent's beta team. Never the text.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BetaTeamView {
    pub team_id: String,
    pub name: String,
    pub status: BetaTeamStatus,
}

/// The 1.0 team ID for a beta team ID. Hashing every ID, built-in ones
/// included, always yields a valid, collision-resistant 1.0 ID.
pub fn beta_team_id(source_id: &str) -> String {
    format!("beta-{:x}", Sha256::digest(source_id.as_bytes()))
}
pub(crate) fn valid_source_id(source_id: &str) -> bool {
    !source_id.is_empty() && source_id.len() <= 256 && !source_id.contains('\0')
}
pub(crate) fn team_name(raw: &str) -> String {
    let name = raw.trim();
    if name.is_empty() {
        return FALLBACK_NAME.into();
    }
    name.chars().take(NAME_LIMIT).collect()
}

/// Pending agents of one team, read by the app's team step.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingBetaTeam {
    pub team_id: String,
    pub name: String,
    /// Distinct beta texts of the members, normally one.
    pub texts: Vec<String>,
    pub members: Vec<BetaTeamMember>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BetaTeamMember {
    pub id: String,
    pub pubkey: String,
    pub revision: u64,
}

/// Read-only grouping of earlier imports that have no `betaTeam` yet.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub token: String,
    pub groups: Vec<RestoreGroup>,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreGroup {
    pub team_id: String,
    pub name: String,
    /// Old Buzz could not be read; the grouping comes from saved agent copies.
    pub inferred: bool,
    /// Candidate team texts; the user picks one when there are several.
    pub texts: Vec<String>,
    pub members: Vec<BetaTeamMember>,
    #[serde(skip)]
    pub(crate) source_id: String,
    #[serde(skip)]
    pub(crate) source: Option<LegacySource>,
}
/// The user's restore choice for one group.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreChoice {
    pub token: String,
    pub text: String,
}

impl Controller {
    pub fn pending_beta_teams(&self, community: &str, owner: &str) -> Result<Vec<PendingBetaTeam>> {
        let relay = crate::config::canonical_relay(community)?;
        let mut teams: BTreeMap<String, PendingBetaTeam> = BTreeMap::new();
        for agent in self.store.agents()? {
            let Some(beta) = BetaTeam::read(&agent)? else {
                continue;
            };
            if beta.status != BetaTeamStatus::Pending
                || agent.relay_url != relay
                || self.verify_team_member_owner(&agent.id, owner).is_err()
            {
                continue;
            }
            let team = teams
                .entry(beta.team_id.clone())
                .or_insert_with(|| PendingBetaTeam {
                    team_id: beta.team_id.clone(),
                    name: beta.name.clone(),
                    texts: Vec::new(),
                    members: Vec::new(),
                });
            if !team.texts.contains(&beta.beta_text) {
                team.texts.push(beta.beta_text);
            }
            team.members.push(BetaTeamMember {
                id: agent.id,
                pubkey: agent.pubkey,
                revision: agent.revision,
            });
        }
        Ok(teams.into_values().collect())
    }
    pub fn restore_beta_teams_preview(
        &self,
        imports: &mut crate::Imports,
        source: LegacySource,
        app_data_parent: std::path::PathBuf,
        ids: &[String],
    ) -> Result<RestorePreview> {
        imports.restore_preview(source, app_data_parent, ids, self.store.agents()?)
    }
    /// One native write per agent: bind it to its team, resolve every team's
    /// text on the same document, and record the outcome. `Completed` needs the
    /// team readable with the agent on it; `Skipped` needs a team that no
    /// longer lists it (a deleted team). Refusals leave the agent pending.
    #[allow(clippy::too_many_arguments)]
    pub fn finish_beta_team(
        &mut self,
        imports: &crate::Imports,
        id: &str,
        revision: u64,
        outcome: BetaTeamStatus,
        community: &str,
        owner: &str,
        heads: &BTreeMap<String, TeamCatalogEntry>,
        texts: &BTreeMap<String, String>,
        restore: Option<&RestoreChoice>,
    ) -> Result<()> {
        if texts.len() > 500 || texts.keys().any(|team| team.is_empty() || team.len() > 120) {
            return Err("Invalid team instructions".into());
        }
        self.verify_team_member_owner(id, owner)?;
        let relay = crate::config::canonical_relay(community)?;
        let init = restore
            .map(|choice| imports.restored(&choice.token, id, revision, &choice.text))
            .transpose()?;
        self.store
            .finish_beta_team(id, revision, outcome, (&relay, owner), heads, texts, init)
    }
}
#[cfg(test)]
mod tests;
