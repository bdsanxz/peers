// Delivery routes: `herdr agent prompt` on the old herdr server, `hcx send`
// over herdr-core. Every notification between sessions is one
// fire-and-forget prompt into the peer's input, with no `--wait`. A failed
// prompt never fails the send: the message stays in the peer's inbox and the
// SENT line says the notification failed. The herdr-core route always goes
// through `hcx send --agent-only --no-footer --json`, which refuses plain
// shells and unknown kinds before sending.

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

/** Lookup timeout (5 s) and send timeout (10 s): a hung helper never blocks forever. */
export const LOOKUP_TIMEOUT_MS = 5000;
export const SEND_TIMEOUT_MS = 10000;

export function haveHerdr(): boolean {
  try {
    return Bun.which("herdr") !== null;
  } catch {
    return false;
  }
}

export function haveHc(): boolean {
  try {
    return Bun.which("hc") !== null;
  } catch {
    return false;
  }
}

function herdrJson(args: string[]): unknown {
  try {
    const p = spawnSync("herdr", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    if (p.status !== 0) return null;
    return JSON.parse(p.stdout as string);
  } catch {
    return null;
  }
}

function hcJson(args: string[]): unknown {
  try {
    const p = spawnSync("hc", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
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

/** Per-process memo of live agents: one `herdr agent list` plus one `hc ls`
 * per command, never one per call site. A process runs one command, so no
 * invalidation is needed. */
let agentListCache: HerdrAgent[] | null = null;

/** Every live agent on this machine, by its address: old herdr agents first,
 * then live herdr-core (hc) terminals. Either side may be empty when its
 * server is stopped; duplicates by address keep the herdr row. */
export function agentList(): HerdrAgent[] {
  if (agentListCache !== null) return agentListCache;
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
  if (!haveHc()) {
    agentListCache = out;
    return out;
  }
  const seen = new Set(out.map((a) => a.address));
  for (const h of hcAgentList()) {
    if (seen.has(h.address)) continue;
    seen.add(h.address);
    out.push(h);
  }
  agentListCache = out;
  return out;
}

const SHELLS = new Set(["zsh", "sh", "bash", "fish", "dash", "ksh", "nu", "pwsh"]);

/** Whether a kind is a plain shell: a shell name, or an unknown kind (empty
 * or missing). Unknown kinds are never treated as agents. Only used to label
 * `peers list` rows from `hc ls` data; notification routing leaves the shell
 * check to `hcx send --agent-only`. */
export function isShellKind(kind: string | undefined | null): boolean {
  if (kind === undefined || kind === null) return true;
  const k = kind.trim().toLowerCase();
  return k === "" || SHELLS.has(k);
}

/** A foreground basename (already lower-cased by `foregroundName`) mapped to
 * the agent kind it runs. `opencode` runs opencode; `qodercli` with an
 * optional `-<version>` suffix (e.g. `qodercli-1.1.81`) runs qoder. Anything
 * else the shell runs stays a shell tab. Copied from hcx
 * (`resolveForegroundAgent`); peers stays self-contained, no import from hcx. */
export function resolveForegroundAgent(foreground: string): string | null {
  if (foreground === "opencode") return "opencode";
  if (/^qodercli(-[0-9][0-9a-z.+-]*)?$/i.test(foreground)) return "qoder";
  return null;
}

/** The basename (lower case) of the foreground program `hc get <addr>`
 * reports; null when it says nothing useful. A failing `hc get`,
 * unparseable JSON, a missing name, or a shell basename all yield null, so a
 * plain shell is never mistaken for an agent. */
function foregroundName(address: string): string | null {
  try {
    const p = spawnSync("hc", ["get", address], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    if (p.status !== 0) return null;
    const body = JSON.parse(p.stdout as string) as { foreground?: { name?: unknown } };
    const name = body.foreground?.name;
    if (typeof name !== "string") return null;
    const base = name.split("/").pop()?.toLowerCase() ?? "";
    return base === "" || isShellKind(base) ? null : base;
  } catch {
    return null;
  }
}

/** A shell kind seen through its shell wrapper: a shell-kind tab whose `hc
 * get` foreground name resolves to an agent reports that kind (`qoder`,
 * `opencode`). A non-shell kind is returned as is with no `hc get` call; a
 * failing `hc get` or an unrecognised foreground keeps the shell kind. */
export function resolveShellKind(kind: string, terminal: string): string {
  if (!isShellKind(kind)) return kind;
  if (terminal.trim() === "") return kind;
  const fg = foregroundName(terminal);
  if (!fg) return kind;
  return resolveForegroundAgent(fg) ?? kind;
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

/** Per-process memo of `herdr-app ls`: one call per command. No invalidation:
 * a process runs one command and tabs are read-only mid-command. */
let spacesCache: { tabs?: HerdrTab[] }[] | null = null;

function herdrSpaces(): { tabs?: HerdrTab[] }[] {
  if (spacesCache !== null) return spacesCache;
  try {
    const p = spawnSync("herdr-app", ["ls"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    spacesCache =
      p.status === 0 ? ((JSON.parse(p.stdout as string) as { spaces?: { tabs?: HerdrTab[] }[] }).spaces ?? []) : [];
    return spacesCache;
  } catch {
    spacesCache = [];
    return spacesCache;
  }
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

function timedOut(p: { error?: unknown }): boolean {
  const e = p.error as { code?: unknown } | undefined;
  return !!e && (e.code === "ETIMEDOUT" || String((e as Error).message ?? "").includes("ETIMEDOUT"));
}

/** hcx is a required dependency for notifications over herdr-core. Checked
 * once per process with `hcx --version --json`: contract >= 1 with the
 * `agent-only` and `no-footer` capabilities. */
let hcxCheckCache: { ok: boolean; hint: string } | null = null;

function hcxCheck(): { ok: boolean; hint: string } {
  if (hcxCheckCache !== null) return hcxCheckCache;
  try {
    if (Bun.which("hcx") === null) {
      hcxCheckCache = { ok: false, hint: "install hcx >= 0.3.0" };
      return hcxCheckCache;
    }
    const p = spawnSync("hcx", ["--version", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: LOOKUP_TIMEOUT_MS,
    });
    if (p.status !== 0) {
      hcxCheckCache = { ok: false, hint: "install hcx >= 0.3.0" };
      return hcxCheckCache;
    }
    const v = JSON.parse(p.stdout as string) as { contract?: unknown; capabilities?: unknown };
    const caps = Array.isArray(v.capabilities) ? (v.capabilities as unknown[]) : [];
    if (typeof v.contract !== "number" || v.contract < 1 || !caps.includes("agent-only") || !caps.includes("no-footer")) {
      hcxCheckCache = { ok: false, hint: "install hcx >= 0.3.0" };
      return hcxCheckCache;
    }
    hcxCheckCache = { ok: true, hint: "" };
    return hcxCheckCache;
  } catch {
    hcxCheckCache = { ok: false, hint: "install hcx >= 0.3.0" };
    return hcxCheckCache;
  }
}

/** The result of one notification attempt: notified, queued (a plain shell or
 * a target hcx reports as not found: nothing ran), or failed. */
export type NotifyResult =
  | { ok: true; detail: string }
  | { ok: false; detail: string; queued: true; reason: "plain-shell" | "not-found" }
  | { ok: false; detail: string };

function hcxErrorKind(chunk: string): { kind: string; message: string; hint: string } | null {
  const texts = [chunk, ...chunk.split("\n")];
  for (const c of texts) {
    const t = c.trim();
    if (t === "") continue;
    try {
      const v = JSON.parse(t) as { error?: { kind?: unknown; message?: unknown; hint?: unknown } };
      const e = v?.error;
      if (e && typeof e.kind === "string")
        return {
          kind: e.kind,
          message: typeof e.message === "string" ? e.message : "",
          hint: typeof e.hint === "string" ? e.hint : "",
        };
    } catch {
      // not JSON: keep looking
    }
  }
  return null;
}

/** One fire-and-forget notification over herdr-core through hcx, with argv
 * and no shell: `hcx send --agent-only --no-footer --json <address> <text>`.
 * hcx looks the kind up first and refuses a plain shell or an unknown kind
 * before sending (kind `plain_shell`, exit 4). Never retried: a timeout or
 * any other nonzero exit after the send may have landed. */
function hcxNotify(target: string, text: string): NotifyResult {
  try {
    const p = spawnSync("hcx", ["send", "--agent-only", "--no-footer", "--json", target, text], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: SEND_TIMEOUT_MS,
    });
    if (timedOut(p)) return { ok: false, detail: `hcx send to ${target} failed: timed out after ${SEND_TIMEOUT_MS / 1000} s` };
    if (p.status === 0) {
      let delivered: boolean | null = null;
      try {
        const v = JSON.parse(p.stdout as string) as Record<string, unknown>;
        const d = (v as { delivered?: unknown }).delivered;
        if (typeof d === "boolean") delivered = d;
        else delivered = null;
      } catch {
        delivered = null;
      }
      const base = `notified via hcx send to ${target}`;
      if (delivered === true) return { ok: true, detail: base };
      if (delivered === false) return { ok: true, detail: `${base} (message not started, do not resend; it is stored)` };
      return { ok: true, detail: `${base} (delivery not confirmed)` };
    }
    const found = hcxErrorKind((p.stderr as string) ?? "") ?? hcxErrorKind((p.stdout as string) ?? "");
    if (found) {
      if (found.kind === "plain_shell")
        return { ok: false, queued: true, reason: "plain-shell", detail: found.message || `tab "${target}" is a plain shell` };
      if (found.kind === "not_found")
        return { ok: false, queued: true, reason: "not-found", detail: found.message || `target "${target}" not found` };
      const tail = found.message ? `: ${found.message}` : "";
      const hint = found.hint ? ` (${found.hint})` : "";
      return { ok: false, detail: `hcx send to ${target} failed: exit ${p.status}${tail}${hint}` };
    }
    const err = ((p.stderr as string) ?? "").trim();
    if (err !== "") return { ok: false, detail: `hcx send to ${target} failed: ${err.split("\n")[0]}` };
    const out = ((p.stdout as string) ?? "").trim();
    const tail = out === "" ? "" : `: ${out.split("\n")[0]}`;
    return { ok: false, detail: `hcx send to ${target} failed: exit ${p.status}${tail}` };
  } catch (e) {
    return { ok: false, detail: `hcx send to ${target} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function herdrPrompt(target: string, text: string): { ok: boolean; detail: string } {
  try {
    const p = spawnSync("herdr", ["agent", "prompt", target, text], { encoding: "utf8", timeout: SEND_TIMEOUT_MS });
    if (timedOut(p))
      return { ok: false, detail: `herdr agent prompt to ${target} failed: timed out after ${SEND_TIMEOUT_MS / 1000} s` };
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

/** One fire-and-forget prompt, over old herdr first, then hcx. Never waits for
 * an answer and never retries a send that may have landed. */
export function prompt(target: string, text: string): NotifyResult {
  const herdr = haveHerdr() ? herdrPrompt(target, text) : { ok: false, detail: "herdr is not on PATH, so no herdr notification was attempted" };
  if (herdr.ok) return { ok: true, detail: herdr.detail };
  const check = hcxCheck();
  if (!check.ok) {
    if (!haveHerdr()) return { ok: false, detail: `hcx is not available (install hcx >= 0.3.0), so the notification was not delivered` };
    return { ok: false, detail: `${herdr.detail}; install hcx >= 0.3.0` };
  }
  const hcx = hcxNotify(target, text);
  if (hcx.ok) return hcx;
  if (!hcx.ok && "queued" in hcx && hcx.queued) return hcx;
  if (!haveHerdr()) return hcx;
  return { ok: false, detail: `${herdr.detail}; ${hcx.detail}` };
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
