use crate::config::Agent;
use crate::Result;
use serde_json::Value;

/// Native-only snapshot of the exact deployment team, not a team runtime or
/// membership/invitation capability. No source lookup happens during Start.
pub(crate) fn team_id(record: &Value) -> Result<Option<&str>> {
    match record.get("team_id") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if id.is_empty() => Ok(None),
        Some(Value::String(id)) if id.len() <= 256 && !id.contains('\0') => Ok(Some(id)),
        _ => Err("Invalid imported team binding".into()),
    }
}

pub(crate) fn validate_team(team: &Value, id: &str) -> Result<()> {
    if team.get("id").and_then(Value::as_str) != Some(id) {
        return Err("Imported team snapshot does not match the saved binding".into());
    }
    if !team["source_dir"].is_null()
        || team["is_symlink"].as_bool() == Some(true)
        || !team["symlink_target"].is_null()
    {
        return Err("Directory-backed team imports are not supported".into());
    }
    match team.get("instructions") {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(value)) if value.len() <= 128 * 1024 && !value.contains('\0') => Ok(()),
        _ => Err("Invalid imported team instructions".into()),
    }
}

pub(crate) fn required(agent: &Agent) -> bool {
    team_id(&agent.imported["record"]).ok().flatten().is_some()
        && agent.imported.get("team").is_none()
}

pub(crate) fn instructions(agent: &Agent) -> Result<Option<&str>> {
    let Some(id) = team_id(&agent.imported["record"])? else {
        return Ok(None);
    };
    let team = agent.imported.get("team").ok_or(
        "Complete this agent's team import from the chosen old Buzz library before starting",
    )?;
    validate_team(team, id)?;
    Ok(team["instructions"]
        .as_str()
        .map(str::trim)
        .filter(|text| !text.is_empty()))
}
