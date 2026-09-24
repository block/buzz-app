//! Bounded native listener diagnostics. Raw child output is never retained or
//! exposed: only known ACP milestones are projected into the existing editor.
use crate::Result;
use std::{
    collections::VecDeque,
    io::Read,
    net::Shutdown,
    os::{fd::OwnedFd, unix::net::UnixStream},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    thread::JoinHandle,
};

pub(crate) struct Diagnostics {
    socket: UnixStream,
    messages: Arc<Mutex<VecDeque<&'static str>>>,
    reader: Option<JoinHandle<()>>,
}
impl Diagnostics {
    pub(crate) fn capture(command: &mut Command) -> Result<Self> {
        let (mut socket, writer) =
            UnixStream::pair().map_err(|_| "Could not open listener diagnostics")?;
        let control = socket
            .try_clone()
            .map_err(|_| "Could not configure listener diagnostics")?;
        let stderr = writer
            .try_clone()
            .map_err(|_| "Could not configure listener diagnostics")?;
        command
            .stdout(Stdio::from(OwnedFd::from(writer)))
            .stderr(Stdio::from(OwnedFd::from(stderr)));
        let messages = Arc::new(Mutex::new(VecDeque::new()));
        let captured = messages.clone();
        let reader = std::thread::Builder::new()
            .name("agent-diagnostics".into())
            .spawn(move || {
                let mut chunk = [0; 4096];
                let mut line = Vec::new();
                let mut overflow = false;
                loop {
                    match socket.read(&mut chunk) {
                        Ok(0) => {
                            if !overflow {
                                record(&captured, &line);
                            }
                            break;
                        }
                        Ok(size) => {
                            for byte in &chunk[..size] {
                                if *byte == b'\n' {
                                    if !overflow {
                                        record(&captured, &line);
                                    }
                                    line.clear();
                                    overflow = false;
                                } else if line.len() < 16 * 1024 {
                                    line.push(*byte);
                                } else {
                                    overflow = true;
                                }
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            push(&captured, "Listener diagnostics stream closed.");
                            break;
                        }
                    }
                }
            })
            .map_err(|_| "Could not start listener diagnostics")?;
        Ok(Self {
            socket: control,
            messages,
            reader: Some(reader),
        })
    }
    pub(crate) fn snapshot(&self) -> Vec<String> {
        match self.messages.lock() {
            Ok(messages) => messages.iter().map(|s| (*s).into()).collect(),
            Err(_) => vec!["Listener diagnostics unavailable.".into()],
        }
    }
}
impl Drop for Diagnostics {
    fn drop(&mut self) {
        let _ = self.socket.shutdown(Shutdown::Both);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
fn push(messages: &Mutex<VecDeque<&'static str>>, message: &'static str) {
    if let Ok(mut messages) = messages.lock() {
        if messages.back() == Some(&message) {
            return;
        }
        if messages.len() == 32 {
            messages.pop_front();
        }
        messages.push_back(message);
    }
}
fn record(messages: &Mutex<VecDeque<&'static str>>, line: &[u8]) {
    let line = String::from_utf8_lossy(line);
    for (marker, message) in [
        ("connected to relay at", "Listener connected to relay."),
        (
            "subscribed to membership notifications",
            "Listener subscribed to membership updates.",
        ),
        (
            "no agent owner configured",
            "Listener has no authorized owner.",
        ),
        (
            "owner-only but no owner",
            "Owner-only policy is rejecting all messages: no owner resolved.",
        ),
        ("subscribed to channel", "Listener subscribed to a channel."),
        (
            "no channel subscriptions resolved",
            "Listener has no channel subscriptions.",
        ),
        (
            "presence set to online",
            "Listener published online presence.",
        ),
        ("agent initialized:", "ACP worker initialized."),
        (
            "agent initialize failed:",
            "ACP worker initialization failed.",
        ),
        (
            "agent timed out during init",
            "ACP worker initialization timed out.",
        ),
        ("agent failed to spawn:", "ACP worker could not start."),
        ("agent_pool_ready", "ACP worker pool ready."),
    ] {
        if line.contains(marker) {
            push(messages, message);
            return;
        }
    }
    if line.contains("WARN") {
        push(
            messages,
            "Listener reported a warning (raw details withheld).",
        );
    }
    if line.contains("ERROR") {
        push(
            messages,
            "Listener reported an error (raw details withheld).",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_real_child_output_without_exposing_payloads() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 'connected to relay at secret-url\\n'; printf 'agent initialize failed: secret-token\\n' >&2"]);
        let diagnostics = Diagnostics::capture(&mut command).unwrap();
        let mut child = command.spawn().unwrap();
        drop(command);
        assert!(child.wait().unwrap().success());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while diagnostics.snapshot().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(
            diagnostics.snapshot(),
            [
                "Listener connected to relay.",
                "ACP worker initialization failed."
            ]
        );
    }
    #[test]
    fn history_is_bounded_and_unknown_output_is_discarded() {
        let messages = Mutex::new(VecDeque::new());
        record(&messages, b"secret payload");
        assert!(messages.lock().unwrap().is_empty());
        for _ in 0..100 {
            record(&messages, b"connected to relay at secret");
            record(&messages, b"agent_pool_ready agents=1");
        }
        assert_eq!(messages.lock().unwrap().len(), 32);
    }
}
