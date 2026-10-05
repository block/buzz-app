//! Process-owned SDK worker. Startup is never aborted: it may already own an OS thread.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MESH_STOP_TIMEOUT: Duration = Duration::from_secs(12);
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{ClientConfig, ServeConfig};
use crate::transport_policy::validate_advertised_endpoint;

/// SDK status returned by the owned worker; payload remains untyped JSON.
pub use mesh_llm_sdk::EmbeddedNodeStatus as NodeStatus;

type Observer = Arc<dyn Fn(Phase) + Send + Sync>;

type Operation<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

trait Node: Send + 'static {
    fn join(&mut self, token: String) -> Operation<'_, ()>;
    fn status(&self) -> Operation<'_, mesh_llm_sdk::EmbeddedNodeStatus>;
    fn stop(self) -> Operation<'static, ()>;
}
impl Node for mesh_llm_sdk::EmbeddedNodeHandle {
    fn join(&mut self, token: String) -> Operation<'_, ()> {
        Box::pin(self.join_token(token))
    }
    fn status(&self) -> Operation<'_, mesh_llm_sdk::EmbeddedNodeStatus> {
        Box::pin(self.status())
    }
    fn stop(self) -> Operation<'static, ()> {
        Box::pin(self.stop())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "camelCase")]
pub enum Phase {
    Stopped,
    Starting,
    Ready,
    Stopping,
    /// Shutdown was not proved; replacement is deliberately refused.
    Failed(String),
}

struct Slot {
    phase: Phase,
    serving: bool,
    dial: Option<mpsc::Sender<String>>,
    stop: Option<watch::Sender<bool>>,
    status: Option<mpsc::Sender<oneshot::Sender<anyhow::Result<mesh_llm_sdk::EmbeddedNodeStatus>>>>,
}

/// The app owns this across plugin/page lifetimes. Dropping it requests shutdown.
pub struct Lifecycle {
    slot: Arc<Mutex<Slot>>,
    progress: crate::progress::Progress,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            progress: crate::progress::Progress::default(),
            slot: Arc::new(Mutex::new(Slot {
                phase: Phase::Stopped,
                serving: false,
                dial: None,
                stop: None,
                status: None,
            })),
        }
    }
}
impl Lifecycle {
    pub fn phase(&self) -> Phase {
        self.slot.lock().expect("mesh slot poisoned").phase.clone()
    }

    /// Ask the owned SDK handle for status; never discover a node by a guessed port.
    pub async fn status(&self) -> anyhow::Result<mesh_llm_sdk::EmbeddedNodeStatus> {
        let (reply, result) = oneshot::channel();
        {
            let slot = self
                .slot
                .lock()
                .map_err(|_| anyhow::anyhow!("Mesh slot unavailable"))?;
            if slot.phase != Phase::Ready {
                anyhow::bail!("Mesh status is not ready");
            }
            slot.status
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Mesh worker unavailable"))?
                .try_send(reply)
                .map_err(|_| anyhow::anyhow!("Mesh status request is already pending"))?;
        }
        result
            .await
            .map_err(|_| anyhow::anyhow!("Mesh stopped during status read"))?
    }

    pub fn start(&self, request: ClientConfig) -> anyhow::Result<()> {
        let config = request.build()?;
        self.launch(async move { mesh_llm_sdk::client::start(config).await })
    }

    /// Share a local model through the same exclusive SDK slot as consumers.
    pub fn serve(&self, request: ServeConfig) -> anyhow::Result<()> {
        self.serve_observed(request, |_| {})
    }

    /// Notify the host of worker transitions for fenced persistence checkpoints.
    /// Observers run outside the slot lock and must not block on async work.
    pub fn serve_observed(
        &self,
        request: ServeConfig,
        observe: impl Fn(Phase) + Send + Sync + 'static,
    ) -> anyhow::Result<()> {
        let config = request.build()?;
        let progress = self.progress.clone();
        self.launch_observed(
            async move {
                progress.install();
                mesh_llm_host_runtime::initialize_host_runtime().await?;
                // Serving resolves and acquires its own artifacts (including layer packages).
                // A separate GGUF download here duplicates acquisition.
                mesh_llm_sdk::serve::start(config).await
            },
            true,
            Arc::new(observe),
        )
    }

