//! Every listener gets its own Unix session. ACP's worker process groups stay
//! inside that session, so teardown is not limited to the listener's group.
//! On Windows, a kill-on-close Job Object contains the listener before it runs.
use crate::Result;
#[cfg(unix)]
use std::process::Stdio;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub(crate) struct Process {
    child: Child,
    #[cfg(unix)]
    session: u32,
    #[cfg(windows)]
    job: std::os::windows::io::OwnedHandle,
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
        #[cfg(windows)]
        {
            let job = job::create()?;
            let child = job::spawn(&job, command)?;
            Ok(Self {
                child,
                job,
                stopped: false,
            })
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
        #[cfg(windows)]
        {
            // A windowless listener has no cooperative stop signal. Terminate
            // the whole job, then confirm that every member has exited.
            job::terminate(&self.job)?;
            let deadline = Instant::now() + Duration::from_secs(5);
            while job::active(&self.job)? != 0 {
                if Instant::now() >= deadline {
                    return Err("Agent descendants have not exited; shutdown is incomplete".into());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            self.child
                .wait()
                .map_err(|_| "Could not reap agent listener")?;
            self.stopped = true;
            Ok(())
        }
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

#[cfg(windows)]
mod job {
    use crate::Result;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenThread, ResumeThread, CREATE_NO_WINDOW, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
    };

    /// Unnamed and without breakaway: members cannot leave, and closing the
    /// last handle (including on owner death) terminates every member.
    pub(super) fn create() -> Result<OwnedHandle> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Could not create agent process container".into());
        }
        let job = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err("Could not configure agent process container".into());
        }
        Ok(job)
    }

    /// Fail closed: a child that is not contained never runs its first instruction.
    pub(super) fn spawn(job: &OwnedHandle, command: &mut Command) -> Result<Child> {
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = command.spawn().map_err(|_| {
            "Could not start bundled agent listener; check the runtime installation"
        })?;
        if let Err(error) = contain(job, &child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok(child)
    }

    /// Assign a suspended child, then resume its only thread.
    fn contain(job: &OwnedHandle, child: &Child) -> Result<()> {
        let thread = primary_thread(child.id()).ok_or("Could not contain agent listener")?;
        if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
            return Err("Could not contain agent listener".into());
        }
        if unsafe { ResumeThread(thread.as_raw_handle()) } != 1 {
            return Err("Could not resume contained agent listener".into());
        }
        Ok(())
    }

    pub(super) fn terminate(job: &OwnedHandle) -> Result<()> {
        if unsafe { TerminateJobObject(job.as_raw_handle(), 1) } == 0 {
            return Err("Could not stop agent processes".into());
        }
        Ok(())
    }

    pub(super) fn active(job: &OwnedHandle) -> Result<u32> {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        if unsafe {
            QueryInformationJobObject(
                job.as_raw_handle(),
                JobObjectBasicAccountingInformation,
                (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&info) as u32,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err("Could not inspect agent descendants".into());
        }
        Ok(info.ActiveProcesses)
    }

    // Same exactly-one-thread check as the host command container.
    fn primary_thread(process_id: u32) -> Option<OwnedHandle> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        if unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } == 0 {
            return None;
        }
        let mut thread_id = None;
        loop {
            if entry.th32OwnerProcessID == process_id
                && thread_id.replace(entry.th32ThreadID).is_some()
            {
                return None;
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } == 0 {
                break;
            }
        }
        if unsafe { GetLastError() } != ERROR_NO_MORE_FILES {
            return None;
        }
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id?) };
        if handle.is_null() {
            return None;
        }
        Some(unsafe { OwnedHandle::from_raw_handle(handle) })
    }

    #[cfg(test)]
    #[test]
    fn uncontained_child_never_runs() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran");
        let mut command = Command::new(std::env::var_os("ComSpec").unwrap());
        command.raw_arg(format!("/d /c type nul > \"{}\"", marker.display()));
        // A handle that is not a job: assignment fails after the suspended spawn.
        let not_a_job = std::fs::File::create(dir.path().join("not-a-job"))
            .unwrap()
            .into();
        assert_eq!(
            spawn(&not_a_job, &mut command).unwrap_err(),
            "Could not contain agent listener"
        );
        assert!(!marker.exists(), "uncontained child ran");
        let job = create().unwrap();
        let mut child = spawn(&job, &mut command).unwrap();
        assert!(child.wait().unwrap().success());
        assert!(marker.exists(), "contained child was not resumed");
    }
}
