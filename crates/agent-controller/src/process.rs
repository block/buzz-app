//! Every listener gets its own Unix session. ACP's worker process groups stay
//! inside that session, so teardown is not limited to the listener's group.
use crate::Result;
#[cfg(unix)]
use std::process::Stdio;
use std::process::{Child, Command};
#[cfg(unix)]
use std::time::{Duration, Instant};

pub(crate) struct Process {
    child: Child,
    #[cfg(unix)]
    session: u32,
    stopped: bool,
}
impl Process {
    pub fn spawn(command: &mut Command) -> Result<Self> {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // setsid is async-signal-safe and performs no allocation in pre_exec.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        #[cfg(not(unix))]
        {
            let _ = command;
            Err("Agent process containment is not supported on this platform yet".into())
        }
        #[cfg(unix)]
        {
            let child = command.spawn().map_err(|_| {
                "Could not start bundled agent listener; check the runtime installation"
            })?;
            let session = child.id();
            Ok(Self {
                child,
                session,
                stopped: false,
            })
        }
    }
    pub fn alive(&mut self) -> Result<bool> {
        if self.stopped {
            return Ok(false);
        }
        match self
            .child
            .try_wait()
            .map_err(|_| "Could not inspect agent process")?
        {
            None => Ok(true),
            Some(_) => {
                self.stop()?;
                Ok(false)
            }
        }
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        #[cfg(unix)]
        {
            // First let ACP cancel turns and shut down its workers itself.
            signal_in_session(self.session, self.session, libc::SIGTERM)?;
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let members = session_members(self.session)?;
                if members.is_empty() {
                    break;
                }
                if Instant::now() >= deadline {
                    // Freeze first so a terminating child cannot create a fresh
                    // descendant between the enumeration and the kill pass.
                    for pid in &members {
                        signal_in_session(*pid, self.session, libc::SIGSTOP)?;
                    }
                    let frozen = session_members(self.session)?;
                    for pid in frozen {
                        signal_in_session(pid, self.session, libc::SIGKILL)?;
                    }
                    break;
                }
                // Reap the leader if it exited; session ID is retained by living members.
                self.child
                    .try_wait()
                    .map_err(|_| "Could not reap agent listener")?;
                std::thread::sleep(Duration::from_millis(25));
            }
            self.child
                .wait()
                .map_err(|_| "Could not reap agent listener")?;
            let deadline = Instant::now() + Duration::from_secs(2);
            while !session_members(self.session)?.is_empty() {
                if Instant::now() >= deadline {
                    return Err("Agent descendants have not exited; shutdown is incomplete".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            self.stopped = true;
            Ok(())
        }
        #[cfg(not(unix))]
        Err("Agent process containment is not supported on this platform yet".into())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
#[cfg(unix)]
fn signal(pid: u32, value: i32) -> Result<()> {
    if pid <= 1 || pid > i32::MAX as u32 {
        return Err("Invalid owned process identifier".into());
    }
    if unsafe { libc::kill(pid as i32, value) } == -1
        && std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    {
        return Err("Could not signal owned agent process".into());
    }
    Ok(())
}
#[cfg(unix)]
fn signal_in_session(pid: u32, session: u32, value: i32) -> Result<()> {
    if unsafe { libc::getsid(pid as i32) } == session as i32 {
        signal(pid, value)?;
    }
    Ok(())
}
#[cfg(unix)]
fn session_members(session: u32) -> Result<Vec<u32>> {
    // ps exposes only IDs/state, never environment or command lines. getsid is
    // the authority, not platform-dependent ps SID formatting (macOS differs).
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,stat="])
        .env_clear()
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Could not inspect agent descendants")?;
    if !output.status.success() || output.stdout.len() > 4 * 1024 * 1024 {
        return Err("Could not inspect agent descendants".into());
    }
    let mut members = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split_whitespace();
        let pid = fields.next().and_then(|p| p.parse::<u32>().ok());
        let status = fields.next().unwrap_or("");
        if status.starts_with('Z') {
            continue;
        } // exited; its parent/init owns reaping
        if let Some(pid) = pid.filter(|p| *p > 1 && *p <= i32::MAX as u32) {
            if unsafe { libc::getsid(pid as i32) } == session as i32 {
                members.push(pid);
            }
        }
    }
    Ok(members)
}
