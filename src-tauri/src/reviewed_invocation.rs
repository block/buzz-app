//! Native call ownership and retirement for plugin host operations.
//! Trusted host-renderer approval; native retains immutable request and effect admission.
#[cfg(debug_assertions)]
pub(crate) mod fixture;
#[cfg(test)]
mod tests;

use crate::{
    app_agents::{AppAgentEvent, Custody, Sent},
    federated_identity::agent::Admission,
    host_request::{CredentialHttp, HostCalls, HostResponse, Once},
    relay::Prepared,
    with_manager, PluginManager,
};
#[cfg(test)]
use buzzodz_plugins::Manager;
use buzzodz_plugins::{
    secrets::{PreparedSecret, Refusal},
    ReviewedInvocation, ReviewedInvocationWitness,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

const REFUSED: &str = "Reviewed invocation is unavailable or retired";
const UNKNOWN: &str = "Reviewed invocation consumed; outcome unknown";
const REVIEW_BUDGET: Duration = Duration::from_secs(120);
/// The longest a parent read waits outside its fences before asking again.
const BUSY_WAIT: Duration = Duration::from_millis(25);
const EXECUTION_BUDGET: Duration = Duration::from_secs(5);
/// Why a parent read was refused, named by the boundary that observed it, never
/// by a guessed cause. The plugin receives only the fixed versioned message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReadFailure {
    Admission,
    Fence,
    Timeout,
    Transport,
    Status,
    Response,
    Retired,
    Interrupted,
}
impl ReadFailure {
    pub(crate) fn message(self) -> String {
        let code = match self {
            Self::Admission => "native-admission",
            Self::Fence => "native-fence",
            Self::Timeout => "native-timeout",
            Self::Transport => "native-transport",
            Self::Status => "native-status",
            Self::Response => "native-response",
            Self::Retired => "native-retired",
            Self::Interrupted => "native-interrupted",
        };
        format!("host-parent-read/v1/{code}")
    }
}
impl From<crate::host_request::CredentialFailure> for ReadFailure {
    fn from(failure: crate::host_request::CredentialFailure) -> Self {
        use crate::host_request::CredentialFailure;
        match failure {
            CredentialFailure::Transport => Self::Transport,
            CredentialFailure::Status => Self::Status,
            CredentialFailure::Response => Self::Response,
        }
    }
}
/// Generic ceiling for parent reads; Creative chooses its cadence within it.
const MAX_READS: u32 = 120;
/// How long one created call's worker stays open for its parent reads.
const WINDOW: Duration = Duration::from_secs(600);
/// Test-only shorter window for the next call created in this channel.
#[cfg(test)]
pub(crate) static TEST_WINDOW: std::sync::Mutex<Option<(String, Duration)>> =
    std::sync::Mutex::new(None);
/// Test-only gate: a parent read of the armed call that met a held lock hands
/// the test a release before it waits, holding it outside every fence.
#[cfg(test)]
pub(crate) static BUSY_GATES: std::sync::Mutex<
    Option<HashMap<String, tokio::sync::mpsc::UnboundedSender<tokio::sync::oneshot::Sender<()>>>>,
