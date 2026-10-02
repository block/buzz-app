//! One app-owned publisher; no public Nostr discovery or raw SDK payload forwarding.
use buzz_mesh_compute::{identity::load_owner_at, lifecycle::Phase, publication};
use std::time::Duration;
use tauri::Manager;

const INTERVAL: Duration = Duration::from_secs(45);
const TIMEOUT: Duration = Duration::from_secs(10);

pub(super) fn ensure_started(app: tauri::AppHandle, host: &super::MeshHost) -> Result<(), String> {
    let mut task = host
        .publisher
        .lock()
        .map_err(|_| "Mesh publisher unavailable")?;
    if task
        .as_ref()
        .is_some_and(|task| !task.inner().is_finished())
    {
        return Ok(());
    }
    *task = Some(tauri::async_runtime::spawn(async move {
        let mut previous: Option<(String, String)> = None;
        loop {
            heartbeat(publish(&app, &mut previous)).await;
        }
    }));
    Ok(())
}

// Classic cadence is 45 seconds after each bounded publication attempt.
async fn heartbeat(operation: impl std::future::Future<Output = Result<(), String>>) {
    match tokio::time::timeout(TIMEOUT, operation).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Mesh status publication failed: {error}"),
        Err(_) => eprintln!("Mesh status publication timed out"),
    }
    tokio::time::sleep(INTERVAL).await;
}

fn needs_stop_note(previous: &(String, String), selected: Option<&str>, viewer: &str) -> bool {
    selected != Some(previous.0.as_str()) && previous.1 == viewer
}

async fn publish(
    app: &tauri::AppHandle,
    previous: &mut Option<(String, String)>,
) -> Result<(), String> {
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::identity::IdentityHost>();
    let selection = host.lease.current()?;
    let viewer = identity.viewer().await?;
    // Clear the old coordinate when leaving a community, using its captured signer.
    // If identity changed, never sign an old member's stopped note as the new member.
    if let Some((community, member)) = previous.as_ref() {
        if needs_stop_note(
            &(community.clone(), member.clone()),
            selection.as_ref().map(|(_, current)| current.as_str()),
            &viewer,
        ) {
            send(&identity, community, member, None).await?;
            *previous = None;
        }
    }
    let Some((lease, community)) = selection else {
        return Ok(());
    };
    let status = if host.lifecycle.phase() == Phase::Ready {
        Some(host.lifecycle.status().await.map_err(|e| e.to_string())?)
    } else {
        None
    };
    host.lease.community(&lease)?;
    if identity.viewer().await? != viewer {
        return Err("Identity changed during Mesh publication".into());
    }
    send(&identity, &community, &viewer, status.as_ref()).await?;
    *previous = Some((community, viewer));
    Ok(())
}

async fn send(
    identity: &crate::identity::IdentityHost,
    community: &str,
    member: &str,
    status: Option<&buzz_mesh_compute::lifecycle::NodeStatus>,
) -> Result<(), String> {
    let path = super::mesh_owner_path()?;
    let owner = tauri::async_runtime::spawn_blocking(move || {
        load_owner_at(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Mesh owner loading failed")??;
    // Serving is not yet exposed by the native host. Until its role is wired,
    // publish consumer bindings only; never infer hosting from peer model lists.
    let builder = match status {
        Some(status) => publication::sdk_status_event(&owner, member, false, status),
        None => publication::status_event(&owner, member, false, None, None),
    }
    .map_err(|e| e.to_string())?;
    let event = identity
        .sign(crate::identity::EventTemplate {
            kind: builder.kind.as_u16(),
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "System clock unavailable")?
                .as_secs(),
            tags: builder
                .tags
                .iter()
                .map(|tag| tag.as_slice().to_vec())
                .collect(),
            content: builder.content,
        })
        .await?;
    if event["pubkey"].as_str() != Some(member) {
        return Err("Identity changed during Mesh publication".into());
    }
    crate::relay::mesh_publish(identity, community, event).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn successful_publication_waits_45_seconds_before_next_attempt() {
        let (started, observed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(heartbeat(async {
            started.send(()).unwrap();
            Ok(())
        }));
        observed.await.unwrap();
        tokio::time::advance(Duration::from_secs(44)).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.unwrap();
    }
    #[tokio::test(start_paused = true)]
    async fn timed_out_publication_is_dropped_at_10_seconds_then_waits_45() {
        struct Dropped(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        let (started, observed) = tokio::sync::oneshot::channel();
        let (dropped, mut drop_observed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(heartbeat(async move {
            let _guard = Dropped(Some(dropped));
            started.send(()).unwrap();
            std::future::pending::<Result<(), String>>().await
        }));
        observed.await.unwrap();
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(matches!(
            drop_observed.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        tokio::time::advance(Duration::from_secs(1)).await;
        drop_observed.await.unwrap();
        tokio::time::advance(Duration::from_secs(44)).await;
        assert!(!task.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        task.await.unwrap();
    }
    #[test]
    fn leaving_or_switching_community_sends_stop_only_for_the_same_member() {
        let previous = ("https://old.example".into(), "member".into());
        assert!(needs_stop_note(&previous, None, "member"));
        assert!(needs_stop_note(
            &previous,
            Some("https://new.example"),
            "member"
        ));
        assert!(!needs_stop_note(
            &previous,
            Some("https://old.example"),
            "member"
        ));
        assert!(!needs_stop_note(&previous, None, "other-member"));
    }
}