    /// Byte progress from the current worker, retained across UI remounts.
    pub fn download_progress(&self) -> Option<crate::progress::DownloadProgress> {
        self.progress.latest()
    }

    fn launch<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
    ) -> anyhow::Result<()> {
        self.launch_role(startup, false)
    }

    /// True only for the installed, ready serving worker, never for startup intent.
    pub fn is_serving(&self) -> bool {
        self.slot
            .lock()
            .map(|slot| slot.phase == Phase::Ready && slot.serving)
            .unwrap_or(false)
    }

    fn launch_role<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
        serving: bool,
    ) -> anyhow::Result<()> {
        self.launch_observed(startup, serving, Arc::new(|_| {}))
    }

    fn launch_observed<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
        serving: bool,
        observe: Observer,
    ) -> anyhow::Result<()> {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if slot.phase != Phase::Stopped {
            anyhow::bail!("Previous Mesh runtime shutdown is not confirmed");
        }
        let runtime = tokio::runtime::Handle::try_current()?;
        self.progress.clear();
        let (dial, mut pending) = mpsc::channel::<String>(64);
        let (status, mut reads) =
            mpsc::channel::<oneshot::Sender<anyhow::Result<mesh_llm_sdk::EmbeddedNodeStatus>>>(1);
        let (stop, mut stopping) = watch::channel(false);
        slot.phase = Phase::Starting;
        slot.serving = serving;
        slot.dial = Some(dial);
        slot.stop = Some(stop);
        slot.status = Some(status);
        let shared = self.slot.clone();
        drop(slot);
        // Detached from the caller's request lifetime, intentionally not abortable by IPC.
        runtime.spawn(async move {
            let mut node = match startup.await {
                Ok(node) => node,
                Err(error) => {
                    let phase = Phase::Failed(error.to_string());
                    shared.lock().expect("mesh slot poisoned").phase = phase.clone();
                    observe(phase);
                    return;
                }
            };
            {
                let mut slot = shared.lock().expect("mesh slot poisoned");
                if slot.phase == Phase::Starting { slot.phase = Phase::Ready; }
            }
            let phase = shared.lock().expect("mesh slot poisoned").phase.clone();
            observe(phase);
            loop {
                if *stopping.borrow() { break; }
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    request = reads.recv() => {
                        let Some(reply) = request else { break; };
                        // Status is cancellable; unlike startup it creates no runtime.
                        tokio::select! {
                            biased;
                            _ = stopping.changed() => break,
                            result = tokio::time::timeout(Duration::from_secs(10), node.status()) => {
                                let result = result.unwrap_or_else(|_| Err(anyhow::anyhow!("Mesh status read timed out")));
                                let _ = reply.send(result);
                            }
                        }
                    }
                    token = pending.recv() => {
                        let Some(token) = token else { break; };
                        if let Err(error) = node.join(token).await {
                            let phase = Phase::Failed(error.to_string());
                            shared.lock().expect("mesh slot poisoned").phase = phase.clone();
                            observe(phase);
                            break;
                        }
                    }
                }
            }
            // A timeout is not proof of shutdown: retain Failed and reject replacement.
            let result = match tokio::time::timeout(MESH_STOP_TIMEOUT, node.stop()).await {
                Ok(result) => result,
                Err(_) => Err(anyhow::anyhow!("Mesh shutdown timed out; restart Buzz before starting another runtime")),
            };
            let mut slot = shared.lock().expect("mesh slot poisoned");
            slot.phase = match result {
                Ok(()) => Phase::Stopped,
                Err(error) => Phase::Failed(error.to_string()),
            };
            slot.dial = None;
            slot.stop = None;
            slot.status = None;
            let phase = slot.phase.clone();
            drop(slot);
            observe(phase);
        });
        Ok(())
    }

    /// Tokens come from host discovery; transport validation also applies to queued joins.
    pub fn dial(&self, token: &str) -> anyhow::Result<()> {
        let token = validate_advertised_endpoint(token)?.join_token;
        self.enqueue(token)
    }
    fn enqueue(&self, token: String) -> anyhow::Result<()> {
        let slot = self.slot.lock().expect("mesh slot poisoned");
        if !matches!(slot.phase, Phase::Starting | Phase::Ready) {
            anyhow::bail!("Mesh runtime is not accepting dial targets");
        }
        slot.dial
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Mesh worker is unavailable"))?
            .try_send(token)
            .map_err(|_| anyhow::anyhow!("Mesh dial queue is full or unavailable"))
    }

    /// Caller timeout never cancels startup or changes the slot to Stopped.
    pub async fn stop_and_wait(&self) -> anyhow::Result<()> {
        self.stop();
        tokio::time::timeout(MESH_STOP_TIMEOUT, async {
            loop {
                match self.phase() {
                    Phase::Stopped => return Ok(()),
                    Phase::Failed(reason) => anyhow::bail!(reason),
                    _ => tokio::time::sleep(Duration::from_millis(25)).await,
                }
            }
        })
        .await
        .map_err(|_| anyhow::anyhow!("Finishing stop; restart Buzz if this persists"))?
    }

    pub fn stop(&self) {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if let Some(stop) = &slot.stop {
            let _ = stop.send(true);
            if !matches!(slot.phase, Phase::Failed(_)) {
                slot.phase = Phase::Stopping;
            }
        }
    }
}
impl Drop for Lifecycle {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    struct FakeNode {
        stopped: oneshot::Sender<()>,
        release: oneshot::Receiver<()>,
        joined: mpsc::UnboundedSender<String>,
    }
    impl Node for FakeNode {
        fn join(&mut self, token: String) -> Operation<'_, ()> {
            Box::pin(async move {
                self.joined.send(token)?;
                Ok(())
            })
        }
        fn status(&self) -> Operation<'_, mesh_llm_sdk::EmbeddedNodeStatus> {
            Box::pin(async {
                Ok(mesh_llm_sdk::EmbeddedNodeStatus {
                    api_base_url: "fixture".into(),
                    console_url: "fixture".into(),
                    invite_token: None,
                    payload: serde_json::json!({"hosted_models":["fixture-model"]}),
                })
            })
        }
        fn stop(self) -> Operation<'static, ()> {
            Box::pin(async move {
                let _ = self.stopped.send(());
                self.release.await?;
                Ok(())
            })
        }
    }
    fn fixture() -> (
        FakeNode,
        oneshot::Receiver<()>,
        oneshot::Sender<()>,
        mpsc::UnboundedReceiver<String>,
    ) {
        let (stopped, observed) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let (joined, received) = mpsc::unbounded_channel();
        (
            FakeNode {
                stopped,
                release: gate,
                joined,
            },
            observed,
            release,
            received,
        )
    }
    #[tokio::test]
    async fn serving_requires_ready_worker_and_clears_on_stop_or_failure() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (enter, gate) = oneshot::channel();
        owner
            .launch_role(
                async move {
                    gate.await?;
                    Ok(node)
                },
                true,
            )
            .unwrap();
        assert!(!owner.is_serving());
        enter.send(()).unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(owner.is_serving());
        owner.stop();
        stopped.await.unwrap();
        assert!(!owner.is_serving());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        owner
            .launch_role(
                async { Err::<FakeNode, _>(anyhow::anyhow!("load failed")) },
                true,
            )
            .unwrap();
        while owner.phase() == Phase::Starting {
            tokio::task::yield_now().await;
        }
        assert!(matches!(owner.phase(), Phase::Failed(_)));
        assert!(!owner.is_serving());
    }
    #[tokio::test]
    async fn observer_sees_ready_then_stop_outside_slot_lock_and_failure_before_replacement() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (events, mut observed) = mpsc::unbounded_channel();
        let slot = owner.slot.clone();
        owner
            .launch_observed(
                async { Ok(node) },
                true,
                Arc::new(move |phase| {
                    assert!(
                        slot.try_lock().is_ok(),
                        "observer cannot run under the slot lock"
                    );
                    events.send(phase).unwrap();
                }),
            )
            .unwrap();
        assert_eq!(observed.recv().await, Some(Phase::Ready));
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        assert_eq!(observed.recv().await, Some(Phase::Stopped));
        let (events, mut observed) = mpsc::unbounded_channel();
        owner
            .launch_observed(
                async { Err::<FakeNode, _>(anyhow::anyhow!("load failed")) },
                true,
                Arc::new(move |phase| {
                    events.send(phase).unwrap();
                }),
            )
            .unwrap();
        assert_eq!(
            observed.recv().await,
            Some(Phase::Failed("load failed".into()))
        );
        assert!(owner
            .start(ClientConfig {
                api_port: 1,
                console_port: 2,
                owner_key: std::env::temp_dir().join("fixture"),
                owner_id: "fixture".into(),
                trusted_owners: vec!["fixture".into()],
                join_token: None,
                mesh_name: None,
            })
            .is_err());
    }

    async fn wait_stopped(owner: &Lifecycle) {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while owner.phase() != Phase::Stopped {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn status_reads_the_owned_node_only_after_start_and_rejects_after_stop() {
        let owner = Lifecycle::default();
        assert!(owner.status().await.is_err());
        let (node, stopped, release, mut joined) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        owner.enqueue("ready-barrier".into()).unwrap();
        joined.recv().await.unwrap();
        assert_eq!(
            owner.status().await.unwrap().payload["hosted_models"][0],
            "fixture-model"
        );
        owner.stop();
        stopped.await.unwrap();
        assert!(owner.status().await.is_err());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
    }

    #[tokio::test]
    async fn stop_during_start_retains_worker_and_blocks_replacement_until_shutdown() {
        let owner = Lifecycle::default();
        let (node, stopped, release, _) = fixture();
        let (start, gate) = oneshot::channel();
        owner
            .launch(async {
                gate.await?;
                Ok(node)
            })
            .unwrap();
        owner.stop();
        assert_eq!(owner.phase(), Phase::Stopping);
        let (rejected, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(rejected) }).is_err());
        start.send(()).unwrap();
        stopped.await.unwrap();
        assert_eq!(owner.phase(), Phase::Stopping);
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
        release.send(()).unwrap();
        wait_stopped(&owner).await;
        let (next, stopped, release, _) = fixture();
        owner.launch(async { Ok(next) }).unwrap();
        owner.stop();
        stopped.await.unwrap();
        release.send(()).unwrap();
        wait_stopped(&owner).await;
    }
    #[tokio::test]
    async fn queued_dial_is_delivered_after_start_and_failed_shutdown_blocks_restart() {
        let owner = Lifecycle::default();
        let (node, stopped, release, mut joined) = fixture();
        let (start, gate) = oneshot::channel();
        owner
            .launch(async {
                gate.await?;
                Ok(node)
            })
            .unwrap();
        owner.enqueue("host-validated-token".into()).unwrap();
        start.send(()).unwrap();
        assert_eq!(joined.recv().await.as_deref(), Some("host-validated-token"));
        owner.stop();
        stopped.await.unwrap();
        drop(release);
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while !matches!(owner.phase(), Phase::Failed(_)) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
    }
    #[tokio::test(start_paused = true)]
    async fn ready_stop_timeout_never_permits_replacement() {
        let owner = Lifecycle::default();
        let (node, stopped, _release, mut joined) = fixture();
        owner.launch(async { Ok(node) }).unwrap();
        owner.enqueue("barrier".into()).unwrap();
        joined.recv().await.unwrap();
        assert_eq!(owner.phase(), Phase::Ready);
        owner.stop();
        stopped.await.unwrap();
        tokio::time::advance(MESH_STOP_TIMEOUT).await;
        while !matches!(owner.phase(), Phase::Failed(_)) {
            tokio::task::yield_now().await;
        }
        let (next, _, _, _) = fixture();
        assert!(owner.launch(async { Ok(next) }).is_err());
    }
}