> = std::sync::Mutex::new(None);
#[cfg(test)]
async fn busy_gate(call: &str) {
    let gate = BUSY_GATES
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|gates| gates.get(call).cloned());
    if let Some(gate) = gate {
        let (release, released) = tokio::sync::oneshot::channel();
        if gate.send(release).is_ok() {
            let _ = released.await;
        }
    }
}
/// Test-only per-call gates on a parent read's path past the busy wait.
#[cfg(test)]
pub(crate) mod read_gates {
    use std::{
        collections::HashMap,
        sync::{Arc, Condvar, Mutex},
        time::Duration,
    };
    /// A gate the test never releases opens itself after this, so a failing
    /// test cannot hold a runtime thread or a fence forever.
    const BOUND: Duration = Duration::from_secs(10);
    type Release = tokio::sync::oneshot::Sender<()>;
    #[derive(Default)]
    pub(crate) struct Enqueue {
        /// The read's end once admission reached the gate, and the release.
        state: Mutex<(Option<tokio::time::Instant>, bool)>,
        changed: Condvar,
    }
    impl Enqueue {
        /// Waits for a read to reach the gate, returning its end.
        pub(crate) fn entered(&self, within: Duration) -> Option<tokio::time::Instant> {
            let state = self.state.lock().unwrap();
            let (state, _) = self
                .changed
                .wait_timeout_while(state, within, |(end, _)| end.is_none())
                .unwrap();
            state.0
        }
        pub(crate) fn release(&self) {
            self.state.lock().unwrap().1 = true;
            self.changed.notify_all();
        }
    }
    #[derive(Clone)]
    pub(crate) struct Worker {
        /// Each held dispatch, with its read's end.
        pub(crate) dispatch: tokio::sync::mpsc::UnboundedSender<(Release, tokio::time::Instant)>,
        pub(crate) finished: tokio::sync::mpsc::UnboundedSender<()>,
    }
    pub(crate) static ENQUEUE: Mutex<Option<HashMap<String, Arc<Enqueue>>>> = Mutex::new(None);
    pub(crate) static WORKER: Mutex<Option<HashMap<String, Worker>>> = Mutex::new(None);
    /// Holds admission synchronously, inside every fence, before its final check.
    pub(super) fn enqueue(call: &str, end: tokio::time::Instant) {
        let gate = ENQUEUE
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|gates| gates.get(call).cloned());
        let Some(gate) = gate else { return };
        let mut state = gate.state.lock().unwrap();
        state.0 = Some(end);
        gate.changed.notify_all();
        let _ = gate
            .changed
            .wait_timeout_while(state, BOUND, |(_, released)| !*released)
            .unwrap();
    }
    /// Holds a dequeued text read before the worker dispatches it.
    pub(super) async fn dispatch(call: &str, end: tokio::time::Instant) {
        if let Some(gate) = worker(call) {
            let (release, released) = tokio::sync::oneshot::channel();
            if gate.dispatch.send((release, end)).is_ok() {
                let _ = tokio::time::timeout(BOUND, released).await;
            }
        }
    }
    /// The worker has finished a text read, its handoff included.
    pub(super) fn finished(call: &str) {
        if let Some(gate) = worker(call) {
            let _ = gate.finished.send(());
        }
    }
    fn worker(call: &str) -> Option<Worker> {
        WORKER
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|gates| gates.get(call).cloned())
    }
}
/// Which end a parent read has passed, the parent window first on a tie.
fn expired(
    deadline: tokio::time::Instant,
    end: tokio::time::Instant,
    now: tokio::time::Instant,
) -> Option<ReadFailure> {
    if now < deadline.min(end) {
        None
    } else if deadline <= end {
        Some(ReadFailure::Admission)
    } else {
        Some(ReadFailure::Timeout)
    }
}
fn window(channel: &str) -> Duration {
    #[cfg(test)]
    if let Some((_, window)) = TEST_WINDOW
        .lock()
        .unwrap()
        .take_if(|(armed, _)| armed == channel)
    {
        return window;
    }
    let _ = channel;
    WINDOW
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Destination {
    community: String,
    viewer: String,
    channel: String,
    #[serde(
        default,
        deserialize_with = "present_root",
        skip_serializing_if = "Option::is_none"
    )]
    root: Option<String>,
}
fn present_root<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    operation: String,
    body: String,
    destination: Destination,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effect: Option<CredentialHttp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    disclosure: Option<Disclosure>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expected_media: Option<ExpectedMedia>,
}
/// The agent membership the app attests started this review; native fences
/// its custody, not who called the tool.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Author {
    pubkey: String,
    relay: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Disclosure {
    version: String,
    text: String,
}
/// The approved result's generic shape, frozen into the digest before review.
/// Final decoding is not optional, so it has no flag.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedMedia {
    version: u32,
    kind: String,
    container: String,
    codec: String,
    width: u32,
    height: u32,
    duration_ms: u32,
    tolerance_ms: u32,
    max_bytes: u32,
}
impl ExpectedMedia {
    fn strict(&self) -> Result<crate::relay::StrictVideo, String> {
        if self.version != 1
            || self.kind != "video"
            || self.container != "mp4"
            || self.codec != "h264"
        {
            return Err(REFUSED.into());
        }
        crate::relay::strict_video(
            self.width,
            self.height,
            self.duration_ms,
            self.tolerance_ms,
            self.max_bytes,
        )
        .ok_or_else(|| REFUSED.into())
    }
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        buzzodz_plugins::valid_id(&self.operation)?;
        match (&self.version, &self.effect, &self.disclosure) {
            (None, None, None) if self.expected_media.is_none() => {}
            (Some(1), Some(effect), Some(disclosure)) => {
                if disclosure.version.is_empty()
                    || disclosure.version.len() > 80
                    || disclosure.version.chars().any(char::is_control)
                    || disclosure.text.is_empty()
                    || disclosure.text.len() > 8 * 1024
                    || disclosure.text.contains('\0')
                {
                    return Err(REFUSED.into());
                }
                effect.validate(&self.body)?;
                self.expected_media
                    .as_ref()
                    .map(ExpectedMedia::strict)
                    .transpose()?;
            }
            _ => return Err(REFUSED.into()),
        }
        if self.body.is_empty()
            || self.body.len() > 32 * 1024
            || self.body.contains('\0')
            || [
                &self.destination.community,
                &self.destination.viewer,
                &self.destination.channel,
            ]
            .into_iter()
            .chain(self.destination.root.iter())
            .any(|part| {
                part.is_empty()
                    || part.len() > 256
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_:/.".contains(&b))
            })
        {
            return Err("Invalid reviewed invocation".into());
        }
        Ok(())
    }
    fn digest(&self, author: Option<&Author>) -> String {
        let bytes = match author {
            None => serde_json::to_vec(self),
            Some(author) => serde_json::to_vec(&(self, author)),
        };
        format!("{:x}", Sha256::digest(bytes.expect("string request")))
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Receipt {
    call_id: String,
    destination: Destination,
    digest: String,
    outcome: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery: Option<Delivery>,
}
/// What the one upload and the one attachment message became. Posted means
/// the community accepted that exact event, not that its media plays; an
/// unsigned message is a failure, whatever the upload did.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Delivery {
    upload: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
}
fn known<T>(sent: &Sent<T>, done: &'static str) -> &'static str {
    match sent {
        Sent::Done(_) => done,
        Sent::Failed => "failed",
        Sent::Unknown => "unknown",
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Projection {
    call_id: String,
    plugin_id: String,
    revision: String,
    request: Request,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<Author>,
    digest: String,
    expires_at: u64,
    /// Host-derived from the admitted grant: one result may be downloaded
    /// from a URL its service's response names.
    #[serde(skip_serializing_if = "Option::is_none")]
    result_url: Option<u32>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateResponse {
    version: u32,
    call_id: String,
    digest: String,
    destination: Destination,
    sequence: u32,
    phase: &'static str,
    status: u16,
    safe_body: String,
}
/// A plugin's reference to the approved create it continues. Not authority.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParentRef {
    version: u32,
    call_id: String,
}
impl ParentRef {
    fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || uuid::Uuid::parse_str(&self.call_id).map_or(true, |v| v.to_string() != self.call_id)
        {
            return Err(REFUSED.into());
        }
        Ok(())
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Correlation {
    version: u32,
    call_id: String,
    digest: String,
    destination: Destination,
    sequence: u32,
}
/// Which observed response's named result to download. Not a URL or authority.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ResultRef {
    version: u32,
    sequence: u32,
}
pub(crate) struct ParentRead<'a> {
    pub(crate) id: &'a str,
    pub(crate) revision: &'a str,
    pub(crate) url: &'a str,
    /// Fixed when the caller's request entered; never refreshed after waits.
    pub(crate) end: tokio::time::Instant,
}
/// Authority retained from one approved create. Attached at its create-response
/// handoff; the create worker itself performs every admitted read.
struct Parent {
    authority: Arc<Authority>,
    deadline: tokio::time::Instant,
    reads: u32,
    reading: bool,
    stage: Stage,
    /// The latest authenticated 200 response's URL at the grant's pointer.
    /// Native only; replaced by every new read, never kept as history.
    selected: Option<(u32, reqwest::Url)>,
    jobs: tokio::sync::mpsc::Sender<Job>,
}
/// The one result attempt, in order. Nothing moves backwards or retries.
enum Stage {
    Open,
    Consumed,
    Retained(Source),
    Preparing,
    /// A selection was consumed without a prepared result.
    Failed,
    Prepared(Prepared),
    /// The worker holds the file through its one upload.
    Uploading,
    /// The file and its URL stay until its one message settles.
    Uploaded(Prepared, String),
    Publishing,
}
/// The one retained result source. The single unfinished Entry bounds it;
/// it holds no byte admission.
struct Source {
    bytes: Vec<u8>,
    sha256: String,
}
/// The callback's selection of the retained source, or the prepared file's
/// facts. A reference, not bytes.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SourceRef {
    sha256: String,
    size: usize,
}
/// The callback's next step for its own original call: references, never
/// bytes, paths, identities or destinations.
#[derive(Deserialize)]
#[serde(tag = "phase", rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) enum Step {
    Prepare { source: SourceRef },
    Upload,
    Publish { event: AppAgentEvent },
}
/// Internal acknowledgement of the original call's stage: prepared, its media
/// uploaded as the agent, or its one message admitted. Not a result, delivery
/// or reusable handle.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ack {
    version: u32,
    call_id: String,
    digest: String,
    destination: Destination,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    prepared: Option<SourceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    upload: Option<Media>,
}
/// The uploaded prepared file, as the host attaches it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Media {
    url: String,
    r#type: &'static str,
    size: usize,
    sha256: String,
    dim: String,
}
struct Authority {
    expected: Option<crate::relay::StrictVideo>,
    revision: String,
    once: Once,
    digest: String,
    destination: Destination,
    effect: CredentialHttp,
    secret: Arc<PreparedSecret>,
    grant: ReviewedInvocation,
    witness: Arc<ReviewedInvocationWitness>,
    /// The agent whose review this is; without one, nothing is delivered.
    custody: Option<Custody>,
}
struct Read {
    outgoing: reqwest::RequestBuilder,
    correlation: Correlation,
    /// The read's one fixed end: never dispatched at or after it.
    end: tokio::time::Instant,
    reply: tokio::sync::oneshot::Sender<Result<HostResponse, ReadFailure>>,
}
type Reply = tokio::sync::oneshot::Receiver<Result<HostResponse, ReadFailure>>;
/// One credential-free result read. Byte admission covers transfer, commit
/// and the caller's frame construction, never retention.
struct Fetch {
    target: Target,
    correlation: Correlation,
    max_bytes: usize,
    admission: tokio::sync::SemaphorePermit<'static>,
    reply: tokio::sync::oneshot::Sender<Result<Fetched, String>>,
}
enum Target {
    Ready(reqwest::RequestBuilder),
    /// A selected public result, resolved by the worker before `end`.
    Public(reqwest::Url, tokio::time::Instant),
}
async fn fetch_result(
    target: Target,
    max_bytes: usize,
    current: impl Fn() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    const REFUSED: &str = "Result bytes unavailable; the attempt is consumed";
    let (url, end) = match target {
        Target::Ready(outgoing) => {
            return crate::host_request::read_result_bytes(outgoing, max_bytes).await
        }
        Target::Public(url, end) => (url, end),
    };
    // No lookup is authority: the original fences hold before it and again
    // after it, as the request is sent.
    let operation = async {
        current()?;
        let remaining = end.saturating_duration_since(tokio::time::Instant::now());
        let outgoing = crate::host_request::public_result_get(&url, remaining).await?;
        current()?;
        crate::host_request::read_result_bytes(outgoing, max_bytes).await
    };
    tokio::time::timeout_at(end, operation)
        .await
        .unwrap_or_else(|_| Err(REFUSED.into()))
}
pub(crate) struct Fetched {
    pub(crate) correlation: Correlation,
    pub(crate) sha256: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) admission: tokio::sync::SemaphorePermit<'static>,
}
type AckReply = tokio::sync::oneshot::Sender<Result<Ack, String>>;
struct Prepare {
    source: Source,
    expected: crate::relay::StrictVideo,
    ack: Ack,
    reply: AckReply,
}
enum Job {
    Text(Read),
    Bytes(Fetch),
    Prepare(Prepare),
    Upload(Prepared, AckReply),
    Publish(Prepared, String, AppAgentEvent),
}
/// File cleanup blocks; join it so nothing outlives retirement.
async fn discard<T: Send + 'static>(value: T) {
    let _ = tauri::async_runtime::spawn_blocking(move || drop(value)).await;
}
impl Authority {
    fn ack(&self, call: &str, phase: &'static str, upload: Option<Media>) -> Ack {
        Ack {
            version: 1,
            call_id: call.into(),
            digest: self.digest.clone(),
            destination: self.destination.clone(),
            phase,
            prepared: None,
            upload,
        }
    }
    /// Current page, viewer and exact reviewed enrollment in existing lock
    /// order. `admit` must only start or hand off bounded work.
    fn fenced<R: tauri::Runtime, T>(
        &self,
        app: &tauri::AppHandle<R>,
        label: &str,
        admit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.try_fenced(app, label, admit).map_err(Refusal::message)
    }
    /// One attempt at `fenced`, where only a momentarily held identity or
    /// metadata lock is `Busy`. A stale page is always terminal.
    fn try_fenced<R: tauri::Runtime, T>(
        &self,
        app: &tauri::AppHandle<R>,
        label: &str,
        admit: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, Refusal> {
        let calls = app.try_state::<HostCalls>().ok_or(REFUSED)?;
        let identity = app
            .try_state::<crate::identity::IdentityHost>()
            .ok_or(REFUSED)?;
        let manager = app.try_state::<PluginManager>().ok_or(REFUSED)?.0.clone()?;
        calls.with_current(label, &self.once, || {
            Ok(
                identity.try_with_current_viewer(&self.destination.viewer, || {
                    manager.try_reviewed_secret(&self.secret, &self.grant, &self.witness, admit)
                }),
            )
        })?
    }
}
impl Parent {
    /// Runs inside every fence. Admitted reads consume the budget whatever
    /// their outcome; nothing here resets it or re-enables create.
    fn next(&self, call: &str) -> Result<(u32, Duration, Correlation), String> {
        let remaining = self
            .deadline
            .saturating_duration_since(tokio::time::Instant::now());
        let reads = self.reads.checked_add(1).ok_or(REFUSED)?;
        if self.reading
            || reads > MAX_READS
            || remaining.is_zero()
            || !matches!(
                self.stage,
                Stage::Open | Stage::Consumed | Stage::Retained(_)
            )
        {
            return Err(REFUSED.into());
        }
        let correlation = Correlation {
            version: 1,
            call_id: call.into(),
            digest: self.authority.digest.clone(),
            destination: self.authority.destination.clone(),
            sequence: reads.checked_add(1).ok_or(REFUSED)?,
        };
        Ok((reads, remaining, correlation))
    }
    fn enqueue(&mut self, reads: u32, job: Job) -> Result<(), String> {
        self.jobs.try_send(job).map_err(|_| REFUSED)?;
        self.reads = reads;
        self.reading = true;
        Ok(())
    }
    fn admit(
        &mut self,
        call: &str,
        url: &str,
        end: tokio::time::Instant,
    ) -> Result<Reply, ReadFailure> {
        let (reads, remaining, correlation) =
            self.next(call).map_err(|_| ReadFailure::Admission)?;
        let authority = &self.authority;
        let timeout = end.saturating_duration_since(tokio::time::Instant::now());
        let outgoing = authority
            .effect
            .read(url, &authority.secret, timeout.min(remaining))
            .map_err(|_| ReadFailure::Admission)?;
        #[cfg(test)]
        read_gates::enqueue(call, end);
        // Preparation can outlast either end; a read refused here consumed nothing.
        if let Some(first) = expired(self.deadline, end, tokio::time::Instant::now()) {
            return Err(first);
        }
        let (reply, receive) = tokio::sync::oneshot::channel();
        self.enqueue(
            reads,
            Job::Text(Read {
                outgoing,
                correlation,
                end,
                reply,
            }),
        )
        .map_err(|_| ReadFailure::Admission)?;
        self.selected = None;
        Ok(receive)
    }
    fn admitting(&self) -> Result<(), String> {
        if self.reading || self.deadline <= tokio::time::Instant::now() {
            return Err(REFUSED.into());
        }
        Ok(())
    }
    /// The one result attempt: consumed on admission, never refetched.
    fn admit_result(
        &mut self,
        call: &str,
        url: &reqwest::Url,
        timeout: Duration,
        max_bytes: usize,
        admission: tokio::sync::SemaphorePermit<'static>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<Fetched, String>>, String> {
        if !matches!(self.stage, Stage::Open) {
            return Err(REFUSED.into());
        }
        let (reads, remaining, correlation) = self.next(call)?;
        let outgoing = crate::host_request::result_get(url, timeout.min(remaining))?;
        let (reply, receive) = tokio::sync::oneshot::channel();
        self.enqueue(
            reads,
            Job::Bytes(Fetch {
                target: Target::Ready(outgoing),
                correlation,
                max_bytes,
                admission,
                reply,
            }),
        )?;
        self.stage = Stage::Consumed;
        Ok(receive)
    }
    /// The one result attempt at the URL native selected from the response
    /// with this sequence: consumed on admission, never refetched. Without
    /// the grant's pointer nothing is ever selected.
    fn admit_selected(
        &mut self,
        call: &str,
        sequence: u32,
        (end, max_bytes): (tokio::time::Instant, usize),
        admission: tokio::sync::SemaphorePermit<'static>,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<Fetched, String>>, String> {
        let url = match &self.selected {
            Some((selected, url)) if *selected == sequence => url.clone(),
            _ => return Err(REFUSED.into()),
        };
        if !matches!(self.stage, Stage::Open) {
            return Err(REFUSED.into());
        }
        let (reads, _, correlation) = self.next(call)?;
        let (reply, receive) = tokio::sync::oneshot::channel();
        self.enqueue(
            reads,
            Job::Bytes(Fetch {
                target: Target::Public(url, end.min(self.deadline)),
                correlation,
                max_bytes,
                admission,
                reply,
            }),
        )?;
        self.selected = None;
        self.stage = Stage::Consumed;
        Ok(receive)
    }
    /// Selecting the retained source consumes it before any work, once. A
    /// mismatched selection consumes it too, so nothing can substitute bytes.
    fn admit_preparation(
        &mut self,
        call: &str,
        selected: &SourceRef,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<Ack, String>>, String> {
        let expected = self.authority.expected.ok_or(REFUSED)?;
        self.admitting()?;
        let Stage::Retained(source) = &self.stage else {
            return Err(REFUSED.into());
        };
        let matches = source.sha256 == selected.sha256 && source.bytes.len() == selected.size;
        let Stage::Retained(source) = std::mem::replace(&mut self.stage, Stage::Preparing) else {
            unreachable!("checked above");
        };
        if !matches {
            self.stage = Stage::Failed;
            return Err(REFUSED.into());
        }
        let ack = self.authority.ack(call, "prepared", None);
        let (reply, receive) = tokio::sync::oneshot::channel();
        self.jobs
            .try_send(Job::Prepare(Prepare {
                source,
                expected,
                ack,
                reply,
            }))
            .map_err(|_| REFUSED)?;
        self.reading = true;
        Ok(receive)
    }
    /// The one upload, as the review's agent: the prepared file is consumed
    /// on admission and never uploaded again.
    fn admit_upload(
        &mut self,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<Ack, String>>, String> {
        self.authority.custody.as_ref().ok_or(REFUSED)?;
        self.admitting()?;
        if !matches!(self.stage, Stage::Prepared(_)) {
            return Err(REFUSED.into());
        }
        // Reserved first, so the file never leaves the stage to drop here.
        let queue = self.jobs.try_reserve().map_err(|_| REFUSED)?;
        let Stage::Prepared(prepared) = std::mem::replace(&mut self.stage, Stage::Uploading) else {
            unreachable!("checked above");
        };
        let (reply, receive) = tokio::sync::oneshot::channel();
        queue.send(Job::Upload(prepared, reply));
        self.reading = true;
        Ok(receive)
    }
    /// The one message: the upload is consumed on admission; the worker checks
    /// the event against it before signing. The terminal receipt reports it.
    fn admit_publication(
        &mut self,
        call: &str,
        event: AppAgentEvent,
    ) -> Result<tokio::sync::oneshot::Receiver<Result<Ack, String>>, String> {
        self.admitting()?;
        if !matches!(self.stage, Stage::Uploaded(..)) {
            return Err(REFUSED.into());
        }
        let queue = self.jobs.try_reserve().map_err(|_| REFUSED)?;
        let Stage::Uploaded(prepared, url) = std::mem::replace(&mut self.stage, Stage::Publishing)
        else {
            unreachable!("checked above");
        };
        queue.send(Job::Publish(prepared, url, event));
        self.reading = true;
        let (reply, receive) = tokio::sync::oneshot::channel();
        let _ = reply.send(Ok(self.authority.ack(call, "publishing", None)));
        Ok(receive)
    }
}
/// The URL at the grant's fixed pointer in one authenticated HTTP 200 body.
/// Anything else selects nothing; it never makes the response an error.
fn select(grant: &ReviewedInvocation, (status, body): (u16, &str)) -> Option<reqwest::Url> {
    let pointer = &grant
        .credential_http
        .as_ref()?
        .result_url
        .as_ref()?
        .json_pointer;
    if status != 200 {
        return None;
    }
    let body: serde_json::Value = serde_json::from_str(body).ok()?;
    crate::host_request::result_target(body.pointer(pointer)?.as_str()?)
}
/// The one attachment-only message for this upload, in the original chat and
/// thread, with the prepared file's own facts: nothing a plugin wrote,
/// mentioned or tagged.
fn attachment_only(
    event: &AppAgentEvent,
    destination: &Destination,
    prepared: &Prepared,
    url: &str,
) -> bool {
    let mut tags = vec![vec!["h".to_owned(), destination.channel.clone()]];
    tags.extend(
        destination
            .root
            .iter()
            .map(|root| vec!["e".to_owned(), root.clone(), String::new(), "reply".into()]),
    );
    tags.push(vec![
        "imeta".to_owned(),
        format!("url {url}"),
        "m video/mp4".into(),
        format!("size {}", prepared.prepared_size),
        format!("x {}", prepared.prepared_sha256),
        "filename video.mp4".into(),
        format!("dim {}", prepared.dim),
    ]);
    event.kind == 9 && event.content == format!("![video.mp4](<{url}>)") && event.tags == tags
}
struct Pending {
    projection: Projection,
    /// The author's membership as it was when review began.
    member: Option<Admission>,
    started: Instant,
    action: Option<tokio::sync::oneshot::Sender<()>>,
}

// Up to 128 tombstones last through this app process. Unregister-before-register cannot revive
// a disposed fiber; the same envelope is independently consumed in HostCalls.
#[derive(Clone, Default)]
pub(crate) struct Invocations(Arc<Mutex<HashMap<String, Entry>>>);
struct Entry {
    plugin: String,
    live: bool,
    create_admitted: bool,
    presenting: bool,
    pending: Option<Pending>,
    parent: Option<Parent>,
    retired: Arc<tokio::sync::Notify>,
    finished: tokio::sync::watch::Sender<bool>,
}
impl Invocations {
    pub(crate) fn own(&self, call: &str, plugin: &str) -> Result<Retirement, String> {
        self.reserve(call, plugin)?;
        Ok(Retirement(self.clone(), call.into()))
    }
    fn reserve(&self, call: &str, plugin: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        if state.len() >= 128 || state.contains_key(call) {
            return Err(REFUSED.into());
        }
        // At most one native review at a time; no queue of stale consent windows.
        if state.values().any(|entry| !*entry.finished.borrow()) {
            return Err("Another review is open".into());
        }
        state.insert(
            call.into(),
            Entry {
                plugin: plugin.into(),
                live: true,
                create_admitted: false,
                presenting: false,
                pending: None,
                parent: None,
                retired: Arc::default(),
                finished: tokio::sync::watch::channel(false).0,
            },
        );
        Ok(())
    }
    pub(crate) fn live(&self, call: &str) -> bool {
        self.0
            .lock()
            .is_ok_and(|s| s.get(call).is_some_and(|e| e.live))
    }
    /// Promotion predicates run under Manager metadata: never wait for this lock.
    pub(crate) fn try_live(&self, call: &str) -> bool {
        self.0
            .try_lock()
            .is_ok_and(|state| state.get(call).is_some_and(|entry| entry.live))
    }
    /// One-shot promotion admission under Manager metadata. Cancellation and
    /// admission share this lock, but an admitted owner still blocks successors
    /// until its write and cleanup return. Never wait in metadata lock order.
    pub(crate) fn try_consume(&self, call: &str) -> bool {
        let Ok(mut state) = self.0.try_lock() else {
            return false;
        };
        let Some(entry) = state.get_mut(call).filter(|entry| entry.live) else {
            return false;
        };
        entry.live = false;
        true
    }
    fn begin_review(&self, call: &str) -> bool {
        let Ok(mut state) = self.0.lock() else {
            return false;
        };
        if let Some(entry) = state
            .get_mut(call)
            .filter(|entry| entry.live && !entry.presenting)
        {
            entry.presenting = true;
            true
        } else {
            false
        }
    }
    fn end_review(&self, call: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(entry) = state.get_mut(call) {
                entry.presenting = false;
                entry.pending = None;
                entry.finished.send_replace(true);
            }
        }
    }
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn retirement_signal(&self, call: &str) -> Result<Arc<tokio::sync::Notify>, String> {
        self.0
            .lock()
            .map_err(|_| REFUSED)?
            .get(call)
            .map(|entry| entry.retired.clone())
            .ok_or_else(|| REFUSED.into())
    }
    fn offer(&self, call: &str, pending: Pending) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let entry = state
            .get_mut(call)
            .filter(|e| e.live && e.presenting && e.pending.is_none())
            .ok_or(REFUSED)?;
        entry.pending = Some(pending);
        Ok(())
    }
    fn dispatch(
        &self,
        call: &str,
        id: &str,
        revision: &str,
        digest: &str,
        destination: &Destination,
    ) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let entry = state.get_mut(call).filter(|e| e.live).ok_or(REFUSED)?;
        let pending = entry.pending.as_mut().ok_or(REFUSED)?;
        let projection = &pending.projection;
        if projection.plugin_id != id
            || projection.revision != revision
            || projection.digest != digest
            || &projection.request.destination != destination
            || pending.started.elapsed() >= REVIEW_BUDGET
            || pending
                .member
                .as_ref()
                .is_some_and(|member| member.commit(false, || Ok(())).is_err())
        {
            return Err(REFUSED.into());
        }
        pending
            .action
            .take()
            .ok_or(REFUSED)?
            .send(())
            .map_err(|_| REFUSED.into())
    }
    fn consume<T>(
        &self,
        call: &str,
        dispatch: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let entry = state.get_mut(call).filter(|e| e.live).ok_or(REFUSED)?;
        entry.live = false;
        // Retirement and this dispatch have one linearization point, no await.
        dispatch()
    }
    fn with_live<T>(
        &self,
        call: &str,
        effect: impl FnOnce(&mut Entry) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let entry = state
            .get_mut(call)
            .filter(|entry| entry.live && entry.create_admitted)
            .ok_or(REFUSED)?;
        effect(entry)
    }
    fn with_parent<T>(
        &self,
        call: &str,
        (id, revision): (&str, &str),
        admit: impl FnOnce(&mut Parent) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let parent = state
            .get_mut(call)
            .filter(|entry| entry.live && entry.plugin == id)
            .and_then(|entry| entry.parent.as_mut())
            .filter(|parent| parent.authority.revision == revision)
            .ok_or(REFUSED)?;
        admit(parent)
    }
    /// Clears the one in-flight read before its handoff, so the next admission
    /// cannot race it. Retirement or a failed fence drops the reply.
    fn finish_read(&self, call: &str, deliver: impl FnOnce(&mut Parent) -> Result<(), String>) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        if let Some(entry) = state.get_mut(call) {
            if let Some(parent) = entry.parent.as_mut() {
                parent.reading = false;
                if entry.live {
                    let _ = deliver(parent);
                }
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn spend(&self, call: &str, reads: u32, deadline: tokio::time::Instant) {
        let mut state = self.0.lock().unwrap();
        let parent = state.get_mut(call).unwrap().parent.as_mut().unwrap();
        (parent.reads, parent.deadline) = (reads, deadline);
    }
    /// Test inspection of the parent's read accounting: (reads, reading,
    /// selected sequence).
    #[cfg(test)]
    pub(crate) fn reads(&self, call: &str) -> (u32, bool, Option<u32>) {
        let state = self.0.lock().unwrap();
        let parent = state.get(call).unwrap().parent.as_ref().unwrap();
        (
            parent.reads,
            parent.reading,
            parent.selected.as_ref().map(|(sequence, _)| *sequence),
        )
    }
    #[cfg(test)]
    pub(crate) fn source(&self, call: &str) -> Option<(Vec<u8>, String)> {
        let state = self.0.lock().unwrap();
        match &state.get(call)?.parent.as_ref()?.stage {
            Stage::Retained(source) => Some((source.bytes.clone(), source.sha256.clone())),
            _ => None,
        }
    }
    /// Test inspection of the retained prepared state: (directory, source
    /// hash, prepared hash, prepared size).
    #[cfg(test)]
    pub(crate) fn prepared(
        &self,
        call: &str,
    ) -> Option<(std::path::PathBuf, String, String, usize)> {
        let state = self.0.lock().unwrap();
        match &state.get(call)?.parent.as_ref()?.stage {
            Stage::Prepared(prepared) => Some((
                prepared.directory().to_owned(),
                prepared.source_sha256.clone(),
                prepared.prepared_sha256.clone(),
                prepared.prepared_size,
            )),
            _ => None,
        }
    }
    /// Takes the parent out so its files are removed outside this lock.
    fn detach(&self, call: &str) -> Option<Parent> {
        self.0.lock().ok()?.get_mut(call)?.parent.take()
    }
    fn create<T>(
        &self,
        call: &str,
        dispatch: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        let entry = state
            .get_mut(call)
            .filter(|e| e.live && !e.create_admitted)
            .ok_or(REFUSED)?;
        // Consume create, not the continuing read/result lifetime. Even refusal
        // or an unknown network outcome cannot turn this attempt into a retry.
        entry.create_admitted = true;
        dispatch()
    }
    pub(crate) fn cancel(&self, call: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(entry) = state.get_mut(call) {
                entry.live = false;
                entry.retired.notify_one();
            } else if state.len() < 128 {
                state.insert(
                    call.into(),
                    Entry {
                        plugin: String::new(),
                        live: false,
                        create_admitted: false,
                        presenting: false,
                        pending: None,
                        parent: None,
                        retired: Arc::default(),
                        finished: tokio::sync::watch::channel(true).0,
                    },
                );
            }
        }
    }
    pub(crate) async fn cancel_and_wait(&self, call: &str) -> Result<(), String> {
        self.cancel(call);
        let mut finished = self
            .0
            .lock()
            .map_err(|_| REFUSED)?
            .get(call)
            .ok_or(REFUSED)?
            .finished
            .subscribe();
        // A retained value, not a Notify pulse: completion before this waiter
        // subscribes is still affirmative ownership retirement.
        finished.wait_for(|done| *done).await.map_err(|_| REFUSED)?;
        Ok(())
    }
    pub(crate) fn retire(&self, plugin: &str) {
        if let Ok(mut state) = self.0.lock() {
            for entry in state.values_mut().filter(|e| e.plugin == plugin) {
                entry.live = false;
                entry.retired.notify_one();
            }
        }
    }
    pub(crate) async fn retire_plugin_and_wait(&self, plugin: &str) -> Result<(), String> {
        let completions: Vec<_> = {
            let mut state = self.0.lock().map_err(|_| REFUSED)?;
            state
                .values_mut()
                .filter(|entry| entry.plugin == plugin)
                .map(|entry| {
                    entry.live = false;
                    entry.retired.notify_one();
                    entry.finished.subscribe()
                })
                .collect()
        };
        for mut finished in completions {
            finished.wait_for(|done| *done).await.map_err(|_| REFUSED)?;
        }
        Ok(())
    }
    pub(crate) fn clear(&self) {
        // Keep tombstones: a late registration must not resurrect retired work.
        if let Ok(mut state) = self.0.lock() {
            for entry in state.values_mut() {
                entry.live = false;
                entry.retired.notify_one();
            }
        }
    }
}
async fn await_review_retirement(
    signal: Arc<tokio::sync::Notify>,
    state: Invocations,
    call: String,
    remaining: Duration,
) {
    tokio::select! {
        _ = signal.notified() => {},
        _ = tokio::time::sleep(remaining) => state.cancel(&call),
    }
}
pub(crate) struct Retirement(Invocations, String);
impl Drop for Retirement {
    fn drop(&mut self) {
        self.0.cancel(&self.1);
        self.0.end_review(&self.1);
    }
}

/// Read-only availability, checked before a plugin offers review. It is not a
/// grant, credential or dispatch check; every invocation is admitted separately.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Support {
    version: u32,
    synthetic: bool,
    credential_http: Option<CredentialHttpSupport>,
}
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialHttpSupport {
    version: u32,
    create_response: bool,
    continuation: bool,
    expected_media: u32,
    result: bool,
    delivery: bool,
    result_url: u32,
}
fn support() -> Support {
    let macos = cfg!(target_os = "macos");
    Support {
        version: 1,
        synthetic: macos,
        // Result and delivery stay false until implemented.
        credential_http: macos.then_some(CredentialHttpSupport {
            version: 1,
            create_response: true,
            // Bounded text parent reads only.
            continuation: true,
            // Frozen expectations and private strict preparation.
            expected_media: 1,
            // One retained result source, prepared, uploaded and posted once.
            result: true,
            delivery: true,
            // One download at a grant's fixed pointer into a response.
            result_url: 1,
        }),
    }
}

