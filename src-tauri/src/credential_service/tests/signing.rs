use super::pairing::paired;
use super::*;
use crate::credential_service::pairing::{Answer, SignRequest};

const LEAVE: u16 = 9022;

fn leave() -> String {
    unsigned(LEAVE, json!([["h", "channel"]]), now())
}

fn sign_requests(fixture: &Fixture) -> Vec<SignRequest> {
    fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .filter_map(|notice| match notice {
            Notice::SignAsk(request) => Some(request.clone()),
            _ => None,
        })
        .collect()
}

fn closed(fixture: &Fixture, id: &str) -> bool {
    fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::SignClosed(closed) if closed == id))
}

/// The signature request the page was asked about and has not closed.
async fn sign_asked(fixture: &Fixture) -> SignRequest {
    for _ in 0..200 {
        let open = sign_requests(fixture)
            .into_iter()
            .rev()
            .find(|request| !closed(fixture, &request.id));
        if let Some(request) = open {
            return request;
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no signature request reached the page");
}

fn sign(
    fixture: &Fixture,
    token: &str,
    event: String,
) -> tokio::task::JoinHandle<(StatusCode, Value)> {
    let service = fixture.service.clone();
    let body = json!({ "id": "1", "method": "sign_event", "params": [event] }).to_string();
    let token = token.to_owned();
    tokio::spawn(
        async move { respond(&service, Some(&token), Some(1), body.as_bytes(), None).await },
    )
}

fn signed(reply: &(StatusCode, Value)) -> Value {
    assert_eq!(reply.0, StatusCode::OK, "{}", reply.1);
    serde_json::from_str(reply.1["result"].as_str().unwrap()).unwrap()
}

async fn pairing_id(fixture: &Fixture) -> String {
    let listed = serde_json::to_value(fixture.service.0.pairings.list().await.unwrap()).unwrap();
    listed[0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_sensitive_kind_is_signed_once_the_human_allows_it() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    assert_eq!(request.kind, LEAVE);
    assert_eq!(
        request.tags,
        vec![vec!["h".to_owned(), "channel".to_owned()]]
    );
    assert_eq!(request.client, "buzz-cli");
    assert_eq!(request.relay, RELAY);
    assert_eq!(request.pairing, pairing_id(&fixture).await);
    assert_eq!((request.expires_in, request.window_seconds), (120, 300));
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Once);
    let event = signed(&pending.await.unwrap());
    assert_eq!(event["kind"], LEAVE);
    assert_eq!(
        event["pubkey"],
        IdentityHost::fixture().viewer().await.unwrap()
    );
    assert!(closed(&fixture, &request.id));
    // Once allows only that one.
    let again = sign(&fixture, &token, leave());
    let next = sign_asked(&fixture).await;
    assert_ne!(next.id, request.id);
    fixture
        .service
        .0
        .pairings
        .answer_signature(&next.id, Answer::Deny);
    again.await.unwrap();
}

#[tokio::test]
async fn a_declined_signature_is_denied_and_closes_its_prompt() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Deny);
    let reply = pending.await.unwrap();
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert_eq!(reply.1["message"], "Declined in Buzz");
    assert!(closed(&fixture, &request.id));
    // A late or stale answer does nothing.
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Once);
}

