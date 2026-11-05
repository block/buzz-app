//! Opt-in control of a website guest, never of Buzz's trusted main document.
use super::*;
use serde::de::DeserializeOwned;
use serde_json::{json, value::RawValue, Value};
use std::time::Duration;
use tokio::time::Instant;

/// One deadline for the action, its settle step, and its Snapshot.
const CALL_DEADLINE: Duration = Duration::from_secs(5);
const SETTLE_POLL: Duration = Duration::from_millis(50);
/// How long an unchanged, idle document must stay so before settle stops.
const SETTLE_QUIET: Duration = Duration::from_millis(300);
/// Settle stops this long before the deadline, which leaves time for the Snapshot.
const SETTLE_RESERVE: Duration = Duration::from_secs(1);
/// Each ref check is a script evaluation, so it polls less often than `loading`.
const REF_WAIT_POLL: Duration = Duration::from_millis(100);
/// The Snapshot after a met `wait` condition gets this long past `timeout_ms`.
const WAIT_SNAPSHOT_BUDGET: Duration = Duration::from_secs(1);
const WAIT_DEFAULT_MS: u64 = 5000;
const WAIT_MAX_MS: u64 = 10_000;
const TOKEN_LENGTH: usize = 36;
const TEXT_BYTES: usize = 8192;
const VALUE_BYTES: std::ops::RangeInclusive<usize> = 1..=1024;
const REF_REVISION_DIGITS: usize = 10;
const REF_INDEX_DIGITS: usize = 6;
/// Every reply, including a `stale_ref` message, fits in 128 KiB.
const REPLY_BYTES: usize = 131_072;
/// `control.js` keeps its part of a Snapshot to 120 KiB, which leaves room
/// for the fields native code adds.
const PAGE_PART_BYTES: usize = 122_880;
const ELEMENT_LIMIT: usize = 150;
const NAME_CHARS: usize = 200;
const TEXT_CHARS: usize = 20_000;
const TITLE_CHARS: usize = 200;
const URL_BYTES: usize = 2048;
const HREF_BYTES: usize = 2048;
const ROLE_BYTES: usize = 32;

/// The codes every agent-facing failure starts with.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Code {
    InvalidRequest,
    InvalidUrl,
    Unavailable,
    NotVisible,
    Revoked,
    Busy,
    StaleRef,
    NotInteractable,
    UnsupportedInput,
    Timeout,
}

impl Code {
    fn as_str(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidUrl => "invalid_url",
            Self::Unavailable => "unavailable",
            Self::NotVisible => "not_visible",
            Self::Revoked => "revoked",
            Self::Busy => "busy",
            Self::StaleRef => "stale_ref",
            Self::NotInteractable => "not_interactable",
            Self::UnsupportedInput => "unsupported_input",
            Self::Timeout => "timeout",
        }
    }

    /// `control.js` runs in the page's JavaScript world, so a page could
    /// otherwise claim a host-only code such as `revoked`.
    fn page_may_send(self) -> bool {
        matches!(
            self,
            Self::StaleRef | Self::NotInteractable | Self::UnsupportedInput | Self::InvalidRequest
        )
    }
}

fn failure(code: Code, sentence: impl std::fmt::Display) -> String {
    format!("{}: {sentence}", code.as_str())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Page,
    Viewport,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Observe {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scope: Option<Scope>,
    },
    Click {
        #[serde(rename = "ref")]
        reference: String,
    },
    Fill {
        #[serde(rename = "ref")]
        reference: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        submit: Option<bool>,
    },
    Select {
        #[serde(rename = "ref")]
        reference: String,
        value: String,
    },
    Press {
        key: Key,
    },
    Scroll {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<Direction>,
        #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
        reference: Option<String>,
    },
    Navigate {
        url: String,
    },
    Back {},
    Forward {},
    Reload {},
    Wait {
        #[serde(rename = "for")]
        condition: Condition,
        #[serde(default = "default_wait_ms")]
        timeout_ms: u64,
    },
}

/// What `wait` waits for: `"load"`, or `{ref}` until that element is visible and enabled.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Condition {
    Load(Load),
    Ref(RefCondition),
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Load {
    Load,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RefCondition {
    #[serde(rename = "ref")]
    reference: String,
}

/// The keys an agent may press.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub enum Key {
    Enter,
    Tab,
    Escape,
    Backspace,
    ArrowUp,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    PageUp,
    PageDown,
    Home,
    End,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Up,
    Down,
}

fn default_wait_ms() -> u64 {
    WAIT_DEFAULT_MS
}