/// One bounded text GET under an approved create's retained authority, through
/// the existing host request. Same-origin admission does not prove the URL is
/// the created task; the trusted caller owns that check.
pub(crate) async fn parent_read<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    read: ParentRead<'_>,
    parent: ParentRef,
) -> Result<HostResponse, String> {
    fn admission(_: impl Sized) -> String {
        ReadFailure::Admission.message()
    }
    let end = read.end;
    let invocations = app
        .try_state::<Invocations>()
        .ok_or_else(|| admission(()))?;
    parent.validate().map_err(admission)?;
    // Layers, outermost first: entry lookup, the fence itself, then the read's
    // own admission. Only the middle layer is the fence's refusal. A fence
    // that met a held lock admitted nothing: every guard is released, then the
    // whole attempt runs again within this read's one end.
    let reply = loop {
        let (deadline, attempt) = invocations
            .with_parent(&parent.call_id, (read.id, read.revision), |admitted| {
                let authority = admitted.authority.clone();
                let deadline = admitted.deadline;
                Ok((
                    deadline,
                    authority.try_fenced(app, label, || {
                        Ok(admitted.admit(&parent.call_id, read.url, end))
                    }),
                ))
            })
            .map_err(admission)?;
        match attempt {
            Ok(admitted) => break admitted.map_err(ReadFailure::message)?,
            // A disabled or updated parent is gone, not a changed fence.
            Err(Refusal::Withdrawn(_)) => return Err(ReadFailure::Admission.message()),
            Err(Refusal::Terminal(_)) => return Err(ReadFailure::Fence.message()),
            Err(Refusal::Busy(_)) => {
                let wake = (tokio::time::Instant::now() + BUSY_WAIT).min(deadline);
                #[cfg(test)]
                busy_gate(&parent.call_id).await;
                tokio::time::sleep_until(wake.min(end)).await;
                if let Some(first) = expired(deadline, end, tokio::time::Instant::now()) {
                    return Err(first.message());
                }
            }
        }
    };
    match tokio::time::timeout_at(end, reply).await {
        Err(_) => Err(ReadFailure::Timeout.message()),
        Ok(Err(_)) => Err(ReadFailure::Interrupted.message()),
        Ok(Ok(result)) => result.map_err(ReadFailure::message),
    }
}

