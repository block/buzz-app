//! Native fencing of host-UI intent, not native active-community state.
use std::sync::Mutex;

#[derive(Default)]
pub(super) struct Lease(Mutex<Option<(String, String)>>);
impl Lease {
    pub fn select(&self, community: String) -> Result<String, String> {
        let id = uuid::Uuid::new_v4().to_string();
        *self.0.lock().map_err(|_| "Mesh lease unavailable")? = Some((id.clone(), community));
        Ok(id)
    }
    pub fn community(&self, id: &str) -> Result<String, String> {
        self.with_current(id, |community| Ok(community.to_owned()))
    }
    pub fn with_current<T>(
        &self,
        id: &str,
        action: impl FnOnce(&str) -> Result<T, String>,
    ) -> Result<T, String> {
        let current = self.0.lock().map_err(|_| "Mesh lease unavailable")?;
        let (_, community) = current
            .as_ref()
            .filter(|(key, _)| key == id)
            .ok_or("Mesh selection expired")?;
        action(community)
    }
    pub fn revoke(&self, id: &str) -> Result<bool, String> {
        let mut current = self.0.lock().map_err(|_| "Mesh lease unavailable")?;
        if current.as_ref().is_some_and(|(key, _)| key == id) {
            *current = None;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn clear(&self) {
        if let Ok(mut current) = self.0.lock() {
            *current = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    #[tokio::test]
    async fn revoked_discovery_cannot_commit_a_start() {
        let lease = Arc::new(Lease::default());
        let id = lease.select("https://fixture.example".into()).unwrap();
        let started = Arc::new(AtomicBool::new(false));
        let (entered, observed) = tokio::sync::oneshot::channel();
        let (release, gate) = tokio::sync::oneshot::channel();
        let task = {
            let lease = lease.clone();
            let id = id.clone();
            let started = started.clone();
            tokio::spawn(async move {
                lease.community(&id)?;
                entered.send(()).unwrap();
                gate.await.unwrap();
                lease.with_current(&id, |_| {
                    started.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        observed.await.unwrap();
        assert!(lease.revoke(&id).unwrap());
        release.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(!started.load(Ordering::SeqCst));
    }
    #[test]
    fn changing_community_fences_old_start_and_old_cleanup() {
        let lease = Lease::default();
        let old = lease.select("https://old.example".into()).unwrap();
        let new = lease.select("https://new.example".into()).unwrap();
        assert!(lease.community(&old).is_err());
        assert!(!lease.revoke(&old).unwrap());
        assert_eq!(lease.community(&new).unwrap(), "https://new.example");
    }
}
