//! Serving intent belongs to the selected community and the existing node.
use tauri::Manager;

pub(super) fn observer(
    app: tauri::AppHandle,
    config: super::preferences::Config,
) -> impl Fn(buzz_mesh_compute::lifecycle::Phase) + Send + Sync + 'static {
    let reached_ready = std::sync::atomic::AtomicBool::new(false);
    move |phase| {
        if phase == buzz_mesh_compute::lifecycle::Phase::Ready {
            reached_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let host = app.state::<super::MeshHost>();
        // Same-community UI remounts rotate the lease without replacing the worker.
        // Bind checkpoints to the still-selected community and exact intent instead.
        let result = host
            .lease
            .for_community(&config.community)
            .and_then(|lease| {
                host.lease.with_current(&lease, |_| {
                    let mut intent = host
                        .sharing
                        .lock()
                        .map_err(|_| "Mesh sharing unavailable")?;
                    if intent.as_ref().map_or(true, |share| {
                        share.model != config.model || share.max_vram_gb != config.max_vram_gb
                    }) {
                        return Ok(());
                    }
                    let result = host
                        .preferences
                        .lock()
                        .map_err(|_| "Mesh settings unavailable")?
                        .phase(
                            &config,
                            &phase,
                            reached_ready.load(std::sync::atomic::Ordering::SeqCst),
                        );
                    if matches!(phase, buzz_mesh_compute::lifecycle::Phase::Failed(_)) {
                        *intent = None;
                    }
                    result
                })
            });
        if let Err(error) = result {
            eprintln!("Mesh sharing checkpoint: {error}");
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Share {
    pub model: String,
    pub max_vram_gb: Option<u64>,
}
impl Share {
    fn new(model: String, max_vram_gb: Option<u64>) -> Result<Self, String> {
        let model = buzz_mesh_compute::catalog::canonical_curated_model_id(&model).to_owned();
        if model.is_empty() {
            return Err("Choose a model before sharing compute".into());
        }
        if max_vram_gb == Some(0) {
            return Err("Shared compute memory limit must be positive".into());
        }
        Ok(Self { model, max_vram_gb })
    }
}

#[tauri::command]
pub async fn mesh_compute_share(
    app: tauri::AppHandle,
    lease: String,
    model: Option<String>,
    max_vram_gb: Option<u64>,
    auto: Option<bool>,
    reset_only: Option<bool>,
) -> Result<(), String> {
    let automatic = auto.unwrap_or(false);
    let resetting = reset_only.unwrap_or(false);
    let host = app.state::<super::MeshHost>();
    let identity = app.state::<crate::identity::IdentityHost>();
    let stopping = model.is_none();
    let viewer = identity.viewer().await?;
    let member = viewer.clone();
    {
        let _guard = host.preparing.lock().await;
        let community = host.lease.community(&lease)?;
        let needs_reset_model = resetting
            && host
                .preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .hint()
                .is_none();
        // The UI currently has no memory override; a future limit must inform Auto's ladder.
        let recommended = if (automatic && model.is_some() && !resetting) || needs_reset_model {
            Some(
                tokio::task::spawn_blocking(buzz_mesh_compute::catalog::recommended_model)
                    .await
                    .map_err(|error| format!("Mesh hardware survey failed: {error}"))?,
            )
        } else {
            None
        };
        let share = if resetting {
            None
        } else {
            model
                .map(|model| Share::new(recommended.clone().unwrap_or(model), max_vram_gb))
                .transpose()?
        };
        if resetting {
            return host.lease.with_current(&lease, |_| {
                let mut prefs = host
                    .preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?;
                let mut config = prefs.hint().cloned().unwrap_or_else(|| {
                    super::preferences::Config::pending(
                        viewer.clone(),
                        community.clone(),
                        &Share {
                            model: recommended.clone().unwrap_or_default(),
                            max_vram_gb: None,
                        },
                    )
                });
                config.auto = true;
                // Preserve the current resolved model and consent; reset never starts or stops.
                prefs.checkpoint(config)
            });
        }
        if stopping
            && host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")?
                .is_none()
        {
            // Failure can clear live intent while leaving the saved model armed.
            host.preferences
                .lock()
                .map_err(|_| "Mesh settings unavailable")?
                .disarm()?;
            return Ok(()); // Share Off must leave an existing consumer alone.
        }
        if !stopping
            && matches!(
                host.lifecycle.phase(),
                buzz_mesh_compute::lifecycle::Phase::Starting
                    | buzz_mesh_compute::lifecycle::Phase::Stopping
            )
        {
            return Err("Mesh is changing state; wait before sharing again".into());
        }
        // Explicit Share Off clears intent even if shutdown cannot be confirmed.
        // The failed lifecycle still refuses replacement; never silently re-serve.
        if stopping {
            host.lease.with_current(&lease, |_| {
                let mut sharing = host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")?;
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .disarm()?;
                *sharing = None;
                Ok(())
            })?;
        }
        if let Some(share) = &share {
            host.lease.with_current(&lease, |_| {
                host.preferences
                    .lock()
                    .map_err(|_| "Mesh settings unavailable")?
                    .checkpoint({
                        let mut config =
                            super::preferences::Config::pending(viewer, community, share);
                        config.auto = automatic;
                        config
                    })
            })?;
        }
        // Do not replace the worker until its shutdown is confirmed.
        host.lifecycle
            .stop_and_wait()
            .await
            .map_err(|e| e.to_string())?;
        host.lease.with_current(&lease, |_| {
            *host
                .sharing
                .lock()
                .map_err(|_| "Mesh sharing unavailable")? = share;
            Ok(())
        })?;
    }
    // Reuses discovery and the same private SDK slot. Solo serving needs no target.
    if stopping {
        // Reached only after stop_and_wait confirmed shutdown (errors return above).
        // Withdraw the serving advertisement now rather than at the next heartbeat.
        if let Ok(community) = host.lease.community(&lease) {
            super::publisher::publish_stopped(&identity, &community, &member).await;
        }
        // Legacy re-arms consumer use for running Mesh agents after the serving node
        // goes away (classic coordinator → ensure_relay_mesh_for_record). Saved
        // sharing stays Off; this starts the same single slot as a client.
        if app
            .state::<crate::agents::AgentHost>()
            .has_mesh_consumers()
            .await
        {
            if let Err(error) = super::start(&app, &host, &identity, &lease).await {
                eprintln!("Mesh consumer re-arm after Share Off failed: {error}");
            }
        }
        Ok(())
    } else {
        let result = super::start(&app, &host, &identity, &lease).await;
        if result.is_err() {
            let _ = host.lease.with_current(&lease, |_| {
                *host
                    .sharing
                    .lock()
                    .map_err(|_| "Mesh sharing unavailable")? = None;
                Ok(())
            });
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serving_requires_a_model_and_positive_memory_limit() {
        assert!(Share::new("  ".into(), None).is_err());
        assert!(Share::new("model".into(), Some(0)).is_err());
        assert_eq!(
            Share::new(" model ".into(), Some(16)).unwrap(),
            Share {
                model: "model".into(),
                max_vram_gb: Some(16),
            }
        );
    }
}