/// The one credential-free result-byte read under an approved create. The
/// source is retained natively; the bytes returned are a copy, not authority.
/// The one credential-free download of the result native selected from an
/// authenticated response of this call. No URL comes from the caller.
pub(crate) async fn parent_result<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    (id, revision): (&str, &str),
    parent: ParentRef,
    result: ResultRef,
    limits: (tokio::time::Instant, usize),
    admission: tokio::sync::SemaphorePermit<'static>,
) -> Result<Fetched, String> {
    let invocations = app.try_state::<Invocations>().ok_or(REFUSED)?;
    parent.validate()?;
    if result.version != 1 {
        return Err(REFUSED.into());
    }
    let reply = invocations.with_parent(&parent.call_id, (id, revision), |admitted| {
        let authority = admitted.authority.clone();
        authority.fenced(app, label, || {
            admitted.admit_selected(&parent.call_id, result.sequence, limits, admission)
        })
    })?;
    tokio::time::timeout_at(limits.0, reply)
        .await
        .map_err(|_| REFUSED)?
        .map_err(|_| REFUSED)?
}

pub(crate) async fn parent_bytes<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
    read: ParentRead<'_>,
    parent: ParentRef,
    target: &reqwest::Url,
    max_bytes: usize,
    admission: tokio::sync::SemaphorePermit<'static>,
) -> Result<Fetched, String> {
    let invocations = app.try_state::<Invocations>().ok_or(REFUSED)?;
    parent.validate()?;
    let reply = invocations.with_parent(&parent.call_id, (read.id, read.revision), |admitted| {
        let authority = admitted.authority.clone();
        authority.fenced(app, label, || {
            let timeout = read
                .end
                .saturating_duration_since(tokio::time::Instant::now());
            admitted.admit_result(&parent.call_id, target, timeout, max_bytes, admission)
        })
    })?;
    tokio::time::timeout_at(read.end, reply)
        .await
        .map_err(|_| REFUSED)?
        .map_err(|_| REFUSED)?
}

