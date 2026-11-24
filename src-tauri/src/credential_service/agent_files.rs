//! `agent_read` and `agent_apply`: a paired tool reads or changes one of the
//! human's local agents, as an agent document (`buzz agents export`,
//! `import` and `edit`). The page holds the agents' state and asks the human
//! to approve a change, so each call is forwarded to it and this waits for
//! its answer.
use super::pairing::{Notice, Notify, APPROVAL};
use super::Failure;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;
use tokio::sync::oneshot;

/// The page answers a read without asking anyone.
const READ: Duration = Duration::from_secs(10);

/// What the page is told.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCall {
    pub(crate) id: String,
    pub(crate) method: &'static str,
    pub(crate) params: Vec<String>,
    pub(crate) expires_in: u64,
}

type Answer = Result<String, Failure>;

pub(crate) struct AgentCalls {
    pending: Mutex<HashMap<String, oneshot::Sender<Answer>>>,
    notify: Notify,
    /// How many of the page's handlers are listening.
    listening: AtomicUsize,
}

/// Whatever ends a call, even the caller hanging up, forgets it and tells the
/// page, so an open approval closes.
struct Ending<'a>(&'a AgentCalls, String);
impl Drop for Ending<'_> {
    fn drop(&mut self) {
        if self.0.pending().remove(&self.1).is_some() {
            (self.0.notify)(Notice::AgentClosed(self.1.clone()));
        }
    }
}

impl AgentCalls {
    pub(crate) fn new(notify: Notify) -> Self {
        Self {
            pending: Mutex::default(),
            notify,
            listening: AtomicUsize::new(0),
        }
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<String, oneshot::Sender<Answer>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Forwards `method` to the page and waits for its answer.
    pub(crate) async fn call(&self, method: &'static str, params: &[String]) -> Answer {
        if self.listening.load(Ordering::SeqCst) == 0 {
            return Err(Failure::unavailable(
                "Open Buzz to read or change agents".into(),
            ));
        }
        let limit = if method == "agent_apply" {
            APPROVAL
        } else {
            READ
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (send, answer) = oneshot::channel();
        self.pending().insert(id.clone(), send);
        let _ending = Ending(self, id.clone());
        (self.notify)(Notice::Agent(AgentCall {
            id,
            method,
            params: params.to_vec(),
            expires_in: limit.as_secs(),
        }));
        match tokio::time::timeout(limit, answer).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(Failure::unavailable("Buzz stopped before answering".into())),
            Err(_) if method == "agent_apply" => Err(Failure::new(
                "approval_required",
                "Nobody approved the change in Buzz in time",
            )),
            Err(_) => Err(Failure::unavailable("Buzz did not answer in time".into())),
        }
    }

    /// The page's answer to call `id`: a result, or an error code and message.
    pub(crate) fn answer(&self, id: &str, answer: Result<String, (String, String)>) {
        let Some(send) = self.pending().remove(id) else {
            return;
        };
        let _ = send.send(answer.map_err(|(code, message)| Failure::new(code_of(&code), &message)));
    }

    /// One of the page's handlers began (`mounted`) or stopped listening.
    pub(crate) fn listen(&self, mounted: bool) {
        if mounted {
            self.listening.fetch_add(1, Ordering::SeqCst);
        } else {
            let _ = self
                .listening
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
        }
    }
}

/// The codes the page may answer with; anything else is `denied`.
fn code_of(code: &str) -> &'static str {
    match code {
        "approval_required" => "approval_required",
        "conflict" => "conflict",
        "invalid_request" => "invalid_request",
        "unavailable" => "unavailable",
        _ => "denied",
    }
}