#[tokio::test]
async fn a_window_allows_that_kind_from_that_tool_until_stopped() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Window);
    signed(&pending.await.unwrap());
    let listed = serde_json::to_value(fixture.service.0.pairings.list().await.unwrap()).unwrap();
    assert_eq!(listed[0]["windows"][0]["kind"], LEAVE);
    let until = listed[0]["windows"][0]["until"].as_u64().unwrap();
    assert!((now() + 299..=now() + 300).contains(&until), "{until}");
    // A lapsed window is not listed.
    let after = serde_json::to_value(fixture.service.0.pairings.windows_of(&id, until)).unwrap();
    assert_eq!(after, json!([]));
    // The same kind signs without asking, as often as it is asked for.
    for _ in 0..3 {
        signed(&ask(&fixture, &token, "sign_event", &[&leave()]).await);
    }
    assert_eq!(sign_requests(&fixture).len(), 1);
    // Another sensitive kind still asks.
    let delete = sign(
        &fixture,
        &token,
        unsigned(9005, json!([["h", "channel"]]), now()),
    );
    let other = sign_asked(&fixture).await;
    assert_eq!(other.kind, 9005);
    fixture
        .service
        .0
        .pairings
        .answer_signature(&other.id, Answer::Once);
    signed(&delete.await.unwrap());
    // Stopped, it asks again.
    fixture.notices.lock().unwrap().clear();
    fixture.service.0.pairings.stop_window(&id, LEAVE);
    assert!(fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Changed)));
    let listed = serde_json::to_value(fixture.service.0.pairings.list().await.unwrap()).unwrap();
    assert_eq!(listed[0]["windows"], json!([]));
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Deny);
    assert_eq!(error(&pending.await.unwrap()).1, "denied");
}

#[tokio::test]
async fn a_window_is_only_for_the_tool_it_was_allowed_for() {
    let fixture = fixture();
    let first = paired(&fixture).await;
    let pending = sign(&fixture, &first, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Window);
    signed(&pending.await.unwrap());
    let second = paired(&fixture).await;
    let pending = sign(&fixture, &second, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Deny);
    assert_eq!(error(&pending.await.unwrap()).1, "denied");
}

#[tokio::test]
async fn revoking_a_pairing_ends_its_windows_and_its_waiting_signature() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Window);
    signed(&pending.await.unwrap());
    let pending = sign(&fixture, &token, unsigned(9005, json!([]), now()));
    let waiting = sign_asked(&fixture).await;
    fixture.service.0.pairings.revoke(&id).await.unwrap();
    let reply = pending.await.unwrap();
    assert_eq!(reply.0, StatusCode::UNAUTHORIZED, "{}", reply.1);
    assert!(closed(&fixture, &waiting.id));
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn revoking_every_pairing_ends_every_window() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Window);
    signed(&pending.await.unwrap());
    fixture.service.0.pairings.clear().await.unwrap();
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn nothing_is_asked_while_no_signature_prompt_is_mounted() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    fixture.service.0.pairings.sign_prompt(false);
    fixture.service.0.pairings.sign_prompt(false);
    let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&reply),
        (StatusCode::SERVICE_UNAVAILABLE, "unavailable")
    );
    assert!(sign_requests(&fixture).is_empty());
}

#[tokio::test]
async fn a_new_page_declines_the_signature_it_never_saw() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture.service.0.pairings.page_load();
    assert_eq!(error(&pending.await.unwrap()).1, "denied");
    assert!(closed(&fixture, &request.id));
}

#[tokio::test]
async fn one_signature_waits_at_a_time() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let first = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    let second = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&second),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert_eq!(second.1["retry_after"], 5);
    fixture
        .service
        .0
        .pairings
        .answer_signature(&request.id, Answer::Deny);
    first.await.unwrap();
}

#[tokio::test]
async fn an_unanswered_signature_needs_approval_and_closes_its_prompt() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    // Paused only now, as for pairing: the human's key is read off this runtime.
    tokio::time::pause();
    let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "approval_required"));
    let request = sign_requests(&fixture).pop().unwrap();
    assert!(closed(&fixture, &request.id));
    // Unanswered, it waits before asking again.
    let again = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&again),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert_eq!(sign_requests(&fixture).len(), 1);
}

#[tokio::test]
async fn an_agent_is_never_asked_for_a_sensitive_kind() {
    let fixture = fixture();
    let (_issued, token) = bound(&fixture).await;
    let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert!(reply.1["message"]
        .as_str()
        .unwrap()
        .contains("can't be signed by a local tool"));
    assert!(sign_requests(&fixture).is_empty());
}

#[tokio::test]
async fn an_unknown_kind_is_denied_without_asking() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let reply = ask(
        &fixture,
        &token,
        "sign_event",
        &[&unsigned(4, json!([]), now())],
    )
    .await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert!(sign_requests(&fixture).is_empty());
}

