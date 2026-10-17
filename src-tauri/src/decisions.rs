//! The app's decision service. Callers ask typed questions about a piece of
//! text: yes/no, a choice from fixed options, or a level on a scale. One
//! backend answers them in one call. The webview picks the backend; native
//! owns the endpoints, credentials, limits and answer checks, so every backend
//! returns the same checked answers or the same failure reasons.
//!
//! - `block`: Jev (TypeSafe System One) through Block's KGoose, pinned to the
//!   model Attention was tuned on. No key: the laptop's Block sign-in admits it.
//! - `block-openai`: OpenAI Decisions through KGoose, on its default model.
//! - `typesafe`: Jev called directly with the user's own TypeSafe key, which
//!   only native code reads (see `jev.rs`).
use crate::jev::JevHost;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Semaphore;

pub(crate) const JEV_MODEL: &str = crate::jev::MODEL;
const BLOCK_JEV: &str = "https://kgoose.sqprod.co/cash-app/goose-cash/v3/jev/systemone";
const BLOCK_OPENAI: &str = "https://kgoose.sqprod.co/cash-app/goose/v3/openai/decisions";
const TYPESAFE: &str = "https://api.typesafe.ai/v1/systemone";
/// KGoose attributes spend to this app id.
const APP_ID: &str = "buzz-app";
const INPUT_LIMIT: usize = 128 * 1024;
const RESPONSE_LIMIT: usize = 64 * 1024;
const MAX_QUESTIONS: usize = 32;
const NAME_LIMIT: usize = 64;
/// Calls past this wait for a slot inside their deadline.
const MAX_IN_FLIGHT: usize = 16;
const TIMEOUT: Duration = Duration::from_secs(30);
const MIN_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Backend {
    Block,
    BlockOpenai,
    Typesafe,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Question {
    YesNo {
        instructions: String,
    },
    /// Option value -> when to pick it.
    Choice {
        instructions: String,
        options: BTreeMap<String, String>,
    },
    /// Level labels, lowest first.
    Score {
        instructions: String,
        levels: Vec<String>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub(crate) state: String,
    pub(crate) questions: BTreeMap<String, Question>,
    /// How long the caller waits, at most 30 seconds.
    #[serde(default)]
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum Answer {
    YesNo {
        probability: f64,
    },
    Choice {
        choice: String,
        confidence: f64,
        /// Option value -> probability.
        probabilities: BTreeMap<String, f64>,
    },
    Score {
        /// Where the answer falls on the 0-based scale; it can be fractional.
        score: f64,
        confidence: f64,
        /// Level index ("0", "1", …) -> probability.
        probabilities: BTreeMap<String, f64>,
    },
}

/// Why a decision has no answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Failure {
    /// `typesafe` has no saved key.
    MissingCredentials,
    /// The service refused the caller: a refused key, or no Block sign-in.
    Unauthorized,
    /// The questions are malformed, or the service rejected them.
    InvalidRequest,
    InputLimit,
    Timeout,
    ServiceError,
    InvalidResponse,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum Decided {
    Answered {
        backend: Backend,
        model: String,
        answers: BTreeMap<String, Answer>,
    },
    Failed {
        backend: Backend,
        reason: Failure,
    },
}

pub(crate) struct Endpoints {
    pub(crate) block: String,
    pub(crate) block_openai: String,
    pub(crate) typesafe: String,
}

pub(crate) struct DecisionsHost {
    endpoints: Endpoints,
    slots: Arc<Semaphore>,
    timeout: Duration,
}

impl DecisionsHost {
    pub(crate) fn new() -> Self {
        Self::with(
            Endpoints {
                block: BLOCK_JEV.into(),
                block_openai: BLOCK_OPENAI.into(),
                typesafe: TYPESAFE.into(),
            },
            TIMEOUT,
        )
    }
    pub(crate) fn with(endpoints: Endpoints, timeout: Duration) -> Self {
        Self {
            endpoints,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            timeout,
        }
    }

    /// One call to one backend. The wait for a slot, the key read, the call
    /// and the response read share one deadline. Nothing is retried, and a
    /// failed backend never falls back to another.
    pub(crate) async fn decide(
        &self,
        keys: &JevHost,
        backend: Backend,
        request: Request,
    ) -> Decided {
        let failed = |reason| Decided::Failed { backend, reason };
        if let Err(reason) = validate(&request) {
            return failed(reason);
        }
        let body = match encode(backend, &request) {
            Ok(body) if body.len() <= INPUT_LIMIT => body,
            Ok(_) => return failed(Failure::InputLimit),
            Err(reason) => return failed(reason),
        };
        let timeout = request
            .timeout_ms
            .map(Duration::from_millis)
            .map_or(self.timeout, |t| t.clamp(MIN_TIMEOUT, self.timeout));
        let deadline = Instant::now() + timeout;
        let call = async {
            let _slot = self
                .slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| Failure::ServiceError)?;
            let key = match backend {
                Backend::Typesafe => match keys.key().await {
                    Ok(Some(key)) => Some(key),
                    Ok(None) => return Err(Failure::MissingCredentials),
                    // Unreadable is not absent: the key may still be saved.
                    Err(_) => return Err(Failure::ServiceError),
                },
                _ => None,
            };
            let endpoint = match backend {
                Backend::Block => &self.endpoints.block,
                Backend::BlockOpenai => &self.endpoints.block_openai,
                Backend::Typesafe => &self.endpoints.typesafe,
            };
            let client = client().ok_or(Failure::ServiceError)?;
            let mut post = client
                .post(endpoint)
                .header("content-type", "application/json")
                .header("accept", "application/json");
            match &key {
                Some(key) => post = post.bearer_auth(key.as_str()),
                None => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    post = post
                        .header("x-app-id", APP_ID)
                        .header("x-jev-deadline-ms", left.as_millis().max(1).to_string());
                }
            }
            let response = post
                .body(body)
                .send()
                .await
                .map_err(|_| Failure::ServiceError)?;
            let status = response.status().as_u16();
            match status {
                200 => {}
                // A KGoose call without a Block sign-in is redirected to it.
                300..=399 | 401 | 403 => {
                    if key.is_some() {
                        // The key may have been removed or replaced elsewhere.
                        keys.forget().await;
                    }
                    return Err(Failure::Unauthorized);
                }
                400 | 422 => return Err(Failure::InvalidRequest),
                _ => return Err(Failure::ServiceError),
            }
            let bytes = read_limited(response).await?;
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidResponse)?;
            decode(backend, &request, &value)
        };
        match tokio::time::timeout_at(deadline.into(), call).await {
            Ok(Ok((model, answers))) => Decided::Answered {
                backend,
                model,
                answers,
            },
            Ok(Err(reason)) => failed(reason),
            Err(_) => failed(Failure::Timeout),
        }
    }
}

