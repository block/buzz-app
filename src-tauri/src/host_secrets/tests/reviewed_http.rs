//! Registered custody → reviewed HTTP create → retirement, using injected native
//! input and a pinned loopback TLS peer. Not AppKit, physical-click or provider evidence.
use super::*;
use crate::{
    host_request::credential_tests::Peer,
    reviewed_invocation::{read_gates, Invocations},
};

const CANARY: &str = "FAKE-NATIVE-HTTP-CANARY";
/// A dropped commit reply, not a preparation failure.
const REFUSED_REPLY: &str = "Reviewed invocation is unavailable or retired";
const BODY: &str = "{ \"prompt\" : \"exact bytes\", \"seed\" : 1e2 }\n";

fn enrolled(peer: &Peer) -> Fixture {
    let f = Fixture::at_origin(
        true,
        false,
        IdentityHost::fixture(),
        true,
        &peer.url.origin().ascii_serialization(),
    );
    let (entered, user) = f.input();
    let reply = f.send(
        &f.view,
        f.view.url().unwrap().as_str(),
        "plugin_host_secret_enroll",
        f.enrollment(),
    );
    entered.recv_timeout(LIMIT).unwrap();
    user.send(Some(CANARY.into())).unwrap();
    assert_eq!(reply.recv_timeout(LIMIT).unwrap().unwrap(), "saved");
    f
}
fn invocation(f: &Fixture, peer: &Peer) -> Value {
    json!({
        "id": ID, "revision": f.revision, "once": f.enrollment()["once"],
        "request": {"version":1, "operation":"create", "body":BODY,
            "effect":{"kind":"credential-http", "method":"POST", "url":peer.url, "headers":{"Content-Type":"application/json","X-Version":"fixture-1"}, "slot":"key"},
            "disclosure":{"version":"fixture/1", "text":"Offline fake create; no provider or spend"},
            "destination":{"community":"fixture-community", "viewer":f.app.state::<IdentityHost>().current_viewer().unwrap().unwrap(), "channel":"fixture-channel"}},
        "onReview":"__CHANNEL__:9", "onProgress":"__CHANNEL__:10"
    })
}
fn send(f: &Fixture, command: &str, body: Value) -> mpsc::Receiver<Result<Value, String>> {
    f.send(&f.view, f.view.url().unwrap().as_str(), command, body)
}
async fn reply(response: mpsc::Receiver<Result<Value, String>>) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || response.recv_timeout(LIMIT).unwrap())
        .await
        .unwrap()
}
async fn event(f: &mut Fixture, expected: u32) -> Value {
    let (callback, data) = tokio::time::timeout(LIMIT, f.events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(callback, expected);
    data
}
async fn approve(f: &Fixture, review: &Value) {
    reply(send(
        f,
        "plugin_host_reviewed_dispatch",
        json!({
            "callId":review["callId"], "id":ID, "revision":f.revision,
            "digest":review["digest"], "destination":review["request"]["destination"]
        }),
    ))
    .await
    .unwrap();
}

#[test]
fn private_custody_to_actual_fake_create_retains_owner_through_disposal() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::new().await;
        let mut f = enrolled(&peer);
        let body = invocation(&f, &peer);
        let terminal = send(&f, "plugin_host_reviewed_invoke", body.clone());
        let review = event(&mut f, 9).await;
        assert_eq!(review["request"], body["request"]);
        assert!(!review.to_string().contains(CANARY));
        assert_eq!(peer.sends(), 0);
        approve(&f, &review).await;
        let wire = tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let head_end = wire
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap()
            + 4;
        assert_eq!(&wire[head_end..], BODY.as_bytes());
        let head = std::str::from_utf8(&wire[..head_end])
            .unwrap()
            .to_ascii_lowercase();
        assert!(head.starts_with("post /"));
        assert!(head.contains(&format!(
            "authorization: bearer {}\r\n",
            CANARY.to_ascii_lowercase()
        )));
        assert_eq!(
            peer.sends(),
            1,
            "actual send observer has a positive control"
        );
        assert!(f
            .app
            .state::<Invocations>()
            .own("while-http-active", ID)
            .is_err());
        peer.respond(
            200,
            "Content-Type: application/json\r\nX-Private: not-exported\r\n",
            br#"{"id":"fixture-task"}"#,
        );
        let progress = event(&mut f, 10).await;
        for key in ["callId", "digest"] {
            assert_eq!(progress[key], review[key]);
        }
        assert_eq!(progress["destination"], review["request"]["destination"]);
        assert_eq!(progress["sequence"], 1);
        assert_eq!(progress["phase"], "create-response");
        assert_eq!(progress["safeBody"], r#"{"id":"fixture-task"}"#);
        assert!(progress.get("headers").is_none());
        assert!(!progress.to_string().contains(CANARY));
        assert!(
            matches!(terminal.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "create response is not ownership completion"
        );
        assert!(reply(send(&f, "plugin_host_reviewed_invoke", body))
            .await
            .is_err());
        reply(send(
            &f,
            "plugin_host_reviewed_retire",
            json!({"callId":review["callId"]}),
        ))
        .await
        .unwrap();
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), 1, "duplicate IPC does not recreate");
        let _successor = f
            .app
            .state::<Invocations>()
            .own("after-http-owner-return", ID)
            .unwrap();
    });
}

#[test]
fn reviewed_create_refuses_lost_account_page_grant_or_retired_attempt_before_send() {
    tauri::async_runtime::block_on(async {
        for change in ["replace", "clear", "page", "disable", "retire"] {
            let peer = Peer::new().await;
            let mut f = enrolled(&peer);
            let terminal = send(&f, "plugin_host_reviewed_invoke", invocation(&f, &peer));
            let review = event(&mut f, 9).await;
            match change {
                "replace" => f
                    .manager
                    .secret_set(
                        ID,
                        &f.revision,
                        "key",
                        &f.app
                            .state::<IdentityHost>()
                            .current_viewer()
                            .unwrap()
                            .unwrap(),
                        "replacement",
                        &|| true,
                    )
                    .unwrap(),
                "clear" => {
                    f.call("clear", f.body()).unwrap();
                }
                "page" => f.app.state::<crate::host_request::HostCalls>().page_load(),
                "disable" => {
                    f.manager.change("disable", ID).unwrap();
                }
                "retire" => f
                    .app
                    .state::<Invocations>()
                    .cancel(review["callId"].as_str().unwrap()),
                _ => unreachable!(),
            }
            // The trusted action may be accepted before final effect admission;
            // neither acceptance nor preparation constitutes an HTTP send.
            let _ = reply(send(
                &f,
                "plugin_host_reviewed_dispatch",
                json!({
                    "callId":review["callId"], "id":ID, "revision":f.revision,
                    "digest":review["digest"], "destination":review["request"]["destination"]
                }),
            ))
            .await;
            let result = reply(terminal).await;
            assert!(
                result.is_err() || result.unwrap()["outcome"] == "cancelled",
                "{change}"
            );
            assert_eq!(
                peer.sends(),
                0,
                "{change}: completed owner is the no-late-send barrier"
            );
            assert!(f.events.try_recv().is_err(), "{change}: no create response");
            let _successor = f
                .app
                .state::<Invocations>()
                .own("after-refusal", ID)
                .unwrap();
        }
    });
}

#[test]
fn private_http_rejects_reflected_success_headers_errors_and_bounded_invalid_json() {
    tauri::async_runtime::block_on(async {
        for (status, headers, body) in [
            (
                200,
                "".to_owned(),
                format!("{{\"reflected\":\"{CANARY}\"}}").into_bytes(),
            ),
            (200, format!("X-Reflected: {CANARY}\r\n"), b"{}".to_vec()),
            (200, format!("Set-Cookie: {CANARY}\r\n"), b"{}".to_vec()),
            (400, "".to_owned(), CANARY.as_bytes().to_vec()),
            (
                302,
                "Location: /another-create\r\n".to_owned(),
                b"{}".to_vec(),
            ),
            (200, "".to_owned(), vec![b'x'; 64 * 1024 + 1]),
            (200, "".to_owned(), b"not-json".to_vec()),
            (200, "".to_owned(), vec![0xff]),
        ] {
            let mut peer = Peer::new().await;
            let mut f = enrolled(&peer);
            let terminal = send(&f, "plugin_host_reviewed_invoke", invocation(&f, &peer));
            let review = event(&mut f, 9).await;
            approve(&f, &review).await;
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .unwrap()
                .unwrap();
            peer.respond(status, &headers, &body);
            let failure = reply(terminal).await.unwrap_err();
            assert!(!failure.contains(CANARY));
            assert!(failure.contains("response unavailable"));
            assert_eq!(peer.sends(), 1);
            assert!(
                f.events.try_recv().is_err(),
                "no unsafe response crosses IPC"
            );
            let _successor = f
                .app
                .state::<Invocations>()
                .own("after-safe-failure", ID)
                .unwrap();
        }
    });
}

#[test]
fn cancelling_inflight_create_waits_for_local_owner_and_suppresses_late_response() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::new().await;
        let mut f = enrolled(&peer);
        let terminal = send(&f, "plugin_host_reviewed_invoke", invocation(&f, &peer));
        let review = event(&mut f, 9).await;
        approve(&f, &review).await;
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        // Hold the real server response while the native request is in flight.
        assert!(f
            .app
            .state::<Invocations>()
            .own("while-response-held", ID)
            .is_err());
        reply(send(
            &f,
            "plugin_host_reviewed_retire",
            json!({"callId":review["callId"]}),
        ))
        .await
        .unwrap();
        assert!(reply(terminal).await.is_err());
        peer.respond(200, "", br#"{"id":"late-task"}"#);
        peer.finish().await;
        assert!(
            f.events.try_recv().is_err(),
            "retirement plus worker/peer completion excludes late progress"
        );
        assert_eq!(
            peer.sends(),
            1,
            "retirement cannot undo the admitted fake request"
        );
        let _successor = f
            .app
            .state::<Invocations>()
            .own("after-cancelled-network", ID)
            .unwrap();
    });
}

