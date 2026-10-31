// Delivery routes: `herdr agent prompt` on the old herdr server, `hc send`
// on the new herdr-core. Every notification between sessions is one
// fire-and-forget prompt into the peer's input, with no `--wait`. A failed
// prompt never fails the send: the message stays in the peer's inbox and the
// SENT line says the notification failed.

import { spawnSync } from "node:child_process";
import { parenMember } from "./names.ts";

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
    let state =
      typeof rec["status"] === "string" && (rec["status"] as string) !== ""
        ? (rec["status"] as string)
        : typeof rec["state"] === "string"
          ? (rec["state"] as string)
          : "?";
    // Every terminal listed here is live; a finished turn means idle, not dead.
    if (state === "done") state = "idle";
    out.push({
      address: named,
      pane: id,
      // An empty agent field means the kind is unknown, never an agent: it is
      // kept empty so routing and `peers list` treat it like a plain shell.
      kind: typeof rec["agent"] === "string" ? (rec["agent"] as string) : "",
      state,
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

/** What peers knows about a notification target, for the hc send route. */
export interface PromptFrom {
  /** What kind of agent the receiver runs; a plain shell keeps the tagged send. */
  targetKind?: string;
}

const SHELLS = new Set(["zsh", "sh", "bash", "fish", "dash", "ksh", "nu", "pwsh"]);

/** Agent programs peers recognises in the foreground of a shell wrapper: a
 * shell kind becomes the foreground program only when it names one of these.
 * Anything else the shell runs (such as `vim` or `python`) stays a shell tab. */
const KNOWN_FOREGROUND_AGENTS = new Set(["opencode"]);

/** Whether a kind is a plain shell: a shell name, or an unknown kind (empty
 * or missing). Unknown kinds are never treated as agents. */
export function isShellKind(kind: string | undefined | null): boolean {
  if (kind === undefined || kind === null) return true;
  const k = kind.trim().toLowerCase();
  return k === "" || SHELLS.has(k);
}

/** Per-run cache of `hc get` foreground lookups: one lookup per address. */
const foregroundOf = new Map<string, string | null>();

/** The foreground program `hc get <address>` reports for a terminal: the
 * basename of `foreground.name`, in lower case. Null when the lookup fails,
 * the JSON is unparseable, or the name is empty. Only the address form from
 * `hc ls --json` is passed: a name often returns not_found. */
function hcForeground(address: string): string | null {
  if (foregroundOf.has(address)) return foregroundOf.get(address)!;
  let fg: string | null = null;
  const v = hcJson(["get", address]) as { foreground?: { name?: unknown } } | null;
  const name = v?.foreground?.name;
  if (typeof name === "string") {
    const base = (name.split("/").pop() ?? "").trim().toLowerCase();
    fg = base === "" ? null : base;
  }
  foregroundOf.set(address, fg);
  return fg;
}

/** The kind peers treats a live target as. hc lists a tab that runs an agent
 * inside a login-shell wrapper as a plain shell (`agent: "zsh"`), so a shell
 * kind is checked against the foreground program `hc get` reports: only a
 * known agent foreground such as `opencode` is the real kind. A failed
 * lookup, a missing or shell foreground, or any other program (such as `vim`)
 * keeps the shell kind. */
export function effectiveKind(agent: HerdrAgent): string {
  if (!SHELLS.has(agent.kind.trim().toLowerCase())) return agent.kind;
  const fg = hcForeground(agent.pane);
  if (fg === null || !KNOWN_FOREGROUND_AGENTS.has(fg)) return agent.kind;
  return fg;
}

/** The Herdr app tab that holds a terminal, or null when the app is absent. */
export function tabNameOf(terminal: string): string | null {
  if (terminal === "") return null;
  const spaces = herdrSpaces();
  for (const sp of spaces) for (const t of sp.tabs ?? []) {
    if ((t.terminals ?? []).some((x) => x.terminal === terminal) && typeof t.name === "string" && t.name !== "") return t.name;
  }
  return null;
}

type HerdrTab = { name?: string; terminals?: { terminal?: string; app?: boolean }[] };
function herdrSpaces(): { tabs?: HerdrTab[] }[] {
  try {
    const p = spawnSync("herdr-app", ["ls"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return p.status === 0 ? ((JSON.parse(p.stdout as string) as { spaces?: { tabs?: HerdrTab[] }[] }).spaces ?? []) : [];
  } catch { return []; }
}

/** A Herdr tab name matched case-insensitively, with the terminal that serves it. */
export interface TabResolution {
  /** The tab's canonical spelling, when the name matched exactly one tab. */
  canonical?: string;
  /** The terminal to notify for that tab: its `app` terminal, else its first. */
  terminal?: string;
  /** Why the name is refused, such as an ambiguous tab name. */
  error?: string;
}

/** Every Herdr app tab with the terminal peers notifies for it: its `app`
 * terminal, else its first. Used for canonical address resolution. */
export function herdrTabs(): { name: string; terminal: string }[] {
  const out: { name: string; terminal: string }[] = [];
  for (const space of herdrSpaces()) for (const tab of space.tabs ?? []) {
    if (typeof tab.name !== "string" || tab.name === "") continue;
    const terminals = tab.terminals ?? [];
    const chosen = terminals.find((t) => t.app) ?? terminals[0];
    if (chosen?.terminal) out.push({ name: tab.name, terminal: chosen.terminal });
  }
  return out;
}

/** Matches a name against Herdr app tabs, case-insensitively. Terminal ids,
 * pane ids and exact member names win: pass reserved when the name is one,
 * and tabs are skipped. A member word also matches the tab that carries it
 * in parens, so "lead" resolves to the "Lena (lead)" tab's terminal. */
export function resolveTabAddress(name: string, reserved: boolean): TabResolution {
  if (reserved) return {};
  const full = herdrTabs().filter((t) => t.name.toLowerCase() === name.toLowerCase());
  const fullTerminals = [...new Set(full.map((m) => m.terminal))];
  if (fullTerminals.length > 1) return { error: `ambiguous tab name ${JSON.stringify(name)}; use one of: ${fullTerminals.join(", ")}` };
  if (fullTerminals.length === 1) return { canonical: full[0]!.name, terminal: fullTerminals[0]! };
  if (!/\s/.test(name)) {
    const member = herdrTabs().filter((t) => parenMember(t.name)?.toLowerCase() === name.toLowerCase());
    const memberTerminals = [...new Set(member.map((m) => m.terminal))];
    if (memberTerminals.length > 1) return { error: `ambiguous tab name ${JSON.stringify(name)}; use one of: ${memberTerminals.join(", ")}` };
    if (memberTerminals.length === 1) return { canonical: member[0]!.name, terminal: memberTerminals[0]! };
  }
  return {};
}

/** How hc's send result reads: `confirmed` when a turn started, `not-started`
 * when hc confirms the send started no turn (`started: false`, which must
 * never read as confirmed), and `unconfirmed` when hc reports no status at
 * all, as for an opencode TUI. */
type DeliveryConfirmation = "confirmed" | "not-started" | "unconfirmed";

function hcDelivery(json: unknown): DeliveryConfirmation {
  if (typeof json !== "object" || json === null) return "unconfirmed";
  const started = (json as Record<string, unknown>)["started"];
  if (started === true) return "confirmed";
  if (started === false) return "not-started";
  return "unconfirmed";
}

function hcSend(target: string, text: string, env: NodeJS.ProcessEnv): { ok: boolean; detail: string } {
  try {
    const p = spawnSync("hc", ["send", target, text], { encoding: "utf8", env });
    if (p.status === 0) {
      let confirmation: DeliveryConfirmation = "unconfirmed";
      try {
        confirmation = hcDelivery(JSON.parse(p.stdout as string));
      } catch {
        confirmation = "unconfirmed";
      }
      const detail = `notified via hc send to ${target}`;
      if (confirmation === "confirmed") return { ok: true, detail };
      if (confirmation === "not-started")
        return { ok: true, detail: `${detail} (message not started, do not resend; it is stored)` };
      return { ok: true, detail: `${detail} (delivery not confirmed by hc)` };
    }
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

/** One fire-and-forget prompt over herdr-core. Never waits for an answer.
 * With `from`, it goes without HC_TERMINAL_ID, so hc adds no <hc from> tag, and
 * the body is sent as is. A failed untagged send is retried the old way. An
 * unknown or shell target kind keeps the tagged send. */
function hcPrompt(target: string, text: string, from?: PromptFrom): { ok: boolean; detail: string } {
  if (from && !isShellKind(from.targetKind)) {
    const env = { ...process.env };
    delete env.HC_TERMINAL_ID;
    const plain = hcSend(target, text, env);
    if (plain.ok) return plain;
  }
  return hcSend(target, text, process.env);
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
export function prompt(target: string, text: string, from?: PromptFrom): { ok: boolean; detail: string } {
  const herdr = haveHerdr() ? herdrPrompt(target, text) : { ok: false, detail: "herdr is not on PATH, so no herdr notification was attempted" };
  if (herdr.ok) return herdr;
  if (!haveHc()) {
    if (!haveHerdr()) return { ok: false, detail: "herdr is not on PATH, so the notification was not delivered" };
    return herdr;
  }
  const hc = hcPrompt(target, text, from);
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

/** This session's own address: PEERS_SELF wins, else its live agent entry.
 * PEERS_SELF may name a tab with spaces, such as "Tara (planner)": it is
 * accepted when it matches a live tab or carries a "(member)" suffix, and
 * canonical resolution turns it into the whitespace-free member key. */
export function selfAddress(): string {
  const forced = (process.env.PEERS_SELF ?? "").trim();
  if (forced !== "") {
    const err = checkTarget(forced);
    if (err) {
      const tabHit = herdrTabs().some((t) => t.name.toLowerCase() === forced.toLowerCase());
      if (parenMember(forced) === null && !tabHit) throw new Error(`PEERS_SELF ${err}`);
    }
    return forced;
  }
  const me = ownAgent();
  if (!me) {
    throw new Error(
      "cannot tell which session this is: HC_TERMINAL_ID and HERDR_PANE_ID name no live agent. " +
        "Run this from inside an hc terminal or a herdr agent pane, or set PEERS_SELF=<your member name>.",
    );
  }
  const terminal = (process.env.HC_TERMINAL_ID ?? "").trim();
  const tabName = tabNameOf(terminal);
  if (tabName && herdrSpaces().flatMap((s) => s.tabs ?? []).filter((t) => t.name?.toLowerCase() === tabName.toLowerCase()).length === 1) return tabName;
  return me.address;
}

/** This session's directory: PEERS_CWD wins, else its herdr agent's cwd, else the cwd. */
export function sessionDir(kind_cwd: string | null): string {
  const forced = (process.env.PEERS_CWD ?? "").trim();
  if (forced !== "") return forced;
  if (kind_cwd && kind_cwd !== "") return kind_cwd;
  return process.cwd();
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
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
  if (!NAME_RE.test(t)) return null; // Unknown names are reported by address resolution, not syntax validation.
  return null;
}
