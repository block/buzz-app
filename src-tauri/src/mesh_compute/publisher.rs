//! One app-owned publisher; no public Nostr discovery or raw SDK payload forwarding.
use buzz_mesh_compute::{identity::load_owner_at, lifecycle::Phase, publication};
use std::time::Duration;
use tauri::Manager;

const INTERVAL: Duration = Duration::from_secs(45);

/// Serializes periodic publication and the immediate Share-Off withdrawal so an
/// in-flight serving snapshot can never be signed after the stopped note.
static PUBLISH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Last `created_at` signed for our replaceable status address.
static LAST_CREATED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Replaceable events resolve by `created_at` (whole seconds), so two notes signed
/// in the same second can tie. Under `PUBLISH`, each note is strictly newer than
/// the previous one, so a stopped note signed after a serving one always wins.
fn next_created_at(now: u64, last: &std::sync::atomic::AtomicU64) -> u64 {
    use std::sync::atomic::Ordering;
    let stamp = now.max(last.load(Ordering::SeqCst) + 1);
    last.store(stamp, Ordering::SeqCst);
    stamp
}
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

/// Publish while Mesh runs, plus exactly one stopped note for the run that just
/// ended in this same community. Nothing is published before first use.
fn should_publish(
    running: bool,
    previous: Option<&(String, String)>,
    community: &str,
    viewer: &str,
) -> bool {
    running || previous.is_some_and(|(c, v)| c == community && v == viewer)
}

fn needs_stop_note(previous: &(String, String), selected: Option<&str>, viewer: &str) -> bool {
    selected != Some(previous.0.as_str()) && previous.1 == viewer
}

async fn publish(
    app: &tauri::AppHandle,
    previous: &mut Option<(String, String)>,
) -> Result<(), String> {
    // Read state and sign under the same lock as withdrawal.
    let _serial = PUBLISH.lock().await;
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::identity::IdentityHost>();
    let selection = host.lease.current()?;
    let viewer = identity.viewer().await?;
    let retired = previous.clone().filter(|old| {
        needs_stop_note(
            old,
            selection.as_ref().map(|(_, current)| current.as_str()),
            &viewer,
        )
    });
    let Some((lease, community)) = selection else {
        *previous = None;
        if let Some((community, member)) = retired {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                send(&identity, &community, &member, false, None),
            )
            .await;
        }
        return Ok(());
    };
    // Enrollment follows legacy Buzz: the member↔owner binding is published only
    // once Mesh actually runs here (Share or a Mesh agent), never merely because
    // the plugin is enabled. After a run ends, one stopped note is published.
    let running = matches!(host.lifecycle.phase(), Phase::Starting | Phase::Ready);
    if !should_publish(running, previous.as_ref(), &community, &viewer) {
        // A replaced community's run still gets its bounded stopped note.
        if let Some((community, member)) = retired {
            *previous = None;
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                send(&identity, &community, &member, false, None),
            )
            .await;
        }
        return Ok(());
    }
    let status = if host.lifecycle.phase() == Phase::Ready {
        let mut status = host.lifecycle.status().await.map_err(|e| e.to_string())?;
        // Mesh's own catalog maps content-addressed GGUF keys to readable refs.
        if let Some(names) = display_names(&status.console_url).await {
            status.payload[publication::DISPLAY_NAMES_KEY] = names;
        }
        Some(status)
    } else {
        None
    };
    host.lease.community(&lease)?;
    if identity.viewer().await? != viewer {
        return Err("Identity changed during Mesh publication".into());
    }
    let serving = host.lifecycle.is_serving();
    send(&identity, &community, &viewer, serving, status.as_ref()).await?;
    // After the stopped note for a finished run, stay quiet until Mesh runs again.
    *previous = running.then_some((community, viewer));
    // Active-community publication takes priority; retirement cannot starve it.
    // Failed retirement is not retried: routing ignores advertisements after 120s.
    if let Some((community, member)) = retired {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            send(&identity, &community, &member, false, None),
        )
        .await;
    }
    Ok(())
}

