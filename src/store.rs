//! The squad database: peer profiles, conversations, per-viewer chat deletions, and the
//! notification queue that the channel and `watch` drain.
//!
//! One database per squad workspace, at ~/.local/cache/peers/<dashed path>/bd.sql. A message is
//! stored once; each side's view of a chat starts after the point it last deleted the chat.

use crate::util::*;
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const PAGE_SIZE: i64 = 20;
const SCHEMA_VERSION: i64 = 1;

const SCHEMA_V1: &str = "
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS profiles (
    address    TEXT PRIMARY KEY,
    runtime    TEXT NOT NULL,
    name       TEXT,
    role       TEXT,
    cwd        TEXT,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender      TEXT NOT NULL,
    recipient   TEXT NOT NULL,
    sender_name TEXT,
    sender_role TEXT NOT NULL,
    kind        TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    reply_to    TEXT,
    body        TEXT NOT NULL,
    sent_at     INTEGER NOT NULL,
    read_at     INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages(sender, recipient, id);
CREATE INDEX IF NOT EXISTS messages_unread ON messages(recipient, read_at);
CREATE TABLE IF NOT EXISTS cleared (
    owner     TEXT NOT NULL,
    peer      TEXT NOT NULL,
    before_id INTEGER NOT NULL,
    PRIMARY KEY (owner, peer)
);
CREATE TABLE IF NOT EXISTS notifications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    owner        TEXT NOT NULL,
    text         TEXT NOT NULL,
    meta         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_owner ON notifications(owner, delivered_at);
CREATE TABLE IF NOT EXISTS listeners (
    owner      TEXT PRIMARY KEY,
    pid        INTEGER NOT NULL,
    started_at INTEGER NOT NULL
);
PRAGMA user_version = 1;
COMMIT;
";

pub fn cache_root() -> PathBuf {
    env_nonempty("PEERS_CACHE").map(PathBuf::from).unwrap_or_else(|| home().join(".local/cache/peers"))
}

/// A directory path as one folder name, the way Claude Code names its project folders:
/// every character other than a letter, digit or dash becomes a dash.
pub fn dashed(p: &Path) -> String {
    p.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

pub fn db_dir(root: &Path) -> PathBuf {
    cache_root().join(dashed(root))
}

fn db(e: rusqlite::Error) -> String {
    format!("database error: {e}")
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub address: String,
    pub runtime: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub cwd: Option<String>,
    pub updated_at: i64,
}

impl Profile {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Profile> {
        Ok(Profile {
            address: r.get(0)?,
            runtime: r.get(1)?,
            name: r.get(2)?,
            role: r.get(3)?,
            cwd: r.get(4)?,
            updated_at: r.get(5)?,
        })
    }
}

pub struct NewMessage<'a> {
    pub sender: &'a str,
    pub recipient: &'a str,
    pub sender_name: Option<&'a str>,
    pub sender_role: &'a str,
    pub kind: &'a str,
    pub seq: i64,
    pub reply_to: Option<&'a str>,
    pub body: &'a str,
}

#[derive(Clone, Debug)]
pub struct Msg {
    pub id: i64,
    pub sender: String,
    pub recipient: String,
    pub sender_name: Option<String>,
    pub sender_role: String,
    pub kind: String,
    pub seq: i64,
    pub reply_to: Option<String>,
    pub body: String,
    pub sent_at: i64,
    pub read_at: Option<i64>,
}

const MSG_COLS: &str = "id, sender, recipient, sender_name, sender_role, kind, seq, reply_to, body, sent_at, read_at";

impl Msg {
    fn from_row(r: &Row<'_>) -> rusqlite::Result<Msg> {
        Ok(Msg {
            id: r.get(0)?,
            sender: r.get(1)?,
            recipient: r.get(2)?,
            sender_name: r.get(3)?,
            sender_role: r.get(4)?,
            kind: r.get(5)?,
            seq: r.get(6)?,
            reply_to: r.get(7)?,
            body: r.get(8)?,
            sent_at: r.get(9)?,
            read_at: r.get(10)?,
        })
    }
}

pub struct Chat {
    pub peer: String,
    pub total: i64,
    pub unread: i64,
    pub last: Msg,
    pub profile: Option<Profile>,
}

pub struct Store {
    conn: Connection,
    /// The squad workspace (or directory) this database belongs to.
    pub root: PathBuf,
    /// Where the database lives; logs and queues of runs started for its members go here too.
    pub dir: PathBuf,
}

/// The messages of one chat as `owner` sees it: ?1 is the owner, ?2 the peer.
const CHAT_WHERE: &str = "((sender = ?1 AND recipient = ?2) OR (sender = ?2 AND recipient = ?1)) \
     AND id > COALESCE((SELECT before_id FROM cleared WHERE owner = ?1 AND peer = ?2), 0)";

impl Store {
    pub fn open(root: &Path) -> Res<Store> {
        let dir = db_dir(root);
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let path = dir.join("bd.sql");
        let conn = Connection::open(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
        conn.busy_timeout(Duration::from_secs(15)).map_err(db)?;
        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(())).map_err(db)?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(db)?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "{} has schema version {version}, newer than this peers understands ({SCHEMA_VERSION}); \
                 install the newer peers",
                path.display()
            ));
        }
        if version < 1 {
            conn.execute_batch(SCHEMA_V1).map_err(db)?;
        }
        Ok(Store { conn, root: root.to_path_buf(), dir })
    }

    /// Adds or refreshes a profile. With `overwrite`, its name and role are replaced, even by
    /// none; otherwise only missing values are filled in. A known directory is always kept.
    pub fn upsert_profile(&self, p: &Profile, overwrite: bool) -> Res<()> {
        self.conn
            .execute(
                "INSERT INTO profiles (address, runtime, name, role, cwd, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(address) DO UPDATE SET
                   name = CASE WHEN ?7 THEN excluded.name ELSE COALESCE(excluded.name, profiles.name) END,
                   role = CASE WHEN ?7 THEN excluded.role ELSE COALESCE(excluded.role, profiles.role) END,
                   cwd = COALESCE(excluded.cwd, profiles.cwd),
                   updated_at = CASE WHEN ?7 THEN excluded.updated_at ELSE profiles.updated_at END",
                params![p.address, p.runtime, p.name, p.role, p.cwd, p.updated_at, overwrite],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn profile(&self, address: &str) -> Res<Option<Profile>> {
        self.conn
            .query_row(
                "SELECT address, runtime, name, role, cwd, updated_at FROM profiles WHERE address = ?1",
                [address],
                Profile::from_row,
            )
            .optional()
            .map_err(db)
    }

    pub fn contacts(&self, me: &str) -> Res<Vec<Profile>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT address, runtime, name, role, cwd, updated_at FROM profiles WHERE address != ?1
                 ORDER BY updated_at DESC, address",
            )
            .map_err(db)?;
        let rows = stmt.query_map([me], Profile::from_row).map_err(db)?;
        rows.collect::<Result<_, _>>().map_err(db)
    }

    pub fn insert_message(&self, m: &NewMessage<'_>) -> Res<i64> {
        self.conn
            .execute(
                "INSERT INTO messages (sender, recipient, sender_name, sender_role, kind, seq, reply_to, body, sent_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![m.sender, m.recipient, m.sender_name, m.sender_role, m.kind, m.seq, m.reply_to, m.body, now_ms()],
            )
            .map_err(db)?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Unread messages to `owner` across its whole inbox, leaving out chats it deleted.
    pub fn unread_total(&self, owner: &str) -> Res<i64> {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM messages m WHERE m.recipient = ?1 AND m.read_at IS NULL
                 AND m.id > COALESCE((SELECT before_id FROM cleared WHERE owner = ?1 AND peer = m.sender), 0)",
                [owner],
                |r| r.get(0),
            )
            .map_err(db)
    }

    pub fn chat_count(&self, owner: &str, peer: &str) -> Res<i64> {
        self.conn
            .query_row(&format!("SELECT COUNT(*) FROM messages WHERE {CHAT_WHERE}"), [owner, peer], |r| r.get(0))
            .map_err(db)
    }

    /// Page `page` of a chat (1 is the newest), oldest message first.
    pub fn page(&self, owner: &str, peer: &str, page: i64) -> Res<Vec<Msg>> {
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {MSG_COLS} FROM messages WHERE {CHAT_WHERE} ORDER BY id DESC LIMIT ?3 OFFSET ?4"))
            .map_err(db)?;
        let rows = stmt
            .query_map(params![owner, peer, PAGE_SIZE, (page - 1) * PAGE_SIZE], Msg::from_row)
            .map_err(db)?;
        let mut msgs: Vec<Msg> = rows.collect::<Result<_, _>>().map_err(db)?;
        msgs.reverse();
        Ok(msgs)
    }

    /// Unread messages from `peer` to `owner` older than message `id`.
    pub fn unread_before(&self, owner: &str, peer: &str, id: i64) -> Res<i64> {
        self.conn
            .query_row(
                &format!("SELECT COUNT(*) FROM messages WHERE {CHAT_WHERE} AND recipient = ?1 AND read_at IS NULL AND id < ?3"),
                params![owner, peer, id],
                |r| r.get(0),
            )
            .map_err(db)
    }

    pub fn mark_read(&mut self, owner: &str, ids: &[i64]) -> Res<()> {
        let tx = self.conn.transaction().map_err(db)?;
        {
            let mut stmt = tx
                .prepare("UPDATE messages SET read_at = ?1 WHERE id = ?2 AND recipient = ?3 AND read_at IS NULL")
                .map_err(db)?;
            let now = now_ms();
            for id in ids {
                stmt.execute(params![now, id, owner]).map_err(db)?;
            }
        }
        tx.commit().map_err(db)
    }

    /// Every chat `owner` can see, the most recent first.
    pub fn chats(&self, owner: &str) -> Res<Vec<Chat>> {
        let mut stmt = self
            .conn
            .prepare(
                "WITH mine AS (
                   SELECT m.id, m.recipient, m.read_at,
                          CASE WHEN m.sender = ?1 THEN m.recipient ELSE m.sender END AS peer
                   FROM messages m WHERE m.sender = ?1 OR m.recipient = ?1)
                 SELECT peer, COUNT(*), SUM(CASE WHEN recipient = ?1 AND read_at IS NULL THEN 1 ELSE 0 END), MAX(id)
                 FROM mine
                 WHERE id > COALESCE((SELECT before_id FROM cleared WHERE owner = ?1 AND peer = mine.peer), 0)
                 GROUP BY peer ORDER BY MAX(id) DESC",
            )
            .map_err(db)?;
        let rows: Vec<(String, i64, i64, i64)> = stmt
            .query_map([owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(db)?
            .collect::<Result<_, _>>()
            .map_err(db)?;
        let mut chats = vec![];
        for (peer, total, unread, last_id) in rows {
            let last = self
                .conn
                .query_row(&format!("SELECT {MSG_COLS} FROM messages WHERE id = ?1"), [last_id], Msg::from_row)
                .map_err(db)?;
            let profile = self.profile(&peer)?;
            chats.push(Chat { peer, total, unread, last, profile });
        }
        Ok(chats)
    }

    /// Hides every message of the chat so far from `owner` only; returns how many were visible.
    pub fn delete_chat(&self, owner: &str, peer: &str) -> Res<i64> {
        let (count, max_id): (i64, Option<i64>) = self
            .conn
            .query_row(&format!("SELECT COUNT(*), MAX(id) FROM messages WHERE {CHAT_WHERE}"), [owner, peer], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db)?;
        if let Some(max_id) = max_id {
            self.conn
                .execute(
                    "INSERT INTO cleared (owner, peer, before_id) VALUES (?1, ?2, ?3)
                     ON CONFLICT(owner, peer) DO UPDATE SET before_id = excluded.before_id",
                    params![owner, peer, max_id],
                )
                .map_err(db)?;
        }
        Ok(count)
    }

    pub fn push_notification(&self, owner: &str, text: &str, meta: &serde_json::Value) -> Res<()> {
        self.conn
            .execute(
                "INSERT INTO notifications (owner, text, meta, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![owner, text, meta.to_string(), now_ms()],
            )
            .map_err(db)?;
        Ok(())
    }

    /// Takes every notification not yet delivered to `owner`, oldest first, and marks it delivered.
    pub fn take_notifications(&mut self, owner: &str) -> Res<Vec<(String, serde_json::Value)>> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(db)?;
        let taken: Vec<(i64, String, String)> = {
            let mut stmt = tx
                .prepare("SELECT id, text, meta FROM notifications WHERE owner = ?1 AND delivered_at IS NULL ORDER BY id")
                .map_err(db)?;
            let rows = stmt.query_map([owner], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(db)?;
            rows.collect::<Result<_, _>>().map_err(db)?
        };
        if let Some((last, _, _)) = taken.last() {
            tx.execute(
                "UPDATE notifications SET delivered_at = ?1 WHERE owner = ?2 AND delivered_at IS NULL AND id <= ?3",
                params![now_ms(), owner, last],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(taken
            .into_iter()
            .map(|(_, text, meta)| (text, serde_json::from_str(&meta).unwrap_or(serde_json::Value::Null)))
            .collect())
    }

    pub fn set_listener(&self, owner: &str, pid: u32) -> Res<()> {
        self.conn
            .execute(
                "INSERT INTO listeners (owner, pid, started_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(owner) DO UPDATE SET pid = excluded.pid, started_at = excluded.started_at",
                params![owner, pid, now_ms()],
            )
            .map_err(db)?;
        Ok(())
    }

    pub fn clear_listener(&self, owner: &str, pid: u32) -> Res<()> {
        self.conn.execute("DELETE FROM listeners WHERE owner = ?1 AND pid = ?2", params![owner, pid]).map_err(db)?;
        Ok(())
    }

    /// Whether a peers channel is running for `owner`'s session, which proves the session is live.
    pub fn listener_alive(&self, owner: &str) -> Res<bool> {
        let pid: Option<i64> = self
            .conn
            .query_row("SELECT pid FROM listeners WHERE owner = ?1", [owner], |r| r.get(0))
            .optional()
            .map_err(db)?;
        // A channel killed with its session leaves its row behind; its pid counts only while it is
        // still a peers process, not another program that reused the number.
        Ok(pid.is_some_and(|pid| {
            process_alive(pid) && crate::identity::basename_lower(&quiet("ps", &["-o", "comm=", "-p", &pid.to_string()])) == "peers"
        }))
    }
}