/// Private HostService wiring for the original call's next step: preparing
/// its retained source, uploading that, then its one message. Deliberately
/// absent from the plugin Host API. The reply is an internal
/// acknowledgement; the original call's receipt reports the delivery.
#[tauri::command]
pub(crate) async fn plugin_host_reviewed_result<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    id: String,
    revision: String,
    parent: ParentRef,
    step: Step,
) -> Result<Ack, String> {
    let invocations = app.try_state::<Invocations>().ok_or(REFUSED)?;
    parent.validate()?;
    let reply = invocations.with_parent(&parent.call_id, (&id, &revision), |admitted| {
        let authority = admitted.authority.clone();
        authority.fenced(&app, webview.label(), || match step {
            Step::Prepare { source } => admitted.admit_preparation(&parent.call_id, &source),
            Step::Upload => admitted.admit_upload(),
            Step::Publish { event } => admitted.admit_publication(&parent.call_id, event),
        })
    })?;
    // The worker's deadline bounds this; a dropped waiter changes nothing.
    reply.await.map_err(|_| REFUSED)?
}

#[tauri::command]
pub(crate) fn plugin_host_reviewed_capabilities<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
) -> Result<Support, String> {
    if webview.label() != "main" {
        return Err(REFUSED.into());
    }
    Ok(support())
}

