//! A separate group leader survives desktop exit long enough to stop its children.
pub const ARG: &str = "--buzz-agent-runner-supervisor";
#[cfg(unix)]
pub fn entry() -> ! {
    use std::{
        io::Read,
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        sync::mpsc,
        time::Duration,
    };
    // Only execute in a dedicated process group created by the desktop.
    let pid = unsafe { libc::getpid() };
    if unsafe { libc::getpgrp() } != pid {
        std::process::exit(2);
    }
    let fd: i32 = std::env::var("BUZZ_RUNNER_LOCK_FD")
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|fd| *fd > 2)
        .unwrap_or_else(|| std::process::exit(2));
    if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
        std::process::exit(2);
    }
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::signal(libc::SIGTERM, libc::SIG_IGN);
    }
    let Some(binary) = std::env::var_os("BUZZ_RUNNER_CHILD") else {
        std::process::exit(2);
    };
    let mut command = Command::new(binary);
    command
        .env_remove("BUZZ_RUNNER_CHILD")
        .env_remove("BUZZ_RUNNER_LOCK_FD")
        .stdin(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            Ok(())
        });
    }
    let Ok(mut child) = command.spawn() else {
        std::process::exit(2);
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buffer = [0; 16];
        let mut input = std::io::stdin();
        while matches!(input.read(&mut buffer), Ok(n) if n > 0) {}
        let _ = tx.send(());
    });
    loop {
        if !matches!(child.try_wait(), Ok(None))
            || rx.recv_timeout(Duration::from_millis(100)) != Err(mpsc::RecvTimeoutError::Timeout)
        {
            break;
        }
    }
    // We ignore TERM; descendants use its default. Keep the lock until the
    // final group kill, including descendants that ignore graceful shutdown.
    unsafe {
        libc::kill(-pid, libc::SIGTERM);
    }
    std::thread::sleep(Duration::from_millis(1500));
    let _ = child.try_wait();
    unsafe {
        libc::kill(-pid, libc::SIGKILL);
    }
    std::process::exit(1)
}
#[cfg(not(unix))]
pub fn entry() -> ! {
    std::process::exit(2)
}
