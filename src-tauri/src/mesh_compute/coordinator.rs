//! Donor roster and peer-join duties, scoped to the app-owned node.
use buzz_mesh_compute::{
    discovery::{availability_from_events, current_member_pubkeys, owner_ids_from_events},
    lifecycle::Phase,
    roster::{Decision, Observation, Reconcile},
};
use std::time::Duration;
use tauri::Manager;

pub(super) fn ensure_started(app: tauri::AppHandle, host: &super::MeshHost) -> Result<(), String> {
    let mut task = host
        .coordinator
        .lock()
        .map_err(|_| "Mesh coordinator unavailable")?;
    if task
        .as_ref()
        .is_some_and(|task| !task.inner().is_finished())
    {
        return Ok(());
    }
    *task = Some(tauri::async_runtime::spawn(async move {
        let mut generation = None;
        let mut roster = Reconcile::default();
        let mut roster_at = tokio::time::Instant::now() + Duration::from_secs(60);
        let mut delay = Duration::from_secs(15);
        loop {
            tokio::time::sleep(delay).await;
            let check_roster = tokio::time::Instant::now() >= roster_at;
            if check_roster {
                roster_at = tokio::time::Instant::now() + Duration::from_secs(60);
            }
            match reconcile(&app, &mut generation, &mut roster, check_roster).await {
                Ok(()) => delay = Duration::from_secs(15),
                Err(error) => {
                    eprintln!("Mesh community reconciliation failed: {error}");
                    delay = (delay * 2).min(Duration::from_secs(120));
                }
            }
        }
    }));
    Ok(())
}

async fn reconcile(
    app: &tauri::AppHandle,
    generation: &mut Option<String>,
    roster: &mut Reconcile,
    check_roster: bool,
) -> Result<(), String> {
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::identity::IdentityHost>();
    let Some((lease, community)) = host.lease.current()? else {
        return Ok(());
    };
    if !matches!(host.lifecycle.phase(), Phase::Starting | Phase::Ready) {
        return Ok(());
    }
    let Some((node, owner, owners)) = host
        .admission
        .lock()
        .map_err(|_| "Mesh admission unavailable")?
        .clone()
    else {
        return Ok(());
    };
    if generation.as_ref() != Some(&node) {
        *generation = Some(node.clone());
        *roster = Reconcile::default();
    }
    let viewer = identity.viewer().await?;
    let events = match tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::read_events(&identity, &community),
    )
    .await
    {
        Ok(Ok(events)) => events,
        result => {
            roster.observe(&owners, Observation::ReadFailed, false);
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Community discovery timed out".into(),
            });
        }
    };
    // Serialize admission against Share, Stop, selection, and agent startup.
    let _guard = host.preparing.lock().await;
    host.lease.community(&lease)?;
    if identity.viewer().await? != viewer {
        return Err("Identity changed during Mesh reconciliation".into());
    }
    if host
        .admission
        .lock()
        .map_err(|_| "Mesh admission unavailable")?
        .as_ref()
        .map(|value| &value.0)
        != Some(&node)
    {
        return Ok(());
    }
    if !matches!(host.lifecycle.phase(), Phase::Starting | Phase::Ready) {
        return Ok(());
    }
    let removed = !current_member_pubkeys(&events).contains(&viewer);
    if removed || check_roster {
        let observation = if removed {
            Observation::ViewerRemoved
        } else {
            let mut fresh = owner_ids_from_events(&events);
            // Admission always includes this node's independently held owner.
            fresh.push(owner.clone());
            Observation::Members(fresh)
        };
        match roster.observe(
            &owners,
            observation,
            host.lifecycle.phase() == Phase::Starting,
        ) {
            Decision::ViewerRemoved => {
                host.lease.revoke(&lease)?;
                *host
                    .admission
                    .lock()
                    .map_err(|_| "Mesh admission unavailable")? = None;
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .set_error(
                        "Community membership was removed; shared compute has stopped".into(),
                    );
                host.lifecycle
                    .stop_and_wait()
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(());
            }
            Decision::Grow(_) | Decision::Shrink(_) => {
                // Keep saved sharing intent; this is not the user's Stop sharing.
                host.lifecycle
                    .stop_and_wait()
                    .await
                    .map_err(|e| e.to_string())?;
                let result = super::start_prepared(app, &host, &identity, &lease).await;
                if let Err(error) = &result {
                    host.preferences.lock().map_err(|_| "Mesh settings unavailable")?
                        .set_error(format!("Shared compute could not restart after membership changed: {error}. Reconnect to retry."));
                }
                return result;
            }
            Decision::Keep | Decision::AwaitConfirmation => {}
        }
    }
    if host.lifecycle.phase() != Phase::Ready {
        return Ok(());
    }
    let status = host.lifecycle.status().await.map_err(|e| e.to_string())?;
    let peers = visible_peer_ids(&status.payload);
    let availability = availability_from_events(events);
    let mut failure = None;
    for target in availability.serve_targets.into_iter().filter(|target| {
        target.owner_id.as_deref() != Some(owner.as_str())
            && !target_is_visible(target.endpoint_id.as_deref(), &peers)
    }) {
        host.lease.community(&lease)?;
        if let Err(error) = host.lifecycle.dial(&target.endpoint_addr) {
            failure = Some(error.to_string());
        }
    }
    failure.map_or(Ok(()), Err)
}

fn visible_peer_ids(payload: &serde_json::Value) -> Vec<String> {
    payload
        .get("peers")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|peer| peer.get("id").and_then(serde_json::Value::as_str))
        .map(|id| id.trim().to_ascii_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}
fn target_is_visible(endpoint: Option<&str>, peers: &[String]) -> bool {
    let Some(endpoint) = endpoint else {
        return false;
    };
    let endpoint = endpoint.trim().to_ascii_lowercase();
    !endpoint.is_empty()
        && peers.iter().any(|peer| {
            !peer.is_empty() && (endpoint.starts_with(peer) || peer.starts_with(&endpoint))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn donor_peer_shape_and_short_ids_are_preserved() {
        let peers = visible_peer_ids(
            &serde_json::json!({"peers":[{"id":" ABC123 "},{"id":"def456"},{"name":"ignored"}]}),
        );
        assert_eq!(peers, ["abc123", "def456"]);
        assert!(target_is_visible(Some("ABC1234567890"), &peers));
        assert!(!target_is_visible(Some("other"), &peers));
        assert!(!target_is_visible(Some("  "), &peers));
        assert!(!target_is_visible(None, &peers));
    }
}
