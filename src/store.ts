// The squad database: peer profiles, conversations, and per-viewer chat deletions.
//
// One database per squad workspace, at ~/.local/cache/peers/<dashed path>/bd.sql.
// A message is stored once; each side's view of a chat starts after the point
// it last deleted the chat. Delivery is always one fire-and-forget
// `herdr agent prompt`, so there is no notification queue: a message whose
// prompt failed or whose peer is not live simply waits in the inbox.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PAGE_SIZE = 20;

const SCHEMA = `
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
PRAGMA user_version = 1;
`;

export function nowMs(): number {
  return Date.now();
}

export function cacheRoot(): string {
  const env = (process.env.PEERS_CACHE ?? "").trim();
  if (env !== "") return env;
  return path.join(os.homedir(), ".local", "cache", "peers");
}

/// A directory path as one folder name: every character other than a letter,
/// digit or dash becomes a dash.
export function dashed(p: string): string {
  return p
    .split("")
    .map((c) => (/[A-Za-z0-9-]/.test(c) ? c : "-"))
    .join("");
}

export function dbDir(root: string): string {
  return path.join(cacheRoot(), dashed(root));
}

export interface Profile {
  address: string;
  runtime: string;
  name: string | null;
  role: string | null;
  cwd: string | null;
  updated_at: number;
}

export interface NewMessage {
  sender: string;
  recipient: string;
  sender_name: string | null;
  sender_role: string;
  kind: string;
  seq: number;
  reply_to: string | null;
  body: string;
}

export interface Msg {
  id: number;
  sender: string;
  recipient: string;
  sender_name: string | null;
  sender_role: string;
  kind: string;
  seq: number;
  reply_to: string | null;
  body: string;
  sent_at: number;
  read_at: number | null;
}

export interface Chat {
  peer: string;
  total: number;
  unread: number;
  last: Msg;
  profile: Profile | null;
}

const MSG_COLS =
  "id, sender, recipient, sender_name, sender_role, kind, seq, reply_to, body, sent_at, read_at";

function rowToMsg(r: Record<string, unknown>): Msg {
  return {
    id: r["id"] as number,
    sender: r["sender"] as string,
    recipient: r["recipient"] as string,
    sender_name: (r["sender_name"] as string | null) ?? null,
    sender_role: r["sender_role"] as string,
    kind: r["kind"] as string,
    seq: r["seq"] as number,
    reply_to: (r["reply_to"] as string | null) ?? null,
    body: r["body"] as string,
    sent_at: r["sent_at"] as number,
    read_at: (r["read_at"] as number | null) ?? null,
  };
}

function rowToProfile(r: Record<string, unknown>): Profile {
  return {
    address: r["address"] as string,
    runtime: r["runtime"] as string,
    name: (r["name"] as string | null) ?? null,
    role: (r["role"] as string | null) ?? null,
    cwd: (r["cwd"] as string | null) ?? null,
    updated_at: r["updated_at"] as number,
  };
}

/// The messages of one chat as `owner` sees it.
function chatWhere(owner: string, peer: string): { sql: string; params: (string | number)[] } {
  return {
    sql: "((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) AND id > COALESCE((SELECT before_id FROM cleared WHERE owner = ? AND peer = ?), 0)",
    params: [owner, peer, peer, owner, owner, peer],
  };
}

export class Store {
  db: Database;
  /** The squad workspace (or directory) this database belongs to. */
  root: string;
  /** Where the database lives. */
  dir: string;

  private constructor(db: Database, root: string, dir: string) {
    this.db = db;
    this.root = root;
    this.dir = dir;
  }

  static open(root: string): Store {
    const dir = dbDir(root);
    fs.mkdirSync(dir, { recursive: true });
    let db: Database;
    try {
      db = new Database(path.join(dir, "bd.sql"), { create: true });
    } catch (e) {
      throw new Error(`cannot open ${path.join(dir, "bd.sql")}: ${e instanceof Error ? e.message : String(e)}`);
    }
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return new Store(db, root, dir);
  }

  close(): void {
    this.db.close();
  }

  /** Adds or refreshes a profile. With `overwrite`, its name and role are replaced,
   * even by none; otherwise only missing values are filled in. A known directory
   * is always kept. */
  upsertProfile(p: Profile, overwrite: boolean): void {
    if (overwrite) {
      this.db
        .query(
          `INSERT INTO profiles (address, runtime, name, role, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET name = excluded.name, role = excluded.role,
             cwd = COALESCE(excluded.cwd, profiles.cwd), updated_at = excluded.updated_at`,
        )
        .run(p.address, p.runtime, p.name, p.role, p.cwd, p.updated_at);
    } else {
      this.db
        .query(
          `INSERT INTO profiles (address, runtime, name, role, cwd, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, profiles.name),
             role = COALESCE(excluded.role, profiles.role),
             cwd = COALESCE(excluded.cwd, profiles.cwd)`,
        )
        .run(p.address, p.runtime, p.name, p.role, p.cwd, p.updated_at);
    }
  }

