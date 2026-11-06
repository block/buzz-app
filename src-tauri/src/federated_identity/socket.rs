//! Only upgrade/frame transport. The renderer retains subscriptions and reconnects.
use super::{config::canonical_relay, FederatedIdentity};
use crate::identity::IdentityHost;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
use tokio_util::sync::CancellationToken;

struct Connection {
    stop: CancellationToken,
    sender: mpsc::Sender<String>,
    start: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub(crate) struct Sockets(Arc<Mutex<HashMap<String, Connection>>>);
impl Sockets {
    pub(crate) fn clear(&self) {
        for (_, connection) in self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            connection.stop.cancel();
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum SocketEvent {
    Text {
        data: String,
    },
    /// The relay's close code and reason, when it sent a close frame.
    Closed {
        code: Option<u16>,
        reason: Option<String>,
    },
    /// The relay refused, after the upgrade, a connection sent without a token
    /// for missing evidence; `reason` is the sign-in reason, as for a `401`.
    Refused {
        reason: String,
    },
    /// The assertion reached its refresh point; the renderer reconnects at
    /// once with a fresh one. Ends the socket before the relay's deadline.
    Renew,
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SocketMode {
    Public,
    Native,
}

#[tauri::command]
pub(crate) async fn relay_socket_connect(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    relay: String,
    on_event: Channel<SocketEvent>,
) -> Result<SocketMode, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid socket connection")?;
    let relay = canonical_relay(&relay)?;
    let proof = fi.cache_proof(identity.inner(), &relay).await?;
    let stop = CancellationToken::new();
    let (sender, mut outgoing) = mpsc::channel(16);
    let (start, started) = oneshot::channel();
    {
        let mut live = sockets
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 16 || live.contains_key(&id) {
            return Err("Native sockets are busy".into());
        }
        live.insert(
            id.clone(),
            Connection {
                stop: stop.clone(),
                sender,
                start: Some(start),
            },
        );
    }
    let connect = upgrade(
        fi.inner(),
        identity.inner(),
        &relay,
        id.clone(),
        stop.clone(),
    );
    let result = tokio::select! { _ = stop.cancelled() => Err("Native socket canceled".into()), result = connect => result };
    if result
        .as_ref()
        .is_err_and(|error| error == "relay-forbidden")
    {
        if let Some(proof) = &proof {
            let admission = super::cache::Admission {
                allowed: false,
                ..proof.admission.clone()
            };
            let _ = fi.cache_update(&proof.revision, admission).await;
        }
    }
    let (mut socket, assertion, unsigned, cancel) = match result {
        Ok(Some(connection)) => connection,
        result => {
            sockets
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return result.map(|_| SocketMode::Public);
        }
    };
    let cancel = proof.as_ref().map_or(cancel, |proof| proof.cancel.clone());
    let host = fi.inner().clone();
    let identity = identity.inner().clone();
    let registry = sockets.0.clone();
    tauri::async_runtime::spawn(async move {
        // A connection without a token (the relay decides) never expires here.
        let expiry = async {
            match &assertion {
                Some(assertion) => tokio::time::sleep(assertion.renew_in()).await,
                None => std::future::pending().await,
            }
        };
        tokio::pin!(expiry);
        let mut closing: Option<(u16, String)> = None;
        let mut refused = None;
        let mut renew = false;
        let mut authentication = None;
        let ready = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(10), started) => result.is_ok_and(|value| value.is_ok()),
            _ = cancel.cancelled() => false,
            _ = stop.cancelled() => false,
            _ = &mut expiry => { renew = true; false },
        };
        if ready {
            let pump = async {
                loop {
                    tokio::select! {
                        data = outgoing.recv() => {
                            let Some(data) = data else { break; };
                            if let Some(assertion) = &assertion {
                                if host.admit_assertion(&identity, assertion).await.is_err() { break; }
                            }
                            if let Some(proof) = &proof {
                                if identity.viewer().await.ok().as_deref() != Some(proof.admission.viewer.as_str()) { break; }
                            }
                            let bound_viewer = proof.as_ref().map(|proof| proof.admission.viewer.as_str())
                                .or_else(|| assertion.as_ref().map(|assertion| assertion.viewer.as_str()));
                            if let Some(viewer) = bound_viewer {
                                if let Ok(serde_json::Value::Array(frame)) = serde_json::from_str::<serde_json::Value>(&data) {
                                    if frame.first().and_then(|v| v.as_str()) == Some("AUTH") && frame.get(1).and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()) != Some(viewer) { break; }
                                }
                            }
                            let sent_auth = auth_id(&data);
                            if socket.send(Message::Text(data.into())).await.is_err() { break; }
                            if let Some(id) = sent_auth { authentication = Some(id); }
                        }
                        frame = socket.next() => {
                            if let Some(assertion) = &assertion {
                                if host.admit_assertion(&identity, assertion).await.is_err() { break; }
                            }
                            match frame {
                                Some(Ok(Message::Text(data))) => {
                                    if let (Some(proof), Some(allowed)) = (&proof, auth_result(authentication.as_deref(), &data)) {
                                        authentication = None;
                                        if identity.viewer().await.ok().as_deref() != Some(proof.admission.viewer.as_str()) { break; }
                                        let admission = super::cache::Admission { allowed, ..proof.admission.clone() };
                                        if host.cache_update(&proof.revision, admission).await.is_err() { break; }
                                    }
                                    refused = missing_evidence(unsigned, &data);
                                    if refused.is_some() || on_event.send(SocketEvent::Text {data:data.to_string()}).is_err() { break; }
                                },
                                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } },
                                Some(Ok(Message::Pong(_))) => {},
                                Some(Ok(Message::Close(frame))) => {
                                    closing = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
                                    break;
                                }
                                _ => break,
                            }
                        }
                    }
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = stop.cancelled() => {},
                _ = &mut expiry => renew = true,
                _ = pump => {},
            }
        }
        // Do not flush queued protected frames after expiry or retirement.
        drop(socket);
        registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        // 1008 also means ordinary lifetime expiry. Keep history locked while
        // allowing a fresh connection; an older in-flight proof cannot reopen it.
        if closing.as_ref().is_some_and(|(code, _)| *code == 1008) {
            if let Some(assertion) = &assertion {
                host.reject_assertion(assertion).await;
            }
            if let Some(proof) = &proof {
                let admission = super::cache::Admission {
                    allowed: false,
                    retryable: true,
                    ..proof.admission.clone()
                };
                let _ = host.cache_update(&proof.revision, admission).await;
            }
        }
        let (code, reason) = match closing {
            Some((code, reason)) => (Some(code), Some(reason)),
            None => (None, None),
        };
        let _ = on_event.send(match refused {
            Some(reason) => SocketEvent::Refused {
                reason: reason.into(),
            },
            None if renew => SocketEvent::Renew,
            None => SocketEvent::Closed { code, reason },
        });
    });
    Ok(SocketMode::Native)
}
#[tauri::command]
pub(crate) fn relay_socket_start(
    sockets: tauri::State<'_, Sockets>,
    id: String,
) -> Result<(), String> {
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_mut(&id)
        .and_then(|entry| entry.start.take())
        .ok_or("Native socket retired")?
        .send(())
        .map_err(|_| "Native socket retired".into())
}
#[tauri::command]
pub(crate) fn relay_socket_send(
    sockets: tauri::State<'_, Sockets>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Socket frame too large".into());
    }
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .ok_or("Native socket retired")?
        .sender
        .try_send(data)
        .map_err(|_| "Socket send queue is full".into())
}
#[tauri::command]
pub(crate) fn relay_socket_close(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    id: String,
) {
    fi.close_discovery(&id);
    if let Some(entry) = sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id)
    {
        entry.stop.cancel();
    }
}

