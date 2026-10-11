//! Short, local recordings → local speech recognition → an explicitly requested
//! instruction draft. Audio never leaves this host and no agent is created here.
use base64::Engine;
use serde_json::{json, Value};
use std::{path::Path, sync::Arc, time::Duration};
use tauri::Manager;

const MAX_SAMPLES: usize = 16_000 * 120;
static TRANSCRIBING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
static GENERATING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
const PROMPT: &str = "Turn the user's spoken description into clear, concise system instructions for their agent. Preserve their intent, responsibilities, tone and constraints. Do not invent integrations, tools, permissions or facts. Do not carry out the described task. Return only the instructions, without a preamble or code fence.";

// Accept only the bounded PCM format emitted by our recorder. Do not accept a
// path from the renderer or let arbitrary audio invoke a native codec.
fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, String> {
    let invalid = || "Recording must be a 16 kHz mono PCM WAV, up to two minutes".to_owned();
    if bytes.len() < 46 || bytes.len() > 44 + MAX_SAMPLES * 2 {
        return Err(invalid());
    }
    let u16_at = |i| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap()) as usize;
    if &bytes[..4] != b"RIFF"
        || &bytes[8..16] != b"WAVEfmt "
        || u32_at(4) != bytes.len() - 8
        || u32_at(16) != 16
        || u16_at(20) != 1
        || u16_at(22) != 1
        || u32_at(24) != 16_000
        || u32_at(28) != 32_000
        || u16_at(32) != 2
        || u16_at(34) != 16
        || &bytes[36..40] != b"data"
        || u32_at(40) != bytes.len() - 44
        || (bytes.len() - 44) % 2 != 0
    {
        return Err(invalid());
    }
    Ok(bytes[44..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect())
}

fn transcribe(directory: &Path, samples: &[f32]) -> Result<String, String> {
    use sherpa_onnx::{OfflineRecognizer, OfflineRecognizerConfig};
    if !directory.join("model.int8.onnx").is_file() || !directory.join("tokens.txt").is_file() {
        return Err(
            "The local Parakeet speech model is not installed on this device. Use Text for now."
                .into(),
        );
    }
    let mut config = OfflineRecognizerConfig::default();
    config.model_config.nemo_ctc.model = Some(
        directory
            .join("model.int8.onnx")
            .to_string_lossy()
            .into_owned(),
    );
    config.model_config.tokens = Some(directory.join("tokens.txt").to_string_lossy().into_owned());
    config.model_config.num_threads = 2;
    let recognizer =
        OfflineRecognizer::create(&config).ok_or("Could not load the local speech model")?;
    let mut words = Vec::new();
    // Bound inference memory like Sprout's local speech pipeline.
    for chunk in samples.chunks(16_000 * 30) {
        let stream = recognizer.create_stream();
        stream.accept_waveform(16_000, chunk);
        recognizer.decode(&stream);
        if let Some(result) = stream.get_result() {
            let text = result.text.trim();
            if !text.is_empty() {
                words.push(text.to_owned());
            }
        }
    }
    let text = words.join(" ");
    if text.is_empty() {
        Err("No speech was detected. Try recording again.".into())
    } else {
        Ok(text)
    }
}

#[tauri::command]
pub(crate) async fn agent_instruction_transcribe<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    audio: String,
) -> Result<String, String> {
    let permit = TRANSCRIBING
        .try_acquire()
        .map_err(|_| "A recording is already being transcribed. Try again shortly.")?;
    if audio.len() > (44 + MAX_SAMPLES * 2).div_ceil(3) * 4 {
        return Err("Recording exceeds two minutes".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio)
        .map_err(|_| "Invalid recording")?;
    let samples = decode_wav(&bytes)?;
    let directory = app
        .path()
        .home_dir()
        .map_err(|_| "Could not locate local speech models")?
        .join(".buzz/models/parakeet-tdt-ctc-110m-en");
    // Permit lives in the blocking job, so a closed UI cannot admit overlapping inference.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        transcribe(&directory, &samples)
    })
    .await
    .map_err(|_| "Local transcription stopped unexpectedly".to_owned())?
}

