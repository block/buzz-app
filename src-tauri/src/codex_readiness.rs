//! Explicit, bounded Codex binding checks. No model discovery or inference.
#[cfg(unix)]
use buzz_agent_controller::codex::CodexContext;
use buzz_agent_controller::ContainedProcess;
use serde::Serialize;
#[cfg(unix)]
use std::{
    io::Read,
    process::{Command, Stdio},
};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
const OUTPUT_LIMIT: usize = 64 * 1024;
#[cfg(unix)]
const MIN_ADAPTER: (u64, u64, u64) = (1, 10, 0);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Readiness {
    pub(crate) status: &'static str,
    message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli_version: Option<String>,
}

#[cfg(unix)]
pub(crate) struct ToolBinding {
    pub(crate) adapter_version: String,
    cli_version: String,
}

impl Readiness {
    fn failed(status: &'static str, message: &'static str) -> Self {
        Self {
            status,
            message,
            adapter_version: None,
            cli_version: None,
        }
    }
}

pub(crate) struct Host {
    tickets: Mutex<Tickets>,
    settled: Condvar,
    lane: Arc<tokio::sync::Mutex<()>>,
    closed: AtomicBool,
    #[cfg(test)]
    retirement_gate: Mutex<Option<(Arc<AtomicBool>, Arc<AtomicBool>)>>,
}

#[cfg(test)]
pub(crate) struct RetirementRelease(Arc<AtomicBool>);
#[cfg(test)]
impl Drop for RetirementRelease {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Tickets {
    next: u64,
    active: Option<Active>,
    running: bool,
    cleanup_failed: bool,
    retained: Vec<ContainedProcess>,
}

struct Active {
    ticket: u64,
    claimed: bool,
    cancelled: Arc<AtomicBool>,
}

struct Finish {
    owner: Arc<Host>,
    ticket: u64,
    cleanup_failed: bool,
    retained: Vec<ContainedProcess>,
}
impl Drop for Finish {
    fn drop(&mut self) {
        self.owner.finished(
            self.ticket,
            self.cleanup_failed,
            std::mem::take(&mut self.retained),
        );
    }
}

impl Default for Host {
    fn default() -> Self {
        Self {
            tickets: Mutex::new(Tickets::default()),
            settled: Condvar::new(),
            lane: Arc::new(tokio::sync::Mutex::new(())),
            closed: AtomicBool::new(false),
            #[cfg(test)]
            retirement_gate: Mutex::new(None),
        }
    }
}

impl Host {
    fn begin(&self) -> Result<u64, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Codex readiness is shutting down".into());
        }
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        if tickets.cleanup_failed || !tickets.retained.is_empty() {
            return Err("Codex readiness cleanup could not be confirmed".into());
        }
        if let Some(active) = &tickets.active {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        let ticket = tickets
            .next
            .checked_add(1)
            .ok_or("Codex readiness ticket space exhausted")?;
        tickets.next = ticket;
        tickets.active = Some(Active {
            ticket,
            claimed: false,
            cancelled: Arc::new(AtomicBool::new(false)),
        });
        Ok(ticket)
    }