fn answer(fixture: &Fixture, id: &str, answer: Answer) {
    fixture.service.0.pairings.answer_signature(id, answer);
}

#[tokio::test]
async fn a_kind_allowed_only_once_offers_no_window_and_begins_none() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let delete = || unsigned(9008, json!([["h", "channel"]]), now());
    let pending = sign(&fixture, &token, delete());
    let request = sign_asked(&fixture).await;
    assert_eq!(request.window_seconds, 0);
    // A window asked for anyway allows only this one.
    answer(&fixture, &request.id, Answer::Window);
    signed(&pending.await.unwrap());
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
    let pending = sign(&fixture, &token, delete());
    let next = sign_asked(&fixture).await;
    assert_ne!(next.id, request.id);
    answer(&fixture, &next.id, Answer::Once);
    signed(&pending.await.unwrap());
}

/// Allows leaves from `token`'s pairing for a while.
async fn window(fixture: &Fixture, token: &str) {
    let pending = sign(fixture, token, leave());
    let request = sign_asked(fixture).await;
    assert_eq!(request.window_seconds, 300);
    answer(fixture, &request.id, Answer::Window);
    signed(&pending.await.unwrap());
}

#[tokio::test]
async fn removing_the_community_ends_its_windows_and_refuses_its_asks() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    window(&fixture, &token).await;
    fixture.notices.lock().unwrap().clear();
    fixture.service.0.pairings.set_communities(Vec::new()).await;
    assert!(fixture
        .notices
        .lock()
        .unwrap()
        .iter()
        .any(|notice| matches!(notice, Notice::Changed)));
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
    let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply), (StatusCode::FORBIDDEN, "denied"));
    assert!(reply.1["message"]
        .as_str()
        .unwrap()
        .contains("isn't a community"));
    assert!(sign_requests(&fixture).is_empty());
}

#[tokio::test]
async fn a_page_load_ends_every_window() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    window(&fixture, &token).await;
    fixture.service.0.pairings.page_load();
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
    fixture.service.0.pairings.sign_prompt(true);
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    answer(&fixture, &request.id, Answer::Deny);
    assert_eq!(error(&pending.await.unwrap()).1, "denied");
}

#[tokio::test]
async fn an_answer_heard_across_a_page_load_begins_no_window() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    // The waiting call hears the answer only after the page has reloaded.
    answer(&fixture, &request.id, Answer::Window);
    fixture.service.0.pairings.page_load();
    signed(&pending.await.unwrap());
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn a_request_closed_unanswered_says_so() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    sign_asked(&fixture).await;
    fixture.service.0.pairings.page_load();
    let reply = pending.await.unwrap();
    assert_eq!(error(&reply).1, "denied");
    assert_eq!(
        reply.1["message"],
        "Buzz closed this request before anyone answered"
    );
    // Nobody said no: the tool may ask again at once.
    fixture.service.0.pairings.sign_prompt(true);
    let pending = sign(&fixture, &token, leave());
    let next = sign_asked(&fixture).await;
    answer(&fixture, &next.id, Answer::Once);
    signed(&pending.await.unwrap());
}

#[tokio::test]
async fn a_declined_tool_waits_before_asking_again_and_others_do_not() {
    let fixture = fixture();
    let first = paired(&fixture).await;
    let pending = sign(&fixture, &first, leave());
    let request = sign_asked(&fixture).await;
    answer(&fixture, &request.id, Answer::Deny);
    pending.await.unwrap();
    let again = ask(&fixture, &first, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&again),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    let retry = again.1["retry_after"].as_u64().unwrap();
    assert!((1..=30).contains(&retry), "{retry}");
    assert_eq!(sign_requests(&fixture).len(), 1);
    let second = paired(&fixture).await;
    let pending = sign(&fixture, &second, leave());
    let other = sign_asked(&fixture).await;
    assert_ne!(other.pairing, request.pairing);
    answer(&fixture, &other.id, Answer::Once);
    signed(&pending.await.unwrap());
}