/// The limits every backend accepts.
fn validate(request: &Request) -> Result<(), Failure> {
    let text = |s: &str| !s.trim().is_empty();
    if !text(&request.state) || request.questions.is_empty() {
        return Err(Failure::InvalidRequest);
    }
    if request.questions.len() > MAX_QUESTIONS {
        return Err(Failure::InvalidRequest);
    }
    for (name, question) in &request.questions {
        if !text(name) || name.chars().count() > NAME_LIMIT {
            return Err(Failure::InvalidRequest);
        }
        let ok = match question {
            Question::YesNo { instructions } => text(instructions),
            Question::Choice {
                instructions,
                options,
            } => {
                text(instructions)
                    && (2..=255).contains(&options.len())
                    && options.keys().all(|value| text(value))
            }
            Question::Score {
                instructions,
                levels,
            } => {
                text(instructions)
                    && (2..=10).contains(&levels.len())
                    && levels.iter().all(|l| text(l))
            }
        };
        if !ok {
            return Err(Failure::InvalidRequest);
        }
    }
    Ok(())
}

fn instructions(question: &Question) -> &str {
    match question {
        Question::YesNo { instructions }
        | Question::Choice { instructions, .. }
        | Question::Score { instructions, .. } => instructions,
    }
}

fn encode(backend: Backend, request: &Request) -> Result<Vec<u8>, Failure> {
    let body = match backend {
        // KGoose's Jev surface: one field per question type.
        Backend::Block => {
            let questions: serde_json::Map<String, Value> = request
                .questions
                .iter()
                .map(|(name, q)| {
                    let typed = match q {
                        Question::YesNo { .. } => ("noul", json!({})),
                        Question::Choice { options, .. } => {
                            ("choice", json!({ "options": options }))
                        }
                        Question::Score { levels, .. } => ("score", json!({ "levels": levels })),
                    };
                    (
                        name.clone(),
                        json!({ "instructions": instructions(q), typed.0: typed.1 }),
                    )
                })
                .collect();
            json!({ "state": request.state, "model": JEV_MODEL, "questions": questions })
        }
        // KGoose's OpenAI Decisions surface: an ordered list of named questions.
        Backend::BlockOpenai => {
            let questions: Vec<Value> = request
                .questions
                .iter()
                .map(|(name, q)| {
                    let mut question = json!({ "name": name, "instructions": instructions(q) });
                    let (key, typed) = match q {
                        Question::YesNo { .. } => ("predicate", json!({})),
                        Question::Choice { options, .. } => (
                            "choice",
                            json!({ "choices": options
                                .iter()
                                .map(|(value, description)| json!({ "value": value, "description": description }))
                                .collect::<Vec<_>>() }),
                        ),
                        Question::Score { levels, .. } => ("score", json!({ "levels": levels })),
                    };
                    question[key] = typed;
                    question
                })
                .collect();
            json!({ "input": request.state, "questions": questions })
        }
        // TypeSafe's own `/v1/systemone`: a `type` and its `criteria`.
        Backend::Typesafe => {
            let questions: serde_json::Map<String, Value> = request
                .questions
                .iter()
                .map(|(name, q)| {
                    let question = match q {
                        Question::YesNo { instructions } => {
                            json!({ "type": "noul", "instructions": instructions })
                        }
                        Question::Choice {
                            instructions,
                            options,
                        } => json!({ "type": "choice", "instructions": instructions, "criteria": options }),
                        Question::Score {
                            instructions,
                            levels,
                        } => json!({ "type": "score", "instructions": instructions, "criteria": levels }),
                    };
                    (name.clone(), question)
                })
                .collect();
            json!({ "state": request.state, "model": JEV_MODEL, "questions": questions })
        }
    };
    serde_json::to_vec(&body).map_err(|_| Failure::InputLimit)
}