    fn claim(&self, ticket: u64) -> Result<Arc<AtomicBool>, String> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        let active = tickets
            .active
            .as_mut()
            .filter(|active| active.ticket == ticket && !active.claimed)
            .ok_or("Codex readiness request expired")?;
        active.claimed = true;
        Ok(active.cancelled.clone())
    }

    fn cancel(&self, ticket: u64) {
        if let Ok(tickets) = self.tickets.lock() {
            if let Some(active) = tickets
                .active
                .as_ref()
                .filter(|active| active.ticket == ticket)
            {
                active.cancelled.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Reserve one dedicated readiness owner for a managed Start. The owner is
    /// not shared with Settings checks, so its single ticket cannot be replaced.
    pub(crate) fn begin_owned(&self) -> Result<u64, String> {
        self.begin()
    }

    /// Cancel an owned check. A ticket that has not reached native work retires
    /// immediately; claimed work remains reserved until `Finish` runs.
    pub(crate) fn cancel_owned(&self, ticket: u64) {
        if let Ok(mut tickets) = self.tickets.lock() {
            let unclaimed = tickets
                .active
                .as_ref()
                .is_some_and(|active| active.ticket == ticket && !active.claimed);
            if let Some(active) = tickets
                .active
                .as_ref()
                .filter(|active| active.ticket == ticket)
            {
                active.cancelled.store(true, Ordering::SeqCst);
            }
            if unclaimed {
                tickets.active = None;
                self.settled.notify_all();
            }
        }
    }

    /// `Ok(false)` means native cleanup still owns the ticket. A cleanup error
    /// remains sticky and must block future starts until app restart.
    pub(crate) fn retirement(&self) -> Result<bool, String> {
        let tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness cleanup could not be confirmed")?;
        if tickets.running || tickets.active.is_some() {
            Ok(false)
        } else if tickets.cleanup_failed || !tickets.retained.is_empty() {
            Err("Codex readiness cleanup could not be confirmed".into())
        } else {
            Ok(true)
        }
    }

    #[cfg(test)]
    pub(crate) fn hold_retirement(&self) -> (Arc<AtomicBool>, RetirementRelease) {
        let entered = Arc::new(AtomicBool::new(false));
        let release = Arc::new(AtomicBool::new(false));
        if let Ok(mut gate) = self.retirement_gate.lock() {
            *gate = Some((entered.clone(), release.clone()));
        }
        (entered, RetirementRelease(release))
    }

    #[cfg(test)]
    fn wait_for_retirement_gate(&self) {
        let gate = self
            .retirement_gate
            .lock()
            .ok()
            .and_then(|gate| gate.clone());
        if let Some((entered, release)) = gate {
            entered.store(true, Ordering::SeqCst);
            while !release.load(Ordering::SeqCst) {
                std::thread::yield_now();
            }
        }
    }

    fn started(&self, ticket: u64) -> Result<(), String> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness is unavailable")?;
        let active = tickets
            .active
            .as_ref()
            .filter(|active| active.ticket == ticket);
        if self.closed.load(Ordering::SeqCst)
            || active.is_none()
            || active.is_some_and(|active| active.cancelled.load(Ordering::SeqCst))
        {
            return Err("Codex readiness request expired".into());
        }
        tickets.running = true;
        Ok(())
    }

    fn finished(&self, ticket: u64, cleanup_failed: bool, retained: Vec<ContainedProcess>) {
        if let Ok(mut tickets) = self.tickets.lock() {
            tickets.running = false;
            tickets.cleanup_failed |= cleanup_failed;
            tickets.retained.extend(retained);
            if tickets.active.as_ref().map(|active| active.ticket) == Some(ticket) {
                tickets.active = None;
            }
            self.settled.notify_all();
        }
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        self.closed.store(true, Ordering::SeqCst);
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| "Codex readiness cleanup could not be confirmed")?;
        if let Some(active) = &tickets.active {
            active.cancelled.store(true, Ordering::SeqCst);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while tickets.running {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Codex readiness cleanup could not be confirmed".into());
            }
            let (next, timed) = self
                .settled
                .wait_timeout(tickets, remaining)
                .map_err(|_| "Codex readiness cleanup could not be confirmed")?;
            tickets = next;
            if timed.timed_out() && tickets.running {
                return Err("Codex readiness cleanup could not be confirmed".into());
            }
        }
        tickets
            .retained
            .retain_mut(|process| process.stop().is_err());
        if tickets.cleanup_failed || !tickets.retained.is_empty() {
            Err("Codex readiness cleanup could not be confirmed".into())
        } else {
            Ok(())
        }
    }
}

#[tauri::command]
pub(crate) fn codex_readiness_begin(state: tauri::State<'_, Arc<Host>>) -> Result<u64, String> {
    state.begin()
}

#[tauri::command]
pub(crate) fn codex_readiness_cancel(state: tauri::State<'_, Arc<Host>>, ticket: u64) {
    state.cancel(ticket);
}