impl Request {
    fn action(&self) -> &'static str {
        match self {
            Self::Observe { .. } => "observe",
            Self::Click { .. } => "click",
            Self::Fill { .. } => "fill",
            Self::Select { .. } => "select",
            Self::Press { .. } => "press",
            Self::Scroll { .. } => "scroll",
            Self::Navigate { .. } => "navigate",
            Self::Back {} => "back",
            Self::Forward {} => "forward",
            Self::Reload {} => "reload",
            Self::Wait { .. } => "wait",
        }
    }

    fn reference(&self) -> Option<&str> {
        match self {
            Self::Click { reference }
            | Self::Fill { reference, .. }
            | Self::Select { reference, .. }
            | Self::Scroll {
                reference: Some(reference),
                ..
            }
            | Self::Wait {
                condition: Condition::Ref(RefCondition { reference }),
                ..
            } => Some(reference),
            Self::Observe { .. }
            | Self::Navigate { .. }
            | Self::Press { .. }
            | Self::Scroll { .. }
            | Self::Back {}
            | Self::Forward {}
            | Self::Reload {}
            | Self::Wait { .. } => None,
        }
    }

    /// `wait` bounds its condition by `timeout_ms` and then gets time for the Snapshot.
    fn limit(&self) -> Duration {
        match self {
            Self::Wait { timeout_ms, .. } => {
                Duration::from_millis(*timeout_ms) + WAIT_SNAPSHOT_BUDGET
            }
            _ => CALL_DEADLINE,
        }
    }

    fn validate(&self) -> Result<(), String> {
        if let Some(reference) = self.reference() {
            if ref_revision(reference).is_none() {
                return Err(failure(
                    Code::InvalidRequest,
                    "ref must look like r4e12, copied from a Snapshot.",
                ));
            }
        }
        if let Self::Fill { text, .. } = self {
            if text.len() > TEXT_BYTES {
                return Err(failure(
                    Code::InvalidRequest,
                    format!("text must be at most {TEXT_BYTES} bytes."),
                ));
            }
        }
        if let Self::Select { value, .. } = self {
            if !VALUE_BYTES.contains(&value.len()) {
                return Err(failure(
                    Code::InvalidRequest,
                    "value must be 1 to 1024 bytes.",
                ));
            }
        }
        if let Self::Scroll {
            direction,
            reference,
        } = self
        {
            if direction.is_some() == reference.is_some() {
                return Err(failure(
                    Code::InvalidRequest,
                    "scroll takes direction or ref, not both.",
                ));
            }
        }
        if let Self::Wait { timeout_ms, .. } = self {
            if *timeout_ms > WAIT_MAX_MS {
                return Err(failure(
                    Code::InvalidRequest,
                    format!("timeout_ms must be an integer from 0 to {WAIT_MAX_MS}."),
                ));
            }
        }
        Ok(())
    }
}

/// The revision a ref names, when it matches `r<revision>e<index>` with up to
/// ten revision digits, up to six index digits, and no leading zeros.
fn ref_revision(reference: &str) -> Option<u64> {
    let (revision, index) = reference.strip_prefix('r')?.split_once('e')?;
    let number = |part: &str, most: usize| {
        !part.is_empty()
            && part.len() <= most
            && !part.starts_with('0')
            && part.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !number(revision, REF_REVISION_DIGITS) || !number(index, REF_INDEX_DIGITS) {
        return None;
    }
    revision.parse().ok()
}

fn permitted<T>(
    token: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String>,
) -> Result<T, String> {
    BROWSERS.with(|browsers| {
        let browsers = browsers.borrow();
        let browser = browsers
            .iter()
            .find(|browser| browser.control.borrow().as_deref() == Some(token))
            .ok_or_else(|| {
                failure(
                    Code::NotVisible,
                    "The page is no longer shared, because it was closed, replaced, or its access was revoked.",
                )
            })?;
        if !browser.visible.get() {
            return Err(failure(
                Code::NotVisible,
                "The page is hidden, so the person must show it again.",
            ));
        }
        operation(browser)
    })
}

/// Runs `operation` on the UI thread when `token` still controls a visible guest.
async fn hop<T: Send + 'static>(
    app: &AppHandle,
    token: &str,
    operation: impl FnOnce(&BrowserSession) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let token = token.to_owned();
    on_main_thread(app, move || Ok(permitted(&token, operation)))
        .await
        .map_err(|error| failure(Code::Unavailable, error))?
}

#[derive(Serialize)]
pub struct Grant {
    pub token: String,
    pub revision: u64,
}

#[tauri::command]
pub async fn browser_control_grant(app: AppHandle, session_id: String) -> Result<Grant, String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            if !browser.visible.get() {
                return Err("Show the browser before allowing control".into());
            }
            let token = uuid::Uuid::new_v4().to_string();
            *browser.control.borrow_mut() = Some(token.clone());
            let revision = browser.control_revision.get() + 1;
            browser.control_revision.set(revision);
            eprintln!("browser_control grant session={}", browser.log_prefix());
            Ok(Grant { token, revision })
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_control_revoke(app: AppHandle, session_id: String) -> Result<(), String> {
    on_main_thread(&app, move || {
        with_browser(&session_id, |browser| {
            browser.revoke_control(RevokeReason::Command);
            Ok(())
        })
    })
    .await
}