#[tauri::command]
pub(crate) async fn plugin_host_reviewed_retire<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, Invocations>,
    call_id: String,
) -> Result<(), String> {
    if webview.label() != "main"
        || uuid::Uuid::parse_str(&call_id).map_or(true, |v| v.to_string() != call_id)
    {
        return Err(REFUSED.into());
    }
    state.cancel_and_wait(&call_id).await
}

// Internal to the trusted main renderer, deliberately absent from the plugin Host API.
// This is not physical-click attestation or a sandbox against installed renderer code.
#[tauri::command]
pub(crate) fn plugin_host_reviewed_dispatch<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, Invocations>,
    call_id: String,
    id: String,
    revision: String,
    digest: String,
    destination: Destination,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err(REFUSED.into());
    }
    state.dispatch(&call_id, &id, &revision, &digest, &destination)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_reviewed_invoke<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    webview: tauri::Webview<R>,
    manager: tauri::State<'_, PluginManager>,
    calls: tauri::State<'_, HostCalls>,
    state: tauri::State<'_, Invocations>,
    id: String,
    revision: String,
    once: Once,
    request: Request,
    author: Option<Author>,
    on_review: tauri::ipc::Channel<Projection>,
    on_progress: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<Receipt, String> {
    let on_progress: Option<tauri::ipc::Channel<CreateResponse>> =
        on_progress.map(|channel| channel.channel_on(webview.clone()));
    if !cfg!(target_os = "macos") {
        return Err("Synthetic reviewed invocation requires macOS".into());
    }
    request.validate()?;
    let custody = match &author {
        Some(author) => Some(
            app.try_state::<crate::app_agents::AppAgentHost>()
                .ok_or(REFUSED)?
                .custody(author.pubkey.clone(), author.relay.clone())
                .await?,
        ),
        None => None,
    };
    let digest = request.digest(author.as_ref());
    calls.consume(
        webview.label(),
        "reviewed-invocation",
        &id,
        &revision,
        &once,
        Sha256::digest(digest.as_bytes()).into(),
    )?;
    let call_id = once.call_id().to_owned();
    let retirement = state.own(&call_id, &id)?;
    let started = Instant::now();
    let identity = request
        .effect
        .as_ref()
        .map(|_| {
            app.try_state::<crate::identity::IdentityHost>()
                .map(|identity| identity.inner().clone())
                .ok_or(REFUSED)
        })
        .transpose()?;
    if request.effect.is_some() && on_progress.is_none() {
        return Err(REFUSED.into());
    }
    let (plugin, artifact, frozen) = (id.clone(), revision.clone(), request.clone());
    let (grant, witness, http, retirement) = with_manager(manager, move |m| {
        // The same native owner survives a dropped IPC during the OS read.
        let (grant, witness) =
            m.admit_reviewed_invocation(&plugin, &artifact, &frozen.operation)?;
        let http = if let Some(effect) = &frozen.effect {
            let identity = identity.ok_or(REFUSED)?;
            if grant.artifact.is_some()
                || !grant
                    .credential_http
                    .as_ref()
                    .is_some_and(|http| http.version == 1 && http.slot == effect.slot)
                || identity.current_viewer()?.as_deref() != Some(&frozen.destination.viewer)
            {
                return Err(REFUSED.into());
            }
            Some(effect.prepare(
                &frozen.body,
                &m,
                &plugin,
                &artifact,
                &identity,
                started + REVIEW_BUDGET + Duration::from_secs(600),
            )?)
        } else {
            if grant.artifact.is_none() || grant.credential_http.is_some() {
                return Err(REFUSED.into());
            }
            None
        };
        Ok((grant, witness, http, retirement))
    })
    .await?;
    let store = app
        .path()
        .app_cache_dir()
        .map_err(|_| REFUSED)?
        .join("reviewed-invocations");
    let retirement = if let Some(descriptor) = grant.artifact.clone() {
        let initial_store = store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::host_process::artifact::snapshot(&descriptor, &initial_store)?;
            Ok::<_, String>(retirement)
        })
        .await
        .map_err(|_| REFUSED)??
    } else {
        retirement
    };
    if !state.live(&call_id)
        || !calls.current(webview.label(), &once)
        || started.elapsed() >= REVIEW_BUDGET
    {
        return Err(REFUSED.into());
    }
    if !state.begin_review(&call_id) {
        return Err(REFUSED.into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let projection = Projection {
        call_id: call_id.clone(),
        plugin_id: id.clone(),
        revision: revision.clone(),
        request: request.clone(),
        author,
        digest: digest.clone(),
        expires_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| REFUSED)?
            .as_millis() as u64
            + REVIEW_BUDGET.saturating_sub(started.elapsed()).as_millis() as u64,
        result_url: grant
            .credential_http
            .as_ref()
            .and_then(|http| http.result_url.as_ref())
            .map(|_| 1),
    };
    state.offer(
        &call_id,
        Pending {
            projection: projection.clone(),
            member: custody.as_ref().map(|custody| custody.member().clone()),
            started,
            action: Some(send),
        },
    )?;
    let signal = state.retirement_signal(&call_id)?;
    on_review.send(projection).map_err(|_| REFUSED)?;
    let approved = tokio::select! {
        result = receive => result.is_ok(),
        _ = await_review_retirement(signal, state.inner().clone(), call_id.clone(), REVIEW_BUDGET.saturating_sub(started.elapsed())) => false,
    };
    if !approved {
        return Ok(Receipt {
            call_id,
            destination: request.destination,
            digest,
            outcome: "cancelled",
            delivery: None,
        });
    }
    if let Some((secret, outgoing)) = http {
        let secret = Arc::new(secret);
        let manager = app.state::<PluginManager>().0.clone()?;
        let identity = app.state::<crate::identity::IdentityHost>().inner().clone();
        let signal = state.retirement_signal(&call_id)?;
        let retained_state = state.inner().clone();
        let native = app.clone();
        let retained_call = call_id.clone();
        let witness = Arc::new(witness);
        let expected = request
            .expected_media
            .as_ref()
            .map(ExpectedMedia::strict)
            .transpose()?;
        let retained = (
            revision.clone(),
            once.clone(),
            digest.clone(),
            request.destination.clone(),
            request.effect.clone().ok_or(REFUSED)?,
            secret.clone(),
            grant.clone(),
            witness.clone(),
            custody,
        );
        let (jobs, mut queue) = tokio::sync::mpsc::channel::<Job>(1);
        // Transfer only after every fence succeeds. On refusal this stays
        // outside the state lock: Retirement::drop itself locks Invocations.
        let mut retirement = Some(retirement);
        let task = state.create(&call_id, || {
            calls.with_current(webview.label(), &once, || {
                identity.with_current_viewer(&request.destination.viewer, || {
                    manager.with_reviewed_secret(&secret, &grant, &witness, || {
                        if started.elapsed() >= REVIEW_BUDGET { return Err(REFUSED.into()); }
                        let retirement = retirement.take().ok_or(REFUSED)?;
                        let (revision, once, digest, destination, effect, secret, grant, witness, custody) = retained;
                        let authority = Arc::new(Authority { expected, revision, once, digest, destination, effect, secret, grant, witness, custody });
                        let deadline = tokio::time::Instant::now() + window(&authority.destination.channel);
                        Ok(tauri::async_runtime::spawn(async move {
                            let _retirement = retirement;
                            // The existing owner moves into the native worker: dropping
                            // the IPC waiter cannot release it or admit a successor.
                            let response = tokio::select! { biased;
                                _ = signal.notified() => return Err(REFUSED.to_owned()),
                                result = crate::host_request::read_credential_response(outgoing, &authority.secret) => result?,
                            };
                            retained_state.with_live(&retained_call, |entry| authority.fenced(&native, "main", || {
                                on_progress.ok_or(REFUSED)?.send(CreateResponse {
                                    version: 1, call_id: retained_call.clone(), digest: authority.digest.clone(),
                                    destination: authority.destination.clone(), sequence: 1, phase: "create-response",
                                    status: response.status, safe_body: response.body,
                                }).map_err(|_| REFUSED.to_owned())?;
                                // Same linearization as the handoff: a read sent on receipt is admissible.
                                entry.parent = Some(Parent { authority: authority.clone(), deadline, reads: 0, reading: false, stage: Stage::Open, selected: None, jobs });
                                Ok(())
                            }))?;
                            // The original page, session, plugin, enrollment and deadline,
                            // rechecked after every await before a new effect.
                            let current = || {
                                if tokio::time::Instant::now() >= deadline {
                                    return Err(REFUSED.to_owned());
                                }
                                retained_state.with_live(&retained_call, |_| authority.fenced(&native, "main", || Ok(())))
                            };
                            let mut delivery = None;
                            // This worker alone performs admitted reads. Retirement or the
                            // deadline drops in-flight local work before the owner returns;
                            // an admitted upload or post completes, and is never repeated.
                            loop {
                                let job = tokio::select! { biased;
                                    _ = signal.notified() => break,
                                    _ = tokio::time::sleep_until(deadline) => break,
                                    job = queue.recv() => match job { Some(job) => job, None => break },
                                };
                                match job {
                                    Job::Text(Read { outgoing, correlation, end, reply }) => {
                                        #[cfg(test)]
                                        read_gates::dispatch(&retained_call, end).await;
                                        // Ending observed here is named to the held read; nothing else goes with it.
                                        let response = tokio::select! { biased;
                                            _ = signal.notified() => { let _ = reply.send(Err(ReadFailure::Retired)); break }
                                            // The window closing ends the parent's eligibility; it is not a slow read.
                                            _ = tokio::time::sleep_until(deadline) => { let _ = reply.send(Err(ReadFailure::Admission)); break }
                                            // The read's own end caps it in flight.
                                            _ = tokio::time::sleep_until(end) => Err(ReadFailure::Timeout),
                                            response = async {
                                                // A timer just past its instant need not be ready on first poll: a job dequeued late is refused before it is sent.
                                                if let Some(first) = expired(deadline, end, tokio::time::Instant::now()) { return Err(first); }
                                                crate::host_request::credential_response(outgoing, &authority.secret).await.map_err(ReadFailure::from)
                                            } => response,
                                        };
                                        // Parsed outside the locks; committed only with its delivery.
                                        let sequence = correlation.sequence;
                                        let selection = response.as_ref().ok().and_then(|response| select(&authority.grant, (response.status, &response.body)));
                                        retained_state.finish_read(&retained_call, |parent| authority.fenced(&native, "main", || {
                                            let delivered = reply.send(response.map(|mut response| { response.parent = Some(correlation); response })).is_ok();
                                            // Its admission already cleared the previous selection.
                                            if let Some(url) = selection.filter(|_| delivered) { parent.selected = Some((sequence, url)); }
                                            Ok(())
                                        }));
                                        #[cfg(test)]
                                        read_gates::finished(&retained_call);
                                    }
                                    Job::Bytes(Fetch { target, correlation, max_bytes, admission, reply }) => {
                                        let bytes = tokio::select! { biased;
                                            _ = signal.notified() => break,
                                            _ = tokio::time::sleep_until(deadline) => break,
                                            bytes = fetch_result(target, max_bytes, &current) => bytes,
                                        };
                                        // Hash before taking the locks; the handoff only commits.
                                        let fetched = bytes.map(|bytes| Fetched { correlation, sha256: format!("{:x}", Sha256::digest(&bytes)), bytes, admission });
                                        retained_state.finish_read(&retained_call, |parent| authority.fenced(&native, "main", || {
                                            if let Ok(fetched) = &fetched {
                                                parent.stage = Stage::Retained(Source { bytes: fetched.bytes.clone(), sha256: fetched.sha256.clone() });
                                            }
                                            let _ = reply.send(fetched);
                                            Ok(())
                                        }));
                                    }
                                    Job::Prepare(Prepare { source: Source { bytes, sha256 }, expected, ack, reply }) => {
                                        let (stop, cancelled) = tokio::sync::oneshot::channel();
                                        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                                        let work = crate::relay::prepare_result(bytes, sha256, expected, remaining, cancelled);
                                        tokio::pin!(work);
                                        let prepared = tokio::select! { biased;
                                            _ = signal.notified() => None,
                                            _ = tokio::time::sleep_until(deadline) => None,
                                            prepared = &mut work => Some(prepared),
                                        };
                                        let Some(prepared) = prepared else {
                                            // Stop the media owner, then join its process and files.
                                            drop(stop);
                                            discard(work.await).await;
                                            break;
                                        };
                                        let mut prepared = Some(prepared);
                                        retained_state.finish_read(&retained_call, |parent| authority.fenced(&native, "main", || {
                                            match prepared.take() {
                                                Some(Ok(value)) => {
                                                    let facts = SourceRef { sha256: value.prepared_sha256.clone(), size: value.prepared_size };
                                                    parent.stage = Stage::Prepared(value);
                                                    let _ = reply.send(Ok(Ack { prepared: Some(facts), ..ack }));
                                                }
                                                Some(Err(error)) => { parent.stage = Stage::Failed; let _ = reply.send(Err(error)); }
                                                None => {}
                                            }
                                            Ok(())
                                        }));
                                        // A stale or refused commit leaves the value here.
                                        discard(prepared).await;
                                    }
                                    Job::Upload(prepared, reply) => {
                                        let Some(custody) = &authority.custody else { break };
                                        // The exact prepared file, hashed again as it leaves; it stays owned here.
                                        let Ok((prepared, file)) = tauri::async_runtime::spawn_blocking(move || {
                                            let file = prepared.file();
                                            (prepared, file)
                                        }).await else { break };
                                        let destination = &authority.destination;
                                        let sent = match file {
                                            Some(file) if current().is_ok() => custody.upload(
                                                &destination.channel, destination.root.as_deref(), file,
                                                (prepared.prepared_size, &prepared.prepared_sha256), &current,
                                            ).await,
                                            _ => Sent::Failed,
                                        };
                                        delivery = Some(Delivery { upload: known(&sent, "uploaded"), status: "failed", event_id: None });
                                        // An unknown upload is not posted, retried or replaced.
                                        let Sent::Done(url) = sent else {
                                            discard(prepared).await;
                                            break;
                                        };
                                        let mut retained = Some((prepared, url));
                                        retained_state.finish_read(&retained_call, |parent| authority.fenced(&native, "main", || {
                                            let (prepared, url) = retained.take().ok_or(REFUSED)?;
                                            let ack = authority.ack(&retained_call, "uploaded", Some(Media {
                                                url: url.clone(), r#type: "video/mp4", size: prepared.prepared_size,
                                                sha256: prepared.prepared_sha256.clone(), dim: prepared.dim.clone(),
                                            }));
                                            parent.stage = Stage::Uploaded(prepared, url);
                                            let _ = reply.send(Ok(ack));
                                            Ok(())
                                        }));
                                        discard(retained).await;
                                    }
                                    Job::Publish(prepared, url, event) => {
                                        let destination = &authority.destination;
                                        let (event_id, sent) = match &authority.custody {
                                            Some(custody) if attachment_only(&event, destination, &prepared, &url) => {
                                                custody.publish(&destination.channel, destination.root.as_deref(), event, &current).await
                                            }
                                            _ => (None, Sent::Failed),
                                        };
                                        delivery = Some(Delivery { upload: "uploaded", status: known(&sent, "posted"), event_id });
                                        discard(prepared).await;
                                        break;
                                    }
                                }
                            }
                            discard(retained_state.detach(&retained_call)).await;
                            // The provider task's own outcome stays unattested here.
                            Ok::<_, String>(Receipt {
                                call_id: retained_call, destination: authority.destination.clone(),
                                digest: authority.digest.clone(), outcome: "unknown", delivery,
                            })
                        }))
                    })
                })
            })
        })?;
        return task.await.map_err(|_| UNKNOWN.to_owned())?;
    }
    let _retirement = retirement;
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Wire<'a> {
        attempt: &'a str,
        digest: &'a str,
        request: &'a Request,
        fake_input: &'a str,
    }
    let mut wire = Zeroizing::new(
        serde_json::to_vec(&Wire {
            attempt: &call_id,
            digest: &digest,
            request: &request,
            fake_input: "fake-native-synthetic",
        })
        .map_err(|_| REFUSED)?,
    );
    // No source path, executable, arguments, environment or transport comes from IPC.
    let manager = app.state::<PluginManager>().0.clone()?;
    let child = state.consume(&call_id, || {
        calls.with_current(webview.label(), &once, || {
            manager.with_reviewed_invocation(&id, &revision, &grant, &witness, || {
                // Revalidate the immutable generation, not the original source path.
                let executable = crate::host_process::artifact::snapshot(
                    grant.artifact.as_ref().ok_or(REFUSED)?,
                    &store,
                )?;
                if started.elapsed() >= REVIEW_BUDGET {
                    return Err(REFUSED.into());
                }
                spawn(&executable)
            })
        })
    })?;
    let acknowledged = bounded_result(child, &mut wire, &call_id, &digest).await;
    Ok(Receipt {
        call_id,
        destination: request.destination,
        digest,
        outcome: if acknowledged { "submitted" } else { "unknown" },
        delivery: None,
    })
}