#[tauri::command]
pub(crate) async fn codex_readiness_run(
    state: tauri::State<'_, Arc<Host>>,
    agents: tauri::State<'_, crate::agents::AgentHost>,
    ticket: u64,
) -> Result<Readiness, String> {
    let (workspace, app_data) = agents.codex_paths().await?;
    let owner = state.inner().clone();
    let cancelled = owner.claim(ticket)?;
    let result_cancelled = cancelled.clone();
    let lane = owner.lane.clone().lock_owned().await;
    if cancelled.load(Ordering::SeqCst) || owner.closed.load(Ordering::SeqCst) {
        return Err("Codex readiness check was cancelled".into());
    }
    owner.started(ticket)?;
    let check_owner = owner.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let _lane = lane;
        let mut finish = Finish {
            owner: check_owner.clone(),
            ticket,
            cleanup_failed: true,
            retained: Vec::new(),
        };
        let result = check(
            &workspace,
            &app_data,
            || !cancelled.load(Ordering::SeqCst) && !check_owner.closed.load(Ordering::SeqCst),
            &mut finish.retained,
        );
        finish.cleanup_failed = false;
        result
    })
    .await;
    let result = joined.map_err(|_| "Codex readiness check failed")??;
    if result_cancelled.load(Ordering::SeqCst) || owner.closed.load(Ordering::SeqCst) {
        return Err("Codex readiness check was cancelled".into());
    }
    Ok(result)
}