/// Takes the request as JSON so a malformed request fails with
/// `invalid_request` like every other agent-facing failure.
#[tauri::command]
pub async fn browser_control_execute(
    app: AppHandle,
    token: String,
    request: Value,
) -> Result<Box<RawValue>, String> {
    let started = Instant::now();
    let mut session = None;
    let request: Result<Request, String> = serde_json::from_value(request)
        .map_err(|error| failure(Code::InvalidRequest, format!("{error}.")));
    let action = request.as_ref().map_or("unknown", Request::action);
    let outcome = match request {
        Ok(request) => control(&app, &token, request, &mut session).await,
        Err(message) => Err(message),
    };
    // Never page text, values, URLs, refs, or tokens.
    eprintln!(
        "browser_control execute action={action} outcome={} ms={} session={}",
        match &outcome {
            Ok(_) => "ok",
            Err(message) => message.split_once(": ").map_or("unknown", |(code, _)| code),
        },
        started.elapsed().as_millis(),
        session.as_deref().unwrap_or("none"),
    );
    outcome
}

async fn control(
    app: &AppHandle,
    token: &str,
    request: Request,
    session: &mut Option<String>,
) -> Result<Box<RawValue>, String> {
    request.validate()?;
    if token.len() != TOKEN_LENGTH {
        return Err(failure(
            Code::NotVisible,
            "The page is no longer shared with you.",
        ));
    }
    let deadline = Instant::now() + request.limit();
    let in_flight = InFlight::begin(app, token).await?;
    *session = Some(in_flight.log_prefix.clone());
    let reply = tokio::time::timeout_at(deadline, run(app, token, request, deadline))
        .await
        .map_err(|_| {
            failure(
                Code::Timeout,
                "The page did not finish in time, and the action may have run, so observe before you retry.",
            )
        })??;
    RawValue::from_string(reply).map_err(|error| failure(Code::Unavailable, error))
}

/// Holds a guest's in-flight flag. Dropping it clears the flag on the UI
/// thread, so every exit, a timeout included, frees the page.
struct InFlight {
    app: AppHandle,
    session: String,
    log_prefix: String,
}

impl InFlight {
    async fn begin(app: &AppHandle, token: &str) -> Result<Self, String> {
        let (session, log_prefix) = hop(app, token, |browser| {
            if browser.control_busy.replace(true) {
                return Err(failure(
                    Code::Busy,
                    "Another action is still running on this page, so wait for it to finish.",
                ));
            }
            Ok((browser.instance.clone(), browser.log_prefix().to_owned()))
        })
        .await?;
        Ok(Self {
            app: app.clone(),
            session,
            log_prefix,
        })
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        let session = std::mem::take(&mut self.session);
        let _ = self.app.run_on_main_thread(move || {
            let _ = with_browser(&session, |browser| {
                browser.control_busy.set(false);
                Ok(())
            });
        });
    }
}

enum Failure {
    StaleRef,
    Coded(String),
}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::Coded(message)
    }
}

async fn run(
    app: &AppHandle,
    token: &str,
    request: Request,
    deadline: Instant,
) -> Result<String, String> {
    match perform(app, token, &request, deadline).await {
        Ok(reply) => Ok(reply),
        Err(Failure::Coded(message)) => Err(message),
        Err(Failure::StaleRef) => Err(stale_ref_message(&snapshot(app, token, None).await?)?),
    }
}

async fn perform(
    app: &AppHandle,
    token: &str,
    request: &Request,
    deadline: Instant,
) -> Result<String, Failure> {
    match request {
        Request::Observe { scope } => Ok(snapshot(app, token, *scope).await?),
        Request::Wait {
            condition,
            timeout_ms,
        } => {
            wait(app, token, condition, *timeout_ms).await?;
            Ok(snapshot(app, token, None).await?)
        }
        _ => {
            let start_revision = change_page(app, token, request).await?;
            settle_page(app, token, start_revision, deadline).await?;
            Ok(snapshot(app, token, None).await?)
        }
    }
}

/// Runs an action that can change the page and returns the revision it started from.
async fn change_page(app: &AppHandle, token: &str, request: &Request) -> Result<u64, Failure> {
    let history = match request {
        Request::Navigate { url } => {
            let url = url.clone();
            return Ok(hop(app, token, move |browser| {
                let revision = browser.document_revision();
                browser
                    .navigate(&url, false)
                    .map_err(|error| failure(Code::InvalidUrl, error))?;
                Ok(revision)
            })
            .await?);
        }
        Request::Fill {
            reference,
            text,
            submit: Some(true),
        } => return fill_and_submit(app, token, reference, text).await,
        Request::Back {} => BrowserAction::Back,
        Request::Forward {} => BrowserAction::Forward,
        Request::Reload {} => BrowserAction::Reload,
        _ => return act(app, token, request).await,
    };
    Ok(hop(app, token, move |browser| {
        let revision = browser.document_revision();
        browser
            .history(history)
            .map_err(|error| failure(Code::Unavailable, error))?;
        Ok(revision)
    })
    .await?)
}

/// Runs one action script and returns the revision it ran in.
async fn act(app: &AppHandle, token: &str, request: &Request) -> Result<u64, Failure> {
    let revision = current_ref_revision(app, token, request).await?;
    let reply = evaluate(
        app.clone(),
        token.to_owned(),
        json!({"revision": revision, "request": request}),
    )
    .await?;
    if !page_reply::<Done>(&reply)?.ok {
        return Err(malformed_reply());
    }
    Ok(revision)
}