#[tokio::test]
async fn one_tool_cannot_spend_every_ask() {
    let fixture = fixture();
    let first = paired(&fixture).await;
    for _ in 0..10 {
        let pending = sign(&fixture, &first, leave());
        let request = sign_asked(&fixture).await;
        answer(&fixture, &request.id, Answer::Once);
        signed(&pending.await.unwrap());
    }
    let over = ask(&fixture, &first, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&over),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert!(over.1["retry_after"].as_u64().unwrap() > 30);
    assert_eq!(sign_requests(&fixture).len(), 10);
    let second = paired(&fixture).await;
    let pending = sign(&fixture, &second, leave());
    let request = sign_asked(&fixture).await;
    answer(&fixture, &request.id, Answer::Once);
    signed(&pending.await.unwrap());
}

#[tokio::test]
async fn a_caller_that_hangs_up_closes_its_prompt() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    pending.abort();
    for _ in 0..200 {
        if closed(&fixture, &request.id) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(closed(&fixture, &request.id));
    // Hanging up is no way around the wait after a deny.
    let again = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&again).1, "rate_limited");
    let other = paired(&fixture).await;
    let pending = sign(&fixture, &other, leave());
    let next = sign_asked(&fixture).await;
    assert_ne!(next.id, request.id);
    answer(&fixture, &next.id, Answer::Deny);
    pending.await.unwrap();
}

#[tokio::test]
async fn removing_the_community_closes_its_open_prompt() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let id = pairing_id(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    fixture.service.0.pairings.set_communities(Vec::new()).await;
    let reply = pending.await.unwrap();
    assert_eq!(error(&reply).1, "denied");
    assert_eq!(
        reply.1["message"],
        "Buzz closed this request before anyone answered"
    );
    assert!(closed(&fixture, &request.id));
    // A late answer begins nothing.
    answer(&fixture, &request.id, Answer::Window);
    assert_eq!(
        serde_json::to_value(fixture.service.0.pairings.windows_of(&id, 0)).unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn every_tool_together_has_a_budget_of_asks() {
    let fixture = fixture();
    for _ in 0..2 {
        let token = paired(&fixture).await;
        for _ in 0..10 {
            let pending = sign(&fixture, &token, leave());
            let request = sign_asked(&fixture).await;
            answer(&fixture, &request.id, Answer::Once);
            signed(&pending.await.unwrap());
        }
    }
    let third = paired(&fixture).await;
    let over = ask(&fixture, &third, "sign_event", &[&leave()]).await;
    assert_eq!(
        error(&over),
        (StatusCode::TOO_MANY_REQUESTS, "rate_limited")
    );
    assert!(over.1["retry_after"].as_u64().unwrap() > 30);
    assert_eq!(sign_requests(&fixture).len(), 20);
}

#[tokio::test]
async fn a_declined_tool_may_ask_again_once_it_has_waited() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    answer(&fixture, &request.id, Answer::Deny);
    pending.await.unwrap();
    let again = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&again).1, "rate_limited");
    skip(31).await;
    let pending = sign(&fixture, &token, leave());
    let next = sign_asked(&fixture).await;
    assert_ne!(next.id, request.id);
    answer(&fixture, &next.id, Answer::Once);
    signed(&pending.await.unwrap());
}

/// Moves the clock `seconds` ahead. It runs on, not paused, so the time a
/// request spends off this runtime is not skipped too.
async fn skip(seconds: u64) {
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(seconds)).await;
    tokio::time::resume();
}

/// Asks from `token` and gives `reply`.
async fn asked(fixture: &Fixture, token: &str, reply: Answer) -> (StatusCode, Value) {
    let pending = sign(fixture, token, leave());
    let request = sign_asked(fixture).await;
    answer(fixture, &request.id, reply);
    pending.await.unwrap()
}

#[tokio::test]
async fn each_deny_in_a_row_makes_a_tool_wait_longer_until_one_is_allowed() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let retry = || async {
        let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
        assert_eq!(error(&reply).1, "rate_limited");
        reply.1["retry_after"].as_u64().unwrap()
    };
    asked(&fixture, &token, Answer::Deny).await;
    assert!((1..=30).contains(&retry().await));
    skip(31).await;
    asked(&fixture, &token, Answer::Deny).await;
    assert!((31..=60).contains(&retry().await));
    skip(61).await;
    signed(&asked(&fixture, &token, Answer::Once).await);
    asked(&fixture, &token, Answer::Deny).await;
    assert!((1..=30).contains(&retry().await));
}

