mod identity;
mod qr;
mod relay;

use buzz_pairing::{PairingError, PairingSession, PayloadType, SessionState};
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
            Ok(Err(message)) => pairing.update(&id, Status::Error { message }),
            Err(_) => pairing.update(&id, Status::Expired),
        }
    });
    Ok(())
}

async fn guard(
    future: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
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
) -> Result<(), String> {
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
            exchange.receive(&event)?
        } else {
            tokio::select! {
                Some(())=confirm.recv()=>exchange.confirm()?,
                message=relay::next(&mut socket)=>{
                    let message=message?;
                    if auth.handle(&mut socket, &exchange.session, &relay_url, &message).await? {continue;}
                    if let Some(event)=relay::event(&message) {exchange.receive(&event)?} else {continue;}
                }
            }
        };
        for event in output.events {
            relay::send(&mut socket, &event).await?;
            auth.unacknowledged.push(event);
        }
        if let Some(status) = output.status {
            if status == Status::Complete {
                return Ok(());
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
            return Ok(Output {
                events: vec![],
                status: Some(Status::Code { code, code_entry }),
            });
        }
        if self.code_entry && self.session.state() == SessionState::Confirming {
            match self.session.handle_target_sas_confirm(event) {
                Ok(proof) => return self.transfer(proof),
                Err(PairingError::TranscriptMismatch) => {
                    return Err("The codes didn’t match. Create a new code and try again.".into())
                }
                Err(_) => {}
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