/// Approved create through its create response; returns the review and terminal.
async fn created(
    f: &mut Fixture,
    peer: &mut Peer,
) -> (Value, mpsc::Receiver<Result<Value, String>>) {
    let request = invocation(f, peer);
    created_from(f, peer, request).await
}
async fn created_from(
    f: &mut Fixture,
    peer: &mut Peer,
    request: Value,
) -> (Value, mpsc::Receiver<Result<Value, String>>) {
    let terminal = send(f, "plugin_host_reviewed_invoke", request);
    let review = event(f, 9).await;
    approve(f, &review).await;
    tokio::time::timeout(LIMIT, peer.requests.recv())
        .await
        .unwrap()
        .unwrap();
    peer.respond(200, "", br#"{"id":"fixture-task"}"#);
    assert_eq!(event(f, 10).await["sequence"], 1);
    // The fake channel delivers inside the handoff fences, which all nest in
    // the Invocations lock; taking that lock observes their release.
    assert!(f
        .app
        .state::<Invocations>()
        .live(review["callId"].as_str().unwrap()));
    (review, terminal)
}
fn parent_get(f: &Fixture, call: &Value, request: Value) -> mpsc::Receiver<Result<Value, String>> {
    send(
        f,
        "plugin_host_request",
        json!({"id":ID, "revision":f.revision, "request":request, "parent":{"version":1, "callId":call}}),
    )
}
/// The exact rejected string a parent read's IPC carries for `name`.
fn code(name: &str) -> String {
    json!(format!("host-parent-read/v1/{name}")).to_string()
}
async fn retire(f: &Fixture, review: &Value) {
    reply(send(
        f,
        "plugin_host_reviewed_retire",
        json!({"callId":review["callId"]}),
    ))
    .await
    .unwrap();
}

#[test]
fn parent_get_continues_the_one_create_under_retained_authority() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(5).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = &review["callId"];
        let get = json!({"url":peer.url, "method":"GET"});
        // Refused shapes never reach the network or fall back to an ordinary request.
        let other = peer.url.join("#fragment").unwrap();
        for (request, parent) in [
            (
                json!({"url":peer.url, "method":"POST", "body":"{}"}),
                json!({"version":1, "callId":call}),
            ),
            (
                json!({"url":peer.url, "headers":{"Authorization":"x"}}),
                json!({"version":1, "callId":call}),
            ),
            (
                json!({"url":peer.url, "secret":"key"}),
                json!({"version":1, "callId":call}),
            ),
            (json!({"url":other}), json!({"version":1, "callId":call})),
            (
                json!({"url":"https://undeclared.example.test/task"}),
                json!({"version":1, "callId":call}),
            ),
            (get.clone(), json!({"version":2, "callId":call})),
            (
                get.clone(),
                json!({"version":1, "callId":uuid::Uuid::new_v4().to_string()}),
            ),
        ] {
            let refused = reply(send(
                &f,
                "plugin_host_request",
                json!({"id":ID, "revision":f.revision, "request":request, "parent":parent}),
            ))
            .await;
            assert_eq!(
                refused.unwrap_err(),
                code("native-admission"),
                "{request} {parent}"
            );
        }
        assert_eq!(peer.sends(), 1, "refusals send nothing");

        let read = parent_get(&f, call, get.clone());
        let wire = tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let head = std::str::from_utf8(&wire).unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /"));
        assert!(head.contains(&format!(
            "authorization: bearer {}\r\n",
            CANARY.to_ascii_lowercase()
        )));
        assert!(head.contains("x-version: fixture-1\r\n"));
        assert!(head.ends_with("\r\n\r\n"), "no body");
        peer.respond(200, "X-Private: hidden\r\n", br#"{"status":"RUNNING"}"#);
        let first = reply(read).await.unwrap();
        assert_eq!(first["body"], r#"{"status":"RUNNING"}"#);
        assert_eq!(first["headers"], json!({}));
        assert_eq!(
            first["parent"],
            json!({"version":1, "callId":call, "digest":review["digest"],
                "destination":review["request"]["destination"], "sequence":2})
        );
        assert!(!first.to_string().contains(CANARY));

        // An admitted failure consumes its read; no refund or retry.
        let read = parent_get(&f, call, get.clone());
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(500, "", CANARY.as_bytes());
        assert_eq!(reply(read).await.unwrap_err(), code("native-status"));
        let read = parent_get(&f, call, get.clone());
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", br#"{"status":"SUCCEEDED"}"#);
        assert_eq!(reply(read).await.unwrap()["parent"]["sequence"], 4);

        // One read in flight: a concurrent read is refused without a send.
        let held = parent_get(&f, call, get.clone());
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            reply(parent_get(&f, call, get.clone())).await.unwrap_err(),
            code("native-admission")
        );
        assert_eq!(peer.sends(), 5);
        peer.respond(200, "", b"{}");
        assert_eq!(reply(held).await.unwrap()["parent"]["sequence"], 5);

        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(
            reply(parent_get(&f, call, get)).await.unwrap_err(),
            code("native-admission")
        );
        assert_eq!(
            peer.sends(),
            5,
            "one create, four reads, nothing after retirement"
        );
        assert!(
            f.events.try_recv().is_err(),
            "reads never reach the progress channel"
        );
        let _successor = f
            .app
            .state::<Invocations>()
            .own("after-parent-reads", ID)
            .unwrap();
    });
}

#[test]
fn parent_get_is_unavailable_before_create_and_after_scope_changes() {
    tauri::async_runtime::block_on(async {
        let peer = Peer::new().await;
        let mut f = enrolled(&peer);
        let terminal = send(&f, "plugin_host_reviewed_invoke", invocation(&f, &peer));
        let review = event(&mut f, 9).await;
        let get = json!({"url":peer.url});
        assert_eq!(
            reply(parent_get(&f, &review["callId"], get))
                .await
                .unwrap_err(),
            code("native-admission")
        );
        assert_eq!(peer.sends(), 0, "no parent before approval and create");
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "cancelled");

        for change in ["replace", "clear", "page", "disable", "budget", "deadline"] {
            let mut peer = Peer::new().await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            let viewer = review["request"]["destination"]["viewer"]
                .as_str()
                .unwrap()
                .to_owned();
            match change {
                "replace" => f
                    .manager
                    .secret_set(ID, &f.revision, "key", &viewer, "replacement", &|| true)
                    .unwrap(),
                "clear" => {
                    f.call("clear", f.body()).unwrap();
                }
                "page" => f.app.state::<crate::host_request::HostCalls>().page_load(),
                "disable" => {
                    f.manager.change("disable", ID).unwrap();
                }
                "budget" => f.app.state::<Invocations>().spend(
                    call,
                    120,
                    tokio::time::Instant::now() + LIMIT,
                ),
                "deadline" => {
                    f.app
                        .state::<Invocations>()
                        .spend(call, 0, tokio::time::Instant::now())
                }
                _ => unreachable!(),
            }
            // Only a live parent behind a refusing fence is a fence refusal:
            // clearing retires the call first, and a disabled plugin is withdrawn.
            let expected = match change {
                "replace" | "page" => "native-fence",
                _ => "native-admission",
            };
            assert_eq!(
                reply(parent_get(&f, &review["callId"], json!({"url":peer.url})))
                    .await
                    .unwrap_err(),
                code(expected),
                "{change}"
            );
            assert_eq!(peer.sends(), 1, "{change}: refused before send");
            retire(&f, &review).await;
            assert!(
                reply(terminal)
                    .await
                    .is_ok_and(|v| v["outcome"] == "unknown"),
                "{change}"
            );
            let _successor = f
                .app
                .state::<Invocations>()
                .own("after-scope-change", ID)
                .unwrap();
        }
    });
}

#[test]
fn last_admitted_read_is_bounded_and_retirement_suppresses_a_held_read() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(3).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = review["callId"].as_str().unwrap();
        let get = json!({"url":peer.url});
        f.app
            .state::<Invocations>()
            .spend(call, 119, tokio::time::Instant::now() + LIMIT);
        let read = parent_get(&f, &review["callId"], get.clone());
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", b"{}");
        assert_eq!(reply(read).await.unwrap()["parent"]["sequence"], 121);
        assert_eq!(
            reply(parent_get(&f, &review["callId"], get.clone()))
                .await
                .unwrap_err(),
            code("native-admission")
        );
        assert_eq!(peer.sends(), 2, "the 121st read is refused before send");
        f.app
            .state::<Invocations>()
            .spend(call, 0, tokio::time::Instant::now() + LIMIT);

        let held = parent_get(&f, &review["callId"], get);
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(f
            .app
            .state::<Invocations>()
            .own("while-read-held", ID)
            .is_err());
        retire(&f, &review).await;
        assert_eq!(
            reply(held).await.unwrap_err(),
            code("native-retired"),
            "no handoff after retirement"
        );
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        peer.respond(200, "", br#"{"late":true}"#);
        peer.finish().await;
        assert!(f.events.try_recv().is_err());
        assert_eq!(peer.sends(), 3);
        let _successor = f
            .app
            .state::<Invocations>()
            .own("after-held-read", ID)
            .unwrap();
    });
}

#[test]
fn dropped_parent_waiter_leaves_the_held_read_with_the_original_worker() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let (app, label) = (f.app.handle().clone(), f.view.label().to_owned());
        let (revision, url) = (f.revision.clone(), peer.url.to_string());
        let parent = serde_json::from_value(json!({"version":1, "callId":call})).unwrap();
        // The same native entry the registered command reaches after its
        // stateless checks; aborting it drops the IPC reply waiter.
        let waiter = tauri::async_runtime::spawn(async move {
            let read = crate::reviewed_invocation::ParentRead {
                id: ID,
                revision: &revision,
                url: &url,
                end: tokio::time::Instant::now() + LIMIT,
            };
            crate::reviewed_invocation::parent_read(&app, &label, read, parent).await
        });
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        waiter.abort();
        assert!(waiter.await.is_err(), "the waiter is gone");

        let invocations = f.app.state::<Invocations>();
        assert!(invocations.live(&call), "the call still owns the held read");
        assert!(invocations.own("while-waiter-dropped", ID).is_err());
        assert_eq!(
            reply(parent_get(&f, &review["callId"], json!({"url":peer.url})))
                .await
                .unwrap_err(),
            code("native-admission"),
            "the held read still occupies the one slot"
        );
        assert_eq!(peer.sends(), 2);
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        peer.respond(200, "", br#"{"late":true}"#);
        peer.finish().await;
        assert!(f.events.try_recv().is_err(), "nothing reaches progress");
        assert_eq!(peer.sends(), 2, "one create, one read, no retry");
        let _successor = invocations.own("after-dropped-waiter", ID).unwrap();
    });
}

#[test]
fn parent_read_failures_name_their_observed_boundary_and_nothing_else() {
    tauri::async_runtime::block_on(async {
        let oversized = format!("{{\"pad\":\"{}\"}}", "x".repeat(64 * 1024));
        let reflected_header = format!("X-Echo: {CANARY}\r\n");
        // (status, headers, body, code): every unsafe success is one code, and
        // a refused status is named before any reflection check.
        let cases: [(u16, &str, &[u8], &str); 8] = [
            (500, &reflected_header, CANARY.as_bytes(), "native-status"),
            (
                302,
                "Location: https://elsewhere.invalid/\r\n",
                b"{}",
                "native-status",
            ),
            (200, &reflected_header, b"{}", "native-response"),
            (200, "", CANARY.as_bytes(), "native-response"),
            (200, "", b"not json", "native-response"),
            (200, "", &[0xff, 0xfe], "native-response"),
            (200, "", oversized.as_bytes(), "native-response"),
            (200, "", b"{}", ""),
        ];
        let mut peer = Peer::serving(cases.len() + 2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = &review["callId"];
        let get = json!({"url":peer.url});
        for (sent, (status, headers, body, expected)) in cases.into_iter().enumerate() {
            let read = parent_get(&f, call, get.clone());
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .unwrap()
                .unwrap();
            peer.respond(status, headers, body);
            match reply(read).await {
                Ok(read) => assert_eq!((read["status"].clone(), expected), (json!(200), "")),
                Err(failure) => assert_eq!(failure, code(expected), "{status} {headers}"),
            }
            assert_eq!(peer.sends(), sent + 2, "one send per read, no retry");
        }
        // A connection closed without a response is the transport's failure.
        let read = parent_get(&f, call, get.clone());
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond_raw(b"");
        let failure = reply(read).await.unwrap_err();
        assert_eq!(failure, code("native-transport"));
        for private in [CANARY, peer.url.as_str()] {
            assert!(!failure.contains(private));
        }
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), cases.len() + 2, "one create, no download");
        assert!(f.events.try_recv().is_err());
    });
}

/// The registered command's native entry, with a caller-chosen wait.
async fn direct_read(
    f: &Fixture,
    url: &str,
    call: &str,
    wait: Duration,
) -> Result<crate::host_request::HostResponse, String> {
    let parent = serde_json::from_value(json!({"version":1, "callId":call})).unwrap();
    let read = crate::reviewed_invocation::ParentRead {
        id: ID,
        revision: &f.revision,
        url,
        end: tokio::time::Instant::now() + wait,
    };
    crate::reviewed_invocation::parent_read(f.app.handle(), f.view.label(), read, parent).await
}

#[test]
fn an_outer_wait_times_out_and_a_withheld_handoff_is_interrupted() {
    tauri::async_runtime::block_on(async {
        // The outer wait, not the network, ends this read.
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let url = peer.url.to_string();
        let wait = Duration::from_millis(200);
        let (timed_out, sent) = tokio::join!(
            direct_read(&f, &url, review["callId"].as_str().unwrap(), wait),
            peer.requests.recv()
        );
        sent.unwrap();
        assert_eq!(timed_out.unwrap_err(), "host-parent-read/v1/native-timeout");
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), 2, "one create, one read, no retry");

        // The page changes while a read is held: its handoff fence refuses and
        // the reply closes without a retirement signal.
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let held = parent_get(&f, &review["callId"], json!({"url":peer.url}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        f.app.state::<crate::host_request::HostCalls>().page_load();
        peer.respond(200, "", b"{}");
        assert_eq!(reply(held).await.unwrap_err(), code("native-interrupted"));
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), 2, "one create, one read, no retry");
    });
}

