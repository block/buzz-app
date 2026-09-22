//! App-owned runner for an explicitly configured existing shared-compute agent.
//! No renderer-provided paths, commands, credentials or environment variables.
mod profile;
pub mod supervisor;
use crate::compute_host::{ComputeHost, TestLease};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Config {
    library: PathBuf,
    binaries: PathBuf,
    workdir: PathBuf,
    service: String,
    agent: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    available: bool,
    state: String,
    name: Option<String>,
    pubkey: Option<String>,
    detail: Option<String>,
}
struct Running {
    child: Child,
    generation: u64,
    _lock: File,
    _lease: TestLease,
}
struct Core {
    running: Option<Running>,
    status: Status,
}
#[derive(Clone)]
pub struct AgentRunner {
    core: Arc<Mutex<Core>>,
    config: Option<Config>,
    logs: PathBuf,
    compute: ComputeHost,
}

impl AgentRunner {
    pub fn new(data: PathBuf, binaries: PathBuf, compute: ComputeHost) -> Self {
        let config = (|| {
            if !cfg!(all(debug_assertions, target_os = "macos")) {
                return None;
            }
            let agent = std::env::var("BUZZ_RUNNER_AGENT").ok()?;
            if agent.len() != 64 || !agent.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            Some(Config {
                library: std::env::var_os("BUZZ_RUNNER_LIBRARY")?.into(),
                service: std::env::var("BUZZ_DEV_CREDENTIAL_SERVICE").ok()?,
                workdir: std::env::var_os("BUZZ_RUNNER_WORKDIR")?.into(),
                binaries,
                agent,
            })
        })();
        let result = Self {
            core: Arc::new(Mutex::new(Core {
                running: None,
                status: Status {
                    available: config.is_some(),
                    state: "stopped".into(),
                    name: None,
                    pubkey: config.as_ref().map(|c| c.agent.clone()),
                    detail: None,
                },
            })),
            config,
            logs: data.join("agent-runner"),
            compute,
        };
        let monitor = result.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let _ = monitor.status();
        });
        result
    }
    pub fn status(&self) -> Result<Status, String> {
        let mut core = self.core.lock().map_err(|_| "Agent state unavailable")?;
        let generation = self.compute.status()?;
        if let Some(running) = core.running.as_mut() {
            if running
                .child
                .try_wait()
                .map_err(|_| "Cannot inspect agent process")?
                .is_some()
            {
                // Retain the child PID until group cleanup, even if the leader exited.
                terminate(running);
                core.running = None;
                core.status.state = "failed".into();
                core.status.detail = Some("Agent exited. Check its local log and restart.".into());
            } else if generation.state != "running"
                || generation.generation != running.generation
                || !generation.available
            {
                terminate(running);
                core.running = None;
                core.status.state = "stopped".into();
                core.status.detail =
                    Some("Compute connection changed; reconnect and start the agent again.".into());
            }
        }
        Ok(core.status.clone())
    }
    pub fn start(&self, viewer: &str, community: &str) -> Result<Status, String> {
        let config = self
            .config
            .as_ref()
            .ok_or("This build has no configured agent runtime")?;
        let mut core = self.core.lock().map_err(|_| "Agent state unavailable")?;
        if core.running.is_some() {
            return Ok(core.status.clone());
        }
        let compute = self.compute.status()?;
        if !compute.available
            || compute.state != "running"
            || compute.mode.as_deref() != Some("client")
            || compute.viewer.as_deref() != Some(viewer)
            || compute.community.as_deref() != Some(community)
        {
            return Err("Connect shared compute for this account and community first".into());
        }
        let api = compute
            .api_base_url
            .as_deref()
            .ok_or("Shared compute endpoint unavailable")?;
        // The consumer lease blocks port reuse until the entire runner group
        // is gone, including while Keychain access is waiting for the user.
        let lease = self.compute.begin_test(compute.generation)?;
        let mut relay = url::Url::parse(community).map_err(|_| "Invalid community")?;
        if relay.scheme() == "https" {
            relay.set_scheme("wss").map_err(|_| "Invalid community")?;
        }
        if relay.scheme() != "wss" {
            return Err("A secure community is required".into());
        }
        let raw = profile::read_json(&config.library)?;
        let profile = profile::project(&raw, &config.agent, viewer)?;
        // Never adopt or kill legacy processes. A live legacy receipt blocks a
        // second listener for the same identity, even across communities.
        let receipts = config
            .library
            .parent()
            .ok_or("Invalid agent library path")?
            .join("agent-pids");
        if let Ok(entries) = std::fs::read_dir(receipts) {
            for entry in entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with(&config.agent))
            {
                let receipt = profile::read_json(&entry.path())?;
                if let Some(pid) = receipt
                    .get("pid")
                    .unwrap_or(&receipt)
                    .as_u64()
                    .filter(|p| *p > 1 && *p <= i32::MAX as u64)
                {
                    #[cfg(unix)]
                    if unsafe { libc::kill(pid as i32, 0) } == 0 {
                        return Err("Stop this agent in old Buzz before starting it here".into());
                    }
                }
            }
        }
        std::fs::create_dir_all(&self.logs).map_err(|_| "Cannot create agent log directory")?;
        let mut lock_options = OpenOptions::new();
        lock_options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            lock_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let lock = lock_options
            .open(
                config
                    .library
                    .parent()
                    .unwrap()
                    .join(format!("{}.new-app.lock", config.agent)),
            )
            .map_err(|_| "Cannot lock agent runtime")?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
                return Err("This agent is already running in another new Buzz app".into());
            }
        }
        for name in ["buzz-acp", "buzz-agent", "buzz-dev-mcp"] {
            if !config.binaries.join(name).is_file() {
                return Err("This app is missing its bundled agent runtime".into());
            }
        }
        let secret = profile::agent_secret(&config.service, &config.agent)?;
        let mut log_options = OpenOptions::new();
        log_options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            log_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let log = log_options
            .open(self.logs.join("runner.log"))
            .map_err(|_| "Cannot open agent log")?;
        let mut command =
            Command::new(std::env::current_exe().map_err(|_| "Cannot locate runner supervisor")?);
        command.arg(supervisor::ARG);
        command.env_clear();
        command.env("BUZZ_RUNNER_CHILD", config.binaries.join("buzz-acp"));
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let fd = lock.as_raw_fd();
            use std::os::unix::process::CommandExt;
            // The supervisor inherits the same flock open-file description;
            // it remains held after a desktop crash until group shutdown.
            unsafe {
                command.pre_exec(move || {
                    if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            command.env("BUZZ_RUNNER_LOCK_FD", fd.to_string());
        }
        for key in ["HOME", "TMPDIR", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let path = std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into());
        command
            .current_dir(&config.workdir)
            .env("PATH", format!("{}:{path}", config.binaries.display()))
            .env("BUZZ_PRIVATE_KEY", secret)
            .env("BUZZ_AUTH_TAG", profile.auth)
            .env("BUZZ_RELAY_URL", relay.as_str())
            .env("BUZZ_ACP_AGENT_OWNER", viewer)
            .env("BUZZ_ACP_RESPOND_TO", "owner-only")
            .env("BUZZ_ACP_AGENT_COMMAND", config.binaries.join("buzz-agent"))
            .env("BUZZ_ACP_MCP_COMMAND", config.binaries.join("buzz-dev-mcp"))
            .env("BUZZ_ACP_SYSTEM_PROMPT", profile.prompt)
            .env("BUZZ_ACP_SESSION_TITLE", &profile.name)
            .env("BUZZ_ACP_DISPLAY_NAME", &profile.name)
            .env("BUZZ_ACP_AGENTS", "1")
            .env("BUZZ_ACP_RELAY_OBSERVER", "true")
            .env("BUZZ_ACP_AUTO_PUBLISH_REPLY", "true")
            .env("BUZZ_AGENT_REQUIRE_REPLY", "0")
            .env("BUZZ_ACP_MODEL", &profile.model)
            .env("BUZZ_AGENT_MODEL", &profile.model)
            .env("BUZZ_AGENT_PROVIDER", "openai")
            .env("OPENAI_COMPAT_BASE_URL", api)
            .env("OPENAI_COMPAT_MODEL", &profile.model)
            .env("OPENAI_COMPAT_API_KEY", "buzz-mesh-local")
            .env("OPENAI_COMPAT_API", "chat")
            .env("BUZZ_AGENT_MAX_OUTPUT_TOKENS", "4096")
            .env("RUST_LOG", "info")
            .stdin(Stdio::piped())
            .stdout(log.try_clone().map_err(|_| "Cannot open agent log")?)
            .stderr(log);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        if !lease.is_current() {
            return Err("Compute connection changed while starting the agent".into());
        }
        let child = command
            .spawn()
            .map_err(|_| "Could not start bundled agent runtime")?;
        core.running = Some(Running {
            child,
            generation: compute.generation,
            _lock: lock,
            _lease: lease,
        });
        core.status.state = "running".into();
        core.status.name = Some(profile.name);
        core.status.detail = None;
        Ok(core.status.clone())
    }
    pub fn stop(&self) -> Result<Status, String> {
        let mut core = self.core.lock().map_err(|_| "Agent state unavailable")?;
        if let Some(running) = core.running.as_mut() {
            terminate(running);
        }
        core.running = None;
        core.status.state = "stopped".into();
        core.status.detail = None;
        Ok(core.status.clone())
    }
}
fn terminate(running: &mut Running) {
    running.child.stdin.take();
    #[cfg(unix)]
    unsafe {
        libc::kill(-(running.child.id() as i32), libc::SIGTERM);
    }
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if running.child.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(-(running.child.id() as i32), libc::SIGKILL);
    }
    let _ = running.child.kill();
    let _ = running.child.wait();
}
#[tauri::command]
pub async fn agent_runner_status(host: tauri::State<'_, AgentRunner>) -> Result<Status, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.status())
        .await
        .map_err(|_| "Agent status failed")?
}
#[tauri::command]
pub async fn agent_runner_start(
    host: tauri::State<'_, AgentRunner>,
    viewer: String,
    community: String,
) -> Result<Status, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.start(&viewer, &community))
        .await
        .map_err(|_| "Agent start failed")?
}
#[tauri::command]
pub async fn agent_runner_stop(host: tauri::State<'_, AgentRunner>) -> Result<Status, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.stop())
        .await
        .map_err(|_| "Agent stop failed")?
}
