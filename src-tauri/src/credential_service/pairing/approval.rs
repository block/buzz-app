//! Sensitive kinds a paired tool asks to have signed (block/buzz
//! `docs/local-credential-provider.md`, Sensitive operations): the human
//! approves each in Buzz, once, or for that kind from that tool for
//! [`WINDOW`] seconds, shown with each paired tool until it lapses or is
//! stopped.
use super::{is_saved, Notice, Pairings, Record, State, APPROVAL};
use crate::credential_service::policy::windowable;
use crate::credential_service::{unix_now, Failure};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::PoisonError;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio::time::Instant;

/// How long allowing a kind lasts.
pub(crate) const WINDOW: u64 = 5 * 60;
/// Signatures that may be asked for per [`ASK_WINDOW`], by all tools and by
/// any one, so one tool cannot spend every other tool's asks.
const ASKS: usize = 20;
const ASKS_PER_PAIRING: usize = 10;
const ASK_WINDOW: Duration = Duration::from_secs(10 * 60);
/// When a caller turned away by another open request retries.
const BUSY_RETRY: u64 = 5;
/// How long a tool waits to ask again after a request it made ends with no
/// yes: declined, not answered, or dropped by the tool. Each such end after
/// that doubles it, up to [`DOUBLINGS`] times, until the human allows one or
/// none ends so for [`ASK_WINDOW`] after the last wait ended.
const COOLDOWN: Duration = Duration::from_secs(30);
const DOUBLINGS: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Answer {
    Deny,
    Once,
    /// Once, and the same kind from the same pairing until [`WINDOW`] ends;
    /// once only for a kind that is not [`windowable`].
    Window,
    /// The pairing was revoked while it waited; never sent by the page.
    #[serde(skip)]
    Revoked,
}

/// What the page is told.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignRequest {
    pub(crate) id: String,
    pub(crate) pairing: String,
    pub(crate) client: String,
    pub(crate) relay: String,
    pub(crate) kind: u16,
    pub(crate) tags: Vec<Vec<String>>,
    pub(crate) expires_in: u64,
    /// 0 when the kind can only be allowed once.
    pub(crate) window_seconds: u64,
}

pub(super) struct Pending {
    id: String,
    pairing: String,
    pub(super) relay: String,
    send: oneshot::Sender<Answer>,
}