/// The socket, its assertion, or the sign-in reason a connection sent without
/// one to an advertising relay keeps for its whole lifetime.
type Upgraded = (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Option<super::assertion::Assertion>,
    Option<&'static str>,
    CancellationToken,
);

/// NIP-FI's missing-evidence Nostr text: a denial after the upgrade.
const MISSING_EVIDENCE: &str = "auth-required: authentication required";
/// The sign-in reason when `data` is the relay's missing-evidence refusal of
/// a connection sent without a token (`unsigned`); otherwise `None`.
fn missing_evidence(unsigned: Option<&'static str>, data: &str) -> Option<&'static str> {
    let unsigned = unsigned?;
    let Ok(serde_json::Value::Array(frame)) = serde_json::from_str(data) else {
        return None;
    };
    let text = match frame.first()?.as_str()? {
        "NOTICE" => frame.get(1),
        "CLOSED" => frame.get(2),
        "OK" if frame.get(2) == Some(&serde_json::Value::Bool(false)) => frame.get(3),
        _ => None,
    }?;
    (text.as_str()? == MISSING_EVIDENCE).then_some(unsigned)
}
/// The native upgrade to `relay`, or `None` when the community does not
/// advertise NIP-FI and is not covered by an organization. An advertising relay
/// is upgraded natively even without a token, so its missing-evidence `401`
/// can become the sign-in prompt; a shadow relay admits that upgrade.
async fn upgrade(
    fi: &FederatedIdentity,
    identity: &IdentityHost,
    relay: &str,
    id: String,
    stop: CancellationToken,
) -> Result<Option<Upgraded>, String> {
    let url = url::Url::parse(relay).map_err(|_| "Invalid relay")?;
    let authorization = fi.assertion_for_socket(identity, &url, id, stop).await?;
    let (assertion, unsigned) = (authorization.assertion, authorization.unsigned);
    if assertion.is_none() && unsigned.is_none() && !fi.server_for(relay)?.protects(relay) {
        return Ok(None);
    }
    let cancel = match &assertion {
        Some(assertion) => {
            let cancel = assertion.cancellation()?;
            fi.admit_assertion(identity, assertion).await?;
            cancel
        }
        None => CancellationToken::new(),
    };
    let mut request = relay
        .into_client_request()
        .map_err(|_| "Invalid native socket request")?;
    request.headers_mut().insert(
        tokio_tungstenite::tungstenite::http::header::USER_AGENT,
        crate::relay::user_agent()
            .parse()
            .map_err(|_| "Invalid native socket request")?,
    );
    if let Some(assertion) = &assertion {
        request.headers_mut().insert(
            super::assertion::HEADER,
            assertion
                .header
                .as_str()
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (socket, _) = tokio::select! {
        _ = cancel.cancelled() => return Err("Federated session changed".into()),
        result = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, connector())) => match result.map_err(|_| "Native socket timed out")? {
            Ok(connection) => connection,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                // NIP-FI's fixed refusal classes: 401 wants fresh evidence,
                // 403 is a decision to stop, 503 is a temporary outage.
                return Err(match response.status().as_u16() {
                    401 => match &assertion {
                        Some(assertion) => {
                            fi.reject_assertion(assertion).await;
                            "relay-unauthorized"
                        }
                        // Missing evidence: the relay requires a token after all.
                        None => unsigned.unwrap_or("relay-unauthorized"),
                    },
                    403 => "relay-forbidden",
                    503 => "relay-unavailable",
                    _ => "Native socket upgrade refused",
                }
                .into());
            }
            Err(_) => return Err("Native socket upgrade refused".into()),
        },
    };
    if let Some(assertion) = &assertion {
        fi.admit_assertion(identity, assertion).await?;
    }
    // Only a connection sent without a token can be refused for missing it.
    let unsigned = unsigned.filter(|_| assertion.is_none());
    Ok(Some((socket, assertion, unsigned, cancel)))
}