fn unit(value: Option<&Value>) -> Result<f64, Failure> {
    match value.and_then(Value::as_f64) {
        Some(p) if (0.0..=1.0).contains(&p) => Ok(p),
        _ => Err(Failure::InvalidResponse),
    }
}

/// The answers, checked against the questions: every question answered with
/// its own type, a known choice, a level on the scale, values within 0–1.
fn decode(
    backend: Backend,
    request: &Request,
    value: &Value,
) -> Result<(String, BTreeMap<String, Answer>), Failure> {
    let model = value
        .get("model")
        .and_then(Value::as_str)
        .ok_or(Failure::InvalidResponse)?
        .to_owned();
    if backend != Backend::BlockOpenai && model != JEV_MODEL {
        return Err(Failure::InvalidResponse);
    }
    let raw: BTreeMap<String, &Value> = match (backend, value.get("answers")) {
        (Backend::BlockOpenai, Some(Value::Array(list))) => list
            .iter()
            .map(|answer| {
                let name = answer.get("name").and_then(Value::as_str);
                name.map(|n| (n.to_owned(), answer))
                    .ok_or(Failure::InvalidResponse)
            })
            .collect::<Result<_, _>>()?,
        (Backend::Block | Backend::Typesafe, Some(Value::Object(map))) => {
            map.iter().map(|(n, a)| (n.clone(), a)).collect()
        }
        _ => return Err(Failure::InvalidResponse),
    };
    let mut answers = BTreeMap::new();
    for (name, question) in &request.questions {
        let answer = raw.get(name).copied().ok_or(Failure::InvalidResponse)?;
        // The typed body: KGoose wraps it under the type's field; TypeSafe
        // puts it beside a `type` tag.
        let (body, kind) = match backend {
            Backend::Typesafe => (answer, answer.get("type").and_then(Value::as_str)),
            Backend::Block => ["noul", "choice", "score"]
                .into_iter()
                .find_map(|k| answer.get(k).map(|b| (b, Some(k))))
                .ok_or(Failure::InvalidResponse)?,
            Backend::BlockOpenai => ["predicate", "choice", "score"]
                .into_iter()
                .find_map(|k| answer.get(k).map(|b| (b, Some(k))))
                .ok_or(Failure::InvalidResponse)?,
        };
        let decoded = match (question, kind) {
            (Question::YesNo { .. }, Some("noul")) => Answer::YesNo {
                probability: unit(match backend {
                    Backend::Typesafe => body.get("noul"),
                    _ => body.get("value"),
                })?,
            },
            (Question::YesNo { .. }, Some("predicate")) => Answer::YesNo {
                probability: unit(body.get("probability"))?,
            },
            (Question::Choice { options, .. }, Some("choice")) => {
                let choice = body
                    .get("choice")
                    .and_then(Value::as_str)
                    .filter(|c| options.contains_key(*c))
                    .ok_or(Failure::InvalidResponse)?
                    .to_owned();
                let probabilities = list_or_map(body.get("probabilities"), "value", |key| {
                    options.contains_key(key)
                })?;
                Answer::Choice {
                    choice,
                    confidence: unit(body.get("confidence"))?,
                    probabilities,
                }
            }
            (Question::Score { levels, .. }, Some("score")) => {
                let score = body
                    .get("score")
                    .and_then(Value::as_f64)
                    .filter(|s| *s >= 0.0 && *s <= (levels.len() - 1) as f64)
                    .ok_or(Failure::InvalidResponse)?;
                let in_scale = |key: &str| key.parse::<usize>().is_ok_and(|i| i < levels.len());
                let probabilities = list_or_map(body.get("probabilities"), "level", in_scale)?;
                Answer::Score {
                    score,
                    confidence: unit(body.get("confidence"))?,
                    probabilities,
                }
            }
            _ => return Err(Failure::InvalidResponse),
        };
        answers.insert(name.clone(), decoded);
    }
    Ok((model, answers))
}

