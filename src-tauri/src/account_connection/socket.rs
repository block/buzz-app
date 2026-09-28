//! One physical socket, not a second reconnect/subscription policy. The existing
//! frontend live owner supplies bounded routes; native owns AUTH and observer keys.
use super::{session::Session, AccountConnection};
use futures_util::{SinkExt, StreamExt};
use nostr::{Event, Timestamp};
#[cfg(test)]
use nostr::{EventBuilder, Kind, Tag};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
type Result<T> = std::result::Result<T, String>;
const ERROR: &str = "Native live connection unavailable";
const MAX_FRAME: usize = 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Packet {
    socket: String,
    seq: u64,
    kind: &'static str,
    value: Value,
}
pub(super) struct SocketControl {
    pub id: String,
    tx: mpsc::Sender<Control>,
    stop: watch::Sender<bool>,
}
enum Control {
    Write(String, oneshot::Sender<Result<()>>),
    Authenticate(oneshot::Sender<Result<Value>>),
    Ack(u64),
    Saved(String, u64, Value),
}
struct Route {
    observer: bool,
    since: u64,
    epoch: u64,
}
struct Protocol {
    routes: BTreeMap<String, Route>,
    challenge: Option<String>,
    auth: Option<Event>,
    auth_sent: bool,
    authenticated: bool,
}
impl Protocol {
    fn new() -> Self {
        Self {
            routes: BTreeMap::new(),
            challenge: None,
            auth: None,
            auth_sent: false,
            authenticated: false,
        }
    }
    fn authenticate(&mut self, session: &Session) -> Result<Value> {
        if self.auth.is_some() || self.auth_sent {
            return Err(ERROR.into());
        }
        let challenge = self.challenge.take().ok_or(ERROR)?;
        let relay = session.origin.replacen("https:", "wss:", 1);
        let value = session.identity.sign_activity(
            &session.viewer,
            crate::identity::EventTemplate {
                kind: 22242,
                created_at: Timestamp::now().as_secs(),
                content: String::new(),
                tags: vec![
                    vec!["relay".into(), relay],
                    vec!["challenge".into(), challenge],
                ],
            },
        )?;
        let event: Event = serde_json::from_value(value.clone()).map_err(|_| ERROR)?;
        self.auth = Some(event);
        Ok(value)
    }
    fn outbound(&mut self, raw: &str, viewer: &str) -> Result<()> {
        if raw.len() > 65536 {
            return Err(ERROR.into());
        }
        let frame: Value = serde_json::from_str(raw).map_err(|_| ERROR)?;
        let parts = frame.as_array().ok_or(ERROR)?;
        match parts.first().and_then(Value::as_str) {
            Some("AUTH") if parts.len() == 2 && !self.auth_sent => {
                if self
                    .auth
                    .as_ref()
                    .and_then(|e| serde_json::to_value(e).ok())
                    != Some(parts[1].clone())
                {
                    return Err(ERROR.into());
                }
                self.auth_sent = true;
                Ok(())
            }
            Some("CLOSE") if parts.len() == 2 => {
                let wire = parts[1].as_str().ok_or(ERROR)?;
                self.routes.remove(wire);
                Ok(())
            }
            Some("REQ") if self.authenticated && (3..=5).contains(&parts.len()) => {
                let wire = parts[1]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 64)
                    .ok_or(ERROR)?;
                if self.routes.contains_key(wire) || self.routes.len() >= 1024 {
                    return Err(ERROR.into());
                }
                let route = validate_route(&parts[2..], viewer)?;
                if route.observer && self.routes.values().any(|r| r.observer) {
                    return Err(ERROR.into());
                }
                self.routes.insert(wire.into(), route);
                Ok(())
            }
            Some("EVENT") if self.authenticated && parts.len() == 2 => {
                let event: Event = serde_json::from_value(parts[1].clone()).map_err(|_| ERROR)?;
                if event.verify().is_err()
                    || event.pubkey.to_hex() != viewer
                    || event
                        .created_at
                        .as_secs()
                        .abs_diff(Timestamp::now().as_secs())
                        > 300
                    || (event.kind.as_u16() != 20001
                        && !crate::relay::write_kind(event.kind.as_u16()))
                {
                    return Err(ERROR.into());
                }
                if event.kind.as_u16() == 20001
                    && (!event.tags.is_empty()
                        || !matches!(event.content.as_str(), "online" | "away" | "offline"))
                {
                    return Err(ERROR.into());
                }
                Ok(())
            }
            _ => Err(ERROR.into()),
        }
    }
    fn inbound(&mut self, raw: &str, session: &Session) -> Result<Option<(&'static str, Value)>> {
        if raw.len() > MAX_FRAME {
            return Err(ERROR.into());
        }
        let frame: Value = serde_json::from_str(raw).map_err(|_| ERROR)?;
        let parts = frame.as_array().ok_or(ERROR)?;
        match parts.first().and_then(Value::as_str) {
            Some("AUTH") if parts.len() == 2 && self.challenge.is_none() && self.auth.is_none() => {
                let challenge = parts[1]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 4096)
                    .ok_or(ERROR)?;
                self.challenge = Some(challenge.into());
                Ok(Some(("message", frame)))
            }
            Some("AUTH") => Err(ERROR.into()),
            Some("OK")
                if parts.len() >= 3
                    && self.auth_sent
                    && parts[1].as_str()
                        == self.auth.as_ref().map(|e| e.id.to_hex()).as_deref() =>
            {
                self.authenticated = parts[2] == true;
                Ok(Some(("message", frame)))
            }
            Some("OK")
                if self.authenticated
                    && parts.len() >= 3
                    && parts[1].as_str().is_some_and(|s| s.len() == 64) =>
            {
                Ok(Some(("message", frame)))
            }
            Some("EVENT") if parts.len() == 3 && self.authenticated => {
                let wire = parts[1].as_str().ok_or(ERROR)?;
                let Some(route) = self.routes.get(wire) else {
                    return Ok(None);
                };
                // Parse numeric wire fields before protocol-library normalization.
                if !parts[2]["kind"].as_u64().is_some_and(|k| k <= 65535)
                    || !parts[2]["created_at"]
                        .as_u64()
                        .is_some_and(|t| t <= 9_007_199_254_740_991)
                {
                    return Err(ERROR.into());
                }
                let checked: Event = serde_json::from_value(parts[2].clone()).map_err(|_| ERROR)?;
                checked.verify().map_err(|_| ERROR)?;
                if route.observer {
                    let Some(dto) = decode_observer(&parts[2], session, route.since) else {
                        return Ok(None);
                    };
                    if route.epoch != session.history.capture_epoch() {
                        return Ok(None);
                    }
                    Ok(Some(("observer", json!({"wire":wire,"frame":dto}))))
                } else {
                    // Observer events can never enter the ordinary signed-message path.
                    if parts[2].get("kind").and_then(Value::as_u64) == Some(24200) {
                        return Ok(None);
                    }
                    session.history.accept_rosters(
                        std::slice::from_ref(&parts[2]),
                        &session.viewer,
                        &session.origin,
                    );
                    Ok(Some(("message", frame)))
                }
            }
            Some("EOSE" | "CLOSED")
                if parts.len() >= 2
                    && self.routes.contains_key(parts[1].as_str().unwrap_or("")) =>
            {
                if parts[0] == "CLOSED" {
                    self.routes.remove(parts[1].as_str().unwrap_or(""));
                }
                Ok(Some(("message", frame)))
            }
            Some("NOTICE") => Ok(None),
            _ => Ok(None),
        }
    }
}
const CHANNEL_KINDS: &[u64] = &[
    9, 40002, 40008, 45001, 45003, 40099, 40100, 40003, 5, 9005, 7, 39000, 39002, 39005, 20002,
];
fn kinds(filter: &Value, expected: &[u64]) -> bool {
    filter
        .get("kinds")
        .and_then(Value::as_array)
        .is_some_and(|v| {
            v.len() == expected.len()
                && v.iter()
                    .all(|n| n.as_u64().is_some_and(|n| expected.contains(&n)))
                && expected.iter().all(|n| v.contains(&json!(n)))
        })
}
fn fields(filter: &Value, names: &[&str]) -> bool {
    filter
        .as_object()
        .is_some_and(|m| m.len() == names.len() && m.keys().all(|k| names.contains(&k.as_str())))
}
fn validate_route(filters: &[Value], viewer: &str) -> Result<Route> {
    let first = filters.first().ok_or(ERROR)?;
    let since = first["since"].as_u64().ok_or(ERROR)?;
    if since > Timestamp::now().as_secs() + 5 {
        return Err(ERROR.into());
    }
    let observer = kinds(first, &[24200]);
    if observer {
        if filters.len() != 1
            || !fields(first, &["kinds", "#p", "since"])
            || first["#p"] != json!([viewer])
            || since + 5 < Timestamp::now().as_secs()
        {
            return Err(ERROR.into());
        }
    } else {
        if filters
            .iter()
            .any(|f| f["since"] != since || f["limit"] != 500)
        {
            return Err(ERROR.into());
        }
        let profiles = filters.len() == 3
            && kinds(first, &[0, 10100, 30177])
            && fields(first, &["kinds", "since", "limit"])
            && kinds(&filters[1], &[30315])
            && fields(&filters[1], &["kinds", "#d", "since", "limit"])
            && filters[1]["#d"] == json!(["general"])
            && kinds(&filters[2], &[30030])
            && fields(&filters[2], &["kinds", "#d", "since", "limit"])
            && filters[2]["#d"] == json!(["buzz:custom-emoji"]);
        let membership = filters.len() == 2
            && kinds(first, &[44100, 44101])
            && fields(first, &["kinds", "#p", "since", "limit"])
            && first["#p"] == json!([viewer])
            && kinds(&filters[1], &[30078])
            && fields(&filters[1], &["kinds", "authors", "#t", "since", "limit"])
            && filters[1]["authors"] == json!([viewer])
            && filters[1]["#t"] == json!(["read-state"]);
        let channel = filters.len() == 1
            && kinds(first, CHANNEL_KINDS)
            && fields(first, &["kinds", "#h", "since", "limit"])
            && first["#h"].as_array().is_some_and(|v| {
                v.len() == 1
                    && v[0].as_str().is_some_and(|s| {
                        !s.is_empty()
                            && s.len() <= 128
                            && s.bytes()
                                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                    })
            });
        if !profiles && !membership && !channel {
            return Err(ERROR.into());
        }
    }
    Ok(Route {
        observer,
        since,
        epoch: 0,
    })
}
pub(super) fn decode_observer(raw: &Value, session: &Session, since: u64) -> Option<Value> {
    if raw["kind"].as_u64() != Some(24200) || raw["created_at"].as_u64()? < since {
        return None;
    }
    let time = raw["created_at"].as_u64()?;
    if time.abs_diff(Timestamp::now().as_secs()) > 300 {
        return None;
    }
    let event: Event = serde_json::from_value(raw.clone()).ok()?;
    event.verify().ok()?;
    let exact = |name: &str, value: &str| {
        let tags: Vec<_> = event
            .tags
            .iter()
            .filter(|t| t.as_slice().first().is_some_and(|s| s == name))
            .collect();
        tags.len() == 1 && tags[0].as_slice() == [name, value]
    };
    if !exact("p", &session.viewer)
        || !exact("agent", &event.pubkey.to_hex())
        || !exact("frame", "telemetry")
        || !(132..=87472).contains(&event.content.len())
    {
        return None;
    }
    let bytes = session
        .identity
        .decrypt_activity(&session.viewer, &event)
        .ok()?;
    if bytes.len() > 65535 {
        return None;
    }
    let plaintext = std::str::from_utf8(&bytes).ok()?;
    serde_json::from_str::<Value>(plaintext).ok()?;
    Some(
        json!({"id":event.id.to_hex(),"agent":event.pubkey.to_hex(),"createdAt":time,"plaintext":plaintext}),
    )
}
struct Delivery {
    id: String,
    sequence: u64,
    pending: BTreeMap<u64, usize>,
    bytes: usize,
    channel: tauri::ipc::Channel<Packet>,
}
impl Delivery {
    fn send(&mut self, kind: &'static str, value: Value) -> Result<()> {
        let bytes = serde_json::to_vec(&value).map_err(|_| ERROR)?.len();
        if self.pending.len() >= 32 || self.bytes + bytes > 2 * 1024 * 1024 {
            return Err(ERROR.into());
        }
        self.sequence += 1;
        self.bytes += bytes;
        self.pending.insert(self.sequence, bytes);
        self.channel
            .send(Packet {
                socket: self.id.clone(),
                seq: self.sequence,
                kind,
                value,
            })
            .map_err(|_| ERROR.into())
    }
    fn ack(&mut self, seq: u64) {
        if let Some(bytes) = self.pending.remove(&seq) {
            self.bytes -= bytes;
        }
    }
}
async fn run(
    session: Arc<Session>,
    id: String,
    mut controls: mpsc::Receiver<Control>,
    mut stop: watch::Receiver<bool>,
    channel: tauri::ipc::Channel<Packet>,
) {
    let mut revoked = session.revoked.subscribe();
    let mut delivery = Delivery {
        id: id.clone(),
        sequence: 0,
        pending: BTreeMap::new(),
        bytes: 0,
        channel,
    };
    let result=async {
   let url=session.origin.replacen("https:","wss:",1);
   #[cfg(test)] let url=url.replacen("http:","ws:",1);
   let config=WebSocketConfig::default().max_message_size(Some(MAX_FRAME)).max_frame_size(Some(MAX_FRAME)).max_write_buffer_size(2*MAX_FRAME);
   session.current().map_err(|_|ERROR)?;if *stop.borrow(){return Err(ERROR.to_owned());}
   let (mut socket,_)=tokio::select!{biased;_ = stop.changed()=>return Err(ERROR.into()),_ = revoked.changed()=>return Err(ERROR.into()),result=tokio::time::timeout(Duration::from_secs(10),connect_async_with_config(url,Some(config),false))=>result.map_err(|_|ERROR)?.map_err(|_|ERROR)?};
   delivery.send("open",Value::Null)?;let mut protocol=Protocol::new();
   // A single bounded blocking worker preserves host receipt order without disk
   // latency blocking this chat/socket actor. Closing drops the sender; epochs
   // reject queued work after revocation/deletion.
   let (saving,mut save_queue)=mpsc::channel::<(String,u64,Value,Value)>(16);
   let captured=session.clone();let control_tx=session.socket.lock().map_err(|_|ERROR)?.as_ref().ok_or(ERROR)?.tx.clone();
   tauri::async_runtime::spawn_blocking(move||{
     while let Some((wire,epoch,event,mut value))=save_queue.blocking_recv(){
       captured.history.flush_gap(&captured);
       let result=captured.history.capture(&captured,&event,&value["frame"],epoch);
       value["frame"]["saved"]=json!(result.is_ok());if let Err(error)=result{captured.history.mark_gap(&captured);value["frame"]["saveError"]=json!(error);}
       let _=control_tx.try_send(Control::Saved(wire,epoch,value));
       captured.history.flush_gap(&captured);
     }
     captured.history.flush_gap(&captured);
   });
   loop {
     if *stop.borrow()||*revoked.borrow(){break;}
     tokio::select!{biased;
       _=stop.changed()=>break,
       _=revoked.changed()=>break,
       control=controls.recv()=>match control {
         Some(Control::Ack(seq))=>delivery.ack(seq),
         Some(Control::Saved(wire,epoch,value))=>{
           if protocol.routes.get(&wire).is_some_and(|r|r.observer&&r.epoch==epoch)&&session.history.capture_epoch()==epoch {delivery.send("observer",value)?;}
         },
         Some(Control::Authenticate(reply))=>{let result=if *stop.borrow()||*revoked.borrow(){Err(ERROR.into())}else{protocol.authenticate(&session)};let _=reply.send(result);},
         Some(Control::Write(raw,reply))=>{
           if let Ok(frame)=serde_json::from_str::<Value>(&raw){
             if frame[0]=="CLOSE"&&protocol.routes.get(frame[1].as_str().unwrap_or("")).is_some_and(|r|r.observer){session.history.stop_capture();}
           }
           let result=protocol.outbound(&raw,&session.viewer);
           if let Ok(frame)=serde_json::from_str::<Value>(&raw){if frame[0]=="REQ"{if let Some(route)=protocol.routes.get_mut(frame[1].as_str().unwrap_or("")){route.epoch=session.history.capture_epoch();}}}
           if result.is_err(){let _=reply.send(result);break;}
           // This actor's sequential command boundary orders route registration before
           // incoming telemetry, and CLOSE before subsequent decode. No native retries.
           if *stop.borrow()||*revoked.borrow(){let _=reply.send(Err(ERROR.into()));break;}
           let result=tokio::select!{biased;_ = stop.changed()=>Err(ERROR.into()),_ = revoked.changed()=>Err(ERROR.into()),result=tokio::time::timeout(Duration::from_secs(10),socket.send(Message::Text(raw.into())))=>result.map_err(|_|ERROR.to_owned()).and_then(|r|r.map_err(|_|ERROR.into()))};
           let failed=result.is_err();let _=reply.send(result);if failed{break;}
         },None=>break,
       },
       incoming=socket.next()=>match incoming {
         Some(Ok(Message::Text(raw)))=>{if let Some((kind,mut value))=protocol.inbound(&raw,&session)? {
           if *stop.borrow()||*revoked.borrow(){break;}
           if kind=="observer" {
             let wire=value["wire"].as_str().unwrap_or("").to_owned();let epoch=session.history.capture_epoch();
             let event=serde_json::from_str::<Value>(&raw).map_err(|_|ERROR)?[2].clone();
             if let Err(error)=saving.try_send((wire,epoch,event,value)) {
               session.history.gap_pending();
               value=error.into_inner().3;value["frame"]["saveError"]=json!("Saved Activity queue full; this frame was not saved");delivery.send(kind,value)?;
             }
           }else{delivery.send(kind,value)?;}
         }},
         Some(Ok(Message::Close(_)))|None=>break,
         Some(Err(_))=>return Err(ERROR.into()),
         Some(Ok(Message::Ping(_)))=>{tokio::select!{biased;_ = stop.changed()=>break,_ = revoked.changed()=>break,result=tokio::time::timeout(Duration::from_secs(5),socket.flush())=>result.map_err(|_|ERROR)?.map_err(|_|ERROR)?};},
         _=>{},
       }
     }
   }
   Ok::<(),String>(())
 }.await;
    session.history.disconnect();
    // One final tiny control packet does not depend on draining the data window.
    let _ = delivery.channel.send(Packet {
        socket: id.clone(),
        seq: 0,
        kind: "closed",
        value: json!({"failed":result.is_err()}),
    });
    if let Ok(mut current) = session.socket.lock() {
        if current.as_ref().is_some_and(|s| s.id == id) {
            current.take();
        }
    }
}
impl Session {
    fn open_socket(self: &Arc<Self>, channel: tauri::ipc::Channel<Packet>) -> Result<String> {
        self.current().map_err(|_| ERROR)?;
        let mut slot = self.socket.lock().map_err(|_| ERROR)?;
        // A replacement waits for the previous physical task to actually exit.
        // Existing JS bounded reconnect retries this refusal; native never retries.
        if slot.is_some() {
            return Err(ERROR.into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel(64);
        let (stop, stopped) = watch::channel(false);
        *slot = Some(SocketControl {
            id: id.clone(),
            tx,
            stop,
        });
        tauri::async_runtime::spawn(run(self.clone(), id.clone(), rx, stopped, channel));
        Ok(id)
    }
    fn socket_control(&self, id: &str, control: Control) -> Result<()> {
        self.current().map_err(|_| ERROR)?;
        if matches!(&control, Control::Write(raw, _) if raw.len() > 65536) {
            return Err(ERROR.into());
        }
        let slot = self.socket.lock().map_err(|_| ERROR)?;
        slot.as_ref()
            .filter(|s| s.id == id)
            .ok_or(ERROR)?
            .tx
            .try_send(control)
            .map_err(|_| ERROR.into())
    }
    pub(super) fn close_socket(&self, id: Option<&str>) {
        if let Ok(slot) = self.socket.lock() {
            if let Some(socket) = slot
                .as_ref()
                .filter(|s| id.is_none() || Some(s.id.as_str()) == id)
            {
                socket.stop.send_replace(true);
            }
        }
    }
}
#[tauri::command]
pub(crate) fn account_socket_open<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    channel: tauri::ipc::Channel<Packet>,
) -> Result<String> {
    host.session(webview.label(), &lease)
        .map_err(|_| ERROR)?
        .open_socket(channel)
}
#[tauri::command]
pub(crate) async fn account_socket_send<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    socket: String,
    frame: String,
) -> Result<()> {
    let session = host.session(webview.label(), &lease).map_err(|_| ERROR)?;
    let (tx, rx) = oneshot::channel();
    session.socket_control(&socket, Control::Write(frame, tx))?;
    rx.await.map_err(|_| ERROR)?
}
#[tauri::command]
pub(crate) async fn account_socket_auth<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    socket: String,
) -> Result<Value> {
    let session = host.session(webview.label(), &lease).map_err(|_| ERROR)?;
    let (tx, rx) = oneshot::channel();
    session.socket_control(&socket, Control::Authenticate(tx))?;
    rx.await.map_err(|_| ERROR)?
}
#[tauri::command]
pub(crate) fn account_socket_ack<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    socket: String,
    seq: u64,
) -> Result<()> {
    host.session(webview.label(), &lease)
        .map_err(|_| ERROR)?
        .socket_control(&socket, Control::Ack(seq))
}
#[tauri::command]
pub(crate) fn account_socket_close<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    host: tauri::State<'_, AccountConnection>,
    lease: String,
    socket: String,
) -> Result<()> {
    host.session(webview.label(), &lease)
        .map_err(|_| ERROR)?
        .close_socket(Some(&socket));
    Ok(())
}
#[cfg(test)]
mod tests;
