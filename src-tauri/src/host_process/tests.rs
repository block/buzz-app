use super::*;
#[cfg(unix)]
use tauri::ipc::InvokeResponseBody;
#[cfg(unix)]
use tokio::sync::mpsc;

#[cfg(unix)]
fn channel() -> (
    Channel<ProcessEvent>,
    mpsc::UnboundedReceiver<serde_json::Value>,
) {
    let (sender, receiver) = mpsc::unbounded_channel();
    let channel = Channel::new(move |body| {
        if let InvokeResponseBody::Json(json) = body {
            let _ = sender.send(serde_json::from_str(&json).unwrap());
        }
        Ok(())
    });
    (channel, receiver)
}

#[cfg(unix)]
fn command(program: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);
    command
}

/// Collects output until the exit event, which it returns last.
#[cfg(unix)]
async fn until_exit(
    events: &mut mpsc::UnboundedReceiver<serde_json::Value>,
) -> (String, String, serde_json::Value) {
    let (mut stdout, mut stderr) = (String::new(), String::new());
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("process event")
            .expect("open channel");
        match event["type"].as_str() {
            Some("stdout") => stdout.push_str(event["data"].as_str().unwrap()),
            Some("stderr") => stderr.push_str(event["data"].as_str().unwrap()),
            _ => return (stdout, stderr, event),
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn streams_stdin_to_stdout_until_input_closes() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "cat",
            command("cat", &[]),
            channel,
        )
        .unwrap();
    processes
        .write("a.plugin", activation, handle, "one\n".into(), false)
        .await
        .unwrap();
    processes
        .write("a.plugin", activation, handle, "two\n".into(), true)
        .await
        .unwrap();
    let (stdout, _, exit) = until_exit(&mut events).await;
    assert_eq!(stdout, "one\ntwo\n");
    assert_eq!(exit, serde_json::json!({"type": "exit", "code": 0}));
    assert!(processes.registry().entries.is_empty());
    assert_eq!(
        processes
            .write("a.plugin", activation, handle, "late".into(), false)
            .await,
        Err("No such process".into())
    );
}

#[cfg(unix)]
#[tokio::test]
async fn reports_stderr_and_exit_code() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "echo oops >&2; exit 3"]),
            channel,
        )
        .unwrap();
    let (_, stderr, exit) = until_exit(&mut events).await;
    assert_eq!(stderr, "oops\n");
    assert_eq!(exit["code"], 3);
}

#[cfg(unix)]
#[tokio::test]
async fn only_the_owning_plugin_can_write_or_kill() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "cat",
            command("cat", &[]),
            channel,
        )
        .unwrap();
    assert!(processes
        .write("b.plugin", activation, handle, "x".into(), false)
        .await
        .is_err());
    assert!(processes
        .kill("b.plugin", activation, handle)
        .await
        .is_err());
    processes
        .kill("a.plugin", activation, handle)
        .await
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["type"], "exit");
}

#[cfg(unix)]
#[tokio::test]
async fn kill_ends_the_process_and_its_descendants() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    // The shell ignores the polite signal; its child would outlive it.
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes
        .kill("a.plugin", activation, handle)
        .await
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], serde_json::Value::Null);
    assert_dead(child).await;
}

#[cfg(unix)]
#[tokio::test]
async fn stop_all_ends_every_process() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (first, mut first_events) = channel();
    let (second, mut second_events) = channel();
    let second_activation = processes
        .begin(processes.page(), "b.plugin".into(), "rev".into())
        .await
        .unwrap();
    processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "cat",
            command("cat", &[]),
            first,
        )
        .unwrap();
    processes
        .start(
            0,
            "b.plugin".into(),
            "rev".into(),
            second_activation,
            "cat",
            command("cat", &[]),
            second,
        )
        .unwrap();
    processes.stop_all();
    until_exit(&mut first_events).await;
    until_exit(&mut second_events).await;
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_page_that_stops_listening_stops_the_process() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let channel = Channel::new(|_| Err(tauri::Error::FailedToReceiveMessage));
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "echo hi; sleep 30"]),
            channel,
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while processes.registry().entries.contains_key(&handle) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("process stopped");
}

