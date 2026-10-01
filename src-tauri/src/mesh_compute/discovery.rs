//! Every invocation captures one community URL; no authority cache crosses communities.
use crate::{identity::IdentityHost, relay};
use buzz_mesh_compute::{
    discovery::{availability_from_events, current_member_pubkeys, owner_ids_from_events},
    discovery_query,
};
use nostr::key::PublicKey;

pub(super) async fn read(
    host: &IdentityHost,
    community: &str,
) -> Result<(Vec<String>, Vec<String>), String> {
    let info = relay::mesh_read(host, community, None).await?;
    let authority = info
        .get("self")
        .and_then(serde_json::Value::as_str)
        .ok_or("Relay did not advertise its identity")?;
    let authority = PublicKey::from_hex(authority).map_err(|_| "Invalid relay identity")?;
    let events = discovery_query::discover(&authority, |filter| async move {
        let data = relay::mesh_read(host, community, Some(filter))
            .await
            .map_err(std::io::Error::other)?;
        let values = data
            .as_array()
            .ok_or_else(|| std::io::Error::other("Invalid Mesh query result"))?;
        Ok(values.clone())
    })
    .await
    .map_err(|error| error.to_string())?;
    let viewer = host.viewer().await?;
    if !current_member_pubkeys(&events).contains(&viewer) {
        return Err("Current identity is not a member of this Mesh community".into());
    }
    let owners = owner_ids_from_events(&events);
    let targets = availability_from_events(events)
        .serve_targets
        .into_iter()
        .map(|target| target.endpoint_addr)
        .collect();
    Ok((owners, targets))
}
