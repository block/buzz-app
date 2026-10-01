//! Agent acquisitions are separate from Settings selection. Call under the native owner lock.
use std::collections::BTreeSet;

#[derive(Default)]
pub struct Consumers {
    community: Option<String>,
    tokens: BTreeSet<String>,
}
impl Consumers {
    /// Reserve before asynchronous startup so another community cannot replace it.
    pub fn acquire(&mut self, community: &str, token: String) -> Result<bool, String> {
        if self
            .community
            .as_deref()
            .is_some_and(|current| current != community)
        {
            return Err("Shared compute is already in use by agents in another community".into());
        }
        if self.tokens.contains(&token) {
            return Err("Duplicate Mesh acquisition".into());
        }
        let first = self.tokens.is_empty();
        self.community = Some(community.into());
        self.tokens.insert(token);
        Ok(first)
    }
    /// Only the last exact acquisition requests shutdown. Keep the community fence
    /// until the owner confirms shutdown; a new acquisition cannot cross that fence.
    pub fn release(&mut self, token: &str) -> bool {
        self.tokens.remove(token) && self.tokens.is_empty()
    }
    pub fn in_use(&self) -> bool {
        !self.tokens.is_empty()
    }
    pub fn shutdown_confirmed(&mut self) -> Result<(), String> {
        if self.in_use() {
            return Err("Mesh still has agent consumers".into());
        }
        self.community = None;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn last_release_and_confirmed_shutdown_are_both_required_to_switch() {
        let mut consumers = Consumers::default();
        assert!(consumers.acquire("a", "old".into()).unwrap());
        assert!(!consumers.acquire("a", "replacement".into()).unwrap());
        assert!(consumers.acquire("b", "other".into()).is_err());
        assert!(!consumers.release("old"));
        assert!(!consumers.release("old"));
        assert!(consumers.shutdown_confirmed().is_err());
        assert!(consumers.release("replacement"));
        assert!(consumers.acquire("b", "other".into()).is_err());
        consumers.shutdown_confirmed().unwrap();
        assert!(consumers.acquire("b", "other".into()).unwrap());
    }
}
