//! Diagnostic stage markers for Mesh startup latency. Opaque attempt id, wall-clock
//! timestamp and elapsed time only: never prompts, keys, config or addresses.
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static CURRENT: Mutex<Option<(String, Instant)>> = Mutex::new(None);

/// Start a new attempt at an entry point (restore, share, agent) and log it.
pub fn begin(entry: &str) {
    let id = format!("{:08x}", rand_u32());
    if let Ok(mut current) = CURRENT.lock() {
        *current = Some((id, Instant::now()));
    }
    stage("entry", &format!("from={entry}"));
}

/// Log a stage of the current attempt.
pub fn stage(name: &str, detail: &str) {
    let (id, elapsed) = CURRENT
        .lock()
        .ok()
        .and_then(|c| {
            c.as_ref()
                .map(|(id, t)| (id.clone(), t.elapsed().as_millis()))
        })
        .unwrap_or_else(|| ("none".into(), 0));
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    eprintln!("mesh-startup ts_ms={ts} attempt={id} stage={name} elapsed_ms={elapsed} {detail}");
}

fn rand_u32() -> u32 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos ^ std::process::id().rotate_left(16)
}