fn check(
    workspace: &Path,
    app_data: &Path,
    current: impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<Readiness, String> {
    #[cfg(not(unix))]
    {
        let _ = (workspace, app_data, current, retained);
        return Ok(Readiness::failed(
            "unsupported",
            "Codex binding is not enabled on this platform yet.",
        ));
    }
    #[cfg(unix)]
    {
        let context = match CodexContext::installed(workspace, Some(app_data)) {
            Ok(context) => context,
            Err(error) => return Ok(resolution_failure(&error)),
        };
        if !current() {
            return Err("Codex readiness check was cancelled".into());
        }
        check_context(context, &current, retained)
    }
}

#[cfg(unix)]
fn resolution_failure(error: &str) -> Readiness {
    if error.contains("Node.js") || error.contains("interpreter") {
        Readiness::failed(
            "interpreter-needed",
            "Install Node.js for the selected Codex CLI and ACP adapter, then check again.",
        )
    } else if error.contains("adapter") {
        Readiness::failed(
            "adapter-needed",
            "Install @agentclientprotocol/codex-acp 1.10.0 or later, then check again.",
        )
    } else if error.contains("CLI") {
        Readiness::failed("cli-needed", "Install the Codex CLI, then check again.")
    } else {
        Readiness::failed(
            "configuration-error",
            "Codex configuration could not be resolved. Repair it, then check again.",
        )
    }
}

#[cfg(unix)]
fn check_context(
    context: CodexContext,
    current: &impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<Readiness, String> {
    let binding = match check_binding(&context, current, retained) {
        Ok(binding) => binding,
        Err(status) => return Ok(status),
    };
    Ok(Readiness {
        status: "binding-ready",
        message: "Codex is ready.",
        adapter_version: Some(binding.adapter_version),
        cli_version: Some(binding.cli_version),
    })
}

#[cfg(unix)]
pub(crate) fn check_binding(
    context: &CodexContext,
    current: &impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<ToolBinding, Readiness> {
    let binding = check_tools(context, current, retained)?;
    crate::codex_acp::initialize(context, &binding.adapter_version, current, retained)
        .map_err(acp_failure)?;
    Ok(binding)
}

/// Run complete binding readiness under a dedicated native owner. `Finish`
/// lives in this blocking call, so task cancellation or runtime teardown cannot
/// retire the ticket before process cleanup actually settles.
#[cfg(unix)]
pub(crate) fn check_binding_owned(
    owner: Arc<Host>,
    ticket: u64,
    context: &CodexContext,
    current: &impl Fn() -> bool,
) -> Result<ToolBinding, Readiness> {
    run_owned(
        owner,
        ticket,
        || Readiness::failed("cancelled", "Codex readiness check was cancelled."),
        |cancelled, retained| {
            check_binding(
                context,
                &|| current() && !cancelled.load(Ordering::SeqCst),
                retained,
            )
        },
    )
}

#[cfg(unix)]
pub(crate) fn run_owned<T, E>(
    owner: Arc<Host>,
    ticket: u64,
    cancelled_error: impl Fn() -> E,
    operation: impl FnOnce(Arc<AtomicBool>, &mut Vec<ContainedProcess>) -> Result<T, E>,
) -> Result<T, E> {
    let cancelled = owner.claim(ticket).map_err(|_| cancelled_error())?;
    let mut finish = Finish {
        owner: owner.clone(),
        ticket,
        cleanup_failed: false,
        retained: Vec::new(),
    };
    owner.started(ticket).map_err(|_| cancelled_error())?;
    finish.cleanup_failed = true;
    let result = operation(cancelled, &mut finish.retained);
    #[cfg(test)]
    owner.wait_for_retirement_gate();
    finish.cleanup_failed = false;
    result
}

#[cfg(unix)]
pub(crate) fn check_tools(
    context: &CodexContext,
    current: &impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<ToolBinding, Readiness> {
    let adapter = readiness_probe(context.adapter_command(), &["--version"], current, retained)?;
    let adapter_version = parse_version(&adapter.stdout, &["@agentclientprotocol/codex-acp "]);
    let Some(adapter_version) = adapter_version else {
        return Err(Readiness::failed(
                "adapter-incompatible",
                "The Codex ACP adapter is incompatible. Install @agentclientprotocol/codex-acp 1.10.0 or later.",
            ));
    };
    if !adapter.success || version_tuple(&adapter_version) < Some(MIN_ADAPTER) {
        return Err(Readiness::failed(
                "adapter-incompatible",
                "The Codex ACP adapter is incompatible. Install @agentclientprotocol/codex-acp 1.10.0 or later.",
            ));
    }
    let cli = readiness_probe(context.cli_command(), &["--version"], current, retained)?;
    let Some(cli_version) = parse_version(&cli.stdout, &["codex-cli "]) else {
        return Err(Readiness::failed(
            "cli-incompatible",
            "The selected Codex CLI version could not be verified. Update Codex, then check again.",
        ));
    };
    if !cli.success {
        return Err(Readiness::failed(
            "cli-incompatible",
            "The selected Codex CLI version could not be verified. Update Codex, then check again.",
        ));
    }
    let login = readiness_probe(
        context.cli_command(),
        &["login", "status"],
        current,
        retained,
    )?;
    if !login.success {
        let combined = format!("{} {}", login.stdout, login.stderr).to_lowercase();
        if combined.contains("not logged in") || combined.contains("sign in") {
            return Err(Readiness::failed(
                "signed-out",
                "Sign in with the selected Codex CLI, then check again.",
            ));
        }
        return Err(Readiness::failed(
            "configuration-error",
            "Codex could not read its configuration or login. Repair it, then check again.",
        ));
    }
    Ok(ToolBinding {
        adapter_version,
        cli_version,
    })
}

#[cfg(unix)]
fn acp_failure(failure: crate::codex_acp::Failure) -> Readiness {
    use crate::codex_acp::Failure;
    match failure {
        Failure::Cancelled => {
            Readiness::failed("cancelled", "Codex readiness check was cancelled.")
        }
        Failure::Timeout => Readiness::failed(
            "timeout",
            "The Codex ACP adapter check timed out. Try again.",
        ),
        Failure::OutputLimit => Readiness::failed(
            "output-limit",
            "The Codex ACP adapter returned too much output.",
        ),
        Failure::Cleanup => Readiness::failed(
            "cleanup-failed",
            "The Codex ACP adapter process could not be cleaned up.",
        ),
        Failure::Incompatible => Readiness::failed(
            "adapter-incompatible",
            "The Codex ACP adapter is incompatible with this binding.",
        ),
        Failure::Authentication => Readiness::failed(
            "signed-out",
            "Sign in with the selected Codex CLI, then check again.",
        ),
        Failure::Network => Readiness::failed(
            "configuration-error",
            "The Codex ACP adapter could not reach its service.",
        ),
        Failure::Rejected | Failure::Quota | Failure::Context | Failure::Limit => {
            Readiness::failed(
                "adapter-incompatible",
                "The Codex ACP adapter is incompatible with this binding.",
            )
        }
    }
}

#[cfg(unix)]
fn readiness_probe(
    command: Command,
    args: &[&str],
    current: &impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<Output, Readiness> {
    probe(command, args, PROBE_TIMEOUT, current, retained).map_err(|error| {
        if error.contains("cancelled") {
            Readiness::failed("cancelled", "Codex readiness check was cancelled.")
        } else if error.contains("timed out") {
            Readiness::failed("timeout", "Codex readiness check timed out. Try again.")
        } else if error.contains("output exceeded") {
            Readiness::failed(
                "output-limit",
                "Codex readiness output exceeded its safety limit.",
            )
        } else if error.contains("cleanup failed") {
            Readiness::failed(
                "cleanup-failed",
                "Codex readiness process cleanup could not be confirmed.",
            )
        } else {
            Readiness::failed(
                "check-failed",
                "Codex readiness could not be checked. Try again.",
            )
        }
    })
}

#[cfg(unix)]
struct Output {
    success: bool,
    stdout: String,
    stderr: String,
}

#[cfg(unix)]
fn probe(
    mut command: Command,
    args: &[&str],
    timeout: Duration,
    current: &impl Fn() -> bool,
    retained: &mut Vec<ContainedProcess>,
) -> Result<Output, String> {
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = ContainedProcess::spawn(&mut command)
        .map_err(|_| "Could not start Codex readiness process")?;
    let stdout = process
        .take_stdout()
        .ok_or("Could not capture Codex output")?;
    let stderr = process
        .take_stderr()
        .ok_or("Could not capture Codex output")?;
    let overflow = Arc::new(AtomicBool::new(false));
    let out = capture(stdout, overflow.clone());
    let err = capture(stderr, overflow.clone());
    let deadline = Instant::now() + timeout;
    loop {
        if !current() {
            crate::codex_acp::retire(process, retained)
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness check was cancelled".into());
        }
        if overflow.load(Ordering::SeqCst) {
            crate::codex_acp::retire(process, retained)
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness output exceeded its limit".into());
        }
        let Ok(alive) = process.alive() else {
            crate::codex_acp::retire(process, retained)
                .map_err(|_| "Codex readiness process cleanup failed")?;
            return Err("Codex readiness process cleanup failed".into());
        };
        if !alive {
            break;
        }
        if Instant::now() >= deadline {
            crate::codex_acp::retire(process, retained)
                .map_err(|_| "Codex readiness process cleanup failed")?;
            let _ = (out.join(), err.join());
            return Err("Codex readiness check timed out".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let success = process.exit_success() == Some(true);
    let stdout = out
        .join()
        .map_err(|_| "Could not capture Codex output")?
        .map_err(|_| "Could not read Codex output")?;
    let stderr = err
        .join()
        .map_err(|_| "Could not capture Codex output")?
        .map_err(|_| "Could not read Codex output")?;
    if overflow.load(Ordering::SeqCst) {
        return Err("Codex readiness output exceeded its limit".into());
    }
    Ok(Output {
        success,
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
    })
}

#[cfg(unix)]
fn capture(
    mut reader: impl Read + Send + 'static,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<std::io::Result<Vec<u8>>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(error) => return Err(error),
                Ok(count) => {
                    let remaining = OUTPUT_LIMIT.saturating_sub(kept.len());
                    kept.extend_from_slice(&chunk[..count.min(remaining)]);
                    if count > remaining {
                        overflow.store(true, Ordering::SeqCst);
                    }
                }
            }
        }
        Ok(kept)
    })
}

#[cfg(unix)]
fn parse_version(output: &str, prefixes: &[&str]) -> Option<String> {
    let line = output.trim();
    for prefix in prefixes {
        if let Some(value) = line.strip_prefix(prefix) {
            let value = value.trim();
            if version_tuple(value).is_some() {
                return Some(value.to_owned());
            }
        }
    }
    None
}

#[cfg(unix)]
fn version_tuple(value: &str) -> Option<(u64, u64, u64)> {
    let mut parts = value.split('.');
    let result = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(result)
}

#[cfg(test)]
mod tests;
