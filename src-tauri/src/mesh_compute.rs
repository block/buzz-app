//! Host side of the bundled Mesh plugin (`src/bundled/mesh-compute/compute`):
//! lends it the signed-in identity and the authenticated relay client.
use crate::{federated_identity::FederatedIdentity, identity, relay};
use buzz_mesh_compute::desktop::host::{AppIdentity, BoxFuture, EventTemplate, Identity};

pub(crate) use buzz_mesh_compute::desktop::MeshHost;

struct AppHost {
    identity: identity::IdentityHost,
    federated_identity: FederatedIdentity,
}

impl AppIdentity for AppHost {
    fn viewer(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(self.identity.viewer())
    }
    /// Signs Mesh member status only; the plugin gets no general signing.
    fn sign(&self, event: EventTemplate) -> BoxFuture<'_, Result<serde_json::Value, String>> {
        if u64::from(event.kind) != buzz_mesh_compute::discovery_types::MESH_STATUS_KIND {
            return Box::pin(async { Err("Mesh may only sign its status event".into()) });
        }
        Box::pin(self.identity.sign(identity::EventTemplate {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content,
        }))
    }
    fn relay_read<'a>(
        &'a self,
        community: &'a str,
        filter: Option<serde_json::Value>,
    ) -> BoxFuture<'a, Result<serde_json::Value, String>> {
        Box::pin(relay::plugin_read(
            &self.identity,
            &self.federated_identity,
            community,
            filter,
        ))
    }
    fn relay_publish<'a>(
        &'a self,
        community: &'a str,
        event: serde_json::Value,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(relay::plugin_publish(
            &self.identity,
            &self.federated_identity,
            community,
            event,
        ))
    }
}

pub(crate) fn identity(
    identity: identity::IdentityHost,
    federated_identity: FederatedIdentity,
) -> Identity {
    std::sync::Arc::new(AppHost {
        identity,
        federated_identity,
    })
}

/// Loads saved sharing preferences from app data.
pub(crate) fn setup<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    app.state::<MeshHost>().initialize_preferences(
        app.path()
            .app_data_dir()
            .map(|root| root.join("mesh-sharing.json"))
            .map_err(|error| error.to_string()),
    );
}

/// The plugin's `mesh_compute_*` commands, routed by prefix in `lib.rs`.
pub(crate) fn commands() -> fn(tauri::ipc::Invoke<tauri::Wry>) -> bool {
    use buzz_mesh_compute::desktop::{self as mesh, agent, sharing, widget};
    tauri::generate_handler![
        mesh::mesh_compute_inventory,
        mesh::mesh_compute_status,
        mesh::mesh_compute_stop,
        mesh::mesh_compute_catalog,
        mesh::mesh_compute_start,
        mesh::mesh_compute_select,
        mesh::mesh_compute_release,
        mesh::mesh_compute_disarm,
        widget::mesh_compute_widget_open,
        widget::mesh_compute_widget_close,
        widget::mesh_compute_widget_status,
        sharing::mesh_compute_share,
        agent::mesh_compute_prepare_inference,
        agent::mesh_compute_inference_current,
        agent::mesh_compute_chat
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::testing::{community, reply};
    use serde_json::json;

    async fn relay_access(required: bool) {
        let community = community(required).await;
        let mesh = identity(community.host.clone(), community.fi.clone());
        let origin = community.origin.as_str();
        let event = mesh
            .sign(EventTemplate {
                kind: buzz_mesh_compute::discovery_types::MESH_STATUS_KIND as u16,
                created_at: 1,
                tags: vec![],
                content: String::new(),
            })
            .await
            .unwrap();
        let receipt = json!({"accepted": true, "event_id": event["id"]});
        let server = community.serve(vec![
            reply("200 OK", r#"{"name":"Community"}"#),
            reply("200 OK", "[]"),
            reply("200 OK", &receipt.to_string()),
        ]);
        assert_eq!(
            mesh.relay_read(origin, None).await.unwrap()["name"],
            "Community"
        );
        assert_eq!(
            mesh.relay_read(origin, Some(json!({"kinds": [13534]})))
                .await
                .unwrap(),
            json!([])
        );
        mesh.relay_publish(origin, event).await.unwrap();
        let heads = server.heads().await;
        assert!(heads[0].starts_with("GET / "));
        community.assert_uncarried(&heads[0]);
        for (head, route) in heads[1..].iter().zip(["POST /query ", "POST /events "]) {
            assert!(head.starts_with(route), "{head}");
            community.assert_carried(head);
        }
    }

    #[tokio::test]
    async fn mesh_reads_and_publications_carry_the_communitys_sign_in() {
        relay_access(true).await;
    }

    #[tokio::test]
    async fn mesh_omits_federated_evidence_for_an_ordinary_community() {
        relay_access(false).await;
    }

    #[tokio::test]
    async fn mesh_uses_the_live_sign_in_after_its_adapter_was_created() {
        let community = community(true).await;
        let mesh = identity(community.host.clone(), community.fi.clone());
        community.fi.sign_out_for_test();
        let server = community.serve(vec![reply("401 Unauthorized", "authentication required\n")]);
        assert_eq!(
            mesh.relay_read(community.origin.as_str(), Some(json!({"kinds": [13534]})))
                .await
                .unwrap_err(),
            "Federated sign-in is required"
        );
        community.assert_uncarried(&server.heads().await[0]);
    }
}
