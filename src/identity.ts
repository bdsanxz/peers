// Who this session is: its herdr address, session directory, squad and role.

import fs from "node:fs";
import path from "node:path";
import { agentList, ownAgent, sessionDir as herdrSessionDir, selfAddress } from "./herdr.ts";
import { loadCtx, primary } from "./canonical.ts";
import { nowMs, type Store } from "./store.ts";

export { selfAddress };

function oneLine(s: string): string {
  return s.split(/\s+/).filter((w) => w !== "").join(" ");
}

function clean(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = oneLine(v);
  return t === "" ? null : t;
}

/** The squad workspace a directory belongs to: the nearest directory at or above it that holds
 * roster.json, else the directory itself. Its database holds the squad's conversations. */
export function squadRoot(dir: string): string {
  let d: string | null = path.resolve(dir);
  for (;;) {
    try {
      if (fs.statSync(path.join(d, "roster.json")).isFile()) return d;
    } catch {
      // not here; walk up
    }
    const parent = path.dirname(d);
    if (parent === d) return path.resolve(dir);
    d = parent;
  }
}

/** The nearest .peers.json at or above one of `dirs` that names a role. */
function identityFile(dirs: string[]): Record<string, unknown> | null {
  for (const start of dirs) {
    let d: string | null = path.resolve(start);
    for (;;) {
      const file = path.join(d, ".peers.json");
      try {
        const v = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
        if (typeof v["role"] === "string" && (v["role"] as string).trim() !== "") return v;
      } catch {
        // missing or unreadable; walk up
      }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }
  return null;
}

/** The sender's squad role and human-readable name. The role comes from --role, then
 * $PEERS_ROLE, then the nearest .peers.json; null means "unassigned". The name comes from
 * --name, then $PEERS_NAME, then that .peers.json's display_name, but only when the role came
 * from it too, so `--role user` never borrows a member's name. */
export function ownIdentity(
  roleFlag: string | undefined,
  nameFlag: string | undefined,
  dirs: string[],
): { role: string | null; name: string | null } {
  let role = clean(roleFlag) ?? clean(process.env.PEERS_ROLE ?? undefined) ?? null;
  let name = clean(nameFlag) ?? clean(process.env.PEERS_NAME ?? undefined) ?? null;
  if (role === null) {
    const data = identityFile(dirs);
    if (data) {
      role = clean(data["role"] as string | undefined);
      if (role !== null) name = name ?? clean(data["display_name"] as string | undefined);
    }
  }
  return { role, name };
}

/** Records this session's own profile in a squad database, under its canonical
 * key: a "Lena (lead)" session registers as "lead", never as a second peer.
 * A role from --role, $PEERS_ROLE or .peers.json replaces the stored role and
 * name; without one, only missing values are filled, and the session's own
 * `updated_at` still refreshes so `seen` stays current. */
export function register(store: Store, me: string, dir: string, kind: string): void {
  const { role, name } = ownIdentity(undefined, undefined, [process.cwd(), dir]);
  const overwrite = role !== null;
  let key = me;
  try {
    key = primary(me, loadCtx(store.root, agentList(), store.contacts("")));
  } catch {
    // canonical resolution is best-effort; the raw spelling still registers
  }
  store.upsertProfile(
    { address: key, runtime: kind, name, role, cwd: dir, updated_at: nowMs() },
    overwrite,
  );
}

/** This session's directory and herdr kind, for its context. */
export function ownContext(): { me: string; dir: string; kind: string } {
  const me = selfAddress();
  const agent = ownAgent();
  const dir = herdrSessionDir(agent?.cwd ?? null);
  return { me, dir, kind: agent?.kind ?? "herdr" };
}
