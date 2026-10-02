//! Process-owned SDK worker. Startup is never aborted: it may already own an OS thread.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const MESH_STOP_TIMEOUT: Duration = Duration::from_secs(12);
use tokio::sync::{mpsc, watch};

use crate::config::{ClientConfig, ServeConfig};
use crate::transport_policy::validate_advertised_endpoint;

type Operation<'a, T> = Pin<Box<dyn Future<Output = anyhow::Result<T>> + Send + 'a>>;

trait Node: Send + 'static {
    fn join(&mut self, token: String) -> Operation<'_, ()>;
    fn stop(self) -> Operation<'static, ()>;
}
impl Node for mesh_llm_sdk::EmbeddedNodeHandle {
    fn join(&mut self, token: String) -> Operation<'_, ()> {
        Box::pin(self.join_token(token))
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
    dial: Option<mpsc::Sender<String>>,
    stop: Option<watch::Sender<bool>>,
}

/// The app owns this across plugin/page lifetimes. Dropping it requests shutdown.
pub struct Lifecycle {
    slot: Arc<Mutex<Slot>>,
}
impl Default for Lifecycle {
    fn default() -> Self {
        Self {
            slot: Arc::new(Mutex::new(Slot {
                phase: Phase::Stopped,
                dial: None,
                stop: None,
            })),
        }
    }
}
impl Lifecycle {
    pub fn phase(&self) -> Phase {
        self.slot.lock().expect("mesh slot poisoned").phase.clone()
    }

    pub fn start(&self, request: ClientConfig) -> anyhow::Result<()> {
        let config = request.build()?;
        self.launch(async move { mesh_llm_sdk::client::start(config).await })
    }

    /// Share a local model through the same exclusive SDK slot as consumers.
    pub fn serve(&self, request: ServeConfig) -> anyhow::Result<()> {
        let config = request.build()?;
        self.launch(async move { mesh_llm_sdk::serve::start(config).await })
    }

    fn launch<N: Node>(
        &self,
        startup: impl Future<Output = anyhow::Result<N>> + Send + 'static,
    ) -> anyhow::Result<()> {
        let mut slot = self.slot.lock().expect("mesh slot poisoned");
        if slot.phase != Phase::Stopped {
            anyhow::bail!("Previous Mesh runtime shutdown is not confirmed");
        }
        let runtime = tokio::runtime::Handle::try_current()?;
        let (dial, mut pending) = mpsc::channel::<String>(64);
        let (stop, mut stopping) = watch::channel(false);
        slot.phase = Phase::Starting;
        slot.dial = Some(dial);
        slot.stop = Some(stop);
        let shared = self.slot.clone();
        // Detached from the caller's request lifetime, intentionally not abortable by IPC.
        runtime.spawn(async move {
            let mut node = match startup.await {
                Ok(node) => node,
                Err(error) => {
                    shared.lock().expect("mesh slot poisoned").phase = Phase::Failed(error.to_string());
                    return;
                }
            };
            {
                let mut slot = shared.lock().expect("mesh slot poisoned");
                if slot.phase == Phase::Starting { slot.phase = Phase::Ready; }
            }
            loop {
                if *stopping.borrow() { break; }
                tokio::select! {
                    biased;
                    _ = stopping.changed() => break,
                    token = pending.recv() => {
                        let Some(token) = token else { break; };
                        if let Err(error) = node.join(token).await {
                            shared.lock().expect("mesh slot poisoned").phase = Phase::Failed(error.to_string());
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
