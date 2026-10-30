// Canonical addresses: one stable, whitespace-free key per peer, so the
// inbox, chats and open agree no matter which spelling a message used.
//
// A peer can be named many ways: its member name ("lead"), its role (the
// same word in squads), its Herdr tab ("Lena (lead)", case-insensitively),
// its herdr-core terminal ("t5x"), its pane id ("w1:p1"), or a stale
// terminal/address from before a relaunch ("framesmith-lead"). Old rows keep
// whatever spelling was stored; reads expand every spelling to its alias set
// instead of rewriting history. New sends store the canonical key, which is
// always copy-pasteable (never holds whitespace).
//
// Display names never leak into the key: "Lena (lead)" as a --name or a tab
// maps to the member "lead", and "Sari (qa)" whoami prints as "qa".

import fs from "node:fs";
import path from "node:path";
import { herdrTabs, type HerdrAgent } from "./herdr.ts";
import { isMemberWord, parenMember, stripSquadPrefix } from "./names.ts";
import type { Profile } from "./store.ts";

export interface RosterMember {
  name: string;
  display: string | null;
}

export interface CanonCtx {
  agents: HerdrAgent[];
  profiles: Profile[];
  tabs: { name: string; terminal: string }[];
  squad: string | null;
  members: RosterMember[];
}

/** A role that one session holds at a time; the defaults are shared by many
 * sessions, so they never identify a peer. Mirrors commands.exclusive. */
export function exclusiveRole(role: string | null): boolean {
  return role !== null && role !== "" && role !== "unassigned" && role !== "user";
}

function readRoster(root: string): { squad: string | null; members: RosterMember[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "roster.json"), "utf8")) as {
      squad?: unknown;
      members?: unknown;
    };
    const squad = typeof raw.squad === "string" && raw.squad !== "" ? raw.squad : null;
    const members: RosterMember[] = [];
    if (Array.isArray(raw.members)) {
      for (const m of raw.members) {
        if (typeof m !== "object" || m === null) continue;
        const rec = m as Record<string, unknown>;
        if (typeof rec["name"] !== "string" || (rec["name"] as string).trim() === "") continue;
        const disp = typeof rec["display_name"] === "string" ? (rec["display_name"] as string).trim() : null;
        members.push({ name: (rec["name"] as string).trim(), display: disp !== "" ? disp : null });
      }
    }
    return { squad, members };
  } catch {
    return { squad: null, members: [] };
  }
}

/** The full resolution context for one squad database. */
export function loadCtx(root: string, agents: HerdrAgent[], profiles: Profile[]): CanonCtx {
  const { squad, members } = readRoster(root);
  return { agents, profiles, tabs: herdrTabs(), squad, members };
}

/** The canonical member key for a spelling (lowercased, whitespace-free),
 * or null when the spelling names no member: an unknown name, a tab without
 * a "(member)" suffix such as "Zytra", or a bare terminal with no profile. */
export function memberOf(spelling: string, ctx: CanonCtx, seen: Set<string> = new Set()): string | null {
  const t = spelling.trim();
  if (t === "") return null;
  const low = t.toLowerCase();
  if (seen.has(low)) return null;
  seen.add(low);

  // A pane id or terminal that a live agent holds: follow it to the agent's
  // own address, which names the member or terminal.
  const agent = ctx.agents.find((a) => a.pane.toLowerCase() === low || a.address.toLowerCase() === low);
  if (agent && agent.address.trim().toLowerCase() !== low) {
    const via = memberOf(agent.address, ctx, seen);
    if (via !== null) return via;
  }

  // A stored address whose profile records an exclusive role belongs to that
  // member — but only when the address is a terminal spelling (a live pane)
  // or an alias the profile's own name gives away ("t5x" named
  // "Tara (planner)"). A bare member word ("old") stays its own key even when
  // a session once held that role, so a replaced member keeps its own inbox
  // and the REPLACED hint keeps naming it.
  const byAddress = ctx.profiles
    .filter((p) => p.address.toLowerCase() === low)
    .sort((a, b) => b.updated_at - a.updated_at);
  const terminalSpelling = ctx.agents.some((a) => a.pane.toLowerCase() === low);
  for (const p of byAddress) {
    if (!exclusiveRole(p.role)) continue;
    const aliased = p.name !== null && p.name !== "" && p.name.toLowerCase() !== low;
    if (terminalSpelling || aliased) return p.role!.toLowerCase();
  }

  // A live tab, matched case-insensitively: "Lena (lead)" is member "lead".
  // A tab without a "(member)" suffix (such as "Zytra") is not a member.
  const tab = ctx.tabs.find((x) => x.name.toLowerCase() === low);
  if (tab) {
    const pm = parenMember(tab.name);
    if (pm !== null && isMemberWord(pm)) return pm.toLowerCase();
  }

  // The "(member)" suffix itself, even with no live tab: old rows, display
  // names from .peers.json, and quoted tab spellings all carry it.
  const pm = parenMember(t);
  if (pm !== null && isMemberWord(pm)) return pm.toLowerCase();

  // The squad roster: member names and their display names.
  for (const m of ctx.members) {
    if (m.name.toLowerCase() === low) return m.name.toLowerCase();
    if (m.display !== null) {
      if (m.display.toLowerCase() === low) return m.name.toLowerCase();
      if (parenMember(m.display)?.toLowerCase() === low) return m.name.toLowerCase();
    }
  }

  // An exclusive role held by a profiled session: "planner" names its member
  // even when no roster lists it.
  const byRole = ctx.profiles
    .filter((p) => (p.role ?? "").toLowerCase() === low && exclusiveRole(p.role))
    .sort((a, b) => b.updated_at - a.updated_at);
  if (byRole.length > 0) return byRole[0]!.role!.toLowerCase();

  // A stale squad-prefixed address from before a relaunch.
  const rest = stripSquadPrefix(t, ctx.squad);
  if (rest !== null) {
    const via = memberOf(rest, ctx, seen);
    if (via !== null) return via;
    if (isMemberWord(rest)) return rest.toLowerCase();
  }

  // A live address with no other mapping (a bare terminal, a pane's member):
  // it is its own key, lowercased so case never fragments it.
  if (agent && isMemberWord(t)) return low;
  return null;
}