#[tokio::test]
async fn a_window_that_has_lapsed_allows_nothing() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    window(&fixture, &token).await;
    fixture.service.0.pairings.age_windows(300);
    let pending = sign(&fixture, &token, leave());
    let request = sign_asked(&fixture).await;
    assert_eq!(sign_requests(&fixture).len(), 2);
    answer(&fixture, &request.id, Answer::Deny);
    assert_eq!(error(&pending.await.unwrap()).1, "denied");
}

#[tokio::test]
async fn channel_edits_and_unbans_offer_no_window() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let person = "ab".repeat(32);
    for event in [
        unsigned(9002, json!([["h", "channel"], ["name", "ops"]]), now()),
        unsigned(9041, json!([["p", person]]), now()),
    ] {
        let pending = sign(&fixture, &token, event);
        let request = sign_asked(&fixture).await;
        assert_eq!(request.window_seconds, 0, "{}", request.kind);
        answer(&fixture, &request.id, Answer::Once);
        signed(&pending.await.unwrap());
    }
}

/// Denies one ask from `token` and gives how long it must then wait.
async fn denied_wait(fixture: &Fixture, token: &str) -> u64 {
    asked(fixture, token, Answer::Deny).await;
    let reply = ask(fixture, token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply).1, "rate_limited");
    reply.1["retry_after"].as_u64().unwrap()
}

#[tokio::test]
async fn the_wait_after_denies_stops_growing_at_eight_minutes() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let mut waits = Vec::new();
    for _ in 0..6 {
        let wait = denied_wait(&fixture, &token).await;
        waits.push(wait);
        skip(wait + 1).await;
    }
    let ceilings = [30, 60, 120, 240, 480, 480];
    for (wait, ceiling) in waits.iter().zip(ceilings) {
        assert!(*wait > ceiling / 2 && *wait <= ceiling, "{waits:?}");
    }
}

#[tokio::test]
async fn the_wait_after_denies_starts_over_after_a_quiet_ten_minutes() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    denied_wait(&fixture, &token).await;
    skip(31).await;
    let wait = denied_wait(&fixture, &token).await;
    assert!(wait > 30);
    skip(wait + 599).await;
    assert!(denied_wait(&fixture, &token).await > 60);
    skip(121 + 600).await;
    assert!(denied_wait(&fixture, &token).await <= 30);
}

/// Lets one ask from `token` go unanswered and gives how long it must then
/// wait.
async fn unanswered_wait(fixture: &Fixture, token: &str) -> u64 {
    tokio::time::pause();
    let reply = ask(fixture, token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply).1, "approval_required");
    tokio::time::resume();
    let reply = ask(fixture, token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply).1, "rate_limited");
    reply.1["retry_after"].as_u64().unwrap()
}

#[tokio::test]
async fn the_wait_after_unanswered_requests_stops_growing_at_eight_minutes() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    let mut waits = Vec::new();
    for _ in 0..6 {
        let wait = unanswered_wait(&fixture, &token).await;
        waits.push(wait);
        skip(wait + 1).await;
    }
    let ceilings = [30, 60, 120, 240, 480, 480];
    for (wait, ceiling) in waits.iter().zip(ceilings) {
        assert!(*wait > ceiling / 2 && *wait <= ceiling, "{waits:?}");
    }
}

#[tokio::test]
async fn an_unanswered_request_counts_once_toward_the_wait() {
    let fixture = fixture();
    let token = paired(&fixture).await;
    tokio::time::pause();
    let reply = ask(&fixture, &token, "sign_event", &[&leave()]).await;
    assert_eq!(error(&reply).1, "approval_required");
    tokio::time::resume();
    skip(31).await;
    let wait = denied_wait(&fixture, &token).await;
    assert!(wait > 30 && wait <= 60, "{wait}");
}
