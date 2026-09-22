//! App-owned process lifecycle. Page disposal does not own compute; plugin disable
//! and app exit do. Only our child handle is ever stopped, never a discovered PID.
use buzz_community_compute::worker::{
    Download, StartRequest, Update, WorkerInput, OUTPUT_PREFIX, WORKER_ARG,
};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub preferred_mode: String,
    pub api_base_url: Option<String>,
    pub usage: Option<buzz_community_compute::usage::Usage>,
    pub available: bool,
    pub generation: u64,
    pub state: String,
    pub mode: Option<String>,
    pub model_id: Option<String>,
    pub community: Option<String>,
    pub viewer: Option<String>,
    pub detail: Option<String>,
    pub download: Option<Download>,
}
struct Core {
    testing: bool,
    usage_at: Option<Instant>,
    stopping: bool,
    status: Status,
    child: Option<Arc<Mutex<Child>>>,
}
#[derive(Clone)]
pub struct ComputeHost {
    core: Arc<Mutex<Core>>,
    operation: Arc<Mutex<()>>,
    allowed: Arc<AtomicBool>,
    path: Option<PathBuf>,
    broker: Option<String>,
    grace: Duration,
    #[cfg(test)]
    fixture: Option<PathBuf>,
}
pub struct TestLease {
    host: ComputeHost,
    pub status: Status,
}
impl TestLease {
    pub fn is_current(&self) -> bool {
        self.host.status().is_ok_and(|s| {
            s.generation == self.status.generation
                && s.state == "running"
                && s.mode.as_deref() == Some("client")
        })
    }
}
impl Drop for TestLease {
    fn drop(&mut self) {
        if let Ok(mut core) = self.host.core.lock() {
            core.testing = false;
        }
    }
}
impl ComputeHost {
    pub fn new(path: Option<PathBuf>, broker: Option<String>, enabled: bool) -> Self {
        let available = cfg!(debug_assertions) && path.is_some() && broker.is_some();
        Self {
            core: Arc::new(Mutex::new(Core {
                testing: false,
                usage_at: None,
                stopping: false,
                status: Status {
                    usage: None,
                    preferred_mode: std::env::var("BUZZ_COMPUTE_ROLE")
                        .unwrap_or_else(|_| "serve".into()),
                    api_base_url: None,
                    available,
                    generation: 0,
                    state: "off".into(),
                    mode: None,
                    model_id: None,
                    community: None,
                    viewer: None,
                    detail: None,
                    download: None,
                },
                child: None,
            })),
            operation: Arc::new(Mutex::new(())),
            allowed: Arc::new(AtomicBool::new(enabled)),
            path: path.map(|p| p.join("community-compute.json")),
            broker,
            grace: Duration::from_secs(6),
            #[cfg(test)]
            fixture: None,
        }
    }
    pub fn status(&self) -> Result<Status, String> {
        let core = self.core.lock().map_err(|_| "Compute state unavailable")?;
        let mut status = core.status.clone();
        if status.state != "running"
            || !core
                .usage_at
                .is_some_and(|at| at.elapsed() < Duration::from_secs(5))
        {
            status.usage = None;
        }
        status.available &= self.allowed.load(Ordering::SeqCst);
        Ok(status)
    }
    pub fn begin_test(&self, generation: u64) -> Result<TestLease, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Compute operation unavailable")?;
        let mut core = self.core.lock().map_err(|_| "Compute state unavailable")?;
        if core.testing
            || core.status.generation != generation
            || core.status.state != "running"
            || core.status.mode.as_deref() != Some("client")
        {
            return Err("Connect the consumer and wait for the previous request to finish".into());
        }
        core.testing = true;
        Ok(TestLease {
            host: self.clone(),
            status: core.status.clone(),
        })
    }
    pub fn set_allowed(&self, value: bool) {
        self.allowed.store(value, Ordering::SeqCst);
    }
    pub fn restore(&self) {
        let host = self.clone();
        std::thread::spawn(move || {
            let Some(path) = &host.path else { return };
            if !host.allowed.load(Ordering::SeqCst) {
                return;
            }
            let result = (|| {
                let _operation = host
                    .operation
                    .lock()
                    .map_err(|_| "Compute operation unavailable")?;
                let file = match std::fs::File::open(path) {
                    Ok(f) => f,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(e) => return Err(e.to_string()),
                };
                if file.metadata().map_err(|e| e.to_string())?.len() > 8192 {
                    return Err("Saved compute preference exceeds limit".into());
                }
                let request: StartRequest = serde_json::from_reader(file)
                    .map_err(|_| "Saved compute preference is invalid")?;
                host.start_locked(request).map(|_| ())
            })();
            if let Err(error) = result {
                if let Ok(mut core) = host.core.lock() {
                    if core.child.is_none() {
                        core.status.state = "failed".into();
                        core.status.detail = Some(error);
                    }
                }
            }
        });
    }
    pub fn start(&self, request: StartRequest) -> Result<Status, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Compute operation unavailable")?;
        self.start_locked(request)
    }
    fn start_locked(&self, request: StartRequest) -> Result<Status, String> {
        if self
            .core
            .lock()
            .map_err(|_| "Compute state unavailable")?
            .testing
        {
            return Err("Previous test request is cancelling; retry connection shortly".into());
        }
        request.validate().map_err(|e| e.to_string())?;
        if !self.allowed.load(Ordering::SeqCst) || !self.status()?.available {
            return Err("Sharing requires the enabled desktop development plugin".into());
        }
        if self
            .core
            .lock()
            .map_err(|_| "Compute state unavailable")?
            .child
            .is_some()
        {
            return Err("Stop the current sharing session before starting another".into());
        }
        let path = self
            .path
            .as_ref()
            .ok_or("Compute preferences unavailable")?;
        std::fs::create_dir_all(path.parent().ok_or("Invalid preferences path")?)
            .map_err(|e| e.to_string())?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec(&request).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        let port = |name: &str, default: u16| -> Result<u16, String> {
            match std::env::var(name) {
                Ok(value) => value
                    .parse::<u16>()
                    .ok()
                    .filter(|p| *p > 0)
                    .ok_or_else(|| format!("Invalid {name}")),
                Err(_) => Ok(default),
            }
        };
        let api_port = port("BUZZ_COMPUTE_API_PORT", 9337)?;
        let console_port = port("BUZZ_COMPUTE_CONSOLE_PORT", 3131)?;
        if api_port == console_port {
            return Err("Compute ports must be distinct".into());
        }
        let input = WorkerInput {
            api_port,
            console_port,
            owner_key: path.with_file_name("community-compute-owner.json"),
            broker_origin: self
                .broker
                .clone()
                .ok_or("Development broker unavailable")?,
            request: request.clone(),
        };
        let mut command = self.command()?;
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot start compute worker: {e}"))?;
        let input = serde_json::to_string(&input).map_err(|e| e.to_string())?;
        if let Err(error) = writeln!(
            child.stdin.as_mut().ok_or("Compute input unavailable")?,
            "{input}"
        ) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.to_string());
        }
        let stdout = child.stdout.take().ok_or("Compute output unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let generation;
        {
            let mut core = self.core.lock().map_err(|_| "Compute state unavailable")?;
            generation = core.status.generation + 1;
            core.status = Status {
                preferred_mode: core.status.preferred_mode.clone(),
                api_base_url: Some(format!("http://127.0.0.1:{api_port}/v1")),
                usage: None,
                available: true,
                generation,
                state: "starting".into(),
                mode: Some(request.mode.as_str().into()),
                model_id: Some(request.model_id),
                community: Some(request.community),
                viewer: Some(request.viewer),
                detail: Some("Preparing shared compute…".into()),
                download: None,
            };
            core.stopping = false;
            core.child = Some(child.clone());
        }
        let host = self.clone();
        let output = std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut line = String::new();
                match reader.by_ref().take(65537).read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if line.len() > 65536 {
                    break;
                }
                let Some(json) = line.strip_prefix(OUTPUT_PREFIX) else {
                    continue;
                };
                let Ok(update) = serde_json::from_str::<Update>(json) else {
                    continue;
                };
                if !["starting", "running", "stopping", "failed"].contains(&update.state.as_str()) {
                    continue;
                }
                if let Ok(mut core) = host.core.lock() {
                    if core.status.generation != generation || core.child.is_none() {
                        break;
                    }
                    if core.stopping {
                        continue;
                    }
                    if update.usage_sample {
                        core.usage_at = update.usage.as_ref().map(|_| Instant::now());
                        core.status.usage = update.usage;
                    }
                    core.status.state = update.state;
                    core.status.detail = update.detail;
                    core.status.download = update.download;
                }
            }
        });
        let host = self.clone();
        std::thread::spawn(move || {
            let exit = loop {
                match child
                    .lock()
                    .map_err(|_| ())
                    .and_then(|mut c| c.try_wait().map_err(|_| ()))
                {
                    Ok(Some(exit)) => break Some(exit),
                    Err(_) => break None,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                }
            };
            let _ = output.join();
            if let Ok(mut core) = host.core.lock() {
                if core.status.generation == generation && core.child.is_some() {
                    core.child = None;
                    core.status.download = None;
                    if core.status.state == "stopping" && exit.is_some_and(|e| e.success()) {
                        core.status.state = "off".into();
                        core.status.mode = None;
                    } else {
                        let reported_failure = core.status.state == "failed";
                        core.status.state = "failed".into();
                        if !reported_failure {
                            core.status.detail=Some("Compute worker stopped unexpectedly; turn sharing off before retrying".into());
                        }
                    }
                }
            }
        });
        self.status()
    }
    fn command(&self) -> Result<Command, String> {
        #[cfg(test)]
        if let Some(script) = &self.fixture {
            let mut command = Command::new("/bin/sh");
            command.arg(script);
            return Ok(command);
        }
        let mut command = Command::new(std::env::current_exe().map_err(|e| e.to_string())?);
        command.arg(WORKER_ARG);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Ok(command)
    }
    /// Clearing saved opt-in is independent from cleanup: storage failure must
    /// never prevent a running child from being stopped.
    pub fn stop(&self, generation: Option<u64>, forget: bool) -> Result<Status, String> {
        let _operation = self
            .operation
            .lock()
            .map_err(|_| "Compute operation unavailable")?;
        let (child, current) = {
            let mut core = self.core.lock().map_err(|_| "Compute state unavailable")?;
            if generation.is_some_and(|id| id != core.status.generation) {
                return Err("Compute session changed; refresh before stopping".into());
            }
            core.stopping = true;
            core.status.state = "stopping".into();
            (core.child.clone(), core.status.generation)
        };
        let persisted = if forget {
            self.path
                .as_ref()
                .map(|path| std::fs::remove_file(path))
                .transpose()
                .or_else(|e| {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        Ok(None)
                    } else {
                        Err(e)
                    }
                })
                .map(|_| ())
                .map_err(|e| e.to_string())
        } else {
            Ok(())
        };
        if let Some(child) = child {
            {
                let mut guard = child.lock().map_err(|_| "Compute process unavailable")?;
                if let Some(input) = guard.stdin.as_mut() {
                    let _ = writeln!(input, "stop");
                }
                guard.stdin.take();
            }
            let deadline = Instant::now() + self.grace;
            loop {
                let mut guard = child.lock().map_err(|_| "Compute process unavailable")?;
                if guard.try_wait().map_err(|e| e.to_string())?.is_some() {
                    break;
                }
                if Instant::now() >= deadline {
                    guard.kill().map_err(|e| e.to_string())?;
                    guard.wait().map_err(|e| e.to_string())?;
                    break;
                }
                drop(guard);
                std::thread::sleep(Duration::from_millis(25));
            }
        }
        {
            let mut core = self.core.lock().map_err(|_| "Compute state unavailable")?;
            if core.status.generation == current {
                core.child = None;
                core.status.state = "off".into();
                core.status.mode = None;
                core.status.download = None;
                core.status.detail = None;
            }
        }
        persisted?;
        self.status()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    fn request() -> StartRequest {
        StartRequest {
            community: "https://compute.example".into(),
            viewer: "0123456789abcdef".repeat(4),
            mode: buzz_community_compute::worker::Mode::Serve,
            model_id: "test-model".into(),
            max_vram_gb: Some(8.0),
        }
    }
    fn fixture() -> (ComputeHost, PathBuf) {
        let dir = std::env::temp_dir().join(format!("buzz-compute-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("worker.sh");
        std::fs::write(&script,"IFS= read -r config\nprintf '%s\\n' 'BUZZ_COMPUTE {\"state\":\"running\",\"detail\":null,\"download\":null}'\nIFS= read -r stop\nexit 0\n").unwrap();
        let mut host = ComputeHost::new(
            Some(dir.clone()),
            Some("http://localhost:1430".into()),
            true,
        );
        host.fixture = Some(script);
        (host, dir)
    }
    fn running(host: &ComputeHost) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while host.status().unwrap().state != "running" {
            assert!(Instant::now() < deadline, "worker did not become ready");
            std::thread::yield_now();
        }
    }
    #[test]
    fn test_lease_blocks_replacement_but_not_stop() {
        let host = ComputeHost::new(None, None, true);
        {
            let mut core = host.core.lock().unwrap();
            core.status.state = "running".into();
            core.status.mode = Some("client".into());
        }
        let lease = host.begin_test(0).unwrap();
        assert!(host.begin_test(0).is_err());
        assert!(host.start(request()).err().unwrap().contains("cancelling"));
        host.stop(Some(0), false).unwrap();
        assert!(!lease.is_current());
        assert!(host.core.lock().unwrap().testing);
        drop(lease);
        assert!(!host.core.lock().unwrap().testing);
    }

    #[test]
    fn heartbeat_does_not_replace_or_clear_sampler_counters() {
        let (host, dir) = fixture();
        std::fs::write(host.fixture.as_ref().unwrap(), r#"IFS= read -r config
printf '%s\n' 'BUZZ_COMPUTE {"state":"running","usageSample":true,"usage":{"tokensServed":42,"inflight":1,"tokensPerSecond":10,"peers":2}}'
printf '%s\n' 'BUZZ_COMPUTE {"state":"running","detail":"heartbeat","usage":{"tokensServed":1,"inflight":0,"tokensPerSecond":0,"peers":2}}'
IFS= read -r stop
"#).unwrap();
        host.start(request()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while host.status().unwrap().detail.as_deref() != Some("heartbeat") {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert_eq!(host.status().unwrap().usage.unwrap().tokens_served, 42);
        host.stop(None, true).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn widget_usage_expires_and_is_not_shown_outside_running_state() {
        let host = ComputeHost::new(None, None, true);
        {
            let mut core = host.core.lock().unwrap();
            core.status.state = "running".into();
            core.status.usage = Some(buzz_community_compute::usage::Usage {
                tokens_served: 42,
                inflight: 1,
                tokens_per_second: Some(10.0),
                peers: Some(2),
            });
            core.usage_at = Some(Instant::now());
        }
        assert_eq!(host.status().unwrap().usage.unwrap().tokens_served, 42);
        host.core.lock().unwrap().usage_at = Some(Instant::now() - Duration::from_secs(6));
        assert!(host.status().unwrap().usage.is_none());
        {
            let mut core = host.core.lock().unwrap();
            core.usage_at = Some(Instant::now());
            core.status.state = "stopping".into();
        }
        assert!(host.status().unwrap().usage.is_none());
    }

    #[test]
    fn owns_one_child_persists_opt_in_and_reaps_before_reporting_off() {
        let (host, dir) = fixture();
        let first = host.start(request()).unwrap();
        running(&host);
        assert!(host.path.as_ref().unwrap().exists());
        assert!(host.start(request()).is_err());
        let child = host.core.lock().unwrap().child.clone().unwrap();
        assert_eq!(
            host.stop(Some(first.generation), true).unwrap().state,
            "off"
        );
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(!host.path.as_ref().unwrap().exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stale_stop_cannot_kill_replacement_and_disable_blocks_new_start() {
        let (host, dir) = fixture();
        let first = host.start(request()).unwrap();
        running(&host);
        host.stop(None, true).unwrap();
        let second = host.start(request()).unwrap();
        running(&host);
        assert!(second.generation > first.generation);
        assert!(host.stop(Some(first.generation), true).is_err());
        assert_eq!(host.status().unwrap().state, "running");
        host.set_allowed(false);
        host.stop(None, true).unwrap();
        assert!(host.start(request()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn app_exit_keeps_opt_in_and_next_host_restores_only_when_enabled() {
        let (host, dir) = fixture();
        host.start(request()).unwrap();
        running(&host);
        host.stop(None, false).unwrap();
        host.restore();
        running(&host);
        host.stop(None, true).unwrap();
        host.set_allowed(false);
        host.restore();
        assert_eq!(host.status().unwrap().state, "off");
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn unexpected_exit_replaces_healthy_detail_with_failure() {
        let (host, dir) = fixture();
        host.start(request()).unwrap();
        running(&host);
        {
            let mut core = host.core.lock().unwrap();
            core.status.detail = Some("Sharing with verified community members".into());
        }
        let child = host.core.lock().unwrap().child.clone().unwrap();
        writeln!(child.lock().unwrap().stdin.as_mut().unwrap(), "exit").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while host.status().unwrap().state != "failed" {
            assert!(Instant::now() < deadline);
            std::thread::yield_now();
        }
        assert!(host
            .status()
            .unwrap()
            .detail
            .unwrap()
            .contains("unexpectedly"));
        host.stop(None, true).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn stop_kills_a_worker_that_ignores_graceful_cancellation() {
        let (mut host, dir) = fixture();
        std::fs::write(host.fixture.as_ref().unwrap(),"IFS= read -r config\nprintf '%s\\n' 'BUZZ_COMPUTE {\"state\":\"running\",\"detail\":null,\"download\":null}'\nexec sleep 120\n").unwrap();
        host.grace = Duration::from_millis(50);
        host.start(request()).unwrap();
        running(&host);
        let child = host.core.lock().unwrap().child.clone().unwrap();
        host.stop(None, true).unwrap();
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        assert_eq!(host.status().unwrap().state, "off");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