#[test]
fn the_parent_window_closing_on_a_held_read_is_admission_not_timeout() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let mut request = invocation(&f, &peer);
        let channel = format!("window-{}", uuid::Uuid::new_v4());
        request["request"]["destination"]["channel"] = json!(channel);
        let window = Duration::from_secs(2);
        *crate::reviewed_invocation::TEST_WINDOW.lock().unwrap() = Some((channel, window));
        let (review, terminal) = created_from(&mut f, &mut peer, request).await;
        // Held past the window: the outer wait (10 s) outlasts it.
        let held = parent_get(&f, &review["callId"], json!({"url":peer.url}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .expect("admitted and sent inside the window");
        assert_eq!(reply(held).await.unwrap_err(), code("native-admission"));
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), 2);
    });
}

fn send_bytes(
    f: &Fixture,
    call: &Value,
    request: Value,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    send_raw(
        f,
        json!({
            "id":ID, "revision":f.revision, "request":request,
            "parent":{"version":1, "callId":call},
        }),
    )
}
fn send_raw(f: &Fixture, body: Value) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    let (tx, rx) = mpsc::channel();
    f.view.as_ref().clone().on_message(
        tauri::webview::InvokeRequest {
            cmd: "plugin_host_request_bytes".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: f.view.url().unwrap(),
            body: tauri::ipc::InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
        Box::new(move |_, _, response, _, _| {
            let _ = tx.send(match response {
                tauri::ipc::InvokeResponse::Ok(tauri::ipc::InvokeResponseBody::Raw(frame)) => {
                    Ok(frame)
                }
                tauri::ipc::InvokeResponse::Ok(_) => Err("expected raw bytes".into()),
                tauri::ipc::InvokeResponse::Err(error) => Err(error.0.to_string()),
            });
        }),
    );
    rx
}
async fn fetched(
    response: mpsc::Receiver<Result<Vec<u8>, String>>,
) -> Result<(Value, Vec<u8>), String> {
    let frame = tokio::task::spawn_blocking(move || response.recv_timeout(LIMIT).unwrap())
        .await
        .unwrap()?;
    let length = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
    Ok((
        serde_json::from_slice(&frame[4..4 + length]).unwrap(),
        frame[4 + length..].to_vec(),
    ))
}
fn sha256(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    format!("{:x}", sha2::Sha256::digest(bytes))
}

#[test]
fn parent_result_bytes_are_one_credential_free_attempt_with_a_retained_source() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(4).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = &review["callId"];
        let id = call.as_str().unwrap();
        let invocations = f.app.state::<Invocations>();
        let bytes = json!({"url":peer.url, "maxBytes":1024});
        // Refused shapes never reach the network or fall back to an ordinary request.
        for (call, request) in [
            (json!(uuid::Uuid::new_v4().to_string()), bytes.clone()),
            (
                call.clone(),
                json!({"url":peer.url.join("#x").unwrap(), "maxBytes":1024}),
            ),
            (
                call.clone(),
                json!({"url":"https://undeclared.example.test/r", "maxBytes":1024}),
            ),
            (call.clone(), json!({"url":peer.url, "maxBytes":0})),
            (
                call.clone(),
                json!({"url":peer.url, "maxBytes":1024, "headers":{"Cookie":"x"}}),
            ),
        ] {
            assert!(
                fetched(send_bytes(&f, &call, request.clone()))
                    .await
                    .is_err(),
                "{request}"
            );
        }
        assert_eq!(peer.sends(), 1, "refusals send nothing");

        let read = send_bytes(&f, call, bytes.clone());
        let wire = tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let head = std::str::from_utf8(&wire).unwrap().to_ascii_lowercase();
        assert!(head.starts_with("get /"));
        for absent in ["authorization", "cookie", "x-version", "content-type"] {
            assert!(
                !head.contains(absent),
                "{absent} is never sent to the output host"
            );
        }
        assert!(!head.contains(&CANARY.to_ascii_lowercase()));
        assert!(head.ends_with("\r\n\r\n"), "no body");
        let body = b"\x00\x01result-bytes\xff".to_vec();
        peer.respond(200, "Set-Cookie: s=1\r\nX-Private: hidden\r\n", &body);
        let (metadata, returned) = fetched(read).await.unwrap();
        assert_eq!(returned, body);
        assert_eq!(metadata["headers"], json!({}));
        assert_eq!(
            metadata["parent"],
            json!({"version":1, "callId":call, "digest":review["digest"],
                "destination":review["request"]["destination"], "sequence":2})
        );
        assert_eq!(
            metadata["source"],
            json!({"sha256":sha256(&body), "size":body.len()})
        );
        assert_eq!(invocations.source(id), Some((body.clone(), sha256(&body))));

        // Transfer admission ended with the frame: ordinary byte work proceeds
        // while the source stays retained and the one reviewed slot stays taken.
        let ordinary = send_raw(
            &f,
            json!({"id":ID, "revision":f.revision, "request":{"url":peer.url, "maxBytes":16}}),
        );
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", b"ordinary");
        let (metadata, returned) = fetched(ordinary).await.unwrap();
        assert_eq!(
            (metadata["status"].as_u64(), returned.as_slice()),
            (Some(200), &b"ordinary"[..])
        );
        assert!(metadata.get("parent").is_none() && metadata.get("source").is_none());
        let managed = crate::host_files::managed_tests::Fixture::new(true, true);
        let saved = b"unrelated managed save";
        managed
            .save(saved, &crate::host_files::managed_tests::digest(saved))
            .unwrap();
        assert_eq!(invocations.source(id), Some((body.clone(), sha256(&body))));
        assert!(invocations.own("second-review", ID).is_err());

        // One result attempt: a second is refused before send; text reads continue.
        assert!(fetched(send_bytes(
            &f,
            call,
            json!({"url":peer.url, "maxBytes":1024, "timeoutMs":1000})
        ))
        .await
        .is_err());
        assert_eq!(
            peer.sends(),
            3,
            "create, result, ordinary; the refused attempt sends nothing"
        );
        let read = parent_get(&f, call, json!({"url":peer.url}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", b"{}");
        assert_eq!(reply(read).await.unwrap()["parent"]["sequence"], 3);

        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.source(id), None, "retirement drops the source");
        assert_eq!(peer.sends(), 4);
        let _successor = invocations.own("after-result", ID).unwrap();
    });
}

#[test]
fn failed_result_attempts_are_consumed_bounded_and_never_refetched() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let failures: [(&str, &[u8], usize); 6] = [
            ("error", b"HTTP/1.1 500 Fixture\r\nContent-Length: 6\r\nConnection: close\r\n\r\nsecret", 64),
            ("empty", b"HTTP/1.1 200 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", 64),
            ("no content", b"HTTP/1.1 204 Fixture\r\nConnection: close\r\n\r\n", 64),
            ("redirect", b"HTTP/1.1 302 Fixture\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", 64),
            ("dishonest length", b"HTTP/1.1 200 Fixture\r\nContent-Length: 99\r\nConnection: close\r\n\r\nABC", 64),
            ("chunk overrun", b"HTTP/1.1 200 Fixture\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n3\r\nABC\r\n3\r\nDEF\r\n0\r\n\r\n", 4),
        ];
        for (name, response, max) in failures {
            let mut peer = Peer::serving(2).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = &review["callId"];
            let read = send_bytes(&f, call, json!({"url":peer.url, "maxBytes":max}));
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .unwrap()
                .unwrap();
            peer.respond_raw(response);
            let failure = fetched(read).await.unwrap_err();
            assert!(!failure.contains("secret"), "{name}");
            let invocations = f.app.state::<Invocations>();
            assert_eq!(invocations.source(call.as_str().unwrap()), None, "{name}");
            assert!(
                fetched(send_bytes(
                    &f,
                    call,
                    json!({"url":peer.url, "maxBytes":max, "timeoutMs":1000})
                ))
                .await
                .is_err(),
                "{name}: the consumed attempt is not refetched"
            );
            assert_eq!(
                peer.sends(),
                2,
                "{name}: one create, one read, no retry or redirect"
            );
            retire(&f, &review).await;
            assert_eq!(
                reply(terminal).await.unwrap()["outcome"],
                "unknown",
                "{name}"
            );
            assert!(crate::host_files::BYTE_WORK.try_acquire().is_ok(), "{name}");
        }
    });
}

#[test]
fn retirement_drops_a_held_result_download_before_a_successor() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = review["callId"].as_str().unwrap();
        let held = send_bytes(
            &f,
            &review["callId"],
            json!({"url":peer.url, "maxBytes":1024}),
        );
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let invocations = f.app.state::<Invocations>();
        assert!(invocations.own("while-result-held", ID).is_err());
        assert!(
            crate::host_files::BYTE_WORK.try_acquire().is_err(),
            "the download holds admission"
        );
        retire(&f, &review).await;
        assert!(fetched(held).await.is_err(), "no handoff after retirement");
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.source(call), None);
        assert!(
            crate::host_files::BYTE_WORK.try_acquire().is_ok(),
            "admission released before finish"
        );
        peer.respond(200, "", b"late");
        peer.finish().await;
        assert!(f.events.try_recv().is_err());
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-held-result", ID).unwrap();
    });
}

#[test]
fn a_closed_result_waiter_releases_admission_but_not_the_committed_source() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let (app, label) = (f.app.handle().clone(), f.view.label().to_owned());
        let (revision, url) = (f.revision.clone(), peer.url.clone());
        let parent = serde_json::from_value(json!({"version":1, "callId":call})).unwrap();
        // The native entry the registered byte command reaches after its
        // stateless checks and admission; aborting it closes the reply.
        let waiter = tauri::async_runtime::spawn(async move {
            let admission = crate::host_files::byte_admission(tokio::time::Instant::now() + LIMIT)
                .await
                .unwrap();
            let read = crate::reviewed_invocation::ParentRead {
                id: ID,
                revision: &revision,
                url: url.as_str(),
                end: tokio::time::Instant::now() + LIMIT,
            };
            crate::reviewed_invocation::parent_bytes(
                &app, &label, read, parent, &url, 1024, admission,
            )
            .await
            .map(|_| ())
        });
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        waiter.abort();
        assert!(waiter.await.is_err());
        peer.respond(200, "", b"committed");
        peer.finish().await;
        let invocations = f.app.state::<Invocations>();
        // Observe the worker's commit; the reply (and its admission) dropped inside it.
        tokio::time::timeout(LIMIT, async {
            while invocations.source(&call).is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(crate::host_files::BYTE_WORK.try_acquire().is_ok());
        assert!(invocations.own("while-source-retained", ID).is_err());
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.source(&call), None);
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-closed-waiter", ID).unwrap();
    });
}