pub(super) struct Window {
    pairing: String,
    pub(super) relay: String,
    kind: u16,
    /// Unix seconds.
    until: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Listed {
    kind: u16,
    until: u64,
}

/// Drops the asks older than [`ASK_WINDOW`] before `at`.
fn lapse(asked: &mut VecDeque<Instant>, at: Instant) {
    while asked
        .front()
        .is_some_and(|front| at.duration_since(*front) >= ASK_WINDOW)
    {
        asked.pop_front();
    }
}

/// Seconds until `asked` has room for another ask, if it is full.
fn full(asked: &VecDeque<Instant>, limit: usize, at: Instant) -> Option<u64> {
    (asked.len() >= limit).then(|| {
        asked.front().map_or(1, |front| {
            (ASK_WINDOW - at.duration_since(*front)).as_secs().max(1)
        })
    })
}

impl Pairings {
    /// Returns once the human lets `record`, admitted under `generation`,
    /// have an event of `kind` with `tags` signed: at once while its kind is
    /// allowed, otherwise after asking in Buzz.
    pub(crate) async fn approve(
        &self,
        record: &Record,
        generation: u64,
        kind: u16,
        tags: &[Vec<String>],
    ) -> Result<(), Failure> {
        let now = unix_now()?;
        let id = uuid::Uuid::new_v4().to_string();
        let (answer, epoch) = {
            // Communities before state, as a removal takes them: either it
            // sees this request pending or this sees the community gone.
            let communities = self
                .communities
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut state = self.state();
            if state.owed || state.generation != generation {
                return Err(Failure::revoked());
            }
            let Some(saved) = communities.as_ref() else {
                return Err(Failure::new("unavailable", "Buzz is starting; try again"));
            };
            if !is_saved(saved, &record.relay) {
                return Err(unsaved(&record.relay));
            }
            state.windows.retain(|window| window.until > now);
            if state
                .windows
                .iter()
                .any(|window| window.pairing == record.id && window.kind == kind)
            {
                return Ok(());
            }
            // Before the rate limit: a request nobody could see spends no slot.
            if state.sign_prompts == 0 {
                return Err(Failure::new(
                    "unavailable",
                    "Buzz can't ask you yet; open Buzz, then try again",
                ));
            }
            let at = Instant::now();
            if let Some(wait) = wait(&mut state, &record.id, at) {
                return Err(Failure {
                    code: "rate_limited",
                    message: "Another request is waiting in Buzz, or too many were made".into(),
                    retry_after: Some(wait),
                });
            }
            let (send, answer) = oneshot::channel();
            state.signing = Some(Pending {
                id: id.clone(),
                pairing: record.id.clone(),
                relay: record.relay.clone(),
                send,
            });
            state.sign_asked.push_back(at);
            state
                .sign_asked_by
                .entry(record.id.clone())
                .or_default()
                .push_back(at);
            // Asked under the lock a revoke takes, so no revoke falls between
            // the request being pending and the page hearing of it.
            (self.notify)(Notice::SignAsk(SignRequest {
                id: id.clone(),
                pairing: record.id.clone(),
                client: record.client.clone(),
                relay: record.relay.clone(),
                kind,
                tags: tags.to_vec(),
                expires_in: APPROVAL.as_secs(),
                window_seconds: if windowable(kind) { WINDOW } else { 0 },
            }));
            (answer, state.sign_epoch)
        };
        // Whatever ends the wait, even the caller hanging up, closes the prompt.
        let _closing = SignClosing(self, id, record.id.clone());
        let answer = tokio::time::timeout(APPROVAL, answer).await;
        match answer {
            Ok(Ok(Answer::Window)) if windowable(kind) => {
                let until = unix_now()? + WINDOW;
                let communities = self
                    .communities
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                let mut state = self.state();
                // A revoke since asking ended this pairing's windows: none begins.
                if state.owed || state.generation != generation {
                    return Err(Failure::revoked());
                }
                state.sign_strikes.remove(&record.id);
                // Signed once all the same: only the window is the page's to end.
                let current = state.sign_epoch == epoch
                    && communities
                        .as_ref()
                        .is_some_and(|communities| is_saved(communities, &record.relay));
                if current {
                    state.windows.push(Window {
                        pairing: record.id.clone(),
                        relay: record.relay.clone(),
                        kind,
                        until,
                    });
                }
                drop(state);
                drop(communities);
                if current {
                    (self.notify)(Notice::Changed);
                }
                Ok(())
            }
            Ok(Ok(Answer::Once | Answer::Window)) => {
                let mut state = self.state();
                if state.owed || state.generation != generation {
                    return Err(Failure::revoked());
                }
                state.sign_strikes.remove(&record.id);
                Ok(())
            }
            Ok(Ok(Answer::Revoked)) => Err(Failure::revoked()),
            Ok(Ok(Answer::Deny)) => {
                cool(&mut self.state(), &record.id);
                Err(Failure::new("denied", "Declined in Buzz"))
            }
            Ok(Err(_)) => Err(Failure::new(
                "denied",
                "Buzz closed this request before anyone answered",
            )),
            Err(_) => Err(Failure::new(
                "approval_required",
                "Nobody approved this in Buzz in time",
            )),
        }
    }

    /// The human's answer to signature request `id`; a stale id does nothing.
    pub(crate) fn answer_signature(&self, id: &str, answer: Answer) {
        let pending = {
            let mut state = self.state();
            match &state.signing {
                Some(pending) if pending.id == id => state.signing.take(),
                _ => None,
            }
        };
        if let Some(pending) = pending {
            let _ = pending.send.send(answer);
        }
    }