pub(crate) fn request(model: &str, transcript: &str) -> (&'static str, Value) {
    use buzz_agent::model_capabilities::{resolve, DatabricksV2Route};
    match resolve("databricks_v2", model).databricks_v2_wire_route {
        DatabricksV2Route::OpenaiResponses => (
            "/ai-gateway/openai/v1/responses",
            json!({"model":model,"instructions":PROMPT,"input":transcript,"max_output_tokens":4096,"store":false}),
        ),
        DatabricksV2Route::AnthropicMessages => (
            "/ai-gateway/anthropic/v1/messages",
            json!({"model":model,"system":PROMPT,"messages":[{"role":"user","content":transcript}],"max_tokens":4096}),
        ),
        _ => (
            "/ai-gateway/mlflow/v1/chat/completions",
            json!({"model":model,"messages":[{"role":"system","content":PROMPT},{"role":"user","content":transcript}],"max_tokens":4096}),
        ),
    }
}
fn response(value: &Value) -> Result<String, String> {
    if value["status"] == "incomplete"
        || value["stop_reason"] == "max_tokens"
        || value["choices"][0]["finish_reason"] == "length"
    {
        return Err("The instruction draft was cut short. Try a shorter description.".into());
    }
    let mut text = Vec::new();
    if let Some(content) = value["choices"][0]["message"]["content"].as_str() {
        text.push(content);
    }
    if let Some(content) = value["content"].as_array() {
        for item in content {
            if item["type"] == "text" {
                if let Some(t) = item["text"].as_str() {
                    text.push(t);
                }
            }
        }
    }
    if let Some(output) = value["output"].as_array() {
        for message in output {
            if message["type"] == "message" {
                if let Some(content) = message["content"].as_array() {
                    for item in content {
                        if item["type"] == "output_text" {
                            if let Some(t) = item["text"].as_str() {
                                text.push(t);
                            }
                        }
                    }
                }
            }
        }
    }
    let text = text.join("\n").trim().to_owned();
    if text.is_empty() || text.len() > 32_000 {
        Err("The model did not return an instruction draft. Try again.".into())
    } else {
        Ok(text)
    }
}