#[cfg(unix)]
#[tokio::test]
async fn a_spawn_from_before_a_reload_is_refused() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let page = processes.page();
    processes.stop_all();
    let (channel, _events) = channel();
    let refused = processes.start(
        page,
        "a.plugin".into(),
        "rev".into(),
        activation,
        "cat",
        command("cat", &[]),
        channel,
    );
    assert_eq!(refused.err().as_deref(), Some("The page reloaded"));
    assert!(processes.registry().entries.is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_process_may_close_its_output_and_carry_on() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "exec >&- 2>&-; sleep 1; exit 4"]),
            channel,
        )
        .unwrap();
    let (_, _, exit) = until_exit(&mut events).await;
    assert_eq!(exit["code"], 4);
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_kills_every_group_without_waiting() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (channel, mut events) = channel();
    processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "trap '' TERM; sleep 30 & echo $!; wait"]),
            channel,
        )
        .unwrap();
    let child: i32 = loop {
        let event = events.recv().await.unwrap();
        if event["type"] == "stdout" {
            break event["data"].as_str().unwrap().trim().parse().unwrap();
        }
    };
    processes.shutdown();
    assert_dead(child).await;
}

#[test]
fn text_waits_for_a_split_character() {
    let mut pending = "héllo".as_bytes()[..2].to_vec();
    assert_eq!(take_text(&mut pending), "h");
    assert_eq!(pending, [0xc3]);
    pending.extend_from_slice(&"héllo".as_bytes()[2..]);
    assert_eq!(take_text(&mut pending), "éllo");
    assert!(pending.is_empty());
    let mut invalid = vec![b'a', 0xff, b'b'];
    assert_eq!(take_text(&mut invalid), "a\u{fffd}b");
}

#[test]
fn directories_are_absolute_or_under_home() {
    let home = home().unwrap();
    assert_eq!(expand_home("~").unwrap(), home);
    assert_eq!(expand_home("~/.buzz").unwrap(), home.join(".buzz"));
    assert!(expand_home("relative/dir").is_err());
    assert!(expand_home("~other/dir").is_err());
}

/// Waits until `pid` has died. A process its new parent has not reaped yet
/// still answers kill(0), as a zombie, so a zombie counts as dead.
#[cfg(unix)]
async fn assert_dead(pid: i32) {
    let dead = || {
        (unsafe { libc::kill(pid, 0) }) != 0
            || std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .is_ok_and(|out| out.stdout.trim_ascii_start().starts_with(b"Z"))
    };
    let until = std::time::Instant::now() + Duration::from_secs(5);
    while !dead() && std::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(dead(), "descendant survived");
}

#[cfg(unix)]
#[tokio::test]
async fn retirement_fences_pending_spawns_and_repeated_same_revision_activations() {
    let processes = HostProcesses::default();
    let first = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (output, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            first,
            "cat",
            command("cat", &[]),
            output,
        )
        .unwrap();
    assert!(processes
        .begin(processes.page(), "a.plugin".into(), "new".into())
        .await
        .is_err());
    assert!(processes
        .write("a.plugin", first + 1, handle, "stale".into(), false)
        .await
        .is_err());
    assert!(processes.kill("a.plugin", first + 1, handle).await.is_err());
    processes.retire("a.plugin", first).await.unwrap();
    assert!(!processes.registry().entries.contains_key(&handle));
    until_exit(&mut events).await;
    let second = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    assert_ne!(first, second);
    let (late, _) = channel();
    assert_eq!(
        processes
            .start(
                0,
                "a.plugin".into(),
                "rev".into(),
                first,
                "cat",
                command("cat", &[]),
                late
            )
            .err()
            .as_deref(),
        Some("Plugin activation retired")
    );
    processes.retire("a.plugin", first).await.unwrap();
    assert_eq!(
        processes.registry().activations.get("a.plugin").unwrap().0,
        second
    );
    processes.retire("a.plugin", second).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn kill_and_retire_wait_for_actual_exit_before_successor_start() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (output, mut events) = channel();
    let handle = processes
        .start(
            0,
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "trap '' TERM; echo ready; exec cat"]),
            output,
        )
        .unwrap();
    assert_eq!(events.recv().await.unwrap()["data"], "ready\n");
    processes
        .kill("a.plugin", activation, handle)
        .await
        .unwrap();
    assert!(!processes.registry().entries.contains_key(&handle));
    until_exit(&mut events).await;
    // Killing one process does not retire the owning activation.
    assert!(processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .is_err());
    processes.retire("a.plugin", activation).await.unwrap();
    processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn a_new_page_activation_waits_for_previous_page_process_exit() {
    let processes = HostProcesses::default();
    let activation = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await
        .unwrap();
    let (output, mut events) = channel();
    processes
        .start(
            processes.page(),
            "a.plugin".into(),
            "rev".into(),
            activation,
            "sh",
            command("sh", &["-c", "trap '' TERM; echo ready; sleep 30"]),
            output,
        )
        .unwrap();
    assert_eq!(events.recv().await.unwrap()["data"], "ready\n");
    processes.stop_all();
    let successor = processes
        .begin(processes.page(), "a.plugin".into(), "rev".into())
        .await;
    let previous_exited = processes.registry().entries.is_empty();
    // Reap the real process even if admission failed, before reporting the result.
    until_exit(&mut events).await;
    assert!(
        successor.is_ok(),
        "new page activation failed: {successor:?}"
    );
    assert!(
        previous_exited,
        "successor admitted before previous process exit"
    );
    assert_ne!(successor.unwrap(), activation);
}

