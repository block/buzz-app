//! Native call ownership and retirement for plugin host operations.
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

const REFUSED: &str = "Reviewed invocation is unavailable or retired";

// Up to 128 tombstones last through this app process. Unregister-before-register cannot revive
// a disposed fiber; the same envelope is independently consumed in HostCalls.
#[derive(Clone, Default)]
pub(crate) struct Invocations(Arc<Mutex<HashMap<String, Entry>>>);
struct Entry {
    plugin: String,
    live: bool,
    retired: Arc<tokio::sync::Notify>,
    finished: tokio::sync::watch::Sender<bool>,
}
impl Invocations {
    pub(crate) fn own(&self, call: &str, plugin: &str) -> Result<Retirement, String> {
        self.reserve(call, plugin)?;
        Ok(Retirement(self.clone(), call.into()))
    }
    fn reserve(&self, call: &str, plugin: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| REFUSED)?;
        if state.len() >= 128 || state.contains_key(call) {
            return Err(REFUSED.into());
        }
        // At most one native review at a time; no queue of stale consent windows.
        if state.values().any(|entry| !*entry.finished.borrow()) {
            return Err("Another review is open".into());
        }
        state.insert(
            call.into(),
            Entry {
                plugin: plugin.into(),
                live: true,
                retired: Arc::default(),
                finished: tokio::sync::watch::channel(false).0,
            },
        );
        Ok(())
    }
    /// Promotion predicates run under Manager metadata: never wait for this lock.
    pub(crate) fn try_live(&self, call: &str) -> bool {
        self.0
            .try_lock()
            .is_ok_and(|state| state.get(call).is_some_and(|entry| entry.live))
    }
    /// One-shot promotion admission under Manager metadata. Cancellation and
    /// admission share this lock, but an admitted owner still blocks successors
    /// until its write and cleanup return. Never wait in metadata lock order.
    pub(crate) fn try_consume(&self, call: &str) -> bool {
        let Ok(mut state) = self.0.try_lock() else {
            return false;
        };
        let Some(entry) = state.get_mut(call).filter(|entry| entry.live) else {
            return false;
        };
        entry.live = false;
        true
    }
    fn end_review(&self, call: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(entry) = state.get_mut(call) {
                entry.finished.send_replace(true);
            }
        }
    }
    #[cfg(any(target_os = "macos", test))]
    pub(crate) fn retirement_signal(&self, call: &str) -> Result<Arc<tokio::sync::Notify>, String> {
        self.0
            .lock()
            .map_err(|_| REFUSED)?
            .get(call)
            .map(|entry| entry.retired.clone())
            .ok_or_else(|| REFUSED.into())
    }
    pub(crate) fn cancel(&self, call: &str) {
        if let Ok(mut state) = self.0.lock() {
            if let Some(entry) = state.get_mut(call) {
                entry.live = false;
                entry.retired.notify_one();
            } else if state.len() < 128 {
                state.insert(
                    call.into(),
                    Entry {
                        plugin: String::new(),
                        live: false,
                        retired: Arc::default(),
                        finished: tokio::sync::watch::channel(true).0,
                    },
                );
            }
        }
    }
    pub(crate) async fn cancel_and_wait(&self, call: &str) -> Result<(), String> {
        self.cancel(call);
        let mut finished = self
            .0
            .lock()
            .map_err(|_| REFUSED)?
            .get(call)
            .ok_or(REFUSED)?
            .finished
            .subscribe();
        // A retained value, not a Notify pulse: completion before this waiter
        // subscribes is still affirmative ownership retirement.
        finished.wait_for(|done| *done).await.map_err(|_| REFUSED)?;
        Ok(())
    }
    pub(crate) fn retire(&self, plugin: &str) {
        if let Ok(mut state) = self.0.lock() {
            for entry in state.values_mut().filter(|e| e.plugin == plugin) {
                entry.live = false;
                entry.retired.notify_one();
            }
        }
    }
    pub(crate) async fn retire_plugin_and_wait(&self, plugin: &str) -> Result<(), String> {
        let completions: Vec<_> = {
            let mut state = self.0.lock().map_err(|_| REFUSED)?;
            state
                .values_mut()
                .filter(|entry| entry.plugin == plugin)
                .map(|entry| {
                    entry.live = false;
                    entry.retired.notify_one();
                    entry.finished.subscribe()
                })
                .collect()
        };
        for mut finished in completions {
            finished.wait_for(|done| *done).await.map_err(|_| REFUSED)?;
        }
        Ok(())
    }
    pub(crate) fn clear(&self) {
        // Keep tombstones: a late registration must not resurrect retired work.
        if let Ok(mut state) = self.0.lock() {
            for entry in state.values_mut() {
                entry.live = false;
                entry.retired.notify_one();
            }
        }
    }
}
pub(crate) struct Retirement(Invocations, String);
impl Drop for Retirement {
    fn drop(&mut self) {
        self.0.cancel(&self.1);
        self.0.end_review(&self.1);
    }
}

#[tauri::command]
pub(crate) async fn plugin_host_reviewed_retire<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    state: tauri::State<'_, Invocations>,
    call_id: String,
) -> Result<(), String> {
    if webview.label() != "main"
        || uuid::Uuid::parse_str(&call_id).map_or(true, |v| v.to_string() != call_id)
    {
        return Err(REFUSED.into());
    }
    state.cancel_and_wait(&call_id).await
}