struct Execution {
    child: tokio::process::Child,
    #[cfg(unix)]
    _group: crate::host_command::ProcessGroupGuard,
}
fn spawn(executable: &Path) -> Result<Execution, String> {
    let mut command = tokio::process::Command::new(executable);
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.as_std_mut().process_group(0);
    }
    let child = command.spawn().map_err(|_| UNKNOWN)?;
    #[cfg(unix)]
    let group = crate::host_command::ProcessGroupGuard {
        process_id: child.id().unwrap_or(0) as i32,
        armed: child.id().is_some(),
    };
    Ok(Execution {
        child,
        #[cfg(unix)]
        _group: group,
    })
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Acknowledgement {
    attempt: String,
    digest: String,
}
async fn bounded_result(
    mut execution: Execution,
    input: &mut Zeroizing<Vec<u8>>,
    attempt: &str,
    digest: &str,
) -> bool {
    let child = &mut execution.child;
    let operation = async {
        let mut stdin = child.stdin.take().ok_or(())?;
        stdin.write_all(input).await.map_err(|_| ())?;
        stdin.shutdown().await.map_err(|_| ())?;
        drop(stdin);
        use zeroize::Zeroize;
        input.zeroize();
        let mut output = Zeroizing::new(Vec::new());
        child
            .stdout
            .take()
            .ok_or(())?
            .take(1025)
            .read_to_end(&mut output)
            .await
            .map_err(|_| ())?;
        if output.len() > 1024 || !child.wait().await.map_err(|_| ())?.success() {
            return Err(());
        }
        let ack: Acknowledgement = serde_json::from_slice(&output).map_err(|_| ())?;
        if ack.attempt != attempt || ack.digest != digest {
            return Err(());
        }
        Ok::<_, ()>(())
    };
    tokio::time::timeout(EXECUTION_BUDGET, operation)
        .await
        .is_ok_and(|r| r.is_ok())
}