/// Fills the field, then sends Enter in a second evaluation, so page
/// microtasks queued by the `input` event, such as one that enables the
/// submit button, run in between. The Enter step runs only in the document
/// the fill ran in.
async fn fill_and_submit(
    app: &AppHandle,
    token: &str,
    reference: &str,
    text: &str,
) -> Result<u64, Failure> {
    let fill = Request::Fill {
        reference: reference.to_owned(),
        text: text.to_owned(),
        submit: None,
    };
    let revision = act(app, token, &fill).await?;
    let reply = evaluate(
        app.clone(),
        token.to_owned(),
        json!({
            "revision": revision,
            "request": Request::Press { key: Key::Enter },
            "fillRef": reference,
        }),
    )
    .await?;
    enter_step_skipped(&reply)?;
    Ok(revision)
}

/// The current revision. Native code rejects a ref from an older revision
/// before the page sees it.
async fn current_ref_revision(
    app: &AppHandle,
    token: &str,
    request: &Request,
) -> Result<u64, Failure> {
    let revision = hop(app, token, |browser| Ok(browser.document_revision())).await?;
    if request
        .reference()
        .is_some_and(|reference| ref_revision(reference) != Some(revision))
    {
        return Err(Failure::StaleRef);
    }
    Ok(revision)
}

/// Polls native state until `settle` stops, so the Snapshot after a
/// page-changing action shows the page it led to.
async fn settle_page(
    app: &AppHandle,
    token: &str,
    start_revision: u64,
    deadline: Instant,
) -> Result<(), String> {
    let started = Instant::now();
    loop {
        let (revision, loading) = hop(app, token, |browser| {
            Ok((
                browser.document_revision(),
                platform::loading(&browser.guest),
            ))
        })
        .await?;
        let now = Instant::now();
        let decision = settle(
            now - started,
            deadline.saturating_duration_since(now),
            start_revision,
            revision,
            loading,
        );
        if decision == Settle::Stop {
            return Ok(());
        }
        tokio::time::sleep(SETTLE_POLL).await;
    }
}

/// Tests the condition until it holds or `timeout_ms` passes. Each test
/// checks the token and visibility, so a revoke ends the wait within one poll.
async fn wait(
    app: &AppHandle,
    token: &str,
    condition: &Condition,
    timeout_ms: u64,
) -> Result<(), Failure> {
    let until = Instant::now() + Duration::from_millis(timeout_ms);
    let poll = match condition {
        Condition::Load(_) => SETTLE_POLL,
        Condition::Ref(_) => REF_WAIT_POLL,
    };
    loop {
        if condition_holds(app, token, condition).await? {
            return Ok(());
        }
        let now = Instant::now();
        if now >= until {
            return Err(Failure::Coded(failure(
                Code::Timeout,
                format!("The condition did not hold within {timeout_ms} ms."),
            )));
        }
        tokio::time::sleep(poll.min(until - now)).await;
    }
}

