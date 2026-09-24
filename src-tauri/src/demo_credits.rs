//! Developer-only, local simulation shared by the Provider and Consumer test apps.
//! This is deliberately not a wallet or an authoritative credit ledger.
use crate::compute_host::ComputeHost;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager as _;

const TOKENS_PER_CREDIT: u64 = 1_000;
const MAX_ENTRIES: usize = 200;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoLedger {
    pub consumer_balance: i64,
    pub provider_balance: i64,
    pub tokens_served: u64,
    pub entries: Vec<DemoEntry>,
    last_generation: Option<u64>,
    last_tokens: u64,
    token_remainder: u64,
    legacy_seeded: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoEntry {
    pub id: String,
    pub kind: String,
    pub consumer_delta: i64,
    pub provider_delta: i64,
    pub tokens: u64,
    pub created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemoWallet {
    pub role: String,
    pub ledger: DemoLedger,
}

fn data_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !cfg!(debug_assertions) {
        return Err("The simulated credits wallet is only available in development builds".into());
    }
    // The Provider and Consumer test bundles have sibling bundle identifiers.
    // Their parent app-data directory gives them one shared, machine-local demo file.
    let parent = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or("Shared demo storage is unavailable")?
        .to_path_buf();
    Ok(parent.join("buzz-compute-credits-demo").join("ledger.json"))
}

#[cfg(unix)]
struct StoreLock(File);

#[cfg(unix)]
impl StoreLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        use std::os::fd::AsRawFd;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|error| error.to_string())?;
        // SAFETY: flock only uses the valid descriptor owned by `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(Self(file))
    }
}

#[cfg(unix)]
impl Drop for StoreLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: the descriptor remains open until this lock is dropped.
        let _ = unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(windows)]
struct StoreLock(PathBuf);

