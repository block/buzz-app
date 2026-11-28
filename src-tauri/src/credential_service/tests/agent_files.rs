use super::*;

/// The agent call the page was asked, once it was.
async fn forwarded(
    notices: &Arc<Mutex<Vec<Notice>>>,
) -> crate::credential_service::agent_files::AgentCall {
    for _ in 0..200 {
        let found = notices
            .lock()
            .unwrap()
            .iter()
            .find_map(|notice| match notice {
                Notice::Agent(call) => Some(call.clone()),
                _ => None,
            });
        if let Some(call) = found {
            return call;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no agent call reached the page");
}

#[tokio::test]
async fn an_agent_can_neither_see_nor_call_the_agent_file_methods() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let described = ask(&fixture, &token, "describe", &[]).await;
    let methods = described.1["result"].as_str().unwrap();
    assert!(!methods.contains("agent_read"), "{methods}");
    assert!(!methods.contains("agent_apply"), "{methods}");
    fixture.service.0.agent_calls.listen(true);
    for (method, params) in [
        ("agent_read", &[""][..]),
        ("agent_apply", &["", "{}", "", "{}"]),
    ] {
        let reply = ask(&fixture, &token, method, params).await;
        assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"), "{method}");
    }
    assert!(fixture.notices.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_paired_tool_reads_through_the_page() {
    let fixture = fixture();
    let token = pairing::paired(&fixture).await;
    let reply = ask(&fixture, &token, "agent_read", &["bot"]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );

    fixture.service.0.agent_calls.listen(true);
    let service = fixture.service.clone();
    let reading = tokio::spawn(async move {
        let body = json!({ "id": "1", "method": "agent_read", "params": ["bot"] }).to_string();
        respond(&service, Some(&token), Some(1), body.as_bytes(), None).await
    });
    let call = forwarded(&fixture.notices).await;
    assert_eq!(
        (call.method, call.params.as_slice()),
        ("agent_read", &["bot".to_owned()][..])
    );
    fixture
        .service
        .0
        .agent_calls
        .answer(&call.id, Ok("{\"revision\":\"r\"}".into()));
    let (status, reply) = reading.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{reply}");
    assert_eq!(reply["result"], "{\"revision\":\"r\"}");
}

#[tokio::test]
async fn a_stale_apply_is_a_conflict_and_closes_its_prompt() {
    let fixture = fixture();
    let token = pairing::paired(&fixture).await;
    fixture.service.0.agent_calls.listen(true);
    let service = fixture.service.clone();
    let applying = tokio::spawn(async move {
        let body = json!({ "id": "1", "method": "agent_apply", "params": ["", "{}", "", "{}"] })
            .to_string();
        respond(&service, Some(&token), Some(1), body.as_bytes(), None).await
    });
    let call = forwarded(&fixture.notices).await;
    assert_eq!(
        call.expires_in,
        crate::credential_service::pairing::APPROVAL.as_secs()
    );
    fixture
        .service
        .0
        .agent_calls
        .answer(&call.id, Err(("conflict".into(), "It changed".into())));
    let reply = applying.await.unwrap();
    assert_eq!(error(&reply), (StatusCode::CONFLICT, "conflict"));
    // Answered calls are forgotten without closing anything twice.
    assert!(!fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::AgentClosed(_))));
}
