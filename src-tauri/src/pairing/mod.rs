mod identity;
mod qr;
mod relay;

use buzz_pairing::{PairingSession, PayloadType, SessionState};
use futures_util::FutureExt;
use nostr_pairing::Event;
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Status {
    Connecting,
    Qr {
        svg: String,
    },
    Code {
        code: String,
        #[serde(rename = "codeEntry")]
        code_entry: bool,
    },
    Transferring,
    Complete,
    Expired,
    Uncertain,
    Error {
        message: String,
    },
    Cancelled,
}
struct Active {
    id: String,
    cancel: CancellationToken,
    confirm: mpsc::Sender<()>,
    status: Status,
    payload_sent: bool,
}
#[derive(Clone, Default)]
pub struct Pairing(Arc<Mutex<Option<Active>>>);
impl Pairing {
    pub fn cancel_all(&self) {
        let mut active = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(old) = active.take() {
            old.cancel.cancel();
        }
    }

    fn update(&self, id: &str, status: Status) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(active) = active
                .as_mut()
                .filter(|a| a.id == id && !a.cancel.is_cancelled())
            {
                active.status = status;
            }
        }
    }
    fn mark_payload_sent(&self, id: &str) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(active) = active.as_mut().filter(|a| a.id == id) {
                active.payload_sent = true;
            }
        }
    }
    fn expire(&self, id: &str) {
        self.fail(id, Status::Expired, true);
    }
    fn fail(&self, id: &str, status: Status, ambiguous: bool) {
        if let Ok(mut active) = self.0.lock() {
            if let Some(active) = active
                .as_mut()
                .filter(|a| a.id == id && !a.cancel.is_cancelled())
            {
                active.status = if active.payload_sent && ambiguous {
                    Status::Uncertain
                } else {
                    status
                };
            }
        }
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
        if active.as_ref().is_some_and(|a| a.id == id) {
            if let Some(old) = active.take() {
                old.cancel.cancel();
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn pairing_account(
    host: tauri::State<'_, crate::identity::IdentityHost>,
) -> Result<String, String> {
    host.with_key(|_, viewer| Ok(viewer.to_owned())).await
}
#[tauri::command]
pub fn pairing_status(pairing: tauri::State<'_, Pairing>, id: String) -> Result<Status, String> {
    let active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    Ok(active
        .as_ref()
        .filter(|a| a.id == id)
        .map(|a| a.status.clone())
        .unwrap_or(Status::Cancelled))
}
#[tauri::command]
pub fn pairing_cancel(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    pairing.cancel(&id)
}
#[tauri::command]
pub fn pairing_confirm(pairing: tauri::State<'_, Pairing>, id: String) -> Result<(), String> {
    let mut active = pairing
        .0
        .lock()
        .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
    let active = active
        .as_mut()
        .filter(|a| {
            a.id == id
                && matches!(
                    a.status,
                    Status::Code {
                        code_entry: false,
                        ..
                    }
                )
        })
        .ok_or("This confirmation is no longer available.")?;
    active
        .confirm
        .try_send(())
        .map_err(|_| "Confirmation is already in progress.")?;
    active.status = Status::Transferring;
    Ok(())
}
#[tauri::command]
pub fn pairing_start(
    pairing: tauri::State<'_, Pairing>,
    host: tauri::State<'_, crate::identity::IdentityHost>,
    id: String,
    viewer: String,
    community: String,
) -> Result<(), String> {
    if id.len() != 36 || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
        return Err("Unsupported pairing request.".into());
    }
    if viewer.len() != 64 || !viewer.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Choose your Buzz account before pairing.".into());
    }
    let origin = relay::community(&community)?;
    let (tx, rx) = mpsc::channel(1);
    let cancel = CancellationToken::new();
    {
        let mut active = pairing
            .0
            .lock()
            .map_err(|_| "Pairing is unavailable. Restart Buzz.")?;
        if let Some(old) = active.take() {
            old.cancel.cancel();
        }
        *active = Some(Active {
            id: id.clone(),
            cancel: cancel.clone(),
            confirm: tx,
            status: Status::Connecting,
            payload_sent: false,
        });
    }
    let host = host.inner().clone();
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::select! {
            biased;
            _=cancel.cancelled()=>return,
            result=tokio::time::timeout(Duration::from_secs(120), guard(run(&pairing,&host,&id,viewer,origin,rx)))=>result,
        };
        match result {
            Ok(Ok(())) => pairing.update(&id, Status::Complete),
            Ok(Err(failure)) => {
                let ambiguous = matches!(failure, Failure::Transport(_));
                let (Failure::Transport(message) | Failure::Rejected(message)) = failure;
                pairing.fail(&id, Status::Error { message }, ambiguous);
            }
            Err(_) => pairing.expire(&id),
        }
    });
    Ok(())
}

#[derive(Debug)]
enum Failure {
    Transport(String),
    Rejected(String),
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Transport(message)
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self::Transport(message.into())
    }
}

async fn guard(
    future: impl std::future::Future<Output = Result<(), Failure>>,
) -> Result<(), Failure> {
    std::panic::AssertUnwindSafe(future)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| {
            Err("Pairing stopped unexpectedly. Create a new code and try again.".into())
        })
}