#[cfg(windows)]
impl StoreLock {
    fn acquire(path: &Path) -> Result<Self, String> {
        use std::{thread, time::Duration};
        let start = std::time::Instant::now();
        loop {
            match OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(_) => return Ok(Self(path.clone())),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if start.elapsed() > Duration::from_secs(5) {
                        return Err("The demo wallet is busy; try again".into());
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
    }
}

#[cfg(windows)]
impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(not(any(unix, windows)))]
struct StoreLock;

#[cfg(not(any(unix, windows)))]
impl StoreLock {
    fn acquire(_: &Path) -> Result<Self, String> {
        Ok(Self)
    }
}

fn with_ledger<T>(
    path: &Path,
    update: impl FnOnce(&mut DemoLedger) -> Result<T, String>,
) -> Result<T, String> {
    let dir = path.parent().ok_or("Demo storage is unavailable")?;
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let lock_path = path.with_extension("lock");
    let _lock = StoreLock::acquire(&lock_path)?;
    let mut ledger = match File::open(path) {
        Ok(file) => {
            let mut raw = String::new();
            file.take(1_048_577)
                .read_to_string(&mut raw)
                .map_err(|error| error.to_string())?;
            if raw.len() > 1_048_576 {
                return Err("Demo ledger exceeds the local size limit".into());
            }
            serde_json::from_str(&raw).map_err(|_| "Demo ledger is invalid")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DemoLedger::default(),
        Err(error) => return Err(error.to_string()),
    };
    let before = ledger.clone();
    let result = update(&mut ledger)?;
    if ledger == before {
        return Ok(result);
    }
    let bytes = serde_json::to_vec(&ledger).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    fs::rename(&temp, path).map_err(|error| error.to_string())?;
    Ok(result)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn append(
    ledger: &mut DemoLedger,
    kind: &str,
    consumer_delta: i64,
    provider_delta: i64,
    tokens: u64,
) {
    ledger.entries.push(DemoEntry {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.into(),
        consumer_delta,
        provider_delta,
        tokens,
        created_at: now(),
    });
    if ledger.entries.len() > MAX_ENTRIES {
        ledger.entries.drain(..ledger.entries.len() - MAX_ENTRIES);
    }
}

fn settle_usage(ledger: &mut DemoLedger, generation: u64, tokens: u64) {
    if ledger.last_generation != Some(generation) {
        ledger.last_generation = Some(generation);
        ledger.last_tokens = 0;
    } else if tokens < ledger.last_tokens {
        // A worker may restart without the desktop process restarting.
        ledger.last_tokens = 0;
        ledger.token_remainder = 0;
    }
    let delta = tokens - ledger.last_tokens;
    ledger.last_tokens = tokens;
    ledger.tokens_served = tokens;
    let combined = ledger.token_remainder.saturating_add(delta);
    let credits = combined / TOKENS_PER_CREDIT;
    ledger.token_remainder = combined % TOKENS_PER_CREDIT;
    if credits > 0 {
        let credits = credits.min(i64::MAX as u64) as i64;
        ledger.provider_balance = ledger.provider_balance.saturating_add(credits);
        ledger.consumer_balance = ledger.consumer_balance.saturating_sub(credits);
        append(ledger, "served-tokens", -credits, credits, delta);
    }
}

fn spend(ledger: &mut DemoLedger, amount: u64) -> Result<(), String> {
    if amount == 0 || amount > 1_000_000 {
        return Err("Choose between 1 and 1,000,000 demo credits".into());
    }
    if amount as i64 > ledger.consumer_balance {
        return Err("The demo Consumer balance is too low".into());
    }
    ledger.consumer_balance -= amount as i64;
    ledger.provider_balance = ledger.provider_balance.saturating_add(amount as i64);
    append(ledger, "demo-spend", -(amount as i64), amount as i64, 0);
    Ok(())
}

#[tauri::command]
pub fn community_compute_demo_wallet(
    app: tauri::AppHandle,
    host: tauri::State<'_, ComputeHost>,
) -> Result<DemoWallet, String> {
    let status = host.status()?;
    let role = if status.preferred_mode == "serve" {
        "provider"
    } else {
        "consumer"
    };
    let path = data_path(&app)?;
    let ledger = with_ledger(&path, |ledger| {
        if role == "provider" && status.state == "running" {
            if let Some(usage) = status.usage.as_ref() {
                settle_usage(ledger, status.generation, usage.tokens_served);
            }
        }
        Ok(ledger.clone())
    })?;
    Ok(DemoWallet {
        role: role.into(),
        ledger,
    })
}

#[tauri::command]
pub fn community_compute_demo_add_consumer_credits(
    app: tauri::AppHandle,
    amount: u64,
) -> Result<DemoLedger, String> {
    if amount == 0 || amount > 1_000_000 {
        return Err("Choose between 1 and 1,000,000 demo credits".into());
    }
    let path = data_path(&app)?;
    with_ledger(&path, |ledger| {
        ledger.consumer_balance = ledger.consumer_balance.saturating_add(amount as i64);
        append(ledger, "demo-top-up", amount as i64, 0, 0);
        Ok(ledger.clone())
    })
}

#[tauri::command]
pub fn community_compute_demo_spend(
    app: tauri::AppHandle,
    amount: u64,
) -> Result<DemoLedger, String> {
    let path = data_path(&app)?;
    with_ledger(&path, |ledger| {
        spend(ledger, amount)?;
        Ok(ledger.clone())
    })
}

#[tauri::command]
pub fn community_compute_demo_reset(
    app: tauri::AppHandle,
    host: tauri::State<'_, ComputeHost>,
) -> Result<DemoLedger, String> {
    let status = host.status()?;
    let path = data_path(&app)?;
    with_ledger(&path, |ledger| {
        *ledger = DemoLedger::default();
        ledger.legacy_seeded = true;
        if status.preferred_mode == "serve" && status.state == "running" {
            ledger.last_generation = Some(status.generation);
            ledger.last_tokens = status
                .usage
                .as_ref()
                .map(|usage| usage.tokens_served)
                .unwrap_or(0);
            ledger.tokens_served = ledger.last_tokens;
        }
        Ok(ledger.clone())
    })
}

#[tauri::command]
pub fn community_compute_demo_seed_legacy(
    app: tauri::AppHandle,
    amount: u64,
) -> Result<DemoLedger, String> {
    let path = data_path(&app)?;
    with_ledger(&path, |ledger| {
        if !ledger.legacy_seeded {
            if amount > 0 && amount <= 1_000_000 {
                ledger.consumer_balance = ledger.consumer_balance.saturating_add(amount as i64);
                append(ledger, "demo-top-up", amount as i64, 0, 0);
            }
            ledger.legacy_seeded = true;
        }
        Ok(ledger.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_usage_moves_simulated_credits_to_provider_once() {
        let mut ledger = DemoLedger::default();
        ledger.consumer_balance = 10;
        settle_usage(&mut ledger, 1, 900);
        settle_usage(&mut ledger, 1, 1_800);
        assert_eq!(ledger.provider_balance, 1);
        assert_eq!(ledger.consumer_balance, 9);
        assert_eq!(ledger.token_remainder, 800);
        settle_usage(&mut ledger, 1, 1_800);
        assert_eq!(ledger.provider_balance, 1);
        settle_usage(&mut ledger, 1, 2_200);
        assert_eq!(ledger.provider_balance, 2);
        assert_eq!(ledger.consumer_balance, 8);
    }

    #[test]
    fn a_new_runtime_counter_resets_its_baseline_without_duplicating_credits() {
        let mut ledger = DemoLedger::default();
        settle_usage(&mut ledger, 1, 2_000);
        settle_usage(&mut ledger, 2, 0);
        settle_usage(&mut ledger, 2, 1_000);
        assert_eq!(ledger.provider_balance, 3);
    }

    #[test]
    fn manual_demo_spend_moves_consumer_credits_to_provider() {
        let mut ledger = DemoLedger::default();
        ledger.consumer_balance = 10;
        spend(&mut ledger, 2).unwrap();
        assert_eq!(ledger.consumer_balance, 8);
        assert_eq!(ledger.provider_balance, 2);
        assert_eq!(ledger.entries.last().unwrap().kind, "demo-spend");
        assert!(spend(&mut ledger, 9).is_err());
    }

    #[test]
    fn local_store_is_shared_across_wallet_updates() {
        let dir = std::env::temp_dir().join(format!("buzz-demo-credits-{}", uuid::Uuid::new_v4()));
        let path = dir.join("ledger.json");
        with_ledger(&path, |ledger| {
            ledger.consumer_balance = 10;
            spend(ledger, 2)?;
            Ok(())
        })
        .unwrap();
        let snapshot = with_ledger(&path, |ledger| Ok(ledger.clone())).unwrap();
        assert_eq!(snapshot.consumer_balance, 8);
        assert_eq!(snapshot.provider_balance, 2);
        fs::remove_dir_all(dir).unwrap();
    }
}
