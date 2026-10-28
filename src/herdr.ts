// The only delivery route: `herdr agent prompt`. Every notification between
// sessions is one fire-and-forget prompt into the peer's herdr agent input,
// with no `--wait`. A failed prompt never fails the send: the message stays
// in the peer's inbox and the SENT line says the notification failed.

import { spawnSync } from "node:child_process";

export interface HerdrAgent {
  /** The member's address: its herdr name, or its pane id when unnamed. */
  address: string;
  /** The pane hosting it, such as "w1:p1". */
  pane: string;
  /** The agent kind herdr reports, such as "muse". */
  kind: string;
  state: string;
  cwd: string;
  workspace: string;
}

export function haveHerdr(): boolean {
  try {
    const p = spawnSync("sh", ["-c", "command -v herdr"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return p.status === 0 && (p.stdout as string).trim() !== "";
  } catch {
    return false;
  }
}

function herdrJson(args: string[]): unknown {
  try {
    const p = spawnSync("herdr", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (p.status !== 0) return null;
    return JSON.parse(p.stdout as string);
  } catch {
    return null;
  }
}

/** Every live herdr agent on this machine, by its address. */
export function agentList(): HerdrAgent[] {
  const v = herdrJson(["agent", "list"]) as {
    result?: { agents?: Record<string, unknown>[] };
  } | null;
  const agents = v?.result?.agents ?? [];
  const out: HerdrAgent[] = [];
  for (const a of agents) {
    const pane = a["pane_id"];
    const name = a["name"];
    if (typeof pane !== "string" || pane === "") continue;
    const address = typeof name === "string" && name !== "" ? name : pane;
    out.push({
      address,
      pane,
      kind: typeof a["agent"] === "string" ? (a["agent"] as string) : "herdr",
      state: typeof a["agent_status"] === "string" ? (a["agent_status"] as string) : "?",
      cwd: typeof a["cwd"] === "string" ? (a["cwd"] as string) : "",
      workspace: typeof a["workspace_id"] === "string" ? (a["workspace_id"] as string) : "",
    });
  }
  return out;
}

/** One fire-and-forget prompt. Never waits for an answer. */
export function prompt(target: string, text: string): { ok: boolean; detail: string } {
  if (!haveHerdr()) return { ok: false, detail: "herdr is not on PATH, so the notification was not delivered" };
  try {
    const p = spawnSync("herdr", ["agent", "prompt", target, text], { encoding: "utf8" });
    if (p.status === 0) return { ok: true, detail: `notified via herdr agent prompt to ${target}` };
    const err = (p.stderr as string).trim();
    if (err === "") {
      const out = (p.stdout as string).trim();
      const tail = out === "" ? "" : `: ${out.split("\n")[0]}`;
      return { ok: false, detail: `herdr agent prompt to ${target} failed: exit ${p.status}${tail}` };
    }
    return { ok: false, detail: `herdr agent prompt to ${target} failed: ${err.split("\n")[0]}` };
  } catch (e) {
    return { ok: false, detail: `herdr agent prompt to ${target} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** This session's own herdr agent, matched by the pane herdr put it in. */
export function ownAgent(): HerdrAgent | null {
  const pane = (process.env.HERDR_PANE_ID ?? "").trim();
  if (pane === "") return null;
  return agentList().find((a) => a.pane === pane) ?? null;
}

/** This session's own address: PEERS_SELF wins, else its herdr agent entry. */
export function selfAddress(): string {
  const forced = (process.env.PEERS_SELF ?? "").trim();
  if (forced !== "") {
    const err = checkTarget(forced);
    if (err) throw new Error(`PEERS_SELF ${err}`);
    return forced;
  }
  const me = ownAgent();
  if (!me) {
    throw new Error(
      "cannot tell which session this is: HERDR_PANE_ID names no live herdr agent. " +
        "Run this from inside a herdr agent pane, or set PEERS_SELF=<your herdr member name>.",
    );
  }
  return me.address;
}

/** This session's directory: PEERS_CWD wins, else its herdr agent's cwd, else the cwd. */
export function sessionDir(kind_cwd: string | null): string {
  const forced = (process.env.PEERS_CWD ?? "").trim();
  if (forced !== "") return forced;
  if (kind_cwd && kind_cwd !== "") return kind_cwd;
  return process.cwd();
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const PANE_RE = /^w\d+:p\d+$/;

/** Validates a send target. Returns the reason when it is not one. */
export function checkTarget(s: string): string | null {
  const t = s.trim();
  if (t === "") return "empty; pass a herdr member name such as \"lead\", or a pane id such as \"w1:p1\"";
  if (/\s/.test(t)) return `${JSON.stringify(s)} holds whitespace; pass one herdr member name or pane id`;
  if (t.includes(":")) {
    if (PANE_RE.test(t)) return null;
    return (
      `bad address ${JSON.stringify(s)}; peers addresses are herdr member names (such as "lead") ` +
      `or pane ids (such as "w1:p1"), not runtime ids (see \`peers list\`)`
    );
  }
  if (!NAME_RE.test(t)) {
    return (
      `bad address ${JSON.stringify(s)}; herdr member names match [a-z][a-z0-9_-]{0,31} ` +
      `(such as "lead"), or pass a pane id such as "w1:p1" (see \`peers list\`)`
    );
  }
  return null;
}