async fn condition_holds(
    app: &AppHandle,
    token: &str,
    condition: &Condition,
) -> Result<bool, Failure> {
    let reference = match condition {
        Condition::Load(_) => {
            return Ok(hop(app, token, |browser| Ok(!platform::loading(&browser.guest))).await?)
        }
        Condition::Ref(RefCondition { reference }) => reference,
    };
    let request = Request::Wait {
        condition: condition.clone(),
        timeout_ms: 0,
    };
    let revision = current_ref_revision(app, token, &request).await?;
    let reply = evaluate(
        app.clone(),
        token.to_owned(),
        json!({"revision": revision, "request": {"action": "wait", "for": {"ref": reference}}}),
    )
    .await?;
    Ok(page_reply::<Met>(&reply)?.met)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageError {
    error: PageErrorDetail,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PageErrorDetail {
    code: Code,
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Done {
    ok: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Met {
    met: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PageReply<T> {
    Value(T),
    Error(PageError),
}

fn malformed_reply() -> Failure {
    Failure::Coded(failure(
        Code::Unavailable,
        "The page sent a malformed reply.",
    ))
}

/// Parses a `control.js` reply that is `T` or one of the page's four error codes.
fn page_reply<T: DeserializeOwned>(reply: &str) -> Result<T, Failure> {
    match serde_json::from_str(reply) {
        Ok(PageReply::Value(value)) => Ok(value),
        Ok(PageReply::Error(PageError { error })) if error.code == Code::StaleRef => {
            Err(Failure::StaleRef)
        }
        Ok(PageReply::Error(PageError { error })) if error.code.page_may_send() => {
            Err(Failure::Coded(failure(error.code, error.message)))
        }
        _ => Err(malformed_reply()),
    }
}

struct NativeFields {
    url: String,
    title: String,
    revision: u64,
    loading: bool,
}

/// Reads the fields a hostile page cannot forge, in the hop that starts the
/// extraction script, so they and the refs describe one document.
fn native_fields(browser: &BrowserSession) -> Result<NativeFields, String> {
    let status = browser
        .snapshot()
        .map_err(|error| failure(Code::Unavailable, error))?;
    Ok(NativeFields {
        url: status.url,
        title: status.title,
        revision: browser.document_revision(),
        loading: status.loading,
    })
}

async fn snapshot(app: &AppHandle, token: &str, scope: Option<Scope>) -> Result<String, String> {
    let request = Request::Observe { scope };
    let (native, reply) = hop(app, token, move |browser| {
        let native = native_fields(browser)?;
        let reply = start_script(
            browser,
            &json!({"revision": native.revision, "request": request}),
        )?;
        Ok((native, reply))
    })
    .await?;
    let reply = receive(reply).await?;
    let final_revision = hop(app, token, |browser| Ok(browser.document_revision())).await?;
    assemble_snapshot(&reply, &native, final_revision)
}

type Reply = tokio::sync::oneshot::Receiver<Result<String, String>>;

fn start_script(browser: &BrowserSession, input: &Value) -> Result<Reply, String> {
    let script = format!(
        "(() => {{ const operate = {}; return operate({input}); }})()",
        include_str!("control.js"),
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(sender));
    browser
        .guest
        .evaluate_script_with_callback(&script, move |reply| {
            let reply = if reply.len() > REPLY_BYTES {
                Err(failure(
                    Code::Unavailable,
                    "The page sent a reply larger than 128 KiB.",
                ))
            } else {
                Ok(reply)
            };
            if let Some(sender) = sender.lock().expect("Browser callback lock").take() {
                let _ = sender.send(reply);
            }
        })
        .map_err(|error| failure(Code::Unavailable, error))?;
    Ok(receiver)
}

async fn receive(reply: Reply) -> Result<String, String> {
    reply
        .await
        .map_err(|_| failure(Code::NotVisible, "The page closed before it replied."))?
}

/// Sends one `control.js` evaluation to the guest that `token` controls and
/// returns its raw reply.
pub(crate) async fn evaluate(
    app: AppHandle,
    token: String,
    input: Value,
) -> Result<String, String> {
    let reply = hop(&app, &token, move |browser| start_script(browser, &input)).await?;
    let reply = receive(reply).await?;
    // A reply arriving after a revoke or a closed guest must not count.
    hop(&app, &token, |_| Ok(())).await?;
    Ok(reply)
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PagePart {
    text: String,
    elements: Vec<Element>,
    truncated: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Element {
    #[serde(rename = "ref")]
    reference: String,
    role: String,
    name: String,
    in_viewport: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    href: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<bool>,
}

impl Element {
    fn follows_the_rules(&self, revision: u64) -> bool {
        ref_revision(&self.reference) == Some(revision)
            && role_allowed(&self.role)
            && self.name.chars().count() <= NAME_CHARS
            && self.href.as_deref().is_none_or(|href| {
                href.len() <= HREF_BYTES
                    && (href.starts_with("http://") || href.starts_with("https://"))
            })
    }
}

fn role_allowed(role: &str) -> bool {
    (1..=ROLE_BYTES).contains(&role.len())
        && role.bytes().all(|byte| byte.is_ascii_lowercase())
        && !matches!(role, "presentation" | "none" | "generic")
}

#[derive(Serialize)]
struct Snapshot<'a> {
    url: &'a str,
    title: &'a str,
    revision: u64,
    loading: bool,
    text: &'a str,
    elements: &'a [Element],
    truncated: bool,
}

/// Builds the Snapshot JSON from the page's reply and the native fields.
/// Only a forged reply breaks a page rule, so a violation fails the call
/// rather than being repaired.
fn assemble_snapshot(
    reply: &str,
    native: &NativeFields,
    final_revision: u64,
) -> Result<String, String> {
    let malformed = || failure(Code::Unavailable, "The page sent a malformed Snapshot.");
    let page: PagePart = serde_json::from_str(reply).map_err(|_| malformed())?;
    if page.elements.len() > ELEMENT_LIMIT
        || page.text.chars().count() > TEXT_CHARS
        || !page
            .elements
            .iter()
            .all(|element| element.follows_the_rules(native.revision))
        || serde_json::to_vec(&page).map_err(|_| malformed())?.len() > PAGE_PART_BYTES
    {
        return Err(malformed());
    }
    let (title, title_cut) = cut_chars(&native.title, TITLE_CHARS);
    let (url, url_cut) = cut_bytes(&native.url, URL_BYTES);
    let snapshot = serde_json::to_string(&Snapshot {
        url,
        title,
        revision: native.revision,
        loading: native.loading || final_revision != native.revision,
        text: &page.text,
        elements: &page.elements,
        truncated: page.truncated || title_cut || url_cut,
    })
    .map_err(|_| malformed())?;
    if snapshot.len() > REPLY_BYTES {
        return Err(failure(
            Code::Unavailable,
            "The Snapshot is larger than 128 KiB.",
        ));
    }
    Ok(snapshot)
}

fn cut_chars(value: &str, most: usize) -> (&str, bool) {
    match value.char_indices().nth(most) {
        Some((end, _)) => (&value[..end], true),
        None => (value, false),
    }
}

fn cut_bytes(value: &str, most: usize) -> (&str, bool) {
    if value.len() <= most {
        return (value, false);
    }
    let end = (0..=most)
        .rev()
        .find(|&end| value.is_char_boundary(end))
        .unwrap_or(0);
    (&value[..end], true)
}

fn stale_ref_message(snapshot: &str) -> Result<String, String> {
    let message = format!(
        "{}\n{snapshot}",
        failure(
            Code::StaleRef,
            "The page changed after that ref was issued. Use refs from this Snapshot."
        )
    );
    if message.len() > REPLY_BYTES {
        return Err(failure(
            Code::Unavailable,
            "The stale_ref reply is larger than 128 KiB.",
        ));
    }
    Ok(message)
}

#[derive(Debug, PartialEq, Eq)]
enum Settle {
    Continue,
    Stop,
}

/// One settle poll. A new document counts once it has loaded, and the same
/// document counts once it has stayed idle for `SETTLE_QUIET`.
fn settle(
    elapsed: Duration,
    remaining: Duration,
    start_revision: u64,
    current_revision: u64,
    loading: bool,
) -> Settle {
    let done = if remaining <= SETTLE_RESERVE {
        true
    } else if current_revision != start_revision {
        !loading
    } else {
        !loading && elapsed >= SETTLE_QUIET
    };
    if done {
        Settle::Stop
    } else {
        Settle::Continue
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EnterStep {
    skipped: bool,
}

/// Whether the Enter step of `fill` with `submit` skipped a document that
/// does not hold the filled ref. Any other reply is malformed.
fn enter_step_skipped(reply: &str) -> Result<bool, String> {
    serde_json::from_str::<EnterStep>(reply)
        .map(|step| step.skipped)
        .map_err(|_| failure(Code::Unavailable, "The page sent a malformed reply."))
}

pub fn handle(request: tauri::ipc::Invoke<tauri::Wry>) -> bool {
    let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
        browser_control_grant,
        browser_control_revoke,
        browser_control_execute
    ];
    handler(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    /// The parse and validation that `browser_control_execute` applies to a raw request.
    fn checked(request: &str) -> Result<Request, String> {
        let request: Request = serde_json::from_str(request).map_err(|error| error.to_string())?;
        request.validate().map_err(|error| error.to_string())?;
        Ok(request)
    }

    /// Each row is (name, raw request, Ok or Err with a fragment the error must contain).
    fn validation_mismatches(rows: Vec<(&str, String, Result<(), &str>)>) -> Vec<String> {
        rows.into_iter()
            .filter_map(|(name, request, expected)| {
                let outcome = checked(&request);
                let matched = match (&outcome, expected) {
                    (Ok(_), Ok(())) => true,
                    (Err(error), Err(fragment)) => error.contains(fragment),
                    _ => false,
                };
                (!matched).then(|| format!("{name}: expected {expected:?}, got {outcome:?}"))
            })
            .collect()
    }

    fn page(revision: u64) -> NativeFields {
        NativeFields {
            url: "https://example.com/".into(),
            title: "Example".into(),
            revision,
            loading: false,
        }
    }

    #[test]
    fn native_validation_accepts_refs_and_text_up_to_their_limits_and_rejects_selector() {
        let text_at_limit = "é".repeat(4096);
        let text_over_limit = format!("{text_at_limit}x");
        let mismatches = validation_mismatches(vec![
            (
                "highest ref index",
                r#"{"action":"click","ref":"r1e999999"}"#.into(),
                Ok(()),
            ),
            (
                "ref index past the pattern",
                r#"{"action":"click","ref":"r1e1000000"}"#.into(),
                Err(""),
            ),
            (
                "8192 bytes of text",
                json!({"action": "fill", "ref": "r1e1", "text": text_at_limit}).to_string(),
                Ok(()),
            ),
            (
                "8193 bytes of text",
                json!({"action": "fill", "ref": "r1e1", "text": text_over_limit}).to_string(),
                Err(""),
            ),
            (
                "selector field",
                r##"{"action":"click","selector":"#name"}"##.into(),
                Err("selector"),
            ),
        ]);
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn largest_honest_page_part_with_capped_title_and_url_fits_a_stale_ref_message() {
        let control_name = "\u{1}".repeat(200);
        let reply = json!({
            "text": format!("{}{}", "\u{1}".repeat(19_813), "\\".repeat(95)),
            "elements": [
                {"ref": "r7e1", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e2", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e3", "role": "link", "name": control_name, "inViewport": true},
            ],
            "truncated": true,
        })
        .to_string();
        assert_eq!(
            reply.len(),
            122_880,
            "precondition: page part at the 120 KiB cap"
        );
        let native = NativeFields {
            url: "\\".repeat(2048),
            title: "\u{1}".repeat(200),
            revision: 7,
            loading: false,
        };

        let snapshot = assemble_snapshot(&reply, &native, 7).expect("an honest page assembles");
        let message = stale_ref_message(&snapshot).expect("the stale_ref message fits");

        assert!(
            message.starts_with(
                "stale_ref: The page changed after that ref was issued. Use refs from this Snapshot.\n"
            ),
            "{}",
            message.chars().take(120).collect::<String>()
        );
        assert!(
            message.len() < 131_072,
            "message is {} bytes",
            message.len()
        );
    }

    #[test]
    fn page_part_one_byte_over_120_kib_is_unavailable() {
        let control_name = "\u{1}".repeat(200);
        let reply = json!({
            "text": format!("{}{}a", "\u{1}".repeat(19_813), "\\".repeat(95)),
            "elements": [
                {"ref": "r7e1", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e2", "role": "link", "name": control_name, "inViewport": true},
                {"ref": "r7e3", "role": "link", "name": control_name, "inViewport": true},
            ],
            "truncated": true,
        })
        .to_string();
        assert_eq!(
            reply.len(),
            122_881,
            "precondition: page part one byte over the cap"
        );

        let error = assemble_snapshot(&reply, &page(7), 7).expect_err("oversized page part");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn native_cuts_a_1_mib_title_and_url_and_marks_the_snapshot_truncated() {
        let reply = r#"{"text":"","elements":[],"truncated":false}"#;
        let native = NativeFields {
            url: format!("https://example.com/x{}", "é".repeat(524_288)),
            title: "é".repeat(524_288),
            revision: 7,
            loading: false,
        };

        let snapshot: Value =
            serde_json::from_str(&assemble_snapshot(reply, &native, 7).expect("assembles"))
                .expect("the Snapshot is JSON");

        assert_eq!(snapshot["title"], "é".repeat(200));
        assert_eq!(
            snapshot["url"],
            format!("https://example.com/x{}", "é".repeat(1013))
        );
        assert_eq!(snapshot["truncated"], true);
    }

    #[test]
    fn page_part_with_151_elements_is_unavailable() {
        let elements: Vec<Value> = (1..=151)
            .map(|index| {
                json!({"ref": format!("r7e{index}"), "role": "link", "name": "Link", "inViewport": true})
            })
            .collect();
        let reply = json!({"text": "", "elements": elements, "truncated": true}).to_string();

        let error = assemble_snapshot(&reply, &page(7), 7).expect_err("151 elements");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn page_part_with_a_ref_from_another_revision_is_unavailable() {
        let reply = r#"{"text":"","elements":[{"ref":"r6e1","role":"link","name":"Old","inViewport":true}],"truncated":false}"#;

        let error = assemble_snapshot(reply, &page(7), 7).expect_err("ref from revision 6");

        assert!(error.starts_with("unavailable: "), "{error}");
    }

    #[test]
    fn page_part_with_escapes_and_every_optional_field_reserializes_to_the_same_bytes() {
        let page_fields = r#""text":"東京 \u0001 \"quoted\" back\\slash","elements":[{"ref":"r7e1","role":"link","name":"地図 \"map\"","inViewport":true,"href":"https://example.com/map?q=1"},{"ref":"r7e2","role":"checkbox","name":"同意","inViewport":false,"checked":true,"disabled":true}],"truncated":false"#;
        let reply = format!("{{{page_fields}}}");

        let snapshot = assemble_snapshot(&reply, &page(7), 7).expect("assembles");

        assert!(snapshot.contains(page_fields), "{snapshot}");
    }

    #[test]
    fn page_part_of_150_elements_without_optional_fields_gains_no_null() {
        let elements = (1..=150)
            .map(|index| {
                format!(r#"{{"ref":"r7e{index}","role":"button","name":"Button {index}","inViewport":true}}"#)
            })
            .collect::<Vec<_>>()
            .join(",");
        let page_fields = format!(r#""text":"Buttons","elements":[{elements}],"truncated":false"#);
        let reply = format!("{{{page_fields}}}");

        let snapshot = assemble_snapshot(&reply, &page(7), 7).expect("assembles");

        assert!(snapshot.contains(&page_fields), "page part changed");
        assert!(
            !snapshot.contains("null"),
            "absent fields were written as null"
        );
    }

    #[test]
    fn new_document_during_extraction_keeps_the_earlier_fields_and_reports_loading() {
        let reply = r#"{"text":"Old page","elements":[{"ref":"r7e1","role":"link","name":"Next","inViewport":true}],"truncated":false}"#;
        let native = NativeFields {
            url: "https://example.com/old".into(),
            title: "Old".into(),
            revision: 7,
            loading: false,
        };

        let snapshot: Value =
            serde_json::from_str(&assemble_snapshot(reply, &native, 8).expect("assembles"))
                .expect("the Snapshot is JSON");

        assert_eq!(snapshot["revision"], 7);
        assert_eq!(snapshot["url"], "https://example.com/old");
        assert_eq!(snapshot["title"], "Old");
        assert_eq!(snapshot["loading"], true);
    }

    #[test]
    fn settle_stops_on_a_quiet_page_a_loaded_new_document_or_the_deadline_reserve() {
        let ms = Duration::from_millis;
        let rows = [
            (
                "same document, idle for 250 ms",
                ms(250),
                ms(4_000),
                7,
                7,
                false,
                Settle::Continue,
            ),
            (
                "same document, idle for 300 ms",
                ms(300),
                ms(4_000),
                7,
                7,
                false,
                Settle::Stop,
            ),
            (
                "same document, loading at 300 ms",
                ms(300),
                ms(4_000),
                7,
                7,
                true,
                Settle::Continue,
            ),
            (
                "new document, loading",
                ms(100),
                ms(4_000),
                7,
                8,
                true,
                Settle::Continue,
            ),
            (
                "new document, loaded",
                ms(100),
                ms(4_000),
                7,
                8,
                false,
                Settle::Stop,
            ),
            (
                "1050 ms before the deadline",
                ms(3_000),
                ms(1_050),
                7,
                8,
                true,
                Settle::Continue,
            ),
            (
                "1 s before the deadline",
                ms(3_000),
                ms(1_000),
                7,
                8,
                true,
                Settle::Stop,
            ),
        ];
        let mismatches: Vec<String> = rows
            .into_iter()
            .filter_map(
                |(name, elapsed, remaining, start, current, loading, expected)| {
                    let outcome = settle(elapsed, remaining, start, current, loading);
                    (outcome != expected)
                        .then(|| format!("{name}: expected {expected:?}, got {outcome:?}"))
                },
            )
            .collect();
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn wait_accepts_integer_timeouts_from_0_to_10000_ms() {
        let mismatches = validation_mismatches(vec![
            (
                "0 ms",
                r#"{"action":"wait","for":"load","timeout_ms":0}"#.into(),
                Ok(()),
            ),
            (
                "10000 ms",
                r#"{"action":"wait","for":"load","timeout_ms":10000}"#.into(),
                Ok(()),
            ),
            (
                "10001 ms",
                r#"{"action":"wait","for":"load","timeout_ms":10001}"#.into(),
                Err(""),
            ),
            (
                "negative",
                r#"{"action":"wait","for":"load","timeout_ms":-1}"#.into(),
                Err(""),
            ),
            (
                "fraction",
                r#"{"action":"wait","for":"load","timeout_ms":1.5}"#.into(),
                Err(""),
            ),
        ]);
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn wait_without_timeout_ms_waits_5000_ms() {
        let request = checked(r#"{"action":"wait","for":"load"}"#).expect("valid wait");

        let sent = serde_json::to_value(&request).expect("the request serializes");

        assert_eq!(sent["timeout_ms"], 5000);
    }

    #[test]
    fn native_validation_rejects_form_requests_outside_their_limits() {
        let value_at_limit = "é".repeat(512);
        let value_over_limit = format!("{value_at_limit}x");
        let mismatches = validation_mismatches(vec![
            (
                "1-byte select value",
                r#"{"action":"select","ref":"r1e1","value":"a"}"#.into(),
                Ok(()),
            ),
            (
                "1024-byte select value",
                json!({"action": "select", "ref": "r1e1", "value": value_at_limit}).to_string(),
                Ok(()),
            ),
            (
                "empty select value",
                r#"{"action":"select","ref":"r1e1","value":""}"#.into(),
                Err(""),
            ),
            (
                "1025-byte select value",
                json!({"action": "select", "ref": "r1e1", "value": value_over_limit}).to_string(),
                Err(""),
            ),
            (
                "Enter",
                r#"{"action":"press","key":"Enter"}"#.into(),
                Ok(()),
            ),
            (
                "key outside the twelve",
                r#"{"action":"press","key":"F5"}"#.into(),
                Err(""),
            ),
            (
                "scroll by direction",
                r#"{"action":"scroll","direction":"down"}"#.into(),
                Ok(()),
            ),
            (
                "scroll by ref",
                r#"{"action":"scroll","ref":"r1e1"}"#.into(),
                Ok(()),
            ),
            (
                "scroll with direction and ref",
                r#"{"action":"scroll","direction":"down","ref":"r1e1"}"#.into(),
                Err(""),
            ),
            (
                "scroll with neither field",
                r#"{"action":"scroll"}"#.into(),
                Err(""),
            ),
        ]);
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }

    #[test]
    fn enter_step_accepts_only_a_boolean_skipped_reply() {
        let rows = [
            ("skipped", r#"{"skipped":true}"#, Ok(true)),
            ("ran", r#"{"skipped":false}"#, Ok(false)),
            ("string skipped", r#"{"skipped":"x"}"#, Err("unavailable: ")),
            ("empty object", r#"{}"#, Err("unavailable: ")),
            (
                "extra field",
                r#"{"skipped":true,"text":""}"#,
                Err("unavailable: "),
            ),
            ("null", "null", Err("unavailable: ")),
            (
                "page error",
                r#"{"error":{"code":"revoked","message":"forged"}}"#,
                Err("unavailable: "),
            ),
        ];
        let mismatches: Vec<String> = rows
            .into_iter()
            .filter_map(|(name, reply, expected)| {
                let outcome = enter_step_skipped(reply);
                let matched = match (&outcome, expected) {
                    (Ok(skipped), Ok(wanted)) => *skipped == wanted,
                    (Err(error), Err(prefix)) => error.starts_with(prefix),
                    _ => false,
                };
                (!matched).then(|| format!("{name}: expected {expected:?}, got {outcome:?}"))
            })
            .collect();
        assert!(mismatches.is_empty(), "{mismatches:#?}");
    }
}