/// Probabilities as a map (Jev) or a list of `{<key>, probability}` (OpenAI),
/// with every key known to the question. Missing means none were reported.
fn list_or_map(
    value: Option<&Value>,
    key: &str,
    known: impl Fn(&str) -> bool,
) -> Result<BTreeMap<String, f64>, Failure> {
    let check = |k: String, p: Option<&Value>| -> Result<(String, f64), Failure> {
        if !known(&k) {
            return Err(Failure::InvalidResponse);
        }
        Ok((k, unit(p)?))
    };
    match value {
        None | Some(Value::Null) => Ok(BTreeMap::new()),
        Some(Value::Object(map)) => map.iter().map(|(k, p)| check(k.clone(), Some(p))).collect(),
        Some(Value::Array(list)) => list
            .iter()
            .map(|entry| {
                let k = match entry.get(key) {
                    Some(Value::String(s)) => s.clone(),
                    Some(Value::Number(n)) => n.to_string(),
                    _ => return Err(Failure::InvalidResponse),
                };
                check(k, entry.get("probability"))
            })
            .collect(),
        _ => Err(Failure::InvalidResponse),
    }
}

async fn read_limited(mut response: reqwest::Response) -> Result<Vec<u8>, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::ServiceError)? {
        if bytes.len() + chunk.len() > RESPONSE_LIMIT {
            return Err(Failure::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn client() -> Option<&'static reqwest::Client> {
    static CLIENT: std::sync::OnceLock<Option<reqwest::Client>> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // A redirect is KGoose asking for a Block sign-in; never follow it.
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .build()
                .ok()
        })
        .as_ref()
}

#[tauri::command]
pub(crate) async fn decide(
    keys: tauri::State<'_, JevHost>,
    host: tauri::State<'_, DecisionsHost>,
    backend: Backend,
    request: Request,
) -> Result<Decided, String> {
    Ok(host.decide(&keys, backend, request).await)
}

#[cfg(test)]
#[path = "decisions_tests.rs"]
mod tests;
