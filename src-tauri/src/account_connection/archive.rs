//! New-app Activity only: original encrypted envelopes, never rendered plaintext.
use super::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};
const AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_RECORDS: i64 = 20_000;
const MAX_BYTES: i64 = 128 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 2 * 1024 * 1024;
const ERROR: &str = "Saved Activity unavailable; existing data was left unchanged";
pub(super) struct Archive {
    root: PathBuf,
    db: Mutex<Option<Connection>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedRow {
    pub id: String,
    pub agent: String,
    pub received_at: i64,
    pub plaintext: String,
    pub kind: String,
}
pub(super) struct EncryptedRow {
    pub sequence: i64,
    pub id: String,
    pub received_at: i64,
    pub raw: String,
    pub channels: Vec<String>,
}
pub(super) struct Page {
    pub rows: Vec<EncryptedRow>,
    pub more: bool,
    pub trimmed: bool,
    pub revision: i64,
}
fn regular(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(ERROR.into()),
    }
}
impl Archive {
    pub fn maintain(&self) -> Result<()> {
        self.with(|db| {
            prune(
                db,
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    .min(i64::MAX as u128) as i64,
            )
        })
    }
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            db: Mutex::new(None),
        }
    }
    fn with<T>(&self, operation: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        let mut slot = self.db.lock().map_err(|_| ERROR)?;
        if slot.is_none() {
            buzz_agent_controller::connection::private_directory(&self.root)?;
            let path = self.root.join("activity.sqlite");
            regular(&path)?;
            regular(&self.root.join("activity.sqlite-journal"))?;
            if self.root.join("activity.sqlite-wal").exists()
                || self.root.join("activity.sqlite-shm").exists()
            {
                return Err(ERROR.into());
            }
            let db = Connection::open(&path).map_err(|_| ERROR)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                    .map_err(|_| ERROR)?;
            }
            // No WAL or disk temp growth. Main DB120MiB plus worst-case full rollback
            // journal120MiB leaves16MiB for headers/metadata below the256MiB directory cap.
            // Physical capacity can be reached before the logical128MiB payload ceiling.
            db.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA page_size=4096; PRAGMA max_page_count=30720; PRAGMA secure_delete=ON;").map_err(|_|ERROR)?;
            let page_size: i64 = db
                .query_row("PRAGMA page_size", [], |r| r.get(0))
                .map_err(|_| ERROR)?;
            if page_size != 4096 {
                return Err(ERROR.into());
            }
            let version: i64 = db
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(|_| ERROR)?;
            if version == 0 {
                let tables: i64 = db
                    .query_row(
                        "SELECT count(*) FROM sqlite_master WHERE type='table'",
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|_| ERROR)?;
                if tables != 0 {
                    return Err(ERROR.into());
                }
                db.execute_batch("BEGIN IMMEDIATE; CREATE TABLE frames(sequence INTEGER PRIMARY KEY AUTOINCREMENT,viewer TEXT NOT NULL,origin TEXT NOT NULL,id TEXT NOT NULL,agent TEXT NOT NULL,received INTEGER NOT NULL,bytes INTEGER NOT NULL,raw TEXT NOT NULL,UNIQUE(viewer,origin,id)); CREATE INDEX scope_agent ON frames(viewer,origin,agent,sequence); CREATE TABLE channels(sequence INTEGER NOT NULL,channel TEXT NOT NULL,PRIMARY KEY(sequence,channel)); CREATE INDEX channel_scope ON channels(channel,sequence); CREATE TABLE gaps(viewer TEXT NOT NULL,origin TEXT NOT NULL,PRIMARY KEY(viewer,origin)); CREATE TABLE revision(value INTEGER NOT NULL); INSERT INTO revision VALUES(0); CREATE TABLE deleted(viewer TEXT NOT NULL,origin TEXT NOT NULL,cutoff INTEGER NOT NULL,PRIMARY KEY(viewer,origin)); PRAGMA user_version=1; COMMIT;").map_err(|_|ERROR)?;
            } else if version != 1 {
                return Err(ERROR.into());
            }
            *slot = Some(db);
        }
        let db = slot.as_mut().ok_or(ERROR)?;
        operation(db)
    }
    #[cfg(test)]
    pub fn append(
        &self,
        principal: (&str, &str),
        id: &str,
        agent: &str,
        raw: &str,
        channels: &[String],
        now: i64,
    ) -> Result<()> {
        self.append_checked(principal, id, agent, raw, channels, (now, || true))
    }
    pub fn append_checked(
        &self,
        principal: (&str, &str),
        id: &str,
        agent: &str,
        raw: &str,
        channels: &[String],
        admission: (i64, impl Fn() -> bool),
    ) -> Result<()> {
        let (now, current) = admission;
        let (viewer, origin) = principal;
        if raw.len() > 128 * 1024 || channels.len() > 128 {
            return Err(ERROR.into());
        }
        self.with(|db|{
   prune(db,now)?;
   let raw_time=serde_json::from_str::<serde_json::Value>(raw).ok().and_then(|v|v["created_at"].as_i64()).ok_or(ERROR)?;
   let cutoff:Option<i64>=db.query_row("SELECT cutoff FROM deleted WHERE viewer=? AND origin=?",params![viewer,origin],|r|r.get(0)).optional().map_err(|_|ERROR)?;
   if cutoff.is_some_and(|cutoff|raw_time<=cutoff){return Err("Activity was not saved during the post-delete replay guard (up to five minutes)".into());}
   if !current(){return Err(ERROR.into());}
   ensure_space(db,raw.len())?;
   let tx=db.transaction().map_err(|_|ERROR)?;
   tx.execute("INSERT OR IGNORE INTO frames(viewer,origin,id,agent,received,bytes,raw) VALUES(?,?,?,?,?,?,?)",params![viewer,origin,id,agent,now,raw.len() as i64,raw]).map_err(|_|ERROR)?;
   let seq:i64=tx.query_row("SELECT sequence FROM frames WHERE viewer=? AND origin=? AND id=?",params![viewer,origin,id],|r|r.get(0)).map_err(|_|ERROR)?;
   for channel in channels {tx.execute("INSERT OR IGNORE INTO channels VALUES(?,?)",params![seq,channel]).map_err(|_|ERROR)?;}
   if !current(){return Err(ERROR.into());}
   tx.execute("UPDATE revision SET value=value+1",[]).map_err(|_|ERROR)?;
   tx.commit().map_err(|_|ERROR)?;
   prune(db,now)
  })
    }
    pub fn page(
        &self,
        viewer: &str,
        origin: &str,
        agent: &str,
        channel: Option<&str>,
        before: Option<i64>,
        now: i64,
    ) -> Result<Page> {
        self.with(|db|{
   prune(db,now)?;
   let mut query=db.prepare("SELECT sequence,id,received,raw FROM frames f WHERE viewer=?1 AND origin=?2 AND agent=?3 AND sequence<?4 AND (?5 IS NULL OR EXISTS(SELECT 1 FROM channels c WHERE c.sequence=f.sequence AND c.channel=?5)) ORDER BY sequence DESC LIMIT 101").map_err(|_|ERROR)?;
   let values=query.query_map(params![viewer,origin,agent,before.unwrap_or(i64::MAX),channel],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?))).map_err(|_|ERROR)?.collect::<std::result::Result<Vec<_>,_>>().map_err(|_|ERROR)?;
   let mut rows=Vec::new();let mut size=0;let mut more=false;
   for(sequence,id,received_at,raw)in values{
    if rows.len()==100||size+raw.len()>MAX_PAGE_BYTES{more=true;break;}size+=raw.len();
    let mut channels=db.prepare("SELECT channel FROM channels WHERE sequence=?").map_err(|_|ERROR)?;
    let channels=channels.query_map([sequence],|r|r.get::<_,String>(0)).map_err(|_|ERROR)?.collect::<std::result::Result<Vec<_>,_>>().map_err(|_|ERROR)?;
    rows.push(EncryptedRow{sequence,id,received_at,raw,channels});
   }
   let trimmed=db.query_row("SELECT 1 FROM gaps WHERE viewer=? AND origin=?",params![viewer,origin],|_|Ok(())).optional().map_err(|_|ERROR)?.is_some();
   let revision=db.query_row("SELECT value FROM revision",[],|r|r.get(0)).map_err(|_|ERROR)?;
   Ok(Page{rows,more,trimmed,revision})
  })
    }
    pub fn delete(&self, viewer: &str, origin: &str, now: i64) -> Result<()> {
        self.with(|db|{
  let tx=db.transaction().map_err(|_|ERROR)?;
  tx.execute("INSERT INTO deleted VALUES(?,?,?) ON CONFLICT(viewer,origin) DO UPDATE SET cutoff=MAX(cutoff,excluded.cutoff)",params![viewer,origin,now/1000+300]).map_err(|_|ERROR)?;
  tx.execute("DELETE FROM channels WHERE sequence IN (SELECT sequence FROM frames WHERE viewer=? AND origin=?)",params![viewer,origin]).map_err(|_|ERROR)?;
  tx.execute("DELETE FROM frames WHERE viewer=? AND origin=?",params![viewer,origin]).map_err(|_|ERROR)?;
  tx.execute("DELETE FROM gaps WHERE viewer=? AND origin=?",params![viewer,origin]).map_err(|_|ERROR)?;
  tx.execute("UPDATE revision SET value=value+1",[]).map_err(|_|ERROR)?;tx.commit().map_err(|_|ERROR)?;Ok(())
 })
    }
    pub fn mark_gap(&self, viewer: &str, origin: &str) -> Result<()> {
        self.with(|db| {
            db.execute(
                "INSERT OR IGNORE INTO gaps VALUES(?,?)",
                params![viewer, origin],
            )
            .map_err(|_| ERROR)?;
            Ok(())
        })
    }
    pub fn purge_channel(&self, viewer: &str, origin: &str, channel: &str) -> Result<()> {
        self.with(|db|{
  let tx=db.transaction().map_err(|_|ERROR)?;
  tx.execute("INSERT OR IGNORE INTO gaps VALUES(?,?)",params![viewer,origin]).map_err(|_|ERROR)?;
  tx.execute("DELETE FROM frames WHERE viewer=? AND origin=? AND sequence IN (SELECT sequence FROM channels WHERE channel=?)",params![viewer,origin,channel]).map_err(|_|ERROR)?;
  tx.execute("DELETE FROM channels WHERE sequence NOT IN (SELECT sequence FROM frames)",[]).map_err(|_|ERROR)?;tx.execute("UPDATE revision SET value=value+1",[]).map_err(|_|ERROR)?;tx.commit().map_err(|_|ERROR)?;Ok(())
 })
    }
}
fn ensure_space(db: &mut Connection, incoming: usize) -> Result<()> {
    loop {
        let pages: i64 = db
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .map_err(|_| ERROR)?;
        let free: i64 = db
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .map_err(|_| ERROR)?;
        let max: i64 = db
            .query_row("PRAGMA max_page_count", [], |r| r.get(0))
            .map_err(|_| ERROR)?;
        let needed = (incoming as i64 / 4096) + 32;
        if max - pages + free > needed {
            return Ok(());
        }
        let old: Option<(i64, String, String)> = db
            .query_row(
                "SELECT sequence,viewer,origin FROM frames ORDER BY sequence LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|_| ERROR)?;
        let Some((seq, viewer, origin)) = old else {
            return Err(ERROR.into());
        };
        let tx = db.transaction().map_err(|_| ERROR)?;
        tx.execute(
            "INSERT OR IGNORE INTO gaps VALUES(?,?)",
            params![viewer, origin],
        )
        .map_err(|_| ERROR)?;
        tx.execute("DELETE FROM channels WHERE sequence=?", [seq])
            .map_err(|_| ERROR)?;
        tx.execute("DELETE FROM frames WHERE sequence=?", [seq])
            .map_err(|_| ERROR)?;
        tx.execute("UPDATE revision SET value=value+1", [])
            .map_err(|_| ERROR)?;
        tx.commit().map_err(|_| ERROR)?;
    }
}
fn prune(db: &mut Connection, now: i64) -> Result<()> {
    let tx = db.transaction().map_err(|_| ERROR)?;
    tx.execute(
        "INSERT OR IGNORE INTO gaps SELECT DISTINCT viewer,origin FROM frames WHERE received<?",
        [now.saturating_sub(AGE_MS)],
    )
    .map_err(|_| ERROR)?;
    tx.execute(
        "DELETE FROM channels WHERE sequence IN (SELECT sequence FROM frames WHERE received<?)",
        [now.saturating_sub(AGE_MS)],
    )
    .map_err(|_| ERROR)?;
    let expired = tx
        .execute(
            "DELETE FROM frames WHERE received<?",
            [now.saturating_sub(AGE_MS)],
        )
        .map_err(|_| ERROR)?;
    if expired > 0 {
        tx.execute("UPDATE revision SET value=value+1", [])
            .map_err(|_| ERROR)?;
    }
    let (mut count, mut bytes): (i64, i64) = tx
        .query_row(
            "SELECT count(*),COALESCE(sum(bytes),0) FROM frames",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| ERROR)?;
    loop {
        let oldest:Option<(i64,String,String,i64,i64)>=tx.query_row("SELECT sequence,viewer,origin,received,bytes FROM frames ORDER BY sequence LIMIT 1",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional().map_err(|_|ERROR)?;
        let Some((seq, viewer, origin, received, size)) = oldest else {
            break;
        };
        if received >= now.saturating_sub(AGE_MS) && count <= MAX_RECORDS && bytes <= MAX_BYTES {
            break;
        }
        tx.execute(
            "INSERT OR IGNORE INTO gaps VALUES(?,?)",
            params![viewer, origin],
        )
        .map_err(|_| ERROR)?;
        tx.execute("DELETE FROM channels WHERE sequence=?", [seq])
            .map_err(|_| ERROR)?;
        tx.execute("DELETE FROM frames WHERE sequence=?", [seq])
            .map_err(|_| ERROR)?;
        tx.execute("UPDATE revision SET value=value+1", [])
            .map_err(|_| ERROR)?;
        count -= 1;
        bytes -= size;
    }
    tx.commit().map_err(|_| ERROR)?;
    Ok(())
}

#[cfg(test)]
mod tests;