    /// The page mounted (`true`) or unmounted a prompt that asks the human
    /// to approve signatures.
    pub(crate) fn sign_prompt(&self, mounted: bool) {
        let mut state = self.state();
        state.sign_prompts = if mounted {
            state.sign_prompts + 1
        } else {
            state.sign_prompts.saturating_sub(1)
        };
    }

    /// Ends pairing `id`'s window for `kind`.
    pub(crate) fn stop_window(&self, id: &str, kind: u16) {
        let mut state = self.state();
        let before = state.windows.len();
        state
            .windows
            .retain(|window| !(window.pairing == id && window.kind == kind));
        let stopped = state.windows.len() != before;
        drop(state);
        if stopped {
            (self.notify)(Notice::Changed);
        }
    }

    /// Ends pairing `id`'s windows and revokes a signature it waits on.
    pub(super) fn forget(&self, id: &str) {
        let mut state = self.state();
        state.windows.retain(|window| window.pairing != id);
        state.sign_asked_by.remove(id);
        state.sign_cooldowns.remove(id);
        state.sign_strikes.remove(id);
        if let Some(pending) = state.signing.take_if(|pending| pending.pairing == id) {
            let _ = pending.send.send(Answer::Revoked);
        }
    }

    #[cfg(test)]
    pub(crate) fn age_windows(&self, seconds: u64) {
        for window in &mut self.state().windows {
            window.until -= seconds;
        }
    }

    pub(crate) fn windows_of(&self, id: &str, now: u64) -> Vec<Listed> {
        self.state()
            .windows
            .iter()
            .filter(|window| window.pairing == id && window.until > now)
            .map(|window| Listed {
                kind: window.kind,
                until: window.until,
            })
            .collect()
    }
}

/// Ends signature request `.1` from pairing `.2` and closes its prompt.
struct SignClosing<'a>(&'a Pairings, String, String);
impl Drop for SignClosing<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state();
        // Still waiting: it timed out or the caller hung up.
        if state
            .signing
            .take_if(|pending| pending.id == self.1)
            .is_some()
        {
            cool(&mut state, &self.2);
        }
        drop(state);
        (self.0.notify)(Notice::SignClosed(self.1.clone()));
    }
}

/// Makes `pairing` wait before it asks again, longer each time in a row.
fn cool(state: &mut State, pairing: &str) {
    let now = Instant::now();
    let (strikes, ended) = state
        .sign_strikes
        .entry(pairing.to_owned())
        .or_insert((0, now));
    if now.duration_since(*ended) >= ASK_WINDOW {
        *strikes = 0;
    }
    let until = now + COOLDOWN * 2u32.pow((*strikes).min(DOUBLINGS));
    *strikes += 1;
    *ended = until;
    state.sign_cooldowns.insert(pairing.to_owned(), until);
}

/// The removed community's error, as pairing gives it.
fn unsaved(relay: &str) -> Failure {
    Failure::new(
        "denied",
        &format!("{relay} isn't a community in Buzz; add it first"),
    )
}

/// Seconds `pairing` waits before it may ask at `at`, if it must: while
/// another request is open, after it was declined, or past its share or the
/// whole budget of asks.
fn wait(state: &mut State, pairing: &str, at: Instant) -> Option<u64> {
    if state.signing.is_some() {
        return Some(BUSY_RETRY);
    }
    state.sign_cooldowns.retain(|_, until| *until > at);
    if let Some(until) = state.sign_cooldowns.get(pairing) {
        return Some(until.duration_since(at).as_secs().max(1));
    }
    lapse(&mut state.sign_asked, at);
    let mine = state.sign_asked_by.entry(pairing.to_owned()).or_default();
    lapse(mine, at);
    full(mine, ASKS_PER_PAIRING, at).or_else(|| full(&state.sign_asked, ASKS, at))
}
