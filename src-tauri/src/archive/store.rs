use super::Result;
use crate::relay::agent::AgentEvent;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;

pub(super) struct Store(Connection, i64, PathBuf);
fn database<T>(result: rusqlite::Result<T>) -> Result<T> {
    result.map_err(|_| "Local archive storage failed; retry without deleting the archive".into())
}
fn valid_kind(kind: u16) -> Result<()> {
    if matches!(kind, 24200 | 44200) {
        Ok(())
    } else {
        Err("Unsupported archive kind".into())
    }
}
impl Store {
    pub(super) fn open(path: PathBuf) -> Result<Self> {
        let parent = path.parent().ok_or("Archive location unavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "Archive directory unavailable")?;
        let connection = database(Connection::open(&path))?;
        database(connection.busy_timeout(std::time::Duration::from_secs(2)))?;
        // On a new database auto-vacuum must be configured before BEGIN creates
        // its header. Switching from NONE only sets a connection flag: existing
        // databases cannot change mode without VACUUM, which we never run here.
        let vacuum: u32 = database(connection.query_row("PRAGMA auto_vacuum", [], |r| r.get(0)))?;
        if vacuum == 0 {
            database(connection.execute_batch("PRAGMA auto_vacuum=INCREMENTAL"))?;
        }
        // Lock before checking the version. An older process may wait behind a
        // migration, but must never downgrade or otherwise mutate a newer file.
        database(connection.execute_batch("BEGIN IMMEDIATE"))?;
        let version: u32 = database(connection.query_row("PRAGMA user_version", [], |r| r.get(0)))?;
        if version > 1 {
            database(connection.execute_batch("ROLLBACK"))?;
            return Err("Archive was created by a newer app".into());
        }
        if version == 0 {
            database(
                connection.execute_batch(include_str!("../../../src/features/archive/schema.sql")),
            )?;
            database(connection.execute_batch("PRAGMA user_version=1"))?;
        }
        database(
            connection.execute_batch("COMMIT; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;"),
        )?;
        Ok(Self(connection, 0, path))
    }

    pub(super) fn seed(&self, viewer: &str, community: &str) -> Result<()> {
        database(self.0.execute(
            "INSERT OR IGNORE INTO archive_partitions(viewer,community) VALUES (?1,?2)",
            params![viewer, community],
        ))?;
        for (name, kinds, days, budget) in [
            ("observer", "[24200]", 30, 512 * 1024 * 1024),
            ("metrics", "[44200]", 90, 64 * 1024 * 1024),
        ] {
            database(self.0.execute("INSERT OR IGNORE INTO archive_subscriptions(viewer,community,name,scope,value,kinds,days,budget) VALUES (?1,?2,?3,'p',?1,?4,?5,?6)",params![viewer,community,name,kinds,days,budget]))?;
        }
        Ok(())
    }
    fn revision(&self, viewer: &str, community: &str) -> Result<i64> {
        database(self.0.query_row(
            "SELECT revision FROM archive_partitions WHERE viewer=?1 AND community=?2",
            params![viewer, community],
            |r| r.get(0),
        ))
    }
    pub(super) fn settings(&self, viewer: &str, community: &str) -> Result<Value> {
        let (observer, days): (bool,u32) = database(self.0.query_row("SELECT enabled,days FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name='observer'",params![viewer,community],|r| Ok((r.get(0)?,r.get(1)?))))?;
        let metrics: bool = database(self.0.query_row("SELECT enabled FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name='metrics'",params![viewer,community],|r|r.get(0)))?;
        Ok(
            json!({"observer":observer,"metrics":metrics,"observerDays":days,"revision":self.revision(viewer,community)?,"location":"device","path":self.2.to_string_lossy(),"bytes":database(self.0.query_row("SELECT COALESCE(SUM(bytes),0) FROM archive_events WHERE viewer=?1 AND community=?2",params![viewer,community],|r|r.get::<_,i64>(0)))?}),
        )
    }
    pub(super) fn configure(
        &mut self,
        viewer: &str,
        community: &str,
        observer: bool,
        metrics: bool,
        days: u32,
        revision: i64,
        now: i64,
    ) -> Result<Value> {
        if !(1..=90).contains(&days) {
            return Err("Observer retention must be 1 to 90 days".into());
        }
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        let changed = database(tx.execute("UPDATE archive_partitions SET revision=revision+1 WHERE viewer=?1 AND community=?2 AND revision=?3",params![viewer,community,revision]))?;
        if changed != 1 {
            return Err("Archive settings changed; reload and retry".into());
        }
        database(tx.execute("UPDATE archive_subscriptions SET enabled=?3, days=?4 WHERE viewer=?1 AND community=?2 AND name='observer'", params![viewer,community,observer,days]))?;
        database(tx.execute("UPDATE archive_subscriptions SET enabled=?3 WHERE viewer=?1 AND community=?2 AND name='metrics'",params![viewer,community,metrics]))?;
        database(tx.commit())?;
        self.1 = 0;
        self.prune(now)?;
        self.settings(viewer, community)
    }
    fn vacuum(&self, pages: u32) -> Result<()> {
        // This pragma yields one row per reclaimed page. execute_batch steps it
        // only once; drain it or a large clear reclaims just a single page.
        let mut statement = database(
            self.0
                .prepare(&format!("PRAGMA incremental_vacuum({pages})")),
        )?;
        let mut rows = database(statement.query([]))?;
        while database(rows.next())?.is_some() {}
        Ok(())
    }
    pub(super) fn prune(&mut self, now: i64) -> Result<()> {
        if now < self.1 + 60 {
            return Ok(());
        }
        // Across inactive partitions too. Indexed expiry, enforced on every host operation.
        database(self.0.execute("DELETE FROM archive_events WHERE seq IN (SELECT e.seq FROM archive_events e JOIN archive_subscriptions s ON s.viewer=e.viewer AND s.community=e.community AND s.name=e.subscription WHERE e.created <= ?1-s.days*86400)",[now]))?;
        let _ = self.vacuum(64);
        self.1 = now;
        Ok(())
    }
    pub(super) fn ingest(
        &mut self,
        viewer: &str,
        community: &str,
        event: &AgentEvent,
        revision: i64,
        now: i64,
    ) -> Result<()> {
        let raw = serde_json::to_string(event).map_err(|_| "Invalid archive envelope")?;
        let name = if event.kind == 24200 {
            "observer"
        } else {
            "metrics"
        };
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        let current: i64 = database(tx.query_row(
            "SELECT revision FROM archive_partitions WHERE viewer=?1 AND community=?2",
            params![viewer, community],
            |r| r.get(0),
        ))?;
        if current != revision {
            return Err("Archive revision changed".into());
        }
        let (enabled, budget): (bool,i64) = database(tx.query_row("SELECT enabled,budget FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name=?3",params![viewer,community,name],|r|Ok((r.get(0)?,r.get(1)?))))?;
        if enabled {
            database(tx.execute("INSERT OR IGNORE INTO archive_events(viewer,community,subscription,id,agent,kind,created,received,bytes,envelope) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![viewer,community,name,event.id,event.pubkey,event.kind,event.created_at as i64,now,raw.len() as i64,raw]))?;
            // Byte quotas, not frame counts. A single agent cannot consume the whole pool.
            for (agent, cap) in [(Some(event.pubkey.as_str()), budget / 4), (None, budget)] {
                let used: i64 = database(tx.query_row("SELECT bytes FROM archive_usage WHERE viewer=?1 AND community=?2 AND subscription=?3 AND agent=?4",params![viewer,community,name,agent.unwrap_or("")],|r|r.get(0)))?;
                if used <= cap {
                    continue;
                }
                database(tx.execute("DELETE FROM archive_events WHERE seq IN (SELECT seq FROM (SELECT seq,SUM(bytes) OVER (ORDER BY seq DESC) AS used FROM archive_events WHERE viewer=?1 AND community=?2 AND subscription=?3 AND (?4 IS NULL OR agent=?4)) WHERE used>?5)",params![viewer,community,name,agent,cap]))?;
            }
        }
        database(tx.commit())
    }
    pub(super) fn clear(&mut self, viewer: &str, community: &str, kind: Option<u16>) -> Result<()> {
        if let Some(kind) = kind {
            valid_kind(kind)?;
        }
        let tx = database(
            self.0
                .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate),
        )?;
        database(tx.execute(
            "UPDATE archive_partitions SET revision=revision+1 WHERE viewer=?1 AND community=?2",
            params![viewer, community],
        ))?;
        database(tx.execute("DELETE FROM archive_events WHERE viewer=?1 AND community=?2 AND (?3 IS NULL OR kind=?3)",params![viewer,community,kind]))?;
        database(tx.commit())?;
        // The delete has committed. Optional space reclamation cannot undo it
        // or truthfully turn this into a failed clear; prune will retry vacuum.
        let _ = self.vacuum(0);
        // Move the shrunken database out of WAL before returning; an active
        // reader may defer this, so reclamation cannot decide delete success.
        let _ = self.0.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)");
        Ok(())
    }
    pub(super) fn agents(&self, viewer: &str, community: &str, kind: u16) -> Result<Vec<String>> {
        let mut stmt = database(self.0.prepare("SELECT DISTINCT agent FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3 ORDER BY agent LIMIT 256"))?;
        let rows = database(stmt.query_map(params![viewer, community, kind], |r| r.get(0)))?;
        database(rows.collect())
    }
    pub(super) fn read(
        &self,
        viewer: &str,
        community: &str,
        kind: u16,
        agent: Option<&str>,
        before: Option<i64>,
    ) -> Result<(Vec<(i64, i64, String)>, i64)> {
        valid_kind(kind)?;
        if agent.is_some_and(|s| s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
            || before.is_some_and(|v| v <= 0)
        {
            return Err("Invalid archive page".into());
        }
        let mut stmt = database(self.0.prepare("SELECT seq,received,envelope FROM archive_events WHERE viewer=?1 AND community=?2 AND kind=?3 AND (?4 IS NULL OR agent=?4) AND (?5 IS NULL OR seq<?5) AND created > strftime('%s','now')-(SELECT days*86400 FROM archive_subscriptions WHERE viewer=?1 AND community=?2 AND name=subscription) ORDER BY seq DESC LIMIT 100"))?;
        let rows = database(stmt.query_map(
            params![viewer, community, kind, agent, before],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        ))?;
        let mut result = Vec::new();
        for row in rows {
            let (seq, received, raw) = database(row)?;
            result.push((seq, received, raw));
        }
        Ok((result, self.revision(viewer, community)?))
    }
}