#[tauri::command]
pub(crate) async fn agent_instruction_generate(
    agents: tauri::State<'_, crate::agents::AgentHost>,
    models: tauri::State<'_, crate::agent_models::ModelHost>,
    transcript: String,
) -> Result<String, String> {
    let _permit = GENERATING
        .try_acquire()
        .map_err(|_| "An instruction draft is still being prepared. Try again shortly.")?;
    if transcript.trim().is_empty() || transcript.len() > 24_000 {
        return Err("Describe your agent in up to two minutes".into());
    }
    let (model, context) = agents.instruction_model_context().await?;
    let workspace = buzz_agent_controller::connection::origin(
        context
            .host
            .as_deref()
            .ok_or("Set the workspace in Agent defaults")?,
    )?;
    let auth = models.instruction_auth(&workspace)?;
    tokio::time::timeout(
        Duration::from_secs(120),
        complete(&workspace, &model, &transcript, auth),
    )
    .await
    .map_err(|_| "Instruction drafting timed out. Your transcript is ready to retry.".to_owned())?
}
async fn complete(
    workspace: &str,
    model: &str,
    transcript: &str,
    auth: Arc<buzz_agent::auth::PkceOAuthTokenSource>,
) -> Result<String, String> {
    use buzz_agent::auth::TokenSource;
    use futures_util::StreamExt;
    let (path, body) = request(model, transcript);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(100))
        .build()
        .map_err(|_| "Could not prepare the model request")?;
    let mut token = auth
        .bearer_no_browser()
        .await
        .map_err(|_| "Connect Databricks in the model picker, then retry your transcript")?;
    for attempt in 0..2 {
        let reply = client
            .post(format!("{workspace}{path}"))
            .bearer_auth(&token)
            .header("Content-Type", "application/json")
            .header("anthropic-version", "2023-06-01")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| {
                "Could not reach your default model. Your transcript is ready to retry."
            })?;
        if reply.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            token = auth
                .refresh_now(&token)
                .await
                .map_err(|_| "Reconnect Databricks in the model picker, then retry")?;
            continue;
        }
        if !reply.status().is_success() {
            return Err(format!(
                "Your default model returned {}. Your transcript is ready to retry.",
                reply.status().as_u16()
            ));
        }
        let mut stream = reply.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "The model response was interrupted")?;
            if bytes.len() + chunk.len() > 1_048_576 {
                return Err("The model response was too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        return response(
            &serde_json::from_slice(&bytes)
                .map_err(|_| "The model returned an unreadable response")?,
        );
    }
    Err("Reconnect Databricks, then retry".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_recording_before_inference() {
        assert!(decode_wav(&[]).is_err());
        assert!(decode_wav(&vec![0; 44 + MAX_SAMPLES * 2 + 2]).is_err());
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend(38u32.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(16000u32.to_le_bytes());
        wav.extend(32000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(2u32.to_le_bytes());
        wav.extend(16384i16.to_le_bytes());
        assert_eq!(decode_wav(&wav).unwrap(), vec![0.5]);
        wav[24] = 1;
        assert!(decode_wav(&wav).is_err());
    }
    #[test]
    fn routes_default_models_and_extracts_only_final_text() {
        assert!(request("system.ai.gpt-6-1-sol", "description")
            .0
            .ends_with("/responses"));
        assert!(request("system.ai.claude-opus-4-6", "description")
            .0
            .ends_with("/messages"));
        assert_eq!(response(&json!({"output":[{"type":"reasoning","content":[{"text":"hidden"}]},{"type":"message","content":[{"type":"output_text","text":"Be helpful."}]}]})).unwrap(), "Be helpful.");
        assert!(response(&json!({"status":"incomplete","output":[]})).is_err());
        assert_eq!(
            response(&json!({"content":[{"type":"text","text":"Instructions"}]})).unwrap(),
            "Instructions"
        );
    }
    #[tokio::test]
    #[ignore = "explicit live default-model check; requires app-isolated sign-in"]
    async fn connected_default_drafts_instructions() {
        let root = std::path::PathBuf::from(std::env::var("BUZZ_INSTRUCTION_TEST_ROOT").unwrap());
        let workspace = std::env::var("BUZZ_INSTRUCTION_TEST_WORKSPACE").unwrap();
        let model = std::env::var("BUZZ_INSTRUCTION_TEST_MODEL").unwrap();
        let host = crate::agent_models::ModelHost::new(Ok(root));
        let auth = host.instruction_auth(&workspace).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(120), complete(&workspace, &model,
            "Help me plan weekend walks. Ask about my available time and suggest a short route. Keep replies concise.", auth)).await.unwrap().unwrap();
        assert!(result.to_lowercase().contains("walk"));
        println!(
            "Default-model instruction drafting succeeded ({} characters)",
            result.len()
        );
    }
    #[test]
    #[ignore = "requires the locally installed Parakeet model and its sample"]
    fn installed_model_transcribes_sample() {
        let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap())
            .join(".buzz/models/parakeet-tdt-ctc-110m-en");
        let file = std::fs::read_dir(dir.join("test_wavs"))
            .unwrap()
            .find_map(|e| {
                let p = e.ok()?.path();
                (p.extension()? == "wav").then_some(p)
            })
            .unwrap();
        let bytes = std::fs::read(file).unwrap();
        // Upstream fixture has a conventional PCM header.
        let samples = decode_wav(&bytes).unwrap();
        let text = transcribe(&dir, &samples).unwrap();
        assert!(!text.is_empty());
        println!("Local fixture transcript: {text}");
    }
}
