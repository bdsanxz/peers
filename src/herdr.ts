// Delivery routes: `herdr agent prompt` on the old herdr server, `hc send`
// on the new herdr-core. Every notification between sessions is one
// fire-and-forget prompt into the peer's input, with no `--wait`. A failed
// prompt never fails the send: the message stays in the peer's inbox and the
// SENT line says the notification failed.

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

export function haveHc(): boolean {
  try {
    const p = spawnSync("sh", ["-c", "command -v hc"], {
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

function hcJson(args: string[]): unknown {
  try {
    const p = spawnSync("hc", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (p.status !== 0) return null;
    return JSON.parse(p.stdout as string);
  } catch {
    return null;
  }
}

/** Every live herdr-core terminal on this machine, by its address. */
export function hcAgentList(): HerdrAgent[] {
  const v = hcJson(["ls", "--json"]) as {
    terminals?: Record<string, unknown>[];
  } | null;
  const terminals = Array.isArray(v?.terminals) ? v!.terminals! : [];
  const out: HerdrAgent[] = [];
  for (const t of terminals) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as Record<string, unknown>;
    if (rec["state"] !== undefined && rec["state"] !== "live") continue;
    const id = rec["address"];
    const name = rec["name"];
    if (typeof id !== "string" || id === "") continue;
    const named = typeof name === "string" && name !== "" ? name : id;
    out.push({
      address: named,
      pane: id,
      kind: typeof rec["agent"] === "string" && (rec["agent"] as string) !== "" ? (rec["agent"] as string) : "herdr",
      state:
        typeof rec["status"] === "string" && (rec["status"] as string) !== ""
          ? (rec["status"] as string)
          : typeof rec["state"] === "string"
            ? (rec["state"] as string)
            : "?",
      cwd: typeof rec["cwd"] === "string" ? (rec["cwd"] as string) : "",
      workspace: typeof rec["where"] === "string" ? (rec["where"] as string) : "",
    });
  }
  return out;
}

/** Every live agent on this machine, by its address: old herdr agents first,
 * then live herdr-core (hc) terminals. Either side may be empty when its
 * server is stopped; duplicates by address keep the herdr row. */
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
  if (!haveHc()) return out;
  const seen = new Set(out.map((a) => a.address));
  for (const h of hcAgentList()) {
    if (seen.has(h.address)) continue;
    seen.add(h.address);
    out.push(h);
  }
  return out;
}

/** One fire-and-forget prompt over herdr-core. Never waits for an answer. */
function hcPrompt(target: string, text: string): { ok: boolean; detail: string } {
  try {
    const p = spawnSync("hc", ["send", target, text], { encoding: "utf8" });
    if (p.status === 0) return { ok: true, detail: `notified via hc send to ${target}` };
    const err = (p.stderr as string).trim();
    if (err === "") {
      const out = (p.stdout as string).trim();
      const tail = out === "" ? "" : `: ${out.split("\n")[0]}`;
      return { ok: false, detail: `hc send to ${target} failed: exit ${p.status}${tail}` };
    }
    return { ok: false, detail: `hc send to ${target} failed: ${err.split("\n")[0]}` };
  } catch (e) {
    return { ok: false, detail: `hc send to ${target} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function herdrPrompt(target: string, text: string): { ok: boolean; detail: string } {
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

/** One fire-and-forget prompt, over old herdr first, then herdr-core. Never waits for an answer. */
export function prompt(target: string, text: string): { ok: boolean; detail: string } {
  const herdr = haveHerdr() ? herdrPrompt(target, text) : { ok: false, detail: "herdr is not on PATH, so no herdr notification was attempted" };
  if (herdr.ok) return herdr;
  if (!haveHc()) {
    if (!haveHerdr()) return { ok: false, detail: "herdr is not on PATH, so the notification was not delivered" };
    return herdr;
  }
  const hc = hcPrompt(target, text);
  if (hc.ok) return hc;
  if (!haveHerdr()) return hc;
  return { ok: false, detail: `${herdr.detail}; ${hc.detail}` };
}

/** This session's own agent, matched by the pane or terminal its host put it in. */
export function ownAgent(): HerdrAgent | null {
  const all = agentList();
  const pane = (process.env.HERDR_PANE_ID ?? "").trim();
  if (pane !== "") {
    const found = all.find((a) => a.pane === pane);
    if (found) return found;
  }
  const term = (process.env.HC_TERMINAL_ID ?? "").trim();
  if (term !== "") {
    const found = all.find((a) => a.pane === term || a.address === term);
    if (found) return found;
  }
  return null;
}

/** This session's own address: PEERS_SELF wins, else its live agent entry. */
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
      "cannot tell which session this is: HC_TERMINAL_ID and HERDR_PANE_ID name no live agent. " +
        "Run this from inside an hc terminal or a herdr agent pane, or set PEERS_SELF=<your member name>.",
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
// Herdr ids are opaque and alphanumeric: workspaces run w1, w20, w31 and w3G, w3H, w2T alike.
const PANE_RE = /^w[0-9a-z]+:p[0-9a-z]+$/i;
// herdr-core terminals: t7, a name, or machine/t7. Machine and terminal parts
// share hc's name charset.
const MACHINE_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Validates a send target. Returns the reason when it is not one. */
export function checkTarget(s: string): string | null {
  const t = s.trim();
  if (t === "") return "empty; pass a member name such as \"lead\", or a terminal such as \"t2\"";
  if (/\s/.test(t)) return `${JSON.stringify(s)} holds whitespace; pass one member name or terminal address`;
  if (t.includes(":")) {
    if (PANE_RE.test(t)) return null;
    return (
      `bad address ${JSON.stringify(s)}; peers addresses are member names (such as "lead") ` +
      `or terminal ids (such as "w1:p1" or "t2"), not runtime ids (see \`peers list\`)`
    );
  }
  if (t.includes("/")) {
    if (MACHINE_RE.test(t)) return null;
    return (
      `bad address ${JSON.stringify(s)}; remote hc terminals look like "machine/t7" ` +
      `(see \`peers list\`)`
    );
  }
  if (!NAME_RE.test(t)) {
    return (
      `bad address ${JSON.stringify(s)}; member names match [a-z][a-z0-9_-]{0,31} ` +
      `(such as "lead"), or pass a terminal id such as "t2" (see \`peers list\`)`
    );
  }
  return null;
}
