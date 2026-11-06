//! Native cache admission, scoped by the secure session's unique revision.
//! A new login never inherits proof, even when it uses the same organization account.
use super::{config::canonical_relay, protocol::now, FederatedIdentity, Status};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Admission {
    pub(crate) viewer: String,
    pub(crate) relay: String,
    pub(crate) allowed: bool,
    /// A policy expiry is locked but can obtain fresh authorization.
    #[serde(default)]
    pub(crate) retryable: bool,
    #[serde(default)]
    pub(crate) generation: u64,
}

/// A refusal wins over late or concurrent success for this session revision.
pub(super) fn record(
    entries: &mut Vec<Admission>,
    mut next: Admission,
) -> Result<(), &'static str> {
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry.viewer == next.viewer && entry.relay == next.relay)
    {
        if !entry.allowed && !entry.retryable {
            return Ok(());
        }
        if (next.allowed || next.retryable) && next.generation != entry.generation {
            return Err("cache-admission-changed");
        }
        if next.retryable {
            next.generation = next.generation.checked_add(1).ok_or("storage-corrupt")?;
        } else if !next.allowed {
            next.generation = entry.generation;
        }
        *entry = next;
    } else {
        if entries.len() >= 128 {
            return Err("storage-unavailable");
        }
        if next.retryable {
            next.generation = next.generation.checked_add(1).ok_or("storage-corrupt")?;
        }
        entries.push(next);
    }
    Ok(())
}

#[derive(Clone)]
pub(super) struct Proof {
    pub(super) revision: String,
    pub(super) admission: Admission,
    pub(super) cancel: tokio_util::sync::CancellationToken,
}

impl FederatedIdentity {
    /// Native context for AUTH, including covered relays that do not use NIP-FI.
    pub(super) async fn cache_proof(
        &self,
        identity: &crate::identity::IdentityHost,
        relay: &str,
    ) -> Result<Option<Proof>, String> {
        let owner = self.server_for(relay)?;
        if !owner.protects(relay) {
            return Ok(None);
        }
        owner.restore().await;
        let viewer = identity.viewer().await?;
        let state = owner.state();
        if state.snapshot.status != Status::SignedIn || state.closed {
            return Ok(None);
        }
        let generation = state
            .snapshot
            .cache_admissions
            .iter()
            .find(|entry| entry.viewer == viewer && entry.relay == relay)
            .map_or(0, |entry| entry.generation);
        Ok(Some(Proof {
            revision: state.snapshot.revision.clone(),
            admission: Admission {
                viewer,
                relay: relay.into(),
                allowed: true,
                retryable: false,
                generation,
            },
            cancel: state.cancellation.clone(),
        }))
    }

    pub(super) async fn cache_result(
        &self,
        revision: &str,
        viewer: &str,
        relay: &str,
        allowed: bool,
    ) -> Result<(), String> {
        self.cache_update(
            revision,
            Admission {
                viewer: viewer.into(),
                relay: canonical_relay(relay)?,
                allowed,
                retryable: false,
                generation: 0,
            },
        )
        .await
    }

    pub(super) async fn cache_update(
        &self,
        revision: &str,
        admission: Admission,
    ) -> Result<(), String> {
        // Closing the socket must not cancel the durable write or its cleanup.
        let owner = self.server_for(&admission.relay)?;
        let revision = revision.to_owned();
        tokio::spawn(async move { owner.persist_cache_result(&revision, admission).await })
            .await
            .map_err(|_| "storage-unavailable".to_owned())?
    }

    async fn persist_cache_result(
        &self,
        revision: &str,
        admission: Admission,
    ) -> Result<(), String> {
        if !self.protects(&admission.relay) {
            return Ok(());
        }
        let _operation = self.0.cache_operation.lock().await;
        let allowed = admission.allowed;
        let session = {
            let mut state = self.state();
            let session = state
                .session
                .clone()
                .filter(|session| {
                    !state.closed
                        && state.snapshot.status == Status::SignedIn
                        && state.snapshot.revision == revision
                        && session.record.revision == revision
                })
                .ok_or("Federated session changed")?;
            if super::protocol::expiry(&session.record.expires_at).map_err(str::to_owned)?
                <= now().map_err(str::to_owned)?
            {
                return Err("Federated session expired".into());
            }
            if (allowed || admission.retryable)
                && state
                    .snapshot
                    .cache_admissions
                    .iter()
                    .find(|entry| {
                        entry.viewer == admission.viewer && entry.relay == admission.relay
                    })
                    .is_some_and(|entry| entry.generation != admission.generation)
            {
                return Err("cache-admission-changed".into());
            }
            if !allowed {
                record(&mut state.snapshot.cache_admissions, admission.clone())
                    .map_err(str::to_owned)?;
                state.cache_epoch += 1;
                self.publish(&state);
            }
            session
        };
        let saved_revision = revision.to_owned();
        let result = self
            .storage(move |store| store.record_cache_admission(&saved_revision, admission))
            .await;
        let superseded = result
            .as_ref()
            .is_err_and(|failure| failure.code == "cache-admission-changed");
        let result = if superseded {
            // Another copy advanced this key/community. Adopt its durable verdict,
            // but never retire the shared sign-in for expected superseded work.
            let revision = revision.to_owned();
            self.storage(move |store| store.cache_admissions(&revision))
                .await
        } else {
            result
        };
        let entries = match result {
            Ok(entries) => entries,
            Err(failure) => {
                // A refusal which cannot be saved must not leave reusable offline proof.
                if !allowed {
                    let retired_revision = {
                        let mut state = self.state();
                        if state.snapshot.revision != revision {
                            return Err("Federated session changed".into());
                        }
                        self.retire_state(&mut state, Status::Unavailable, Some(failure.code));
                        state.snapshot.revision.clone()
                    };
                    self.remove_retired(session, &retired_revision).await;
                }
                return Err(failure.code.into());
            }
        };
        let mut state = self.state();
        if state.closed
            || state.snapshot.revision != revision
            || state.snapshot.status != Status::SignedIn
        {
            return Err("Federated session changed".into());
        }
        state.snapshot.cache_admissions = entries;
        state.cache_epoch += 1;
        self.publish(&state);
        if superseded {
            Err("cache-admission-changed".into())
        } else {
            Ok(())
        }
    }
}
