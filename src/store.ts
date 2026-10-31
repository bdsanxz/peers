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

export const SCHEMA_VERSION = 1;

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

/** Whether an error is a SQLite busy/locked failure worth retrying. */
function isBusy(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /database is locked|SQLITE_BUSY/i.test(msg);
}

/** Runs `fn`, retrying busy/locked failures for up to `maxMs`. Concurrent
 * senders queue on the write lock; the retry turns a momentary collision
 * into a wait instead of a failed send. */
function withBusyRetry<T>(fn: () => T, maxMs = 10000): T {
  const start = Date.now();
  let delay = 20;
  for (;;) {
    try {
      return fn();
    } catch (e) {
      if (!isBusy(e) || Date.now() - start >= maxMs) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      delay = Math.min(delay * 2, 200);
    }
  }
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

/** One row of `messagesMetaForOwners`: only what counting needs, no bodies. */
export interface MsgMeta {
  id: number;
  sender: string;
  recipient: string;
  read_at: number | null;
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

/// An `IN` list matched case-insensitively: every spelling of one peer's
/// address set compares equal however it was capitalised or stored.
function lowerList(vals: string[]): { list: string; params: string[] } {
  const uniq = [...new Set(vals.map((v) => v.toLowerCase()))];
  return { list: uniq.map(() => "?").join(","), params: uniq };
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
    // Several sessions notify and read at once: wait on a locked database
    // instead of failing the send with SQLITE_BUSY. The timeout comes first
    // so even the journal_mode switch waits instead of failing at once.
    // Opens retry on busy, so two concurrent senders never fail here.
    withBusyRetry(() => {
      db.exec("PRAGMA busy_timeout = 10000;");
      const jm = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
      if ((jm?.journal_mode ?? "").toLowerCase() !== "wal") db.exec("PRAGMA journal_mode = WAL;");
      // The schema runs once: later opens do no writes here, so a second
      // open leaves data_version alone and a concurrent writer never sees
      // a locked schema step.
      const v = db.query("PRAGMA user_version").get() as { user_version: number };
      if ((v?.user_version ?? 0) < SCHEMA_VERSION) db.exec(SCHEMA);
    });
    return new Store(db, root, dir);
  }

  /** Runs `fn` in one write transaction: a send's profiles plus its message
   * commit together, so concurrent senders queue on the write lock instead
   * of interleaving separate autocommits. Busy locks retry, so two
   * concurrent senders wait instead of failing with `database is locked`. */
  transaction<T>(fn: () => T): T {
    return withBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE;");
      try {
        const r = fn();
        this.db.exec("COMMIT;");
        return r;
      } catch (e) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          // the original error matters, not a failed rollback
        }
        throw e;
      }
    });
  }

  close(): void {
    this.db.close();
  }

  /** Adds or refreshes a profile. With `overwrite`, its name and role are replaced,
   * even by none; otherwise only missing values are filled in. Either way its
   * `updated_at` refreshes, so a session that runs with no stated role still
   * moves to the front of `contacts`. A known directory is always kept. */
  upsertProfile(p: Profile, overwrite: boolean): void {
    withBusyRetry(() => {
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
             cwd = COALESCE(excluded.cwd, profiles.cwd), updated_at = excluded.updated_at`,
          )
          .run(p.address, p.runtime, p.name, p.role, p.cwd, p.updated_at);
      }
    });
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

  /** Metadata for every message `owner` takes part in, oldest first: no bodies,
   * for counting and chat lists. Deletion filtering happens in the caller. */
  messagesMetaForOwners(owners: string[]): MsgMeta[] {
    const o = lowerList(owners);
    return this.db.query(
      `SELECT id, sender, recipient, read_at FROM messages WHERE LOWER(sender) IN (${o.list}) OR LOWER(recipient) IN (${o.list}) ORDER BY id ASC`,
    ).all(...o.params, ...o.params) as MsgMeta[];
  }

  /** Full rows for the given ids, oldest first. Used to load only the page
   * `open` prints, or the last message of each chat `chats` lists. */
  messagesByIds(ids: number[]): Msg[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .query(`SELECT ${MSG_COLS} FROM messages WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY id ASC`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map(rowToMsg);
  }

  /** Every message `owner` (under any of its alias spellings) takes part in,
   * oldest first. Deletion filtering happens in the caller, which knows each
   * peer's canonical key. */
  messagesForOwners(owners: string[]): Msg[] {
    const o = lowerList(owners);
    const rows = this.db
      .query(
        `SELECT ${MSG_COLS} FROM messages WHERE LOWER(sender) IN (${o.list}) OR LOWER(recipient) IN (${o.list}) ORDER BY id ASC`,
      )
      .all(...o.params, ...o.params) as Record<string, unknown>[];
    return rows.map(rowToMsg);
  }

  /** Deletion markers for owner aliases: which peer views were cleared, and how far. */
  clearedForOwners(owners: string[]): { owner: string; peer: string; before_id: number }[] {
    const o = lowerList(owners);
    return this.db.query(`SELECT owner, peer, before_id FROM cleared WHERE LOWER(owner) IN (${o.list})`).all(
      ...o.params,
    ) as { owner: string; peer: string; before_id: number }[];
  }

  markRead(owners: string[], ids: number[]): void {
    if (ids.length === 0) return;
    withBusyRetry(() => {
      const o = lowerList(owners);
      this.db
        .query(
          `UPDATE messages SET read_at = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND LOWER(recipient) IN (${o.list}) AND read_at IS NULL`,
        )
        .run(nowMs(), ...ids, ...o.params);
    });
  }

  /** Hides every visible message of the chat so far from `owner` only; returns
   * how many were visible. `visible` is the caller's cleared-filtered list;
   * the marker is recorded under the canonical pair. */
  hideChat(primaryOwner: string, primaryPeer: string, visible: Msg[]): number {
    if (visible.length > 0) {
      withBusyRetry(() => {
        this.db
          .query(
            `INSERT INTO cleared (owner, peer, before_id) VALUES (?, ?, ?)
           ON CONFLICT(owner, peer) DO UPDATE SET before_id = MAX(cleared.before_id, excluded.before_id)`,
          )
          .run(primaryOwner, primaryPeer, visible[visible.length - 1]!.id);
      });
    }
    return visible.length;
  }
}