/** The display case for a member key: the live agent's spelling, else the
 * roster's, else a stored role's, else the tab's "(member)" inner spelling.
 * Grouping always compares case-insensitively; this only picks the case the
 * user sees, so "Zytra" never degrades to "zytra". */
function displayMember(m: string, ctx: CanonCtx): string {
  const agent = ctx.agents.find((a) => a.address.toLowerCase() === m);
  if (agent) return agent.address;
  const roster = ctx.members.find((r) => r.name.toLowerCase() === m);
  if (roster) return roster.name;
  const prof = ctx.profiles
    .filter((p) => (p.role ?? "").toLowerCase() === m && exclusiveRole(p.role))
    .sort((a, b) => b.updated_at - a.updated_at)[0];
  if (prof?.role) return prof.role;
  for (const tb of ctx.tabs) {
    const pm = parenMember(tb.name);
    if (pm?.toLowerCase() === m) return pm;
  }
  return m;
}

/** The preferred storage and display key for a spelling: the canonical member
 * when one is known (always whitespace-free), else the live tab's spelling
 * (such as "Zytra"), else the spelling as typed. */
export function primary(spelling: string, ctx: CanonCtx): string {
  const t = spelling.trim();
  const m = memberOf(t, ctx);
  if (m !== null) return displayMember(m, ctx);
  const tab = ctx.tabs.find((x) => x.name.toLowerCase() === t.toLowerCase());
  if (tab) return tab.name;
  return t;
}

/** Every spelling that names the same peer as `spelling`: itself, its member
 * key, and every profile address, live address, pane, tab, roster name and
 * stale squad-prefixed form that resolves to that member. Reads match with
 * these, so old rows stored under any spelling are still found. */
/** Whether `m` (lowercased member key) is backed by something real: the
 * roster, a profile role or address, a live agent address or pane, or a tab.
 * Guards the "no member, terminal or tab" error so invented parenthesised
 * names like "Foo (bar)" are still refused. */
export function memberKnown(m: string, ctx: CanonCtx): boolean {
  const low = m.toLowerCase();
  if (ctx.members.some((r) => r.name.toLowerCase() === low)) return true;
  if (
    ctx.profiles.some(
      (p) => memberOf(p.address, ctx) === low || ((p.role ?? "").toLowerCase() === low && exclusiveRole(p.role)),
    )
  )
    return true;
  if (ctx.agents.some((a) => a.address.toLowerCase() === low || a.pane.toLowerCase() === low)) return true;
  if (ctx.tabs.some((tb) => tb.name.toLowerCase() === low || parenMember(tb.name)?.toLowerCase() === low)) return true;
  return false;
}

export function aliases(spelling: string, ctx: CanonCtx): string[] {
  const t = spelling.trim();
  const out = new Set<string>([t]);
  const m = memberOf(t, ctx);
  if (m === null) {
    const tab = ctx.tabs.find((x) => x.name.toLowerCase() === t.toLowerCase());
    if (tab) {
      out.add(tab.name);
      out.add(tab.terminal);
    }
    return [...out];
  }
  out.add(m);
  for (const p of ctx.profiles) {
    if (memberOf(p.address, ctx) === m) out.add(p.address);
  }
  for (const a of ctx.agents) {
    if (memberOf(a.address, ctx) === m) {
      out.add(a.address);
      out.add(a.pane);
    } else if (memberOf(a.pane, ctx) === m) {
      out.add(a.address);
      out.add(a.pane);
    }
  }
  for (const tb of ctx.tabs) {
    const inner = parenMember(tb.name);
    const tm: string | null = inner !== null ? inner.toLowerCase() : tb.name.toLowerCase() === m ? m : null;
    if (tm === m) {
      out.add(tb.name);
      out.add(tb.terminal);
    }
  }
  for (const r of ctx.members) {
    if (r.name.toLowerCase() === m) {
      out.add(r.name);
      if (r.display !== null) out.add(r.display);
      if (ctx.squad) out.add(`${ctx.squad}-${r.name}`);
    }
  }
  if (ctx.squad) out.add(`${ctx.squad}-${m}`);
  return [...out];
}