// Correlate only a relay's answer to this socket's actual NIP-42 authentication.
fn auth_id(data: &str) -> Option<String> {
    let frame: serde_json::Value = serde_json::from_str(data).ok()?;
    (frame.get(0)?.as_str()? == "AUTH").then_some(())?;
    frame.get(1)?.get("id")?.as_str().map(str::to_owned)
}
fn auth_result(id: Option<&str>, data: &str) -> Option<bool> {
    let id = id?;
    let frame: serde_json::Value = serde_json::from_str(data).ok()?;
    if frame.get(0)?.as_str()? != "OK" || frame.get(1)?.as_str()? != id {
        return None;
    }
    frame.get(2)?.as_bool()
}

/// Tests' loopback communities use one self-signed root.
fn connector() -> Option<tokio_tungstenite::Connector> {
    #[cfg(test)]
    return Some(super::testing::trusted_connector());
    #[cfg(not(test))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::testing::{community, reply};

    #[test]
    fn cache_proof_requires_the_exact_sent_authentication() {
        assert_eq!(
            auth_id(r#"["AUTH",{"id":"auth"}]"#).as_deref(),
            Some("auth")
        );
        assert_eq!(auth_id(r#"["EVENT",{"id":"auth"}]"#), None);
        assert_eq!(auth_result(None, r#"["OK","auth",true]"#), None);
        assert_eq!(auth_result(Some("auth"), r#"["OK","publish",true]"#), None);
        assert_eq!(
            auth_result(Some("auth"), r#"["OK","auth",true]"#),
            Some(true)
        );
        assert_eq!(
            auth_result(Some("auth"), r#"["OK","auth",false]"#),
            Some(false)
        );
    }

    fn relay(community: &super::super::testing::Community) -> String {
        format!("wss://{}", community.origin.authority())
    }

    #[tokio::test]
    async fn socket_worker_records_only_matching_auth_and_persists_refusal() {
        use tauri::{ipc::InvokeResponseBody, Manager};
        for (requires, policy_close) in [(true, false), (true, true), (false, false), (false, true)]
        {
            let community = community(requires).await;
            let viewer = community.host.viewer().await.unwrap();
            let destination = relay(&community);
            let (close, closing) = oneshot::channel();
            let (accept, accepting) = oneshot::channel();
            let server = community.serve_socket(move |mut relay| async move {
                relay.send(Message::Text(r#"["AUTH","challenge"]"#.into())).await.unwrap();
                let Some(Ok(Message::Text(auth))) = relay.next().await else { panic!("no AUTH") };
                assert_eq!(auth_id(&auth).as_deref(), Some("auth"));
                relay.send(Message::Text(r#"["OK","unrelated",true,""]"#.into())).await.unwrap();
                accepting.await.unwrap();
                relay.send(Message::Text(r#"["OK","auth",true,""]"#.into())).await.unwrap();
                closing.await.unwrap();
                if policy_close {
                    relay.send(Message::Close(Some(tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode::Policy,
                        reason: "restricted".into(),
                    }))).await.unwrap();
                } else {
                    let Some(Ok(Message::Text(auth))) = relay.next().await else { panic!("no second AUTH") };
                    assert_eq!(auth_id(&auth).as_deref(), Some("second"));
                    relay.send(Message::Text(r#"["OK","second",false,"restricted"]"#.into())).await.unwrap();
                }
                let _ = relay.next().await;
            });
            let app = tauri::test::mock_builder()
                .manage(community.fi.clone())
                .manage(community.host.clone())
                .manage(Sockets::default())
                .build(crate::app_context())
                .unwrap();
            let (events, mut received) = mpsc::unbounded_channel::<serde_json::Value>();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Json(json) = body {
                    let _ = events.send(serde_json::from_str(&json).unwrap());
                }
                Ok(())
            });
            let id = uuid::Uuid::new_v4().to_string();
            relay_socket_connect(
                app.state(),
                app.state(),
                app.state(),
                id.clone(),
                destination.clone(),
                channel,
            )
            .await
            .unwrap();
            relay_socket_start(app.state(), id.clone()).unwrap();
            let challenge = received.recv().await.unwrap();
            assert_eq!(challenge["data"], r#"["AUTH","challenge"]"#);
            relay_socket_send(
                app.state(),
                id.clone(),
                serde_json::json!(["AUTH", {"id":"auth", "pubkey":viewer}]).to_string(),
            )
            .unwrap();
            let unrelated = received.recv().await.unwrap();
            assert_eq!(unrelated["data"], r#"["OK","unrelated",true,""]"#);
            assert!(community.fi.snapshot().cache_admissions.is_empty());
            accept.send(()).unwrap();
            // The matching receipt is forwarded only after durable admission.
            let accepted = received.recv().await.unwrap();
            assert_eq!(accepted["data"], r#"["OK","auth",true,""]"#);
            let revision = community.fi.snapshot().revision;
            let entries = community.fi.0.store.cache_admissions(&revision).unwrap();
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].viewer, viewer);
            assert_eq!(entries[0].relay, destination);
            assert!(entries[0].allowed);
            close.send(()).unwrap();
            if !policy_close {
                relay_socket_send(
                    app.state(),
                    id.clone(),
                    serde_json::json!(["AUTH", {"id":"second", "pubkey":viewer}]).to_string(),
                )
                .unwrap();
            }
            let refusal = received.recv().await.unwrap();
            if policy_close {
                assert_eq!(refusal["code"], 1008);
            } else {
                assert_eq!(refusal["data"], r#"["OK","second",false,"restricted"]"#);
            }
            assert!(!community.fi.snapshot().cache_admissions[0].allowed);
            let saved = community.fi.0.store.cache_admissions(&revision).unwrap();
            assert!(!saved[0].allowed);
            assert_eq!(saved[0].retryable, policy_close);
            app.state::<Sockets>().clear();
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn forbidden_covered_upgrade_revokes_admission_with_or_without_fi() {
        use tauri::Manager;
        for requires in [true, false] {
            let community = community(requires).await;
            let destination = relay(&community);
            let proof = community
                .fi
                .cache_proof(&community.host, &destination)
                .await
                .unwrap()
                .unwrap();
            community
                .fi
                .cache_update(&proof.revision, proof.admission)
                .await
                .unwrap();
            let server = community.serve(vec![reply("403 Forbidden", "{}")]);
            let app = tauri::test::mock_builder()
                .manage(community.fi.clone())
                .manage(community.host.clone())
                .manage(Sockets::default())
                .build(crate::app_context())
                .unwrap();
            let result = relay_socket_connect(
                app.state(),
                app.state(),
                app.state(),
                uuid::Uuid::new_v4().to_string(),
                destination,
                Channel::new(|_| Ok(())),
            )
            .await;
            assert_eq!(result.err().as_deref(), Some("relay-forbidden"));
            assert!(!community.fi.snapshot().cache_admissions[0].allowed);
            let saved = community
                .fi
                .0
                .store
                .cache_admissions(&proof.revision)
                .unwrap();
            assert!(!saved[0].allowed);
            assert!(!saved[0].retryable);
            server.heads().await;
        }
    }

    /// The upgrade request carries exactly the issued assertion; the relay's
    /// refusal ends the attempt after it is captured.
    #[tokio::test]
    async fn upgrade_attaches_for_required_discovery() {
        let community = community(true).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("relay-forbidden"));
        let heads = server.heads().await;
        assert!(
            heads[0].to_ascii_lowercase().contains("upgrade: websocket"),
            "{}",
            heads[0]
        );
        assert!(
            heads[0]
                .lines()
                .any(|line| line.eq_ignore_ascii_case("user-agent: Buzz")),
            "{}",
            heads[0]
        );
        community.assert_carried(&heads[0]);
    }

    /// Ordinary discovery leaves the socket public: no native upgrade, so no
    /// request that could carry an assertion.
    #[tokio::test]
    async fn upgrade_omits_for_ordinary_discovery() {
        let community = community(false).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let public = super::super::tests::host(Arc::new(super::super::tests::Memory::default()));
        let result = upgrade(
            &public,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Ok(None)));
        assert!(server.received().is_empty());
    }

    /// A signed-out client still upgrades to an advertising relay, plainly: a
    /// shadow relay admits it, and NIP-42 runs over the native socket.
    #[tokio::test]
    async fn upgrade_without_session_goes_plainly_to_an_advertising_relay() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let server = community.serve_socket(|mut relay| async move {
            relay
                .send(Message::Text(r#"["AUTH","challenge"]"#.into()))
                .await
                .unwrap();
            let Some(Ok(Message::Text(auth))) = relay.next().await else {
                panic!("no AUTH")
            };
            assert_eq!(auth.as_str(), r#"["AUTH",{"id":"auth"}]"#);
            relay
                .send(Message::Text(r#"["OK","auth",true,""]"#.into()))
                .await
                .unwrap();
        });
        let (mut socket, assertion, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(assertion.is_none());
        let Some(Ok(Message::Text(challenge))) = socket.next().await else {
            panic!("no challenge")
        };
        assert_eq!(challenge.as_str(), r#"["AUTH","challenge"]"#);
        socket
            .send(Message::Text(r#"["AUTH",{"id":"auth"}]"#.into()))
            .await
            .unwrap();
        let Some(Ok(Message::Text(ok))) = socket.next().await else {
            panic!("no OK")
        };
        assert_eq!(ok.as_str(), r#"["OK","auth",true,""]"#);
        // Admitted frames pass through; only the canonical refusal is one.
        assert_eq!(missing_evidence(unsigned, &ok), None);
        community.assert_uncarried(&server.await.unwrap());
    }

    /// That connection keeps its unsigned context, so the relay's later
    /// missing-evidence text becomes the sign-in reason, as its `401` does.
    #[tokio::test]
    async fn missing_evidence_text_after_upgrade_without_session_asks_for_sign_in() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let _server = community.serve_socket(|mut relay| async move {
            relay
                .send(Message::Text(
                    r#"["NOTICE","auth-required: authentication required"]"#.into(),
                ))
                .await
                .unwrap();
            let _ = relay.next().await;
        });
        let (mut socket, _, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        let Some(Ok(Message::Text(frame))) = socket.next().await else {
            panic!("no refusal")
        };
        assert_eq!(
            missing_evidence(unsigned, &frame),
            Some("Federated sign-in is required")
        );
        for refusal in [
            r#"["CLOSED","sub","auth-required: authentication required"]"#,
            r#"["OK","auth",false,"auth-required: authentication required"]"#,
        ] {
            assert_eq!(missing_evidence(unsigned, refusal), unsigned);
        }
        // Other refusals keep their ordinary handling.
        for other in [
            r#"["NOTICE","restricted: evidence rejected"]"#,
            r#"["CLOSED","sub","auth-required: please authenticate"]"#,
            r#"["EVENT","sub",{"content":"auth-required: authentication required"}]"#,
            r#"["OK","auth",true,"auth-required: authentication required"]"#,
        ] {
            assert_eq!(missing_evidence(unsigned, other), None);
        }
    }

    /// A connection that sent a token keeps no unsigned context: the same text
    /// is not a sign-in refusal. (A relay that does not advertise NIP-FI is
    /// never upgraded natively; see `upgrade_omits_for_ordinary_discovery`.)
    #[tokio::test]
    async fn missing_evidence_text_after_signed_upgrade_is_not_a_sign_in_refusal() {
        let community = community(true).await;
        let server = community.serve_socket(|_| async {});
        let (_, assertion, unsigned, _) = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(assertion.is_some());
        assert_eq!(unsigned, None);
        assert_eq!(
            missing_evidence(
                unsigned,
                r#"["NOTICE","auth-required: authentication required"]"#
            ),
            None
        );
        community.assert_carried(&server.await.unwrap());
    }

    /// An enforcing relay's missing-evidence 401 to that plain upgrade becomes
    /// the sign-in reason the app prompts for.
    #[tokio::test]
    async fn missing_evidence_refusal_without_session_asks_for_sign_in() {
        let community = community(true).await;
        community.fi.sign_out_for_test();
        let server = community.serve(vec![reply("401 Unauthorized", "authentication required\n")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(
            result.err().as_deref(),
            Some("Federated sign-in is required")
        );
        community.assert_uncarried(&server.heads().await[0]);
    }
}