async fn run(
    pairing: &Pairing,
    host: &crate::identity::IdentityHost,
    id: &str,
    viewer: String,
    origin: url::Url,
    mut confirm: mpsc::Receiver<()>,
) -> Result<(), Failure> {
    let origin_string = origin.as_str().trim_end_matches('/').to_string();
    let payload = identity::prepare(host, viewer, origin_string).await?;
    let relay_url = relay::discover(&origin).await?;
    let (session, qr) = PairingSession::new_source(relay_url.to_string());
    let mut exchange = Exchange {
        session,
        payload: Some(payload),
        code_entry: false,
    };
    let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(256 * 1024))
        .max_frame_size(Some(256 * 1024));
    let (mut socket, _) = tokio_tungstenite::connect_async_tls_with_config(
        relay_url.as_str(),
        Some(config),
        false,
        Some(relay::tls_connector()?),
    )
    .await
    .map_err(|_| "Couldn’t connect for pairing. Check your connection and try again.")?;
    let (pending, mut auth) = relay::subscribe(&mut socket, &exchange.session, &relay_url).await?;
    let uri = Zeroizing::new(buzz_pairing::qr::encode_qr(&qr));
    let svg = qr::render(&uri)?;
    pairing.update(id, Status::Qr { svg });
    let mut pending = std::collections::VecDeque::from(pending);
    loop {
        let output = if let Some(event) = pending.pop_front() {
            exchange.receive(&event).map_err(Failure::Rejected)?
        } else {
            tokio::select! {
                Some(())=confirm.recv()=>exchange.confirm().map_err(Failure::Rejected)?,
                message=relay::next(&mut socket)=>{
                    let message=message?;
                    if auth.handle(&mut socket, &exchange.session, &relay_url, &message).await? {continue;}
                    if let Some(event)=relay::event(&message) {exchange.receive(&event).map_err(Failure::Rejected)?} else {continue;}
                }
            }
        };
        let payload_index = output.events.len().checked_sub(1);
        for (index, event) in output.events.into_iter().enumerate() {
            if output.status == Some(Status::Transferring) && Some(index) == payload_index {
                // Once publication begins, cancellation of the await cannot prove
                // that the phone did not receive and import this payload.
                pairing.mark_payload_sent(id);
            }
            relay::send(&mut socket, &event).await?;
            auth.unacknowledged.push(event);
        }
        if let Some(status) = output.status {
            if status == Status::Complete {
                return Ok(());
            }
            if let Status::Error { message } = status {
                return Err(Failure::Rejected(message));
            }
            pairing.update(id, status);
        }
    }
}
struct Exchange {
    session: PairingSession,
    payload: Option<Zeroizing<String>>,
    code_entry: bool,
}
#[derive(Default)]
struct Output {
    events: Vec<Event>,
    status: Option<Status>,
}
impl Exchange {
    fn transfer(&mut self, proof: Event) -> Result<Output, String> {
        let payload = self
            .payload
            .take()
            .ok_or("This pairing code has already been used.")?;
        let event = self
            .session
            .send_payload(PayloadType::Custom, payload)
            .map_err(|_| "Couldn’t prepare the pairing transfer.")?;
        Ok(Output {
            events: vec![proof, event],
            status: Some(Status::Transferring),
        })
    }
    fn confirm(&mut self) -> Result<Output, String> {
        if self.code_entry {
            return Err("Enter the code on your phone to continue.".into());
        }
        let proof = self
            .session
            .confirm_sas()
            .map_err(|_| "This confirmation has expired. Try pairing again.")?;
        self.transfer(proof)
    }
    fn receive(&mut self, event: &Event) -> Result<Output, String> {
        if self.session.handle_abort(event).is_ok() {
            return Err("Pairing was cancelled on your phone. Try again when you’re ready.".into());
        }
        if let Ok((code, code_entry)) = self.session.handle_offer_with_confirmation(event) {
            self.code_entry = code_entry;
            let (code, events) = if code_entry {
                let (code, challenge) = self
                    .session
                    .start_desktop_code()
                    .map_err(|_| "Couldn’t create the desktop verification code.")?;
                (code, vec![challenge])
            } else {
                (code, vec![])
            };
            return Ok(Output {
                events,
                status: Some(Status::Code { code, code_entry }),
            });
        }
        if self.code_entry && self.session.state() == SessionState::Confirming {
            if let Ok((reply, accepted)) = self.session.handle_target_code(event) {
                if accepted {
                    return self.transfer(reply);
                }
                let status =
                    (self.session.state() == SessionState::Aborted).then(|| Status::Error {
                        message: "Too many incorrect codes. Try pairing again.".into(),
                    });
                return Ok(Output {
                    events: vec![reply],
                    status,
                });
            }
        }

        match self.session.handle_complete(event) {
            Ok(()) => {
                return Ok(Output {
                    events: vec![],
                    status: Some(Status::Complete),
                })
            }
            Err(_) if self.session.state() == SessionState::Aborted => {
                return Err("Your phone couldn’t save the account. Try pairing again.".into())
            }
            Err(_) => {}
        }
        Ok(Output::default())
    }
}
#[cfg(test)]
mod tests;

#[cfg(test)]
mod relay_tests;
