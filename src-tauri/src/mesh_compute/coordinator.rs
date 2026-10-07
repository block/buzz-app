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
    let Some((node, owner, owners, admitted_evidence)) = host
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
    // A successful membership read must take effect before optional status reads.
    let membership = match tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::read_membership(&identity, &community),
    )
    .await
    {
        Ok(Ok(events)) => events,
        result => {
            roster.observe(&owners, Observation::ReadFailed, false);
            return Err(match result {
                Ok(Err(error)) => error,
                _ => "Community membership read timed out".into(),
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
    let admitted_at = admitted_evidence
        .iter()
        .filter(|event| event.kind.as_u16() == 13534)
        .map(|event| event.created_at)
        .max();
    let observed_at = membership.iter().map(|event| event.created_at).max();
    if observed_at < admitted_at {
        return Err("Ignoring older Mesh membership snapshot".into());
    }
    let removed = !current_member_pubkeys(&membership).contains(&viewer);
    let retained_records = retained_evidence(&admitted_evidence, &membership);
    let mut retained = owner_ids_from_events(&retained_records);
    retained.push(owner.clone());
    if !removed && owners.iter().any(|id| !retained.contains(id)) {
        // Authoritative removal is not a liveness short-read. Stop the old admission
        // before trying optional discovery; a failed restart remains safely stopped.
        host.lifecycle
            .stop_and_wait()
            .await
            .map_err(|e| e.to_string())?;
        // Restart only with retained admission; failed status discovery cannot widen it.
        let targets = availability_from_events(retained_records.clone()).serve_targets;
        return super::start_with_evidence(
            app,
            &host,
            &identity,
            &lease,
            retained,
            targets,
            retained_records,
        )
        .await;
    }
    if removed {
        host.lease.revoke(&lease)?;
        app.state::<crate::agents::AgentHost>()
            .stop_mesh_consumers()
            .await?;
        host.lifecycle
            .stop_and_wait()
            .await
            .map_err(|e| e.to_string())?;
        return Err("Community membership was removed; shared compute has stopped".into());
    }
    let events = tokio::time::timeout(
        Duration::from_secs(10),
        super::discovery::read_events(&identity, &community),
    )
    .await
    .map_err(|_| "Community status discovery timed out")??;
    // A second status read cannot roll back the separately verified roster.
    let events = retained_evidence(&events, &membership);
    if check_roster {
        let mut fresh = owner_ids_from_events(&events);
        fresh.push(owner.clone());
        let observation = Observation::Members(fresh);
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

// Reuse only previously verified owner bindings; new admission needs full discovery.
fn retained_evidence(
    admitted: &[nostr::event::Event],
    membership: &[nostr::event::Event],
) -> Vec<nostr::event::Event> {
    let members = current_member_pubkeys(membership);
    membership
        .iter()
        .filter(|event| event.kind.as_u16() == 13534)
        .chain(admitted.iter().filter(|event| {
            event.kind.as_u16() != 13534 && members.contains(&event.pubkey.to_hex())
        }))
        .cloned()
        .collect()
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
    fn fresh_membership_revokes_captured_owner_without_status_and_never_admits_new_owner() {
        use nostr::{
            event::{EventBuilder, FinalizeEvent, Kind, Tag},
            key::Keys,
        };
        let relay = Keys::generate();
        let a = Keys::generate();
        let b = Keys::generate();
        let new = Keys::generate();
        let dir = tempfile::tempdir().unwrap();
        let owner_a =
            buzz_mesh_compute::identity::load_owner_at(&dir.path().join("a.json")).unwrap();
        let owner_b =
            buzz_mesh_compute::identity::load_owner_at(&dir.path().join("b.json")).unwrap();
        let roster =
            |members: &[&Keys]| {
                EventBuilder::new(Kind::Custom(13534), "")
                    .tags(members.iter().map(|member| {
                        Tag::parse(["member", &member.public_key().to_hex()]).unwrap()
                    }))
                    .finalize(&relay)
                    .unwrap()
            };
        let status = |member: &Keys, owner| {
            buzz_mesh_compute::publication::status_event(
                owner,
                &member.public_key().to_hex(),
                false,
                None,
                None,
                None,
            )
            .unwrap()
            .finalize(member)
            .unwrap()
        };
        let admitted = vec![
            roster(&[&a, &b]),
            status(&a, &owner_a),
            status(&b, &owner_b),
        ];
        let membership = vec![roster(&[&a, &new])];
        // Optional advertisements are unavailable: only captured bindings are present.
        let retained = retained_evidence(&admitted, &membership);
        assert_eq!(owner_ids_from_events(&retained), vec![owner_a.owner_id()]);
        assert!(!retained.iter().any(|event| event.pubkey == b.public_key()));
        assert_eq!(current_member_pubkeys(&retained).len(), 2);
    }

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
