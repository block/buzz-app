use super::*;

#[test]
fn bounded_lifetime_capacity_fails_closed() {
    let state = Invocations::default();
    for n in 0..128 {
        state.cancel(&format!("retired-{n}"));
    }
    state.clear();
    assert!(state.reserve("new-call", "example.plugin").is_err());
}

#[tokio::test]
async fn a_dropped_retirement_waiter_does_not_release_the_native_owner() {
    let state = Invocations::default();
    state.reserve("original", "example.plugin").unwrap();
    let owner = Retirement(state.clone(), "original".into());
    {
        let retirement = state.cancel_and_wait("original");
        tokio::pin!(retirement);
        tokio::select! { biased;
            _ = &mut retirement => panic!("acknowledged before owner returned"),
            _ = std::future::ready(()) => {},
        }
    }
    assert!(!state.try_live("original"));
    assert!(state.reserve("successor", "example.plugin").is_err());
    drop(owner);
    state.cancel_and_wait("original").await.unwrap();
    state.reserve("successor", "example.plugin").unwrap();
}

#[tokio::test]
async fn plugin_retirement_keeps_successors_out_until_the_owner_returns() {
    let state = Invocations::default();
    let owner = state.own("original", "example.plugin").unwrap();
    let retirement = state.retire_plugin_and_wait("example.plugin");
    tokio::pin!(retirement);
    tokio::select! { biased;
        _ = &mut retirement => panic!("acknowledged before owner returned"),
        _ = std::future::ready(()) => {},
    }
    assert!(!state.try_live("original"));
    assert!(state.own("successor", "example.plugin").is_err());
    drop(owner);
    retirement.await.unwrap();
    let _successor = state.own("successor", "example.plugin").unwrap();
    assert!(state.try_live("successor"));
}

#[test]
fn promotion_liveness_never_waits_for_the_invocation_mutex() {
    let state = Invocations::default();
    let _owner = state.own("original", "example.plugin").unwrap();
    assert!(state.try_live("original"));
    let _held = state.0.lock().unwrap();
    assert!(!state.try_live("original"));
}

#[test]
fn promotion_admission_is_one_shot_and_does_not_complete_the_owner() {
    let state = Invocations::default();
    let owner = state.own("saving", "example.plugin").unwrap();
    assert!(state.try_consume("saving"));
    assert!(!state.try_consume("saving"));
    assert!(state.own("successor", "example.plugin").is_err());
    drop(owner);
    let successor = state.own("successor", "example.plugin").unwrap();
    state.cancel("successor");
    assert!(!state.try_consume("successor"));
    drop(successor);
    let _held = state.own("held", "example.plugin").unwrap();
    let _lock = state.0.lock().unwrap();
    assert!(!state.try_consume("held"));
}