/// Scripted DNS for the production result client: one answer list per lookup,
/// optionally held until released. Only the resolver and address rule change.
struct Dns {
    answers: std::sync::Mutex<Vec<Vec<std::net::IpAddr>>>,
    lookups: std::sync::atomic::AtomicUsize,
    hold: Option<(tokio::sync::Notify, tokio::sync::Semaphore)>,
}
impl crate::public_https::Resolve for Dns {
    fn lookup<'a>(&'a self, host: &'a str, port: u16) -> crate::public_https::Lookup<'a> {
        Box::pin(async move {
            assert_eq!(host, crate::host_request::credential_tests::RESULT_HOST);
            self.lookups
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if let Some((started, release)) = &self.hold {
                started.notify_one();
                let _ = release.acquire().await;
            }
            let answers = self.answers.lock().unwrap().remove(0);
            Ok(answers
                .into_iter()
                .map(|ip| std::net::SocketAddr::new(ip, port))
                .collect())
        })
    }
}
fn loopback(ip: std::net::IpAddr) -> bool {
    ip.is_loopback()
}
/// Routes the result client's lookups through `dns`, trusting `media`, until dropped.
struct ResultNet;
impl ResultNet {
    fn route(dns: Arc<Dns>, media: &Peer) -> Self {
        let mut net = crate::public_https::Net::custom(dns, loopback);
        net.root = Some(media.root.clone());
        *crate::host_request::RESULT_NET.lock().unwrap() = Some(net);
        Self
    }
}
impl Drop for ResultNet {
    fn drop(&mut self) {
        *crate::host_request::RESULT_NET.lock().unwrap() = None;
    }
}
fn dns(answers: &[&[&str]], held: bool) -> Arc<Dns> {
    Arc::new(Dns {
        answers: std::sync::Mutex::new(
            answers
                .iter()
                .map(|list| list.iter().map(|ip| ip.parse().unwrap()).collect())
                .collect(),
        ),
        lookups: Default::default(),
        hold: held.then(|| (tokio::sync::Notify::new(), tokio::sync::Semaphore::new(0))),
    })
}
fn named(media: &Peer, path: &str) -> String {
    format!(
        "https://{}:{}{path}",
        crate::host_request::credential_tests::RESULT_HOST,
        media.url.port().unwrap()
    )
}
/// One authenticated text read answered with `status` and `body`.
async fn observed(
    f: &Fixture,
    peer: &mut Peer,
    call: &Value,
    status: u16,
    body: &str,
) -> Result<Value, String> {
    let read = parent_get(f, call, json!({"url":peer.url}));
    tokio::time::timeout(LIMIT, peer.requests.recv())
        .await
        .unwrap()
        .unwrap();
    peer.respond(status, "", body.as_bytes());
    reply(read).await
}
fn send_result(
    f: &Fixture,
    call: &Value,
    sequence: Value,
) -> mpsc::Receiver<Result<Vec<u8>, String>> {
    send_bytes(
        f,
        call,
        json!({"result":{"version":1, "sequence":sequence}, "maxBytes":1024}),
    )
}

#[test]
fn a_selected_result_is_the_latest_authenticated_200_url_fetched_once_without_credentials() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(7).await;
        let mut media = Peer::serving(1).await;
        let dns = dns(&[&["127.0.0.1"], &["10.0.0.1"]], false);
        let _net = ResultNet::route(dns.clone(), &media);
        let mut f = enrolled(&peer);
        // The registered handshake the renderer parses advertises this mode.
        assert_eq!(
            reply(send(&f, "plugin_host_reviewed_capabilities", json!({})))
                .await
                .unwrap(),
            json!({"version":1, "synthetic":true, "credentialHttp":{"version":1, "createResponse":true,
                "continuation":true, "expectedMedia":1, "result":true, "delivery":true, "resultUrl":1}})
        );
        let (review, terminal) = created(&mut f, &mut peer).await;
        assert_eq!(
            review["resultUrl"], 1,
            "host-derived from the admitted grant"
        );
        let call = &review["callId"];
        let id = call.as_str().unwrap();
        // The create response is not a read; nothing is selected yet.
        assert!(fetched(send_result(&f, call, json!(1))).await.is_err());
        let signed = "/v/1.mp4?X-Sig=a%2Fb&Expires=1&b=2";
        let output = |url: &str| json!({"status":"SUCCEEDED", "output":[url]}).to_string();
        let first = observed(&f, &mut peer, call, 200, &output(&named(&media, signed)))
            .await
            .unwrap();
        assert_eq!(first["parent"]["sequence"], 2);
        // Never a caller URL, a URL beside the result, another call or revision.
        let selected = json!({"version":1, "sequence":2});
        for body in [
            json!({"id":ID, "revision":f.revision, "request":{"result":selected, "url":named(&media, signed), "maxBytes":1024}, "parent":{"version":1, "callId":call}}),
            json!({"id":ID, "revision":f.revision, "request":{"result":selected, "maxBytes":1024}}),
            json!({"id":ID, "revision":f.revision, "request":{"result":{"version":2, "sequence":2}, "maxBytes":1024}, "parent":{"version":1, "callId":call}}),
            json!({"id":ID, "revision":f.revision, "request":{"result":selected, "maxBytes":1024}, "parent":{"version":1, "callId":uuid::Uuid::new_v4().to_string()}}),
            json!({"id":ID, "revision":"other", "request":{"result":selected, "maxBytes":1024}, "parent":{"version":1, "callId":call}}),
        ] {
            assert!(fetched(send_raw(&f, body.clone())).await.is_err(), "{body}");
        }
        // Each new read replaces the selection, whatever it answers.
        assert!(
            observed(&f, &mut peer, call, 500, &output(&named(&media, "/v/500")))
                .await
                .is_err()
        );
        assert!(
            fetched(send_result(&f, call, json!(2))).await.is_err(),
            "replaced by a failed read"
        );
        assert_eq!(
            observed(&f, &mut peer, call, 201, &output(&named(&media, "/v/201")))
                .await
                .unwrap()["parent"]["sequence"],
            4
        );
        assert!(
            fetched(send_result(&f, call, json!(4))).await.is_err(),
            "only HTTP 200 selects"
        );
        for (sequence, unusable) in [
            (5, json!({"output":[7]}).to_string()),
            (
                6,
                output(&format!(
                    "https://127.0.0.1:{}/v",
                    media.url.port().unwrap()
                )),
            ),
        ] {
            assert_eq!(
                observed(&f, &mut peer, call, 200, &unusable).await.unwrap()["parent"]["sequence"],
                sequence
            );
            assert!(
                fetched(send_result(&f, call, json!(sequence)))
                    .await
                    .is_err(),
                "{unusable}"
            );
        }
        let latest = observed(&f, &mut peer, call, 200, &output(&named(&media, signed)))
            .await
            .unwrap();
        assert_eq!(latest["parent"]["sequence"], 7);
        assert!(
            fetched(send_result(&f, call, json!(6))).await.is_err(),
            "stale sequence"
        );
        assert_eq!(
            dns.lookups.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "refusals resolve nothing"
        );
        assert!(media.requests.try_recv().is_err());

        let download = send_result(&f, call, json!(7));
        let wire = tokio::time::timeout(LIMIT, media.requests.recv())
            .await
            .unwrap()
            .unwrap();
        let head = std::str::from_utf8(&wire).unwrap();
        assert!(
            head.starts_with(&format!("GET {signed} HTTP/1.1\r\n")),
            "signed path and query exactly"
        );
        let lower = head.to_ascii_lowercase();
        assert!(lower.contains(&format!(
            "host: {}:",
            crate::host_request::credential_tests::RESULT_HOST
        )));
        for absent in [
            "authorization",
            "cookie",
            "x-version",
            "content-type",
            "referer",
        ] {
            assert!(!lower.contains(absent), "{absent}");
        }
        assert!(!lower.contains(&CANARY.to_ascii_lowercase()));
        let body = b"\x00selected-result\xff".to_vec();
        media.respond(200, "Set-Cookie: s=1\r\n", &body);
        let (metadata, returned) = fetched(download).await.unwrap();
        assert_eq!(returned, body);
        assert_eq!(metadata["parent"]["sequence"], 8);
        assert_eq!(
            metadata["source"],
            json!({"sha256":sha256(&body), "size":body.len()})
        );
        assert_eq!(
            f.app.state::<Invocations>().source(id),
            Some((body.clone(), sha256(&body)))
        );
        assert!(
            fetched(send_result(&f, call, json!(7))).await.is_err(),
            "consumed once"
        );
        assert_eq!(
            dns.lookups.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "one vetted answer, pinned"
        );
        media.finish().await;

        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(peer.sends(), 7, "one create and six reads");
        let _successor = f
            .app
            .state::<Invocations>()
            .own("after-selected-result", ID)
            .unwrap();
    });
}

/// A failure name, scripted DNS answers and an optional raw media response.
type FailedResult = (
    &'static str,
    &'static [&'static [&'static str]],
    Option<&'static [u8]>,
);

#[test]
fn failed_selected_results_are_consumed_without_fallback_or_retry() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let redirect: &'static [u8] = b"HTTP/1.1 302 Fixture\r\nLocation: https://result.example.test/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let oversized: &'static [u8] =
            b"HTTP/1.1 200 Fixture\r\nContent-Length: 2048\r\nConnection: close\r\n\r\n";
        let cases: [FailedResult; 4] = [
            ("mixed answers", &[&["127.0.0.1", "10.0.0.1"]], None),
            ("no answers", &[&[]], None),
            ("redirect", &[&["127.0.0.1"]], Some(redirect)),
            ("oversized", &[&["127.0.0.1"]], Some(oversized)),
        ];
        for (name, answers, response) in cases {
            let mut peer = Peer::serving(2).await;
            let mut media = Peer::serving(1).await;
            let _net = ResultNet::route(dns(answers, false), &media);
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = &review["callId"];
            let output = json!({"output":[named(&media, "/r")]}).to_string();
            observed(&f, &mut peer, call, 200, &output).await.unwrap();
            let download = send_result(&f, call, json!(2));
            if let Some(response) = response {
                tokio::time::timeout(LIMIT, media.requests.recv())
                    .await
                    .unwrap()
                    .unwrap();
                media.respond_raw(response);
            }
            let failure = fetched(download).await.unwrap_err();
            assert!(
                !failure.contains("result.example.test") && !failure.contains("/r"),
                "{name}: {failure}"
            );
            assert_eq!(
                f.app.state::<Invocations>().source(call.as_str().unwrap()),
                None,
                "{name}"
            );
            assert!(
                fetched(send_result(&f, call, json!(2))).await.is_err(),
                "{name}: consumed"
            );
            assert!(
                media.requests.try_recv().is_err(),
                "{name}: no retry or redirect"
            );
            retire(&f, &review).await;
            assert_eq!(
                reply(terminal).await.unwrap()["outcome"],
                "unknown",
                "{name}"
            );
            assert!(crate::host_files::BYTE_WORK.try_acquire().is_ok(), "{name}");
        }
    });
}

#[test]
fn a_scope_change_while_the_result_lookup_is_held_sends_nothing() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        for change in ["retire", "page", "disable"] {
            let mut peer = Peer::serving(2).await;
            let mut media = Peer::serving(1).await;
            let dns = dns(&[&["127.0.0.1"]], true);
            let _net = ResultNet::route(dns.clone(), &media);
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = &review["callId"];
            let output = json!({"output":[named(&media, "/held")]}).to_string();
            observed(&f, &mut peer, call, 200, &output).await.unwrap();
            let (started, release) = dns.hold.as_ref().unwrap();
            let lookup = started.notified();
            let download = send_result(&f, call, json!(2));
            tokio::time::timeout(LIMIT, lookup).await.unwrap();
            let outcome = async {
                match change {
                    "retire" => retire(&f, &review).await,
                    "page" => f.app.state::<crate::host_request::HostCalls>().page_load(),
                    "disable" => {
                        f.manager.change("disable", ID).unwrap();
                    }
                    _ => unreachable!(),
                }
            };
            outcome.await;
            release.add_permits(1);
            // The reply is the completion barrier: the worker finished this attempt.
            assert!(fetched(download).await.is_err(), "{change}");
            if change != "retire" {
                retire(&f, &review).await;
            }
            assert_eq!(
                reply(terminal).await.unwrap()["outcome"],
                "unknown",
                "{change}"
            );
            assert!(
                media.requests.try_recv().is_err(),
                "{change}: nothing sent after the lookup"
            );
            assert_eq!(
                dns.lookups.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "{change}"
            );
            let _successor = f
                .app
                .state::<Invocations>()
                .own("after-held-lookup", ID)
                .unwrap();
        }
    });
}

