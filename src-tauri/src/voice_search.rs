//! Speech-to-text for voice jump. A distributor's endpoint
//! (`BUZZ_VOICE_TRANSCRIPTION_URL`, at build time or in the environment)
//! mints a short-lived OpenAI Realtime transcription key, answering a JSON
//! POST with `{"client_secret": …, "expires_at": …}`. Native code keeps that
//! key and uses it to answer the webview's WebRTC offer, so the key never
//! reaches the webview and the webview needs no OpenAI connect source. Audio
//! then streams peer to peer. Without an endpoint, voice is unavailable.
//!
//! The key is fetched ahead of time (`voice_search_prepare`) and reused until
//! shortly before it expires, so starting to listen costs one round trip.
use serde::Deserialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

const OPENAI_CALLS_URL: &str = "https://api.openai.com/v1/realtime/calls";
const OFFER_LIMIT: usize = 64 * 1024;
/// A kept key is replaced once it has less than this long left.
const KEY_MARGIN_SECS: u64 = 60;
/// How long a key without `expires_at` is kept.
const KEY_DEFAULT_SECS: u64 = 120;

#[derive(Deserialize)]
struct Secret {
    client_secret: String,
    #[serde(default)]
    expires_at: Option<u64>,
}

struct Kept {
    secret: Zeroizing<String>,
    expires_at: u64,
}

static KEPT: Mutex<Option<Kept>> = Mutex::const_new(None);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()
                .ok()
        })
        .as_ref()
        .ok_or_else(|| "Voice search is unavailable".to_string())
}

fn endpoint() -> Option<String> {
    std::env::var("BUZZ_VOICE_TRANSCRIPTION_URL")
        .ok()
        .or_else(|| option_env!("BUZZ_VOICE_TRANSCRIPTION_URL").map(str::to_owned))
        .filter(|url| url.starts_with("https://"))
}

async fn mint() -> Result<Kept, String> {
    let url = endpoint().ok_or("Voice search is unavailable")?;
    let response = client()?
        .post(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .body(r#"{"language":"en"}"#)
        .send()
        .await
        .map_err(|_| "Voice search couldn't get a transcription key")?;
    if !response.status().is_success() {
        return Err(format!(
            "Voice search was refused a transcription key ({})",
            response.status().as_u16()
        ));
    }
    let body = Zeroizing::new(
        response
            .bytes()
            .await
            .map_err(|_| "Voice search got no key")?
            .to_vec(),
    );
    let parsed = serde_json::from_slice::<Secret>(&body)
        .map_err(|_| "Voice search got an unreadable key")?;
    Ok(Kept {
        expires_at: parsed
            .expires_at
            .unwrap_or_else(|| now() + KEY_DEFAULT_SECS),
        secret: Zeroizing::new(parsed.client_secret),
    })
}

/// The kept key, fetching a new one when it is missing or nearly expired.
async fn key(fresh: bool) -> Result<Zeroizing<String>, String> {
    let mut kept = KEPT.lock().await;
    if fresh {
        *kept = None;
    }
    if let Some(current) = kept.as_ref() {
        if current.expires_at > now() + KEY_MARGIN_SECS {
            return Ok(current.secret.clone());
        }
    }
    let next = mint().await?;
    let secret = next.secret.clone();
    *kept = Some(next);
    Ok(secret)
}

/// Whether this build can transcribe speech.
#[tauri::command]
pub(crate) fn voice_search_available() -> bool {
    endpoint().is_some()
}

/// Fetches a transcription key ahead of listening, if none is kept.
#[tauri::command]
pub(crate) async fn voice_search_prepare() -> Result<(), String> {
    key(false).await.map(|_| ())
}

async fn answer(secret: &str, offer: &str) -> Result<(reqwest::StatusCode, String), String> {
    let response = client()?
        .post(OPENAI_CALLS_URL)
        .bearer_auth(secret)
        .header("Content-Type", "application/sdp")
        .body(offer.to_owned())
        .send()
        .await
        .map_err(|_| "Voice search couldn't reach OpenAI")?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|_| "Voice search got no answer")?;
    Ok((status, text))
}

/// Answers a WebRTC offer with a transcription session's SDP answer.
#[tauri::command]
pub(crate) async fn voice_search_connect(offer: String) -> Result<String, String> {
    if offer.is_empty() || offer.len() > OFFER_LIMIT {
        return Err("Invalid voice offer".into());
    }
    let (mut status, mut text) = answer(&key(false).await?, &offer).await?;
    // A kept key the service no longer accepts is replaced once.
    if status == reqwest::StatusCode::UNAUTHORIZED {
        (status, text) = answer(&key(true).await?, &offer).await?;
    }
    if !status.is_success() {
        return Err(format!("Voice search was refused ({})", status.as_u16()));
    }
    Ok(text)
}
