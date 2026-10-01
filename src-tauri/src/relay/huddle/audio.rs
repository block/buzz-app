use super::{now, template, Call, Channel, IdentityHost, Result, Update};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    Connector, MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
type Peers = BTreeMap<u8, String>;
const FRAME: usize = 960;
const HEADER: usize = 8;
const PROTOCOL: u8 = 2;

fn tls_config() -> Result<std::sync::Arc<rustls::ClientConfig>> {
    static CONFIG: std::sync::OnceLock<Result<std::sync::Arc<rustls::ClientConfig>>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            if roots.is_empty() {
                return Err("System TLS certificates unavailable".into());
            }
            // reqwest and the updater enable different providers. Choose explicitly,
            // rather than letting rustls panic when both providers are compiled in.
            let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::aws_lc_rs::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|_| "Huddle TLS unavailable")?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(std::sync::Arc::new(config))
        })
        .clone()
}

fn roster(value: &Value) -> Result<Peers> {
    let peers = value["peers"].as_array().ok_or("Invalid Huddle roster")?;
    if peers.len() > 256 {
        return Err("Huddle roster exceeds protocol capacity".into());
    }
    let mut result = Peers::new();
    for p in peers {
        let index = p["peer_index"]
            .as_u64()
            .filter(|i| *i <= 255)
            .ok_or("Invalid Huddle peer")? as u8;
        let key = p["pubkey"]
            .as_str()
            .filter(|s| super::super::hex_key(s))
            .ok_or("Invalid Huddle peer")?;
        if result.insert(index, key.into()).is_some() {
            return Err("Duplicate Huddle peer".into());
        }
    }
    Ok(result)
}
async fn control(socket: &mut Socket) -> Result<Value> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(text))) => {
                let value: Value =
                    serde_json::from_str(&text).map_err(|_| "Invalid Huddle response")?;
                if value["type"] == "error" {
                    return Err(value["message"]
                        .as_str()
                        .unwrap_or("Huddle rejected by relay")
                        .chars()
                        .take(240)
                        .collect());
                }
                return Ok(value);
            }
            Some(Ok(Message::Ping(data))) => socket
                .send(Message::Pong(data))
                .await
                .map_err(|_| "Huddle disconnected")?,
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                return Err("Huddle disconnected".into())
            }
            _ => {}
        }
    }
}
pub(super) async fn connect(
    host: &IdentityHost,
    call: &Call,
    room: &str,
) -> Result<(Socket, Peers)> {
    let mut url = super::origin(&call.community)?;
    url.set_scheme("wss").map_err(|_| "Invalid Huddle relay")?;
    // Use the same origin string as the existing desktop v2 client for NIP-42.
    let relay = url.as_str().trim_end_matches('/').to_owned();
    url.set_path(&format!("/huddle/{room}/audio"));
    let config = WebSocketConfig::default()
        .max_message_size(Some(65536))
        .max_frame_size(Some(65536));
    let (mut socket, _) = connect_async_tls_with_config(
        url.as_str(),
        Some(config),
        false,
        Some(Connector::Rustls(tls_config()?)),
    )
    .await
    .map_err(|_| "Could not connect to Huddle audio")?;
    let challenge = control(&mut socket).await?;
    let text = challenge["challenge"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or("Invalid Huddle challenge")?;
    if challenge["type"] != "challenge" {
        return Err("Invalid Huddle handshake".into());
    }
    let event = host
        .sign(template(
            22242,
            vec![
                vec!["relay".into(), relay],
                vec!["challenge".into(), text.into()],
            ],
            String::new(),
        ))
        .await?;
    socket.send(Message::Text(json!({"type":"auth", "event":event, "parent_channel_id":call.parent, "protocol_version":PROTOCOL}).to_string().into())).await.map_err(|_| "Huddle authentication failed")?;
    let joined = control(&mut socket).await?;
    if joined["type"] != "joined" {
        return Err("Huddle admission was not confirmed".into());
    }
    Ok((socket, roster(&joined)?))
}

struct Codec {
    encoder: opus::Encoder,
    decoders: BTreeMap<u8, opus::Decoder>,
    seq: u16,
    timestamp: u32,
}
impl Codec {
    fn new() -> Result<Self> {
        let mut encoder = opus::Encoder::new(48000, opus::Channels::Mono, opus::Application::Voip)
            .map_err(|_| "Audio encoder unavailable")?;
        encoder
            .set_bitrate(opus::Bitrate::Bits(32000))
            .map_err(|_| "Audio encoder unavailable")?;
        encoder
            .set_dtx(true)
            .map_err(|_| "Audio encoder unavailable")?;
        Ok(Self {
            encoder,
            decoders: BTreeMap::new(),
            seq: 0,
            timestamp: 0,
        })
    }
    fn encode(&mut self, samples: &[f32]) -> Result<Vec<u8>> {
        let mut frame = vec![0; 4000 + HEADER];
        let n = self
            .encoder
            .encode_float(samples, &mut frame[HEADER..])
            .map_err(|_| "Microphone encoding failed")?;
        frame[..2].copy_from_slice(&self.seq.to_be_bytes());
        frame[2..6].copy_from_slice(&self.timestamp.to_be_bytes());
        let rms = (samples.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / FRAME as f64).sqrt();
        frame[6] = ((20.0 * rms.log10()).round().clamp(-127.0, 0.0) as i8) as u8;
        frame[7] = u8::from(n <= 2);
        frame.truncate(HEADER + n);
        self.seq = self.seq.wrapping_add(1);
        self.timestamp = self.timestamp.wrapping_add(FRAME as u32);
        Ok(frame)
    }
    fn decode(&mut self, frame: &[u8], peers: &Peers) -> Result<Option<(String, Vec<f32>)>> {
        if frame.len() <= HEADER + 1 || frame.len() > 4000 + HEADER + 1 {
            return Ok(None);
        }
        let index = frame[0];
        let Some(peer) = peers.get(&index) else {
            return Ok(None);
        };
        if let std::collections::btree_map::Entry::Vacant(entry) = self.decoders.entry(index) {
            entry.insert(
                opus::Decoder::new(48000, opus::Channels::Mono)
                    .map_err(|_| "Audio decoder unavailable")?,
            );
        }
        // Opus can carry up to 120ms even when our own sender uses 20ms.
        let mut pcm = vec![0.0; 5760];
        let Some(decoder) = self.decoders.get_mut(&index) else {
            return Ok(None);
        };
        let Ok(n) = decoder.decode_float(&frame[HEADER + 1..], &mut pcm, false) else {
            return Ok(None);
        };
        pcm.truncate(n);
        Ok(Some((peer.clone(), pcm)))
    }
    fn replace(&mut self, peers: &mut Peers, next: Peers) {
        self.decoders.retain(|i, _| peers.get(i) == next.get(i));
        *peers = next;
    }
    fn joined(&mut self, peers: &mut Peers, delta: Peers) {
        let mut next = peers.clone();
        next.extend(delta);
        self.replace(peers, next);
    }
}

pub(super) async fn run(
    mut socket: Socket,
    mut peers: Peers,
    mut pcm: mpsc::Receiver<Vec<f32>>,
    mut stop: watch::Receiver<bool>,
    updates: &Channel<Update>,
    touched: &std::sync::atomic::AtomicU64,
) -> Result<()> {
    let mut codec = Codec::new()?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_received = tokio::time::Instant::now();
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            // Cleanup must not be starved by a continuously ready audio stream.
            _ = heartbeat.tick() => {
                super::check_cancelled(&stop, touched)?;
                if last_received.elapsed() > Duration::from_secs(30) { return Err("Huddle connection timed out. You can join again.".into()); }
                tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Ping(now().to_be_bytes().to_vec().into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
            }
            packet = socket.next() => {
                last_received = tokio::time::Instant::now();
                match packet {
                    Some(Ok(Message::Binary(frame))) => {
                        if let Some((peer, samples)) = codec.decode(&frame, &peers)? {
                            updates.send(Update::Audio {peer, samples}).map_err(|_| "Huddle view closed")?;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid Huddle update")?;
                        match value["type"].as_str() {
                            Some("joined") => {
                                // Mesh joins are deltas. Preserve already connected peers.
                                codec.joined(&mut peers, roster(&value)?);
                            }
                            Some("roster") => {
                                let next = roster(&value)?;
                                codec.replace(&mut peers, next);
                            }
                            Some("left") => {
                                if let Some(i) = value["peer_index"].as_u64().filter(|i| *i <= 255) {
                                    peers.remove(&(i as u8));
                                    codec.decoders.remove(&(i as u8));
                                }
                            }
                            Some("error") => return Err("The relay ended this Huddle connection".into()),
                            _ => continue,
                        }
                        updates.send(Update::Participants {participants:peers.values().cloned().collect()}).map_err(|_| "Huddle view closed")?;
                    }
                    Some(Ok(Message::Ping(bytes))) => {
                        tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Pong(bytes))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Huddle disconnected. You can join again.".into()),
                    _ => {},
                }
            }
            samples = pcm.recv() => {
                let Some(samples) = samples else { break; };
                let frame = codec.encode(&samples)?;
                tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Binary(frame.into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tls_uses_an_explicit_provider_with_system_trust() {
        assert!(tls_config().is_ok());
    }
    #[test]
    fn v2_opus_round_trip_and_peer_reuse() {
        let mut codec = Codec::new().unwrap();
        let samples: Vec<f32> = (0..FRAME).map(|n| ((n as f32) * 0.1).sin() * 0.1).collect();
        let encoded = codec.encode(&samples).unwrap();
        assert_eq!(&encoded[..6], &[0, 0, 0, 0, 0, 0]);
        let frame = [vec![7], encoded].concat();
        let mut peers = BTreeMap::from([(7, "a".repeat(64))]);
        let (peer, decoded) = codec.decode(&frame, &peers).unwrap().unwrap();
        assert_eq!(peer, "a".repeat(64));
        assert_eq!(decoded.len(), FRAME);
        assert!(decoded.iter().all(|s| s.is_finite()));
        codec.replace(&mut peers, BTreeMap::from([(7, "b".repeat(64))]));
        assert!(codec.decoders.is_empty());
        let encoded = codec.encode(&samples).unwrap();
        assert_eq!(&encoded[..6], &[0, 1, 0, 0, 3, 192]);
    }
    #[test]
    fn malformed_frames_and_rosters_are_bounded() {
        assert!(roster(&json!({"peers":[{"peer_index":256,"pubkey":"a".repeat(64)}]})).is_err());
        assert!(roster(&json!({"peers":[{"peer_index":0,"pubkey":"bad"}]})).is_err());
        let mut codec = Codec::new().unwrap();
        assert!(codec.decode(&[0; 8], &Peers::new()).unwrap().is_none());
        assert!(codec.decode(&[0; 40010], &Peers::new()).unwrap().is_none());
    }

    #[test]
    fn mesh_join_delta_keeps_existing_speakers() {
        let mut codec = Codec::new().unwrap();
        let mut peers = BTreeMap::from([(1, "a".repeat(64)), (2, "b".repeat(64))]);
        let frame = [vec![1], codec.encode(&vec![0.1; FRAME]).unwrap()].concat();
        codec.decode(&frame, &peers).unwrap();
        codec.joined(
            &mut peers,
            roster(&json!({"peers":[{"peer_index":3,"pubkey":"c".repeat(64)}]})).unwrap(),
        );
        assert_eq!(peers.len(), 3);
        assert!(codec.decoders.contains_key(&1));
        assert!(codec.decode(&frame, &peers).unwrap().is_some());
        codec.joined(&mut peers, BTreeMap::from([(1, "d".repeat(64))]));
        assert!(!codec.decoders.contains_key(&1));
        assert_eq!(peers.len(), 3);
    }
}