const MEDIA: [&str; 8] = [
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1280x720:rate=24:duration=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
];
/// A generated MP4 the loopback peer serves; None when the tools are absent.
fn served_media() -> Option<Vec<u8>> {
    let path = crate::host_command::effective_path();
    let ffmpeg = crate::host_command::resolve_program("ffmpeg", &path);
    let ffprobe = crate::host_command::resolve_program("ffprobe", &path);
    if std::process::Command::new(&ffprobe)
        .arg("-version")
        .output()
        .is_err()
    {
        eprintln!("UNVERIFIED: ffmpeg/ffprobe unavailable");
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("served.mp4");
    assert!(std::process::Command::new(ffmpeg)
        .args(["-v", "error"])
        .args(MEDIA)
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p"
        ])
        .args([
            "-c:a",
            "aac",
            "-shortest",
            "-metadata",
            "title=fixture-private-title"
        ])
        .arg(&file)
        .status()
        .unwrap()
        .success());
    Some(std::fs::read(file).unwrap())
}
fn expecting(f: &Fixture, peer: &Peer) -> Value {
    let mut request = invocation(f, peer);
    request["request"]["expectedMedia"] = json!({"version":1, "kind":"video", "container":"mp4",
        "codec":"h264", "width":1280, "height":720, "durationMs":1000, "toleranceMs":50,
        "maxBytes":16 * 1024 * 1024});
    request
}
fn select(f: &Fixture, call: &Value, source: Value) -> mpsc::Receiver<Result<Value, String>> {
    send(
        f,
        "plugin_host_reviewed_result",
        json!({"id":ID, "revision":f.revision, "parent":{"version":1, "callId":call}, "step":{"phase":"prepare", "source":source}}),
    )
}
/// Approved create with expectations, then its one retained result source.
async fn retained(
    f: &mut Fixture,
    peer: &mut Peer,
    body: &[u8],
) -> (Value, mpsc::Receiver<Result<Value, String>>, Value) {
    let request = expecting(f, peer);
    retained_from(f, peer, request, body).await
}
async fn retained_from(
    f: &mut Fixture,
    peer: &mut Peer,
    request: Value,
    body: &[u8],
) -> (Value, mpsc::Receiver<Result<Value, String>>, Value) {
    let (review, terminal) = created_from(f, peer, request).await;
    let read = send_bytes(
        f,
        &review["callId"],
        json!({"url":peer.url, "maxBytes":16 * 1024 * 1024}),
    );
    tokio::time::timeout(LIMIT, peer.requests.recv())
        .await
        .unwrap()
        .unwrap();
    peer.respond(200, "", body);
    let (metadata, _) = fetched(read).await.unwrap();
    (review, terminal, metadata["source"].clone())
}

#[test]
fn selected_retained_source_is_strictly_prepared_and_held_by_the_original_call() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal, source) = retained(&mut f, &mut peer, &served).await;
        assert_eq!(
            review["request"]["expectedMedia"]["durationMs"], 1000,
            "frozen in the native projection"
        );
        let call = &review["callId"];
        let id = call.as_str().unwrap();
        let ack = reply(select(&f, call, source.clone())).await.unwrap();
        let invocations = f.app.state::<Invocations>();
        let (directory, source_sha, prepared_sha, size) = invocations.prepared(id).unwrap();
        let file = directory.join("prepared.mp4");
        let prepared = std::fs::read(&file).unwrap();
        assert_eq!(
            ack,
            json!({"version":1, "callId":call, "digest":review["digest"],
                "destination":review["request"]["destination"], "phase":"prepared",
                "prepared":{"sha256":prepared_sha, "size":size}})
        );
        assert_eq!(
            source_sha,
            sha256(&served),
            "the downloaded bytes, not a copy"
        );
        assert_eq!(
            (prepared_sha.as_str(), size),
            (sha256(&prepared).as_str(), prepared.len())
        );
        assert_ne!(prepared_sha, source_sha);
        assert_eq!(
            invocations.source(id),
            None,
            "the selection consumed the source"
        );
        let probe = std::process::Command::new(crate::host_command::resolve_program(
            "ffprobe",
            &crate::host_command::effective_path(),
        ))
        .args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(&file)
        .output()
        .unwrap();
        let probe: Value = serde_json::from_slice(&probe.stdout).unwrap();
        let streams = probe["streams"].as_array().unwrap();
        assert_eq!(
            (
                streams[0]["codec_name"].as_str(),
                streams[0]["width"].as_u64(),
                streams[0]["height"].as_u64()
            ),
            (Some("h264"), Some(1280), Some(720))
        );
        assert!(streams.iter().any(|s| s["codec_name"] == "aac"));
        assert!(!probe.to_string().contains("fixture-private-title"));
        let duration: f64 = streams[0]["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration * 1000.0 - 1000.0).abs() <= 50.0, "{duration}");

        // Nothing repeats, substitutes or completes; transfer admission stays free.
        assert!(reply(select(&f, call, source.clone())).await.is_err());
        assert!(reply(parent_get(&f, call, json!({"url":peer.url})))
            .await
            .is_err());
        assert!(
            fetched(send_bytes(&f, call, json!({"url":peer.url, "maxBytes":16})))
                .await
                .is_err()
        );
        assert!(crate::host_files::BYTE_WORK.try_acquire().is_ok());
        assert!(invocations.own("while-prepared", ID).is_err());
        assert!(matches!(
            terminal.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(f.events.try_recv().is_err());
        assert_eq!(
            peer.sends(),
            2,
            "one create, one download; preparation is local"
        );

        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.prepared(id), None);
        assert!(
            !directory.exists(),
            "files removed before the owner finished"
        );
        let _successor = invocations.own("after-prepared", ID).unwrap();
        eprintln!(
            "PREPARED_STRICT source_sha256={source_sha} prepared_sha256={prepared_sha} size={size} duration={duration}"
        );
    });
}

/// One signed community event, as a loopback community's read returns it.
fn community_event(signer: &::nostr::key::Keys, kind: u16, tags: &[&[&str]]) -> Value {
    use ::nostr::event::FinalizeEvent;
    let tags = tags
        .iter()
        .map(|tag| ::nostr::event::Tag::parse(tag.iter().copied()).unwrap());
    let event = ::nostr::event::EventBuilder::new(::nostr::event::Kind::Custom(kind), "")
        .tags(tags)
        .finalize(signer)
        .unwrap();
    serde_json::to_value(event).unwrap()
}

/// How one agent delivery's community and host part differ from the
/// accepted path.
#[derive(Clone, Copy, PartialEq)]
enum Delivery {
    Accepted,
    Guest,
    Archived,
    ForeignRoot,
    Tampered,
    UnusableReceipt,
    RetiredBeforePublish,
    ExtraTag,
    MismatchedAck,
    RetiredDuringUpload,
    RetiredDuringPublish,
}

/// What one delivery left behind.
struct Delivered {
    agent: String,
    root: String,
    prepared: Value,
    event: Option<Value>,
    receipt: Value,
    heads: Vec<String>,
    bodies: Vec<Vec<u8>>,
}

/// The registered path for an agent's review, end to end: invoke as the
/// agent, approve, create, read and prepare the result, then one upload and
/// one attachment message in the original chat and thread. Fake loopback
/// transports and an offline key; this test plays the JS host's part, so it
/// is not the JS host, a live community or playable media.
async fn deliver(case: Delivery, served: &[u8]) -> Delivered {
    let community = crate::federated_identity::testing::community(false).await;
    let key = buzz_agent_controller::Secret::generate().unwrap();
    let agent = buzz_agent_controller::AppAgent {
        pubkey: key.pubkey().into(),
        relay: format!("wss://{}", community.origin.authority()),
        owner: "a".repeat(64),
        auth: r#"["auth","fixture-owner","","fixture-attestation"]"#.into(),
        agent_type: "p/t".into(),
        name: "Ada".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
        home: None,
        joining: false,
        protection: None,
        protection_revision: 0,
    };
    let relay_key = ::nostr::key::Keys::generate();
    let authority = relay_key.public_key().to_hex();
    let rooted = if case == Delivery::ForeignRoot {
        "other-channel"
    } else {
        "fixture-channel"
    };
    let root = community_event(&::nostr::key::Keys::generate(), 9, &[&["h", rooted]]);
    let root_id = root["id"].as_str().unwrap().to_owned();
    let member: &[&str] = if case == Delivery::Guest {
        &["p", &agent.pubkey, "", "guest"]
    } else {
        &["p", &agent.pubkey]
    };
    let metadata: &[&[&str]] = if case == Delivery::Archived {
        &[&["d", "fixture-channel"], &["archived", "true"]]
    } else {
        &[&["d", "fixture-channel"]]
    };
    let readable = json!([
        community_event(&relay_key, 39002, &[&["d", "fixture-channel"], member]),
        community_event(&relay_key, 39000, metadata),
        root,
    ])
    .to_string();
    // Identity and read precede each effect; refusals stop before it.
    let expected = match case {
        Delivery::Accepted | Delivery::MismatchedAck => 6,
        Delivery::Guest | Delivery::Archived | Delivery::ForeignRoot => 2,
        Delivery::RetiredDuringUpload => 2,
        Delivery::Tampered => 0,
        Delivery::UnusableReceipt | Delivery::RetiredBeforePublish | Delivery::ExtraTag => 3,
        Delivery::RetiredDuringPublish => 5,
    };
    // The author's channel read before the upload or the signature, held
    // until the test has retired the call.
    let hold = match case {
        Delivery::RetiredDuringUpload => Some(2),
        Delivery::RetiredDuringPublish => Some(5),
        _ => None,
    };
    let (held, holding) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = bodies.clone();
    let relay = community.serve_with(expected, move |head, body| {
        let mut seen = recorded.lock().unwrap();
        seen.push(body.to_vec());
        if Some(seen.len()) == hold {
            drop(seen);
            held.send(()).unwrap();
            released.recv().unwrap();
        }
        let answer = if head.starts_with("GET / ") {
            json!({"self":authority})
        } else if head.starts_with("PUT /upload ") {
            let sha = sha256(body);
            let named = if case == Delivery::UnusableReceipt { "0".repeat(64) } else { sha.clone() };
            json!({"url":format!("/media/{named}.mp4"), "sha256":named, "size":body.len(), "type":"video/mp4"})
        } else if head.starts_with("POST /events ") {
            let event: Value = serde_json::from_slice(body).unwrap();
            let id = if case == Delivery::MismatchedAck { json!("1".repeat(64)) } else { event["id"].clone() };
            json!({"accepted":true, "event_id":id})
        } else {
            return crate::federated_identity::testing::reply("200 OK", &readable);
        };
        crate::federated_identity::testing::reply("200 OK", &answer.to_string())
    });
    let dir = tempfile::tempdir().unwrap();
    let tokens = crate::federated_identity::agent::AgentTokens::unconfigured();
    let mut peer = Peer::serving(2).await;
    let mut f = enrolled(&peer);
    f.app.manage(crate::app_agents::AppAgentHost::fixture(
        dir.path(),
        &agent,
        key,
        tokens,
    ));
    let mut request = expecting(&f, &peer);
    request["author"] = json!({"pubkey":agent.pubkey, "relay":agent.relay});
    request["request"]["destination"]["root"] = json!(root_id);
    let (review, terminal, source) = retained_from(&mut f, &mut peer, request, served).await;
    let call = &review["callId"];
    let step = |step: Value| {
        send(
            &f,
            "plugin_host_reviewed_result",
            json!({"id":ID, "revision":f.revision, "parent":{"version":1, "callId":call}, "step":step}),
        )
    };
    let prepared = reply(step(json!({"phase":"prepare", "source":source})))
        .await
        .unwrap()["prepared"]
        .clone();
    let invocations = f.app.state::<Invocations>();
    let (directory, ..) = invocations.prepared(call.as_str().unwrap()).unwrap();
    // Retires while the session, plugin and membership all stay valid.
    let mut stop = Some(async {
        tokio::task::spawn_blocking(move || holding.recv().unwrap())
            .await
            .unwrap();
        invocations.cancel(call.as_str().unwrap());
        release.send(()).unwrap();
        // The retire command's own wait: the worker has finished.
        retire(&f, &review).await;
    });
    if case == Delivery::Tampered {
        let path = directory.join("prepared.mp4");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] ^= 1;
        std::fs::write(&path, bytes).unwrap();
    }
    let upload = reply(step(json!({"phase":"upload"})));
    let uploaded = if case == Delivery::RetiredDuringUpload {
        tokio::join!(upload, stop.take().unwrap()).0
    } else {
        upload.await
    };
    let event = match uploaded {
        Ok(uploaded) => {
            let media = &uploaded["upload"];
            assert_eq!(uploaded["phase"], "uploaded");
            assert_eq!(uploaded["destination"], review["request"]["destination"]);
            assert_eq!(
                (
                    &media["sha256"],
                    &media["size"],
                    &media["type"],
                    &media["dim"]
                ),
                (
                    &prepared["sha256"],
                    &prepared["size"],
                    &json!("video/mp4"),
                    &json!("1280x720")
                ),
                "the prepared file's own facts, not the receipt's"
            );
            // What the JS host builds from this receipt.
            let url = media["url"].as_str().unwrap();
            let mut event = json!({"kind":9, "content":format!("![video.mp4](<{url}>)"), "tags":[
                ["h", "fixture-channel"], ["e", root_id, "", "reply"],
                ["imeta", format!("url {url}"), "m video/mp4", format!("size {}", prepared["size"]),
                    format!("x {}", prepared["sha256"].as_str().unwrap()), "filename video.mp4",
                    format!("dim {}", media["dim"].as_str().unwrap())]]});
            if case == Delivery::ExtraTag {
                event["tags"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(["p", "b".repeat(64)]));
            }
            if case == Delivery::RetiredBeforePublish {
                retire(&f, &review).await;
            }
            let admitted = reply(step(json!({"phase":"publish", "event":event}))).await;
            match admitted {
                Ok(ack) => assert_eq!(ack["phase"], "publishing"),
                Err(_) => assert!(case == Delivery::RetiredBeforePublish),
            }
            if case == Delivery::RetiredDuringPublish {
                stop.take().unwrap().await;
            }
            Some(event)
        }
        Err(_) => None,
    };
    let receipt = reply(terminal).await.unwrap();
    let heads = relay.heads().await;
    assert_eq!(peer.sends(), 2, "one create and one result read");
    // Nothing prepared, uploaded or posted outlives the call.
    assert!(!directory.exists(), "the prepared directory is gone");
    let _successor = invocations.own("after-delivery", ID).unwrap();
    let bodies = bodies.lock().unwrap().clone();
    Delivered {
        agent: agent.pubkey,
        root: root_id,
        prepared,
        event,
        receipt,
        heads,
        bodies,
    }
}