  profile(address: string): Profile | null {
    const r = this.db
      .query("SELECT address, runtime, name, role, cwd, updated_at FROM profiles WHERE address = ?")
      .get(address) as Record<string, unknown> | null;
    return r ? rowToProfile(r) : null;
  }

  contacts(me: string): Profile[] {
    const rows = this.db
      .query(
        "SELECT address, runtime, name, role, cwd, updated_at FROM profiles WHERE address != ? ORDER BY updated_at DESC, address",
      )
      .all(me) as Record<string, unknown>[];
    return rows.map(rowToProfile);
  }

  insertMessage(m: NewMessage): number {
    this.db
      .query(
        `INSERT INTO messages (sender, recipient, sender_name, sender_role, kind, seq, reply_to, body, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(m.sender, m.recipient, m.sender_name, m.sender_role, m.kind, m.seq, m.reply_to, m.body, nowMs());
    return (this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  }

  /** Unread messages to `owner` across its whole inbox, leaving out chats it deleted. */
  unreadTotal(owner: string): number {
    const r = this.db
      .query(
        `SELECT COUNT(*) AS n FROM messages m WHERE m.recipient = ? AND m.read_at IS NULL
         AND m.id > COALESCE((SELECT before_id FROM cleared WHERE owner = ? AND peer = m.sender), 0)`,
      )
      .get(owner, owner) as { n: number };
    return r.n;
  }

  chatCount(owner: string, peer: string): number {
    const w = chatWhere(owner, peer);
    const r = this.db.query(`SELECT COUNT(*) AS n FROM messages WHERE ${w.sql}`).get(...w.params) as {
      n: number;
    };
    return r.n;
  }

  /** Page `page` of a chat (1 is the newest), oldest message first. */
  page(owner: string, peer: string, page: number): Msg[] {
    const w = chatWhere(owner, peer);
    const rows = this.db
      .query(`SELECT ${MSG_COLS} FROM messages WHERE ${w.sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...w.params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Record<string, unknown>[];
    return rows.map(rowToMsg).reverse();
  }

  /** Unread messages from `peer` to `owner` older than message `id`. */
  unreadBefore(owner: string, peer: string, id: number): number {
    const w = chatWhere(owner, peer);
    const r = this.db
      .query(`SELECT COUNT(*) AS n FROM messages WHERE ${w.sql} AND recipient = ? AND read_at IS NULL AND id < ?`)
      .get(...w.params, owner, id) as { n: number };
    return r.n;
  }

  markRead(owner: string, ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.query("UPDATE messages SET read_at = ? WHERE id = ? AND recipient = ? AND read_at IS NULL");
    const now = nowMs();
    const tx = this.db.transaction((list: number[]) => {
      for (const id of list) stmt.run(now, id, owner);
    });
    tx(ids);
  }

  /** Every chat `owner` can see, the most recent first. */
  chats(owner: string): Chat[] {
    const raw = this.db
      .query(
        `WITH mine AS (
           SELECT m.id, m.recipient, m.read_at,
                  CASE WHEN m.sender = ? THEN m.recipient ELSE m.sender END AS peer
           FROM messages m WHERE m.sender = ? OR m.recipient = ?)
         SELECT peer, COUNT(*) AS total, SUM(CASE WHEN recipient = ? AND read_at IS NULL THEN 1 ELSE 0 END) AS unread, MAX(id) AS last_id
         FROM mine
         WHERE id > COALESCE((SELECT before_id FROM cleared WHERE owner = ? AND peer = mine.peer), 0)
         GROUP BY peer ORDER BY MAX(id) DESC`,
      )
      .all(owner, owner, owner, owner, owner) as { peer: string; total: number; unread: number; last_id: number }[];
    const out: Chat[] = [];
    for (const r of raw) {
      const last = this.db.query(`SELECT ${MSG_COLS} FROM messages WHERE id = ?`).get(r.last_id) as Record<
        string,
        unknown
      >;
      out.push({ peer: r.peer, total: r.total, unread: r.unread, last: rowToMsg(last), profile: this.profile(r.peer) });
    }
    return out;
  }

  /** Hides every message of the chat so far from `owner` only; returns how many were visible. */
  deleteChat(owner: string, peer: string): number {
    const w = chatWhere(owner, peer);
    const r = this.db.query(`SELECT COUNT(*) AS n, MAX(id) AS max_id FROM messages WHERE ${w.sql}`).get(
      ...w.params,
    ) as { n: number; max_id: number | null };
    if (r.max_id !== null) {
      this.db
        .query(
          `INSERT INTO cleared (owner, peer, before_id) VALUES (?, ?, ?)
           ON CONFLICT(owner, peer) DO UPDATE SET before_id = excluded.before_id`,
        )
        .run(owner, peer, r.max_id);
    }
    return r.n;
  }
}
