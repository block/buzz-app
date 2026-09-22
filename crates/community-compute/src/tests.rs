use super::*;
use mesh_llm_host_runtime::crypto::OwnerKeypair;
use nostr::{Event, EventBuilder, Keys, Kind, Tag, Timestamp};
use serde_json::{json, Value};

fn event(keys: &Keys, kind: u16, content: Value, tags: Vec<Vec<String>>, age: u64) -> Event {
    EventBuilder::new(Kind::Custom(kind), content.to_string())
        .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
        .custom_created_at(Timestamp::from_secs(Timestamp::now().as_secs() - age))
        .sign_with_keys(keys)
        .unwrap()
}
fn roster(authority: &Keys, members: &[&Keys]) -> Event {
    event(
        authority,
        13534,
        json!(null),
        members
            .iter()
            .map(|m| vec!["member".into(), m.public_key().to_hex()])
            .collect(),
        0,
    )
}
fn payload(owner: &OwnerKeypair, member: &Keys, targets: bool) -> Value {
    let endpoint = transport_policy::endpoint_token_for_test([iroh::TransportAddr::Ip(
        "192.168.1.20:47916".parse().unwrap(),
    )]);
    let tokens = if targets {
        vec![endpoint.clone()]
    } else {
        vec![]
    };
    let member = member.public_key().to_hex();
    json!({
        "ownerId": owner.owner_id(),
        "ownerVerifyingKey": hex::encode(owner.verifying_key().as_bytes()),
        "ownerBindingSig": hex::encode(owner.sign_bytes(&identity::member_binding_bytes(&member))),
        "ownerEndpointBindingSig": hex::encode(owner.sign_bytes(&identity::member_endpoint_binding_bytes(&member, &tokens))),
        "serveTargets": if targets { json!([{"modelId":"local-model", "endpointAddr":endpoint}]) } else { json!([]) },
        "node_state": "serving", "my_vram_gb":8.0, "model_size_gb":4.0,
        "deviceName": "Test device", "gpus":[{"vram_bytes":999999999999_u64}],
        "privateField": "must not be projected"
    })
}
fn status(member: &Keys, payload: Value, age: u64) -> Event {
    event(
        member,
        30003,
        payload,
        vec![vec!["k".into(), "buzz-mesh-status".into()]],
        age,
    )
}
fn project_for(events: Vec<Event>, authority: &Keys, member: &Keys) -> MeshSnapshot {
    project(
        events,
        &authority.public_key().to_hex(),
        &member.public_key().to_hex(),
    )
    .unwrap()
}
#[test]
fn verifies_both_bindings_and_projects_only_capped_display_fields() {
    let authority = Keys::generate();
    let member = Keys::generate();
    let owner = OwnerKeypair::generate();
    let result = project_for(
        vec![
            roster(&authority, &[&member]),
            status(&member, payload(&owner, &member, true), 0),
        ],
        &authority,
        &member,
    );
    assert_eq!(result.sharing_device_count, 1);
    assert_eq!(result.shared_capacity_gb, Some(8.0));
    assert_eq!(result.allocated_capacity_gb, Some(4.0));
    assert!(result.includes_self);
    let serialized = serde_json::to_string(&result).unwrap();
    for private in [
        "ownerBindingSig",
        "ownerVerifyingKey",
        "endpointAddr",
        "gpus",
        "privateField",
    ] {
        assert!(!serialized.contains(private));
    }
}
#[test]
fn ignores_nonmembers_stale_notes_future_notes_and_tampered_owner_bindings() {
    let authority = Keys::generate();
    let member = Keys::generate();
    let outsider = Keys::generate();
    let owner = OwnerKeypair::generate();
    let valid = payload(&owner, &member, true);
    let mut bad_owner = valid.clone();
    bad_owner["ownerId"] = json!("00".repeat(32));
    let mut bad_binding = valid.clone();
    bad_binding["ownerBindingSig"] = json!("00".repeat(64));
    let mut bad_endpoint = valid.clone();
    bad_endpoint["serveTargets"][0]["endpointAddr"] = json!("substituted");
    let future = EventBuilder::new(Kind::Custom(30003), valid.to_string())
        .tags([Tag::parse(["k", "buzz-mesh-status"]).unwrap()])
        .custom_created_at(Timestamp::from_secs(Timestamp::now().as_secs() + 1000))
        .sign_with_keys(&member)
        .unwrap();
    for invalid in [
        status(&outsider, payload(&owner, &outsider, true), 0),
        status(&member, valid, 121),
        status(&member, bad_owner, 0),
        status(&member, bad_binding, 0),
        status(&member, bad_endpoint, 0),
        future,
    ] {
        let result = project_for(
            vec![roster(&authority, &[&member]), invalid],
            &authority,
            &member,
        );
        assert_eq!(result.sharing_device_count, 0);
    }
}
#[test]
fn rejects_forged_rosters_and_event_signatures() {
    let authority = Keys::generate();
    let member = Keys::generate();
    assert!(project(
        vec![roster(&member, &[&member])],
        &authority.public_key().to_hex(),
        &member.public_key().to_hex()
    )
    .is_err());
    let mut forged = roster(&authority, &[&member]);
    forged.content.push('x');
    assert!(project(
        vec![forged],
        &authority.public_key().to_hex(),
        &member.public_key().to_hex()
    )
    .is_err());
}
#[test]
fn latest_stopped_note_wins_regardless_of_input_order_and_serving_label_needs_targets() {
    let authority = Keys::generate();
    let member = Keys::generate();
    let owner = OwnerKeypair::generate();
    let old = status(&member, payload(&owner, &member, true), 10);
    let stopped = status(&member, payload(&owner, &member, false), 0);
    for notes in [
        vec![old.clone(), stopped.clone()],
        vec![stopped.clone(), old.clone()],
    ] {
        let mut events = vec![roster(&authority, &[&member])];
        events.extend(notes);
        let result = project_for(events, &authority, &member);
        assert_eq!(result.devices.len(), 1);
        assert_eq!(result.sharing_device_count, 0);
    }
}
#[test]
fn counts_devices_separately_but_members_once_and_keeps_unknown_allocation_unknown() {
    let authority = Keys::generate();
    let member = Keys::generate();
    let first = payload(&OwnerKeypair::generate(), &member, true);
    let mut second = payload(&OwnerKeypair::generate(), &member, true);
    second.as_object_mut().unwrap().remove("model_size_gb");
    let result = project_for(
        vec![
            roster(&authority, &[&member]),
            status(&member, first, 0),
            status(&member, second, 0),
        ],
        &authority,
        &member,
    );
    assert_eq!(result.sharing_device_count, 2);
    assert_eq!(result.contributor_member_count, 1);
    assert_eq!(result.allocated_capacity_gb, None);
}