#[test]
fn an_agents_review_posts_its_prepared_media_once_as_that_agent() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let d = deliver(Delivery::Accepted, &served).await;
        let event = d.event.unwrap();
        let posted: Value = serde_json::from_slice(&d.bodies[5]).unwrap();
        assert_eq!(
            d.receipt["delivery"],
            json!({"upload":"uploaded", "status":"posted", "eventId":posted["id"]})
        );
        assert_eq!(
            d.receipt["outcome"], "unknown",
            "the provider task stays unattested"
        );
        assert!(d.heads[2].starts_with("PUT /upload ") && d.heads[5].starts_with("POST /events "));
        assert_eq!(sha256(&d.bodies[2]), d.prepared["sha256"].as_str().unwrap());
        assert_eq!(
            (&posted["pubkey"], &posted["kind"], &posted["content"]),
            (&json!(d.agent), &json!(9), &event["content"])
        );
        let mut expected = event["tags"].as_array().unwrap().clone();
        expected.push(json!(["auth", "fixture-owner", "", "fixture-attestation"]));
        let mut tags = posted["tags"].as_array().unwrap().clone();
        let ms = tags.pop().unwrap();
        assert!(ms[0] == "ms" && ms[1].as_str().unwrap().parse::<u16>().unwrap() < 1000);
        assert_eq!(
            tags, expected,
            "only the signer's attestation and ordering are added"
        );
        eprintln!(
            "DELIVERED pubkey={} event={} h=fixture-channel e={} x={} {}",
            d.agent, posted["id"], d.root, d.prepared["sha256"], event["tags"][2][1]
        );
    });
}

#[test]
fn an_agents_delivery_stops_before_any_effect_it_cannot_stand_behind() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        // Refused before the upload: no PUT, no event.
        for case in [
            Delivery::Guest,
            Delivery::Archived,
            Delivery::ForeignRoot,
            Delivery::Tampered,
            Delivery::RetiredDuringUpload,
        ] {
            let d = deliver(case, &served).await;
            assert_eq!(d.event, None);
            assert_eq!(
                d.receipt["delivery"],
                json!({"upload":"failed", "status":"failed"})
            );
            assert!(d.heads.iter().all(|head| !head.starts_with("PUT ")));
        }
        // Uploaded once, never posted: nothing was signed. An unusable receipt
        // leaves the upload unknown, and nothing replaces it.
        for case in [
            Delivery::UnusableReceipt,
            Delivery::RetiredBeforePublish,
            Delivery::ExtraTag,
            Delivery::RetiredDuringPublish,
        ] {
            let d = deliver(case, &served).await;
            let unusable = case == Delivery::UnusableReceipt;
            assert_eq!(d.event.is_some(), !unusable);
            assert_eq!(
                d.receipt["delivery"],
                json!({"upload":if unusable { "unknown" } else { "uploaded" }, "status":"failed"})
            );
            assert_eq!(
                d.heads
                    .iter()
                    .filter(|head| head.starts_with("PUT /upload "))
                    .count(),
                1
            );
            assert!(d
                .heads
                .iter()
                .all(|head| !head.starts_with("POST /events ")));
        }
        // An unconfirmed post keeps the exact signed ID and is never resent.
        let d = deliver(Delivery::MismatchedAck, &served).await;
        let posted: Value = serde_json::from_slice(&d.bodies[5]).unwrap();
        assert_eq!(
            d.receipt["delivery"],
            json!({"upload":"uploaded", "status":"unknown", "eventId":posted["id"]})
        );
        assert_eq!(
            d.heads
                .iter()
                .filter(|head| head.starts_with("POST /events "))
                .count(),
            1
        );
    });
}

#[test]
fn result_selection_needs_expectations_and_the_exact_retained_source_once() {
    let _serial = crate::host_files::managed_tests::commands();
    tauri::async_runtime::block_on(async {
        let body = b"retained-but-not-media".to_vec();
        let exact = json!({"sha256":sha256(&body), "size":body.len()});
        // Without frozen expectations, selection is refused and keeps the source.
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let read = send_bytes(
            &f,
            &review["callId"],
            json!({"url":peer.url, "maxBytes":1024}),
        );
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", &body);
        fetched(read).await.unwrap();
        assert!(reply(select(&f, &review["callId"], exact.clone()))
            .await
            .is_err());
        let invocations = f.app.state::<Invocations>();
        assert!(invocations
            .source(review["callId"].as_str().unwrap())
            .is_some());
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");

        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let request = expecting(&f, &peer);
        let (review, terminal) = created_from(&mut f, &mut peer, request).await;
        let call = &review["callId"];
        let id = call.as_str().unwrap();
        assert!(
            reply(select(&f, call, exact.clone())).await.is_err(),
            "no source yet"
        );
        let read = send_bytes(&f, call, json!({"url":peer.url, "maxBytes":1024}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", &body);
        fetched(read).await.unwrap();
        let invocations = f.app.state::<Invocations>();
        // Refusals before admission leave the source; extra fields never parse.
        for (command, body) in [
            (
                call.clone(),
                json!({"sha256":sha256(&body), "size":body.len(), "path":"/tmp/x"}),
            ),
            (json!(uuid::Uuid::new_v4().to_string()), exact.clone()),
        ] {
            assert!(reply(select(&f, &command, body)).await.is_err());
        }
        assert!(reply(send(
            &f,
            "plugin_host_reviewed_result",
            json!({"id":ID, "revision":"stale", "parent":{"version":1, "callId":call}, "step":{"phase":"prepare", "source":exact}}),
        ))
        .await
        .is_err());
        assert!(invocations.source(id).is_some());
        // An admitted mismatch consumes the selection: the exact one cannot follow.
        assert!(reply(select(
            &f,
            call,
            json!({"sha256":"0".repeat(64), "size":body.len()})
        ))
        .await
        .is_err());
        assert_eq!(invocations.source(id), None);
        assert!(reply(select(&f, call, exact.clone())).await.is_err());
        assert_eq!(invocations.prepared(id), None);
        assert_eq!(peer.sends(), 2);
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");

        // The original deadline is not renewed by a selection.
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal, source) = retained(&mut f, &mut peer, &body).await;
        let invocations = f.app.state::<Invocations>();
        invocations.spend(
            review["callId"].as_str().unwrap(),
            2,
            tokio::time::Instant::now(),
        );
        assert!(reply(select(&f, &review["callId"], source)).await.is_err());
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        let _successor = invocations.own("after-selections", ID).unwrap();
    });
}

#[cfg(unix)]
#[test]
fn retirement_stops_a_held_preparation_and_removes_its_files_before_a_successor() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let (fake, pid, work) = (
        dir.path().join("ffmpeg"),
        dir.path().join("pid"),
        dir.path().join("work"),
    );
    // Records the private work directory, then holds conversion.
    crate::test_executable::write_executable(
        &fake,
        format!("#!/bin/sh\nfor a; do out=$a; done\ndirname \"$out\" > {work:?}\necho $$ > {pid:?}\nexec sleep 60\n"),
    );
    let _programs = crate::relay::Programs::set(
        fake,
        crate::host_command::resolve_program("ffprobe", &crate::host_command::effective_path()),
    );
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal, source) = retained(&mut f, &mut peer, &served).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let (app, view, revision) = (
            f.app.handle().clone(),
            f.view.as_ref().clone(),
            f.revision.clone(),
        );
        let (parent, selected) = (
            serde_json::from_value(json!({"version":1, "callId":call})).unwrap(),
            serde_json::from_value(json!({"phase":"prepare", "source":source})).unwrap(),
        );
        // The registered command's native body; aborting it closes the reply.
        let waiter =
            tauri::async_runtime::spawn(crate::reviewed_invocation::plugin_host_reviewed_result(
                app,
                view,
                ID.into(),
                revision,
                parent,
                selected,
            ));
        let held = tokio::time::timeout(LIMIT, async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(&pid) {
                    if pid.ends_with('\n') {
                        return pid;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let work = std::path::PathBuf::from(std::fs::read_to_string(&work).unwrap().trim());
        assert!(work.join("source.mp4").exists());
        waiter.abort();
        assert!(waiter.await.is_err());
        let alive = || {
            std::process::Command::new("/bin/kill")
                .args(["-0", held.trim()])
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        let invocations = f.app.state::<Invocations>();
        assert!(
            alive(),
            "a closed waiter does not cancel the original owner"
        );
        assert!(invocations.own("while-preparing", ID).is_err());
        assert!(
            reply(parent_get(&f, &review["callId"], json!({"url":peer.url})))
                .await
                .is_err()
        );
        retire(&f, &review).await;
        assert!(!alive(), "the conversion was stopped and reaped");
        assert!(
            !work.exists(),
            "files removed before retirement was acknowledged"
        );
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.prepared(&call), None);
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-held-preparation", ID).unwrap();
    });
}

/// The private work directory of a strict source write held before writing.
async fn held_write(gate: &mut crate::relay::WriteGate) -> std::path::PathBuf {
    let source = tokio::time::timeout(LIMIT, &mut gate.entered)
        .await
        .unwrap()
        .unwrap();
    assert!(!source.exists(), "held before the write");
    source.parent().unwrap().to_owned()
}

