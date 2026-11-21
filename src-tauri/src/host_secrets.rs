//! Write-only installed-plugin slots under the qualified native installation owner.
use crate::{identity::IdentityHost, PluginManager};
use tauri::Manager as _;
use zeroize::Zeroizing;

mod private_input;

const UNAVAILABLE: &str = "Saved plugin credentials are unavailable";
const SAVE_UNKNOWN: &str =
    "Buzz couldn't confirm saving the credential. Saving may still finish; do not retry yet.";
const WAIT: std::time::Duration = buzzodz_plugins::secrets::CLEANUP_BUDGET;

fn viewer(identity: &IdentityHost, id: &str, revision: &str, slot: &str) -> Result<String, String> {
    if !cfg!(unix)
        || buzzodz_plugins::valid_id(id).is_err()
        || buzzodz_plugins::valid_id(slot).is_err()
        || revision.len() != 64
        || !revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(UNAVAILABLE.into());
    }
    identity
        .current_viewer()
        .map_err(|_| "Identity is busy or unavailable".to_owned())?
        .ok_or_else(|| "Set up your identity first".to_owned())
}

#[tauri::command]
pub(crate) async fn plugin_host_secret_status(
    manager: tauri::State<'_, PluginManager>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    revision: String,
    slot: String,
) -> Result<buzzodz_plugins::SecretStatus, String> {
    let viewer = viewer(&identity, &id, &revision, &slot)?;
    crate::with_manager(manager, move |m| {
        m.secret_status(&id, &revision, &slot, &viewer)
    })
    .await
    .map_err(|_| UNAVAILABLE.into())
}

#[tauri::command]
pub(crate) async fn plugin_host_secret_clear(
    manager: tauri::State<'_, PluginManager>,
    identity: tauri::State<'_, IdentityHost>,
    reviewed: tauri::State<'_, crate::reviewed_invocation::Invocations>,
    id: String,
    revision: String,
    slot: String,
) -> Result<(), String> {
    let viewer = viewer(&identity, &id, &revision, &slot)?;
    reviewed.retire_plugin_and_wait(&id).await?;
    let owner = reviewed.own(&uuid::Uuid::new_v4().to_string(), &id)?;
    crate::with_manager(manager, move |m| {
        let _owner = owner;
        m.secret_clear(&id, &revision, &slot, &viewer)
    })
    .await
    .map_err(|_| UNAVAILABLE.into())
}

#[tauri::command]
pub(crate) async fn plugin_host_secret_set<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    revision: String,
    slot: String,
    value: String,
) -> Result<(), String> {
    let value = Zeroizing::new(value);
    let viewer = viewer(&identity, &id, &revision, &slot)?;
    let manager = manager.0.clone().map_err(|_| UNAVAILABLE.to_owned())?;
    let identity = identity.inner().clone();
    let wait = WAIT;
    #[cfg(test)]
    let wait = app.try_state::<std::time::Duration>().map_or(wait, |v| *v);
    tauri::async_runtime::spawn_blocking(move || {
        let instance = app
            .try_state::<crate::sign_out::Instance>()
            .ok_or(UNAVAILABLE)?;
        instance
            // Legacy renderer-value entry has no cancellable native input attempt.
            // The private enrollment route must supply its retained lifetime fence.
            .set_secret(
                manager,
                identity,
                viewer,
                id,
                revision,
                slot,
                value,
                std::sync::Arc::new(|| true),
                wait,
            )
            .map_err(|_| SAVE_UNKNOWN.to_owned())
    })
    .await
    .map_err(|_| SAVE_UNKNOWN.to_owned())?
}

/// Slot-only IPC: the credential is collected and retained entirely in native code.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_secret_enroll<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    manager: tauri::State<'_, PluginManager>,
    identity: tauri::State<'_, IdentityHost>,
    calls: tauri::State<'_, crate::host_request::HostCalls>,
    reviewed: tauri::State<'_, crate::reviewed_invocation::Invocations>,
    id: String,
    revision: String,
    slot: String,
    once: crate::host_request::Once,
) -> Result<buzzodz_plugins::SecretStatus, String> {
    use sha2::{Digest, Sha256};
    if !cfg!(target_os = "macos") {
        return Err(UNAVAILABLE.into());
    }
    let snapshot = viewer(&identity, &id, &revision, &slot)?;
    app.try_state::<crate::sign_out::Instance>()
        .ok_or(UNAVAILABLE)?
        .check_secret_admission()?;
    calls.consume(
        webview.label(),
        "secret-enrollment",
        &id,
        &revision,
        &once,
        Sha256::digest(slot.as_bytes()).into(),
    )?;
    reviewed.retire_plugin_and_wait(&id).await?;
    let call = once.call_id().to_owned();
    let owner = reviewed.own(&call, &id)?;
    let manager = manager.0.clone().map_err(|_| UNAVAILABLE)?;
    let (clear_manager, plugin, artifact, key_slot, viewer) = (
        manager.clone(),
        id.clone(),
        revision.clone(),
        slot.clone(),
        snapshot.clone(),
    );
    // Logical retirement precedes input even if physical deletion is denied.
    // Keep the native owner through any late cleanup, not just this future.
    let (cleared, owner) = tauri::async_runtime::spawn_blocking(move || {
        (
            clear_manager.secret_clear(&plugin, &artifact, &key_slot, &viewer),
            owner,
        )
    })
    .await
    .map_err(|_| UNAVAILABLE)?;
    cleared.map_err(|_| "Buzz couldn't confirm retiring the old credential or finishing cleanup. No new entry was opened; retry cleanup before connecting again.")?;
    if !calls.current(webview.label(), &once)
        || identity.current_viewer().ok().flatten().as_deref() != Some(snapshot.as_str())
        || !reviewed.try_live(&call)
    {
        return Err(UNAVAILABLE.into());
    }
    app.state::<crate::sign_out::Instance>()
        .check_secret_admission()?;
    let state = reviewed.inner().clone();
    let Some((value, owner)) = private_input::enter(
        app.clone(),
        state.clone(),
        call.clone(),
        format!("{id} · {slot}"),
        owner,
    )
    .await?
    else {
        return Ok(buzzodz_plugins::SecretStatus::Missing);
    };
    let completion_call = call.clone();
    let still_current = std::sync::Arc::new(move || {
        let _retained_owner = &owner;
        state.try_consume(&call)
    });
    let identity = identity.inner().clone();
    let wait = WAIT;
    #[cfg(test)]
    let wait = app.try_state::<std::time::Duration>().map_or(wait, |v| *v);
    tauri::async_runtime::spawn_blocking(move || {
        app.try_state::<crate::sign_out::Instance>()
            .ok_or(UNAVAILABLE)?
            .set_secret(
                manager,
                identity,
                snapshot,
                id,
                revision,
                slot,
                value,
                still_current,
                wait,
            )
            .map_err(|_| SAVE_UNKNOWN.to_owned())
    })
    .await
    .map_err(|_| SAVE_UNKNOWN)??;
    reviewed.cancel_and_wait(&completion_call).await?;
    Ok(buzzodz_plugins::SecretStatus::Saved)
}

#[cfg(test)]
mod tests;