/// Best-effort read of the local node's `/api/models`; publication never waits on it long.
pub(super) async fn display_names(console_url: &str) -> Option<serde_json::Value> {
    let response = reqwest::Client::new()
        .get(format!("{}/api/models", console_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(3))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let models: serde_json::Value = serde_json::from_slice(&response.bytes().await.ok()?).ok()?;
    Some(publication::display_names_from_models(&models))
}

/// Withdraw this member's serving advertisement right after Share Off, as legacy
/// `mesh_stop_node` did with `publish_stopped_status_once_at`. Best-effort and bounded;
/// the periodic publisher still follows up.
pub(super) async fn publish_stopped(
    identity: &crate::identity::IdentityHost,
    community: &str,
    member: &str,
) {
    let _serial = PUBLISH.lock().await;
    match tokio::time::timeout(
        Duration::from_secs(5),
        send(identity, community, member, false, None),
    )
    .await
    {
        Ok(Ok(())) => {}
        Ok(Err(error)) => eprintln!("Mesh stopped-status publication failed: {error}"),
        Err(_) => eprintln!("Mesh stopped-status publication timed out"),
    }
}

async fn send(
    identity: &crate::identity::IdentityHost,
    community: &str,
    member: &str,
    serving: bool,
    status: Option<&buzz_mesh_compute::lifecycle::NodeStatus>,
) -> Result<(), String> {
    let path = super::mesh_owner_path()?;
    let owner = tauri::async_runtime::spawn_blocking(move || {
        load_owner_at(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Mesh owner loading failed")??;
    let builder = match status {
        Some(status) => publication::sdk_status_event(&owner, member, serving, status),
        None => publication::status_event(&owner, member, false, None, None),
    }
    .map_err(|e| e.to_string())?;
    let event = identity
        .sign(crate::identity::EventTemplate {
            kind: builder.kind.as_u16(),
            created_at: next_created_at(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|_| "System clock unavailable")?
                    .as_secs(),
                &LAST_CREATED,
            ),
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

    #[test]
    fn a_stopped_note_signed_in_the_same_second_still_supersedes_serving() {
        let last = std::sync::atomic::AtomicU64::new(0);
        let serving = next_created_at(1_000, &last);
        // Off lands within the same wall-clock second as the held serving note.
        let stopped = next_created_at(1_000, &last);
        assert!(stopped > serving, "{stopped} must win over {serving}");
        // Clock going backwards cannot reorder later notes either.
        assert!(next_created_at(999, &last) > stopped);
        assert_eq!(next_created_at(5_000, &last), 5_000);
    }

    #[tokio::test]
    async fn withdrawal_waits_for_an_in_flight_serving_publication() {
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let last = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let held = PUBLISH.lock().await; // a periodic serving publication is in flight
        let (o, l) = (order.clone(), last.clone());
        let off = tokio::spawn(async move {
            let _serial = PUBLISH.lock().await;
            o.lock()
                .unwrap()
                .push(("stopped", next_created_at(1_000, &l)));
        });
        tokio::task::yield_now().await;
        order
            .lock()
            .unwrap()
            .push(("serving", next_created_at(1_000, &last)));
        drop(held);
        off.await.unwrap();
        let order = order.lock().unwrap().clone();
        assert_eq!(order[0].0, "serving");
        assert_eq!(order[1].0, "stopped");
        assert!(order[1].1 > order[0].1);
    }
    #[test]
    fn enrollment_waits_for_first_use_then_sends_one_stopped_note() {
        let ran = ("https://a.example".to_owned(), "viewer".to_owned());
        // Plugin enabled and community selected, Mesh never run: no binding published.
        assert!(!should_publish(false, None, "https://a.example", "viewer"));
        // Share or a Mesh agent started: publish.
        assert!(should_publish(true, None, "https://a.example", "viewer"));
        // Run just ended in this community: one stopped note.
        assert!(should_publish(
            false,
            Some(&ran),
            "https://a.example",
            "viewer"
        ));
        // A different community or identity never inherits the earlier run.
        assert!(!should_publish(
            false,
            Some(&ran),
            "https://b.example",
            "viewer"
        ));
        assert!(!should_publish(
            false,
            Some(&ran),
            "https://a.example",
            "other"
        ));
    }
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