fn pending_exit(processes: &HostProcesses) -> watch::Sender<bool> {
    let (exited, exit) = watch::channel(false);
    processes.registry().entries.insert(
        0,
        Entry {
            plugin: "a.plugin".into(),
            activation: 0,
            exited: exit,
            group: None,
            stdin: None,
            stop: None,
        },
    );
    exited
}

#[tokio::test]
async fn begin_waits_for_cleanup_and_rechecks_the_page_afterward() {
    use std::future::Future as _;
    use std::task::Poll;

    for reload_again in [false, true] {
        let processes = HostProcesses::default();
        let exited = pending_exit(&processes);
        processes.stop_all();
        let page = processes.page();
        let mut admission = Box::pin(processes.begin(page, "a.plugin".into(), "rev".into()));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(admission.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        assert!(processes.registry().activations.is_empty());
        if reload_again {
            processes.stop_all();
        }
        processes.registry().entries.remove(&0);
        exited.send(true).unwrap();
        let result = admission.await;
        if reload_again {
            assert_eq!(result.err().as_deref(), Some("The page reloaded"));
            assert!(processes.registry().activations.is_empty());
        } else {
            assert!(result.is_ok());
        }
    }
}

#[tokio::test]
async fn simultaneous_admission_after_cleanup_keeps_one_activation_owner() {
    use std::future::Future as _;
    use std::task::Poll;

    let processes = HostProcesses::default();
    let exited = pending_exit(&processes);
    processes.stop_all();
    let mut first = Box::pin(processes.begin(processes.page(), "a.plugin".into(), "rev".into()));
    let mut second = Box::pin(processes.begin(processes.page(), "a.plugin".into(), "rev".into()));
    assert!(
        std::future::poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    assert!(
        std::future::poll_fn(|cx| Poll::Ready(second.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    processes.registry().entries.remove(&0);
    exited.send(true).unwrap();
    let activation = first.await.unwrap();
    assert!(second.await.is_err());
    assert_eq!(processes.registry().activations["a.plugin"].0, activation);
}

#[tokio::test]
async fn failed_previous_page_cleanup_does_not_admit_a_successor() {
    let processes = HostProcesses::default();
    let exited = pending_exit(&processes);
    processes.stop_all();
    drop(exited);
    assert_eq!(
        processes
            .begin(processes.page(), "a.plugin".into(), "rev".into())
            .await
            .err()
            .as_deref(),
        Some("Process cleanup failed; restart the app")
    );
    assert!(processes.registry().activations.is_empty());
}

#[tokio::test]
async fn begin_from_a_retired_page_cannot_reserve_an_activation() {
    let processes = HostProcesses::default();
    let page = processes.page();
    processes.stop_all();
    assert_eq!(
        processes
            .begin(page, "a.plugin".into(), "rev".into())
            .await
            .err()
            .as_deref(),
        Some("The page reloaded")
    );
    assert!(processes.registry().activations.is_empty());
}