#[cfg(unix)]
#[test]
fn retirement_joins_a_held_source_write_before_removing_files_and_a_successor() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal, source) = retained(&mut f, &mut peer, &served).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let mut gate = crate::relay::WriteGate::arm();
        let selected = select(&f, &review["callId"], source);
        let work = held_write(&mut gate).await;
        let invocations = f.app.state::<Invocations>();
        let retiring = send(&f, "plugin_host_reviewed_retire", json!({"callId":call}));
        let mut retired = tokio::task::spawn_blocking(move || retiring.recv_timeout(LIMIT));
        // No timing guess: retirement must reach the join of the still-held write
        // before it can be acknowledged.
        tokio::select! { biased;
            joined = &mut gate.joined => joined.expect("the held write was dropped, not joined"),
            _ = &mut retired => panic!("retirement finished before the held write was joined"),
        }
        assert!(
            !retired.is_finished(),
            "retirement waits for the held write"
        );
        assert!(
            matches!(terminal.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "the original owner is unfinished"
        );
        assert!(invocations.own("while-write-held", ID).is_err());
        assert!(work.exists(), "files stay until the write is joined");
        gate.release();
        retired.await.unwrap().unwrap().unwrap();
        assert!(
            !work.exists(),
            "files removed before retirement was acknowledged"
        );
        assert!(reply(selected).await.is_err());
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert_eq!(invocations.prepared(&call), None);
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-held-write", ID).unwrap();
    });
}

#[cfg(unix)]
#[test]
fn the_deadline_during_a_held_source_write_joins_it_before_removing_files_and_a_successor() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let mut request = expecting(&f, &peer);
        let channel = format!("deadline-{}", uuid::Uuid::new_v4());
        request["request"]["destination"]["channel"] = json!(channel);
        let window = std::time::Duration::from_secs(3);
        *crate::reviewed_invocation::TEST_WINDOW.lock().unwrap() = Some((channel, window));
        let opened = tokio::time::Instant::now();
        let (review, terminal, source) = retained_from(&mut f, &mut peer, request, &served).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let mut gate = crate::relay::WriteGate::arm();
        let selected = select(&f, &review["callId"], source);
        let work = held_write(&mut gate).await;
        // The worker's deadline is later than opened + window.
        assert!(opened.elapsed() < window, "held before the deadline");
        tokio::time::timeout(LIMIT, &mut gate.joined)
            .await
            .expect("the deadline joins the held write")
            .expect("the held write was dropped, not joined");
        let invocations = f.app.state::<Invocations>();
        assert!(
            matches!(terminal.try_recv(), Err(mpsc::TryRecvError::Empty)),
            "the original owner is unfinished"
        );
        assert!(invocations.own("while-deadline-write-held", ID).is_err());
        assert!(work.exists(), "files stay until the write is joined");
        gate.release();
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert!(!work.exists(), "files removed before the owner finished");
        assert!(reply(selected).await.is_err());
        assert_eq!(invocations.prepared(&call), None);
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-deadline", ID).unwrap();
    });
}

#[cfg(unix)]
#[test]
fn a_fence_refused_prepared_commit_is_discarded_before_a_successor() {
    let _serial = crate::host_files::managed_tests::commands();
    let _conversions = crate::relay::CONVERSIONS.blocking_lock();
    let Some(served) = served_media() else {
        return;
    };
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal, source) = retained(&mut f, &mut peer, &served).await;
        let call = review["callId"].as_str().unwrap().to_owned();
        let mut gate = crate::relay::WriteGate::arm();
        let selected = select(&f, &review["callId"], source.clone());
        let work = held_write(&mut gate).await;
        // The page changes while the write is held; the real preparation then
        // completes and its commit's fence refuses.
        f.app.state::<crate::host_request::HostCalls>().page_load();
        gate.release();
        assert_eq!(
            reply(selected).await.unwrap_err(),
            json!(REFUSED_REPLY).to_string()
        );
        let invocations = f.app.state::<Invocations>();
        assert_eq!(invocations.prepared(&call), None);
        assert_eq!(
            invocations.source(&call),
            None,
            "the selection was consumed"
        );
        assert!(reply(select(&f, &review["callId"], source)).await.is_err());
        assert!(invocations.own("after-refused-commit", ID).is_err());
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        assert!(!work.exists(), "files removed before the owner finished");
        assert_eq!(peer.sends(), 2);
        let _successor = invocations.own("after-refused-commit", ID).unwrap();
    });
}

/// The fixture's files whose name `matches`.
fn find_files(f: &Fixture, matches: &dyn Fn(&str) -> bool) -> Vec<std::path::PathBuf> {
    fn find(dir: &std::path::Path, matches: &dyn Fn(&str) -> bool) -> Vec<std::path::PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                found.extend(find(&path, matches));
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(matches)
            {
                found.push(path);
            }
        }
        found
    }
    find(f.root.path(), matches)
}

trait Holding {}
impl<T> Holding for T {}
/// The four try-locks a parent read's fence takes, in fence order.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Holder {
    Identity,
    Registry,
    State,
    Namespace,
}
const HOLDERS: [Holder; 4] = [
    Holder::Identity,
    Holder::Registry,
    Holder::State,
    Holder::Namespace,
];
fn lock_path(f: &Fixture, holder: Holder) -> std::path::PathBuf {
    let [path] = find_files(f, &|name| match holder {
        Holder::Registry => name == "registry.lock",
        Holder::State => name == "state.lock",
        Holder::Namespace => name.starts_with("ns-") && name.ends_with(".lock"),
        Holder::Identity => unreachable!(),
    })
    .try_into()
    .unwrap();
    path
}
/// Holds one metadata lock file, as another writer would.
fn lock_file(f: &Fixture, holder: Holder) -> std::fs::File {
    let file = std::fs::File::open(lock_path(f, holder)).unwrap();
    file.try_lock().unwrap();
    file
}
fn hold(f: &Fixture, holder: Holder) -> Box<dyn Holding + '_> {
    match holder {
        Holder::Identity => Box::new(f.app.state::<IdentityHost>().inner().held()),
        _ => Box::new(lock_file(f, holder)),
    }
}
type Release = tokio::sync::oneshot::Sender<()>;
/// Every busy attempt of `call` now waits for the test's release.
fn arm(call: &str) -> tokio::sync::mpsc::UnboundedReceiver<Release> {
    let (gate, gated) = tokio::sync::mpsc::unbounded_channel();
    crate::reviewed_invocation::BUSY_GATES
        .lock()
        .unwrap()
        .get_or_insert_default()
        .insert(call.into(), gate);
    gated
}
async fn gated(gated: &mut tokio::sync::mpsc::UnboundedReceiver<Release>) -> Release {
    tokio::time::timeout(LIMIT, gated.recv())
        .await
        .expect("the read met the held lock")
        .unwrap()
}

#[test]
fn a_parent_read_waits_out_a_held_lock_then_sends_once() {
    tauri::async_runtime::block_on(async {
        for holder in HOLDERS {
            let mut peer = Peer::serving(2).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            let mut gate = arm(call);
            let held = hold(&f, holder);
            let url = peer.url.to_string();
            let observe = async {
                let release = gated(&mut gate).await;
                // Waiting outside every guard: nothing sent or admitted, and
                // the entry and each lock the test does not hold are free.
                assert_eq!(peer.sends(), 1, "{holder:?}");
                assert!(f.app.state::<Invocations>().live(call), "{holder:?}");
                for free in [Holder::Registry, Holder::State, Holder::Namespace] {
                    if free != holder {
                        drop(lock_file(&f, free));
                    }
                }
                drop(held);
                release.send(()).unwrap();
                tokio::time::timeout(LIMIT, peer.requests.recv())
                    .await
                    .unwrap()
                    .unwrap();
                peer.respond(200, "", br#"{"status":"RUNNING"}"#);
            };
            let (read, ()) = tokio::join!(direct_read(&f, &url, call, LIMIT), observe);
            let read = read.unwrap();
            assert_eq!(
                json!(read.parent.unwrap())["sequence"],
                2,
                "{holder:?}: the next read"
            );
            assert_eq!(peer.sends(), 2, "{holder:?}: exactly one GET after release");
            retire(&f, &review).await;
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

#[test]
fn a_lock_held_past_either_end_refuses_without_a_late_send() {
    tauri::async_runtime::block_on(async {
        for (holder, parent_first) in HOLDERS.into_iter().flat_map(|h| [(h, false), (h, true)]) {
            let mut peer = Peer::serving(2).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            let window = Duration::from_millis(if parent_first { 500 } else { 60_000 });
            f.app
                .state::<Invocations>()
                .spend(call, 0, tokio::time::Instant::now() + window);
            let held = hold(&f, holder);
            // The read's own end is first unless the parent window closes first.
            let wait = if parent_first {
                LIMIT
            } else {
                Duration::from_millis(200)
            };
            let refused = direct_read(&f, peer.url.as_str(), call, wait).await;
            drop(held);
            let expected = if parent_first {
                "native-admission"
            } else {
                "native-timeout"
            };
            assert_eq!(
                refused.unwrap_err(),
                format!("host-parent-read/v1/{expected}"),
                "{holder:?}"
            );
            assert_eq!(peer.sends(), 1, "{holder:?}: nothing sent while held");
            if parent_first {
                assert_eq!(
                    reply(parent_get(&f, &review["callId"], json!({"url":peer.url})))
                        .await
                        .unwrap_err(),
                    code("native-admission"),
                    "{holder:?}: the closed window admits nothing later"
                );
                retire(&f, &review).await;
                assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
                assert_eq!(peer.sends(), 1, "{holder:?}: no late dispatch");
                continue;
            }
            // Nothing was admitted: the next read is the first, and the only send.
            let next = parent_get(&f, &review["callId"], json!({"url":peer.url}));
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .unwrap()
                .unwrap();
            peer.respond(200, "", b"{}");
            assert_eq!(reply(next).await.unwrap()["parent"]["sequence"], 2);
            assert_eq!(peer.sends(), 2, "{holder:?}: no late dispatch");
            retire(&f, &review).await;
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

#[test]
fn a_registered_read_honors_its_end_while_the_registry_is_held() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(2).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        // Held well past the read's end; the registered command, not
        // `direct_read`, so every check ahead of the fence is exercised.
        let held = hold(&f, Holder::Registry);
        let entered = std::time::Instant::now();
        let pending = parent_get(
            &f,
            &review["callId"],
            json!({"url":peer.url, "timeoutMs":200}),
        );
        let refused =
            tokio::task::spawn_blocking(move || pending.recv_timeout(Duration::from_secs(2)))
                .await
                .unwrap()
                .expect("the read returns at its end while the registry is held");
        assert_eq!(refused.unwrap_err(), code("native-timeout"));
        assert!(entered.elapsed() < Duration::from_secs(2));
        assert_eq!(peer.sends(), 1, "nothing sent while held");
        drop(held);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            peer.sends(),
            1,
            "no late GET after the registry is released"
        );
        // Nothing was admitted: the next read is the first, and the only send.
        let next = parent_get(&f, &review["callId"], json!({"url":peer.url}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", b"{}");
        assert_eq!(reply(next).await.unwrap()["parent"]["sequence"], 2);
        assert_eq!(peer.sends(), 2);
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
    });
}

#[test]
fn a_real_change_while_a_parent_read_waits_refuses_and_sends_nothing() {
    tauri::async_runtime::block_on(async {
        for (holder, change) in [
            (Holder::Identity, "page"),
            (Holder::Identity, "replace"),
            (Holder::Identity, "disable"),
            (Holder::Identity, "retire"),
            (Holder::Namespace, "page"),
            (Holder::Registry, "retire"),
        ] {
            let mut peer = Peer::serving(2).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            let viewer = review["request"]["destination"]["viewer"]
                .as_str()
                .unwrap()
                .to_owned();
            let mut gate = arm(call);
            let held = hold(&f, holder);
            let observe = async {
                let release = gated(&mut gate).await;
                match change {
                    "page" => f.app.state::<crate::host_request::HostCalls>().page_load(),
                    "replace" => f
                        .manager
                        .secret_set(ID, &f.revision, "key", &viewer, "replacement", &|| true)
                        .unwrap(),
                    "disable" => {
                        f.manager.change("disable", ID).unwrap();
                    }
                    "retire" => retire(&f, &review).await,
                    _ => unreachable!(),
                }
                drop(held);
                release.send(()).unwrap();
            };
            let (refused, ()) =
                tokio::join!(direct_read(&f, peer.url.as_str(), call, LIMIT), observe);
            // A disabled parent is gone, like a retired one; the rest changed a live fence.
            let expected = match change {
                "retire" | "disable" => "native-admission",
                _ => "native-fence",
            };
            assert_eq!(
                refused.unwrap_err(),
                format!("host-parent-read/v1/{expected}"),
                "{holder:?} {change}"
            );
            assert_eq!(peer.sends(), 1, "{holder:?} {change}: nothing sent");
            if change != "retire" {
                retire(&f, &review).await;
            }
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

#[test]
fn poisoned_or_malformed_fence_state_is_refused_without_waiting() {
    tauri::async_runtime::block_on(async {
        for damage in ["poisoned", "state", "lock"] {
            let mut peer = Peer::serving(1).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            let mut gate = arm(call);
            match damage {
                "poisoned" => f.app.state::<IdentityHost>().poison(),
                "state" => {
                    let [state] = find_files(&f, &|name| name == "state.json")
                        .try_into()
                        .unwrap();
                    std::fs::write(state, b"{").unwrap();
                }
                "lock" => {
                    let lock = lock_path(&f, Holder::Namespace);
                    std::fs::remove_file(&lock).unwrap();
                    std::fs::create_dir(&lock).unwrap();
                }
                _ => unreachable!(),
            }
            assert_eq!(
                // An armed gate holds any busy wait, so only a terminal refusal returns.
                tokio::time::timeout(LIMIT, direct_read(&f, peer.url.as_str(), call, 2 * LIMIT))
                    .await
                    .expect("terminal, never waited")
                    .unwrap_err(),
                "host-parent-read/v1/native-fence",
                "{damage}"
            );
            assert!(gate.try_recv().is_err(), "{damage}: terminal, never waited");
            assert_eq!(peer.sends(), 1, "{damage}: nothing sent");
            retire(&f, &review).await;
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

/// Holds `call`'s admission at its last check before enqueue; dropping it
/// releases and removes the gate.
struct EnqueueGate(String, std::sync::Arc<read_gates::Enqueue>);
impl EnqueueGate {
    fn arm(call: &str) -> Self {
        let gate = std::sync::Arc::<read_gates::Enqueue>::default();
        read_gates::ENQUEUE
            .lock()
            .unwrap()
            .get_or_insert_default()
            .insert(call.into(), gate.clone());
        Self(call.into(), gate)
    }
}
impl Drop for EnqueueGate {
    fn drop(&mut self) {
        self.1.release();
        if let Some(gates) = read_gates::ENQUEUE.lock().unwrap().as_mut() {
            gates.remove(&self.0);
        }
    }
}
/// Holds `call`'s worker before it dispatches a text read, and reports each
/// finished one; dropping it removes the gate, releasing any held dispatch.
struct WorkerGate(String);
impl WorkerGate {
    fn arm(
        call: &str,
    ) -> (
        Self,
        tokio::sync::mpsc::UnboundedReceiver<(Release, tokio::time::Instant)>,
        tokio::sync::mpsc::UnboundedReceiver<()>,
    ) {
        let (dispatch, dispatched) = tokio::sync::mpsc::unbounded_channel();
        let (finished, done) = tokio::sync::mpsc::unbounded_channel();
        read_gates::WORKER
            .lock()
            .unwrap()
            .get_or_insert_default()
            .insert(call.into(), read_gates::Worker { dispatch, finished });
        (Self(call.into()), dispatched, done)
    }
}
impl Drop for WorkerGate {
    fn drop(&mut self) {
        if let Some(gates) = read_gates::WORKER.lock().unwrap().as_mut() {
            gates.remove(&self.0);
        }
    }
}
/// A read answered with a selectable result, so the parent holds a selection.
async fn with_selection(f: &Fixture, peer: &mut Peer, call: &Value) {
    let body = json!({"status":"SUCCEEDED", "output":[named(peer, "/v/1")]}).to_string();
    let read = observed(f, peer, call, 200, &body).await.unwrap();
    assert_eq!(read["parent"]["sequence"], 2);
    let id = call.as_str().unwrap();
    assert_eq!(f.app.state::<Invocations>().reads(id), (1, false, Some(2)));
}

#[test]
fn admission_that_outlasts_either_end_enqueues_nothing() {
    tauri::async_runtime::block_on(async {
        for parent_first in [false, true] {
            let mut peer = Peer::serving(3).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            with_selection(&f, &mut peer, &review["callId"]).await;
            let invocations = f.app.state::<Invocations>();
            let window = tokio::time::Instant::now() + Duration::from_millis(300);
            let (wait, deadline) = if parent_first {
                invocations.spend(call, 1, window);
                (LIMIT, Some(window))
            } else {
                (Duration::from_millis(200), None)
            };
            let gate = EnqueueGate::arm(call);
            let held = gate.1.clone();
            // Admission is held, fences and all, until the first end has passed.
            let observer = std::thread::spawn(move || {
                let end = held
                    .entered(LIMIT)
                    .expect("admission reached its last check");
                let first = deadline.map_or(end, |deadline| deadline.min(end));
                std::thread::sleep(first.saturating_duration_since(tokio::time::Instant::now()));
                assert!(tokio::time::Instant::now() >= first);
                held.release();
            });
            let refused = direct_read(&f, peer.url.as_str(), call, wait).await;
            observer.join().unwrap();
            drop(gate);
            let expected = if parent_first {
                "native-admission"
            } else {
                "native-timeout"
            };
            assert_eq!(
                refused.unwrap_err(),
                format!("host-parent-read/v1/{expected}")
            );
            assert_eq!(peer.sends(), 2, "{expected}: nothing sent");
            assert_eq!(
                invocations.reads(call),
                (1, false, Some(2)),
                "{expected}: nothing consumed, the selection kept"
            );
            if !parent_first {
                // The next read is the one the refused attempt would have been.
                let next = parent_get(&f, &review["callId"], json!({"url":peer.url}));
                tokio::time::timeout(LIMIT, peer.requests.recv())
                    .await
                    .unwrap()
                    .unwrap();
                peer.respond(200, "", b"{}");
                assert_eq!(reply(next).await.unwrap()["parent"]["sequence"], 3);
            }
            retire(&f, &review).await;
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

#[test]
fn a_text_read_dequeued_after_its_end_is_never_sent() {
    tauri::async_runtime::block_on(async {
        // Released once the caller has timed out, then as soon as the end has passed.
        for at_end in [false, true] {
            let mut peer = Peer::serving(3).await;
            let mut f = enrolled(&peer);
            let (review, terminal) = created(&mut f, &mut peer).await;
            let call = review["callId"].as_str().unwrap();
            with_selection(&f, &mut peer, &review["callId"]).await;
            let invocations = f.app.state::<Invocations>();
            let (gate, mut dispatched, mut done) = WorkerGate::arm(call);
            let held = async {
                let (release, end) = tokio::time::timeout(LIMIT, dispatched.recv())
                    .await
                    .expect("the worker dequeued the read")
                    .unwrap();
                assert_eq!(invocations.reads(call), (2, true, None), "admitted");
                if !at_end {
                    return Some(release);
                }
                std::thread::sleep(end.saturating_duration_since(tokio::time::Instant::now()));
                assert!(tokio::time::Instant::now() >= end);
                release.send(()).unwrap();
                None
            };
            let (refused, release) = tokio::join!(
                direct_read(&f, peer.url.as_str(), call, Duration::from_millis(200)),
                held
            );
            assert_eq!(
                refused.unwrap_err(),
                "host-parent-read/v1/native-timeout",
                "at end: {at_end}"
            );
            if let Some(release) = release {
                release.send(()).unwrap();
            }
            tokio::select! { biased;
                _ = peer.requests.recv() => panic!("at end: {at_end}: dispatched after its end"),
                finished = tokio::time::timeout(LIMIT, done.recv()) => finished.expect("the worker finished it").unwrap(),
            }
            assert_eq!(peer.sends(), 2, "at end: {at_end}: no late GET");
            assert_eq!(
                invocations.reads(call),
                (2, false, None),
                "at end: {at_end}: consumed once, cleared, nothing selected"
            );
            drop(gate);
            let next = parent_get(&f, &review["callId"], json!({"url":peer.url}));
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .unwrap()
                .unwrap();
            peer.respond(200, "", b"{}");
            assert_eq!(reply(next).await.unwrap()["parent"]["sequence"], 4);
            retire(&f, &review).await;
            assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
        }
    });
}

#[test]
fn a_held_response_ends_at_the_read_end_not_the_later_transport_cap() {
    tauri::async_runtime::block_on(async {
        let mut peer = Peer::serving(4).await;
        let mut f = enrolled(&peer);
        let (review, terminal) = created(&mut f, &mut peer).await;
        let call = review["callId"].as_str().unwrap();
        with_selection(&f, &mut peer, &review["callId"]).await;
        let invocations = f.app.state::<Invocations>();
        let (gate, mut dispatched, mut done) = WorkerGate::arm(call);
        let url = peer.url.to_string();
        let wait = Duration::from_millis(1500);
        // Dispatched well before the end, so the transport cap taken at
        // admission runs about a second past it.
        let held = async {
            let (release, end) = tokio::time::timeout(LIMIT, dispatched.recv())
                .await
                .expect("the worker dequeued the read")
                .unwrap();
            let gated_at = tokio::time::Instant::now();
            tokio::time::sleep_until(end - Duration::from_millis(500)).await;
            let released_at = tokio::time::Instant::now();
            release.send(()).unwrap();
            tokio::time::timeout(LIMIT, peer.requests.recv())
                .await
                .expect("sent before its end")
                .unwrap();
            assert!(
                tokio::time::Instant::now() < end,
                "in flight before its end"
            );
            // Admission preceded the gate, so the relative cap ends no earlier than this.
            (end, released_at + (end - gated_at))
        };
        let (refused, (end, transport_floor)) =
            tokio::join!(direct_read(&f, &url, call, wait), held);
        assert_eq!(refused.unwrap_err(), "host-parent-read/v1/native-timeout");
        // Not retired: only the read's own end can finish it this early.
        tokio::time::timeout(LIMIT, done.recv())
            .await
            .expect("the worker finished it")
            .unwrap();
        let finished = tokio::time::Instant::now();
        eprintln!(
            "held-response smoke: finished {:?} after the read end; transport floor {:?} after it",
            finished - end,
            transport_floor - end
        );
        assert!(finished >= end);
        assert!(
            finished + Duration::from_millis(500) < transport_floor,
            "ended at the read end, well before the transport cap"
        );
        assert!(invocations.live(call), "never retired");
        assert_eq!(peer.sends(), 3, "no retry");
        assert_eq!(
            invocations.reads(call),
            (2, false, None),
            "consumed once, cleared, nothing selected"
        );
        // The withheld response arrives after the worker let go of it.
        let stale = json!({"status":"SUCCEEDED", "output":[named(&peer, "/v/stale")]}).to_string();
        peer.respond(200, "", stale.as_bytes());
        drop(gate);
        let next = parent_get(&f, &review["callId"], json!({"url":peer.url}));
        tokio::time::timeout(LIMIT, peer.requests.recv())
            .await
            .unwrap()
            .unwrap();
        peer.respond(200, "", b"{}");
        assert_eq!(reply(next).await.unwrap()["parent"]["sequence"], 4);
        assert_eq!(peer.sends(), 4);
        assert_eq!(
            invocations.reads(call),
            (3, false, None),
            "the stale response selected nothing"
        );
        retire(&f, &review).await;
        assert_eq!(reply(terminal).await.unwrap()["outcome"], "unknown");
    });
}
