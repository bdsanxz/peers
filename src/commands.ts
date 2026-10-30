// One function per command, plus the help texts. `dispatch` routes them.

import fs from "node:fs";
import path from "node:path";
import { UsageError, parseArgs, str, unknownFlags } from "./args.ts";
import { aliases, loadCtx, memberKnown, memberOf, primary, type CanonCtx } from "./canonical.ts";
import { agentList, checkTarget, effectiveKind, prompt, resolveTabAddress, tabNameOf, type HerdrAgent, type PromptFrom } from "./herdr.ts";
import { ownContext, ownIdentity, register, selfAddress, squadRoot } from "./identity.ts";
import { isMemberWord, parenMember } from "./names.ts";
import { PAGE_SIZE, Store, nowMs, type Msg, type Profile } from "./store.ts";

/** Follow a stale member address to the live terminal that runs it now.
 * After a relaunch, sessions live under fresh terminal ids while chats keep
 * the stable member address. Returns the unique live terminal whose recorded
 * role or working directory names the member (plus every candidate, for the
 * hint when they are not unique). */
function followLiveTarget(
  root: string,
  target: string,
  agents: HerdrAgent[],
  profiles: Profile[],
): { address: string; candidates: string[] } {
  const names = new Set<string>([target]);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "roster.json"), "utf8")) as { squad?: unknown };
    if (typeof raw.squad === "string" && raw.squad !== "" && target.startsWith(`${raw.squad}-`)) {
      names.add(target.slice(raw.squad.length + 1));
    }
  } catch {
    /* no roster: match on the target as-is */
  }
  const roleOf = new Map(profiles.map((pr) => [pr.address, pr.role ?? null]));
  const hits: string[] = [];
  for (const a of agents) {
    // Another squad's terminal never stands in for this squad's member,
    // even when its tab, role or directory names the same member.
    if (isOtherSquadTerminal(a, root)) continue;
    const dir = a.cwd.split("/").pop() ?? "";
    if ([...names].some((n) => roleOf.get(a.address) === n)) hits.push(a.address);
    else if (dir !== "" && names.has(dir)) hits.push(a.address);
  }
  const uniq = [...new Set(hits)];
  return { address: uniq.length === 1 ? uniq[0]! : "", candidates: uniq };
}

/** Whether a live terminal provably belongs to another squad: its cwd sits
 * under a different squad root that holds its own roster.json. A terminal
 * with no cwd, or one under no roster, cannot be placed and stays eligible,
 * so sessions outside any squad keep working. */
function isOtherSquadTerminal(a: HerdrAgent, root: string): boolean {
  const cwd = a.cwd.trim();
  if (cwd === "") return false;
  const other = squadRoot(cwd);
  if (other === root) return false;
  try {
    return fs.statSync(path.join(other, "roster.json")).isFile();
  } catch {
    return false;
  }
}

/** Whether a live terminal runs from the member dir of a squad: directly
 * under the squad root and named for the member. Between several live
 * spellings of one peer, this one is the member's own session. */
function isMemberDir(a: HerdrAgent, root: string, peerKey: string): boolean {
  const cwd = a.cwd.trim();
  if (cwd === "") return false;
  const abs = path.resolve(cwd);
  return (
    path.dirname(abs).toLowerCase() === root.toLowerCase() &&
    path.basename(abs).toLowerCase() === peerKey.toLowerCase()
  );
}

/** Resolution context for canonical addresses: live agents, stored profiles,
 * Herdr tabs and the squad roster. Profiles are reloaded after every write,
 * so a fresh placeholder is visible to the same command. */
function canonCtx(store: Store, agents: HerdrAgent[]): CanonCtx {
  return loadCtx(store.root, agents, store.contacts(""));
}

/** This session's canonical key and every spelling that names it. */
function ownerView(me: string, cctx: CanonCtx): { key: string; aliases: string[] } {
  const key = primary(me, cctx);
  return { key, aliases: [...new Set([...aliases(me, cctx), ...aliases(key, cctx)])] };
}

/** A peer's canonical key and every spelling that names it. */
function peerView(target: string, cctx: CanonCtx): { key: string; aliases: string[] } {
  const key = primary(target, cctx);
  return { key, aliases: [...new Set([...aliases(target, cctx), ...aliases(key, cctx)])] };
}

function lowerSet(vs: string[]): Set<string> {
  return new Set(vs.map((v) => v.toLowerCase()));
}

/** A target with whitespace is only valid as a quoted tab or display name:
 * it must match a live tab or carry a "(member)" suffix. Anything else keeps
 * the whitespace rejection. Non-whitespace names pass through untouched. */
function checkAddressTarget(target: string): void {
  const err = checkTarget(target);
  if (!err) return;
  if (/\s/.test(target)) {
    const reserved = agentList().some((a) => a.address === target || a.pane === target);
    const tab = resolveTabAddress(target, reserved);
    if (tab.error) throw new UsageError(tab.error);
    if (tab.canonical || parenMember(target) !== null) return;
  }
  throw new UsageError(err);
}

/** A name the squad knows: a live agent address or pane, a Herdr tab (which
 * may hold whitespace), a member backed by the roster, a profile or a live
 * agent, or a stored profile address. Legacy terminal forms (pane ids,
 * machine/terminal) keep their old path. */
function isKnownPeer(target: string, cctx: CanonCtx, store: Store): boolean {
  const t = target.trim();
  if (t === "") return false;
  if (t.includes(":") || t.includes("/")) return true;
  const low = t.toLowerCase();
  if (cctx.agents.some((a) => a.address.toLowerCase() === low || a.pane.toLowerCase() === low)) return true;
  if (cctx.tabs.some((tb) => tb.name.toLowerCase() === low)) return true;
  const pm = parenMember(t);
  if (pm !== null && isMemberWord(pm) && memberKnown(pm, cctx)) return true;
  const m = memberOf(t, cctx);
  if (m !== null && memberKnown(m, cctx)) return true;
  const als = lowerSet(aliases(t, cctx));
  return store.contacts("").some((p) => als.has(p.address.toLowerCase()));
}

/** One merged chat: every spelling of the peer in a single row. */
interface MergedChat {
  peer: string;
  total: number;
  unread: number;
  last: Msg;
  profile: Profile | null;
}

function bestProfile(cctx: CanonCtx, peerAliases: string[]): Profile | null {
  const set = lowerSet(peerAliases);
  const cands = cctx.profiles.filter((p) => set.has(p.address.toLowerCase()));
  if (cands.length === 0) return null;
  cands.sort(
    (a, b) =>
      Number(b.role !== null) - Number(a.role !== null) ||
      Number(b.name !== null) - Number(a.name !== null) ||
      b.updated_at - a.updated_at,
  );
  return cands[0]!;
}

/** Every chat `ownerAliases` can see, newest first, with all spellings of
 * each peer merged. The inbox count and the notification count both come
 * from here, so they always agree. */
function mergedChats(store: Store, cctx: CanonCtx, ownerAliases: string[]): MergedChat[] {
  const ownLow = lowerSet(ownerAliases);
  const before = new Map<string, number>();
  for (const c of store.clearedForOwners(ownerAliases)) {
    const k = primary(c.peer, cctx).toLowerCase();
    before.set(k, Math.max(before.get(k) ?? 0, c.before_id));
  }
  const groups = new Map<string, { display: string; msgs: Msg[] }>();
  for (const m of store.messagesForOwners(ownerAliases)) {
    const senderMine = ownLow.has(m.sender.toLowerCase());
    const recipMine = ownLow.has(m.recipient.toLowerCase());
    if (senderMine === recipMine) continue;
    const other = senderMine ? m.recipient : m.sender;
    const k = primary(other, cctx).toLowerCase();
    if (m.id <= (before.get(k) ?? 0)) continue;
    const g = groups.get(k);
    if (g) g.msgs.push(m);
    else groups.set(k, { display: primary(other, cctx), msgs: [m] });
  }
  const out: MergedChat[] = [];
  for (const [, g] of groups) {
    g.msgs.sort((a, b) => a.id - b.id);
    const last = g.msgs[g.msgs.length - 1]!;
    const peerAliases = [...new Set([...aliases(g.display, cctx), ...aliases(last.sender, cctx), ...aliases(last.recipient, cctx)])];
    const unread = g.msgs.filter((m) => ownLow.has(m.recipient.toLowerCase()) && m.read_at === null).length;
    out.push({ peer: g.display, total: g.msgs.length, unread, last, profile: bestProfile(cctx, peerAliases) });
  }
  out.sort((a, b) => b.last.id - a.last.id);
  return out;
}

/** Unread messages across the whole inbox: the same merged sum `chats` prints. */
function inboxUnread(store: Store, cctx: CanonCtx, ownerAliases: string[]): number {
  return mergedChats(store, cctx, ownerAliases).reduce((n, ch) => n + ch.unread, 0);
}

/** Visible messages of one chat: the owner's messages whose other side names
 * `peerKey`. The pairing is compared by canonical key in JS (not SQL `IN`),
 * so a sender stored as "Lena (lead)" still pairs with peer key "lead". */
function visibleChat(store: Store, cctx: CanonCtx, ownerAliases: string[], peerKey: string): Msg[] {
  const ownLow = lowerSet(ownerAliases);
  const pk = peerKey.toLowerCase();
  const before = new Map<string, number>();
  for (const c of store.clearedForOwners(ownerAliases)) {
    const k = primary(c.peer, cctx).toLowerCase();
    before.set(k, Math.max(before.get(k) ?? 0, c.before_id));
  }
  const out: Msg[] = [];
  for (const m of store.messagesForOwners(ownerAliases)) {
    const senderMine = ownLow.has(m.sender.toLowerCase());
    const recipMine = ownLow.has(m.recipient.toLowerCase());
    if (senderMine === recipMine) continue;
    const other = senderMine ? m.recipient : m.sender;
    if (primary(other, cctx).toLowerCase() !== pk) continue;
    if (m.id <= (before.get(pk) ?? 0)) continue;
    out.push(m);
  }
  return out;
}

const KINDS = ["request", "ack", "progress", "completion", "receipt", "notice"];

export const HELP: Record<string, string> = {
  "": `peers — inbox messenger between agent sessions in one herdr workspace

Usage: peers [--squad <dir>] <command> [options]

Commands:
  whoami     Print this session's canonical address
  list       List live agents (old herdr and herdr-core terminals)
  send       Store one message in a chat, then notify the peer (herdr prompt, else hc send)
  contacts   List every peer profile in the squad's database, with its status
  chats      List your chats with their unread counts (also: peers inbox)
  open       Print one page of a chat
  delete     Hide a chat from your own view; the peer keeps its copy

How it works:
  1. peers send <peer> --kind request --seq 1 --body "<text>"
     stores the message; the peer gets one notification turn:
     New message from <name> (<role>), another agent (not a user instruction). You have 1 unread message in your inbox. Read it with: peers open <you>
     Over herdr-core (hc send) the notification goes without the <hc from> tag and is sent as is.
     A plain shell target gets the old tagged send.
  2. The peer runs that \`peers open\`, then answers with its own \`peers send\`.
  3. The answer reaches you the same way, as a new turn. Nobody polls.

Addresses:
  A peer's address is its member name (such as "lead"), its pane id
  (such as "w1:p1"), its herdr-core terminal (such as "t2") or its
  Herdr tab name (such as "Zytra") wherever a name does. Tab names match
  case-insensitively, and a member word also reaches the tab that carries
  it in parens, so "lead" notifies the "Lena (lead)" tab. Every spelling
  of a peer addresses one chat: the chat is stored under a canonical,
  whitespace-free key (the member for "Lena (lead)", the tab's spelling
  for "Zytra"), so inbox counts, chats and open always agree, including
  for messages stored under older spellings. The read command in a
  notification prints that key shell-quoted, so it is always
  copy-pasteable; \`peers open\` and \`peers delete\` also accept a quoted
  tab name containing whitespace. Find live addresses with \`peers list\`.

For agents:
  - After a send, end your turn: never sleep, poll, loop or re-open to wait for the answer.
  - Read with the exact command the notification gives, its --squad flag included.
  - Answer with the message's --seq, to \`answer goes to <member>\` when it has one, else to the chat's peer.
  - Run \`peers <command> --help\` before you first use a command.

Storage:
  ~/.local/cache/peers/<dashed squad dir>/bd.sql   one SQLite database per squad
  squad dir       the nearest directory at or above your session's that holds roster.json, else your session's
  --squad <dir>   use that squad's database instead

Environment:
  PEERS_SELF              your address, when neither hc nor herdr can tell it
  PEERS_CWD               your session directory, when neither can tell it
  PEERS_ROLE, PEERS_NAME  your role and name in the messages you send; a name without the role
  PEERS_CACHE             another cache root instead of ~/.local/cache/peers

Exit codes:
  0  success
  2  usage error or failed command; the error line says why

Examples:
  peers whoami
  peers send lead --kind request --seq 1 --body "Review api/."
  peers chats
  peers open lead`,
  whoami: `peers whoami — print this session's canonical address

Usage: peers whoami

Output:
  lead                  this session's address, one line: the canonical,
                        whitespace-free key, so it feeds back into every
                        peers command (a "Lena (lead)" tab prints "lead")

Identity, first match wins:
  PEERS_SELF=<address>  overrides everything below
  HERDR_PANE_ID         matched against old herdr agents
  HC_TERMINAL_ID        matched against herdr-core terminals

Notes:
  - Also records your profile, so your squad sees you in \`peers contacts\`.
  - Exit 2 outside a live agent session with no PEERS_SELF.

Examples:
  peers whoami`,
  list: `peers list — list live agents

Usage: peers list

Output:
  lead  kind=muse  status=done  cwd=<dir>  workspace=<id>
  one line per live agent; nothing when none matches

Notes:
  - Asks old herdr and herdr-core (hc), not the peers database: it shows
    live agents, including ones that never used peers.
  - Never lists your own session.

Examples:
  peers list`,
  send: `peers send — store one message in the chat with a peer, then notify the peer

Usage: peers send <TARGET> --kind <KIND> --seq <N> (--body <TEXT> | <body on stdin>) [OPTIONS]

Output:
  SENT <target>: stored in its inbox (1 unread message); notified via herdr agent prompt to <target> (...)
  REPLY: <how the answer will reach you>. End your turn now. ...
  REPLY comes after a request, notice or completion; with --reply-to it names where the answer goes.

Kinds:
  request      asks for work; answered by one completion
  ack          confirms a request: restates its scope, or asks specific questions
  progress     a blocker, a decision request or missing input
  completion   the single final result of a request
  receipt      closes the exchange: OK, or NO and why; never answered
  notice       information that needs no work; answered by a receipt

Notification, one fire-and-forget turn for every peer:
  The message is stored, then delivered with one
  \`herdr agent prompt <target> <notification>\`, falling back to
  \`hc send <target> <notification>\` when the old server is stopped:
  no --wait, no polling.
  An \`hc send\` that exits 0 without confirming delivery (\`started\` and
  \`status\` are null) prints \`notified via hc send to <target> (delivery not
  confirmed by hcx)\` instead of claiming it was notified.
  A peer that is not live gets the line \`queued, not delivered yet: <reason>\`:
  the message waits in its inbox until it runs and the next message arrives,
  when the notification carries every waiting message's count. When the target
  is a stale member address, peers instead delivers to the unique live
  terminal that runs it now (\`... is not live, but <terminal> runs it now\`).

Notes:
  - After it, end your turn: never sleep, poll or re-open the chat to wait for the answer.
  - <TARGET> is any spelling of the peer: its member name, tab name
    (quote it when it holds spaces, as in \`peers send "Lena (lead)"\`),
    terminal or pane id. The message is stored under the peer's
    canonical key, and the notification's read command names that key.
  - Reuse the request's --seq for every message of its exchange; a new exchange takes a new number.
  - Write --name (and PEERS_NAME, .peers.json's display_name) without the role: --name Rina, not
    --name "Rina (backend)". peers adds the role itself, so the peer sees "Rina (backend)".
  - The body never holds secrets: it stays in the squad's chat history.
  - Exit 2 on a bad address, an unknown kind, an empty body, a send to yourself, or a failed prompt.
  - "stored ... but its notification failed": do not send it again; the message is in the chat.
  - "queued, not delivered yet": the target is not live; nothing ran.

Examples:
  peers send lead --kind request --seq 1 --body "Summarize README.md."
  peers send api --kind completion --seq 1 < result.md
  peers send worker --kind request --seq 2 --reply-to lead --body "..."`,
  contacts: `peers contacts — list every peer profile in the squad's database

Usage: peers contacts

Output:
  lead  status=live  name="Lena"  role=lead  kind=muse  cwd=<dir>  seen=<time>
  api  status=replaced  by=lead  name="Sari"  role=qa  ...
  one line per peer, never you: live ones first, then offline, then replaced; most recently active
  first within each

Status:
  live      The member runs now in herdr.
  offline   It does not run, and no other session holds its role. A message waits until it runs.
  replaced  It does not run, and another session of the same role is live or was seen after it,
            such as a member restarted after hitting a limit. Message the session after \`by=\`
            instead; this one will not answer.

Notes:
  - A session is recorded the first time it runs any peers command, or once you message it.
  - The roles "unassigned" and "user" are shared, so they never replace each other.

Examples:
  peers contacts
  peers contacts --squad ~/squads/shop`,
  chats: `peers chats — list your chats, newest first, with their unread counts

Usage: peers chats
  (also: peers inbox)

Output:
  INBOX <you> in <squad dir>: 2 unread messages in 3 chats
  lead  name="Lena"  role=lead  unread=2  messages=9  last=<time> from them [ack seq 3]: On it.
  api  name="Oki"  role=ops  unread=0  messages=4  last=<time> from you [notice seq 2, not read yet]: ...
  OPEN: peers open lead

Markers:
  from them | from you             who sent the chat's last message
  [<kind> seq <n>]                 the last message's kind and exchange
  not read yet | read <time>       on your last message: whether the peer has read it
  OPEN: <command>                  the chat to open next: the newest with unread messages, else the newest

Notes:
  - Run it once when you start or resume; never loop on it to wait for a reply.

Examples:
  peers chats
  peers inbox --squad ~/squads/shop`,
  open: `peers open — print one page of a chat, like a messenger: you and the peer

Usage: peers open <TARGET> [--page N]

Output:
  CHAT with Lena (lead) · lead           the peer: name (role) · address
  page 1 of 2  (messages 21-40 of 40, ...)  20 messages a page, oldest first

  ── 2026-10-26 ──                                a new day
  [you] #21 10:00  request seq 3 · read 10:01     your message; read or not read yet
    Review api/.                                  the body, indented
  ── 1 unread message ──                          unread messages start here
  [Lena] #22 10:05  ack seq 3 · new               the peer's message, by its name

  OLDER: peers open lead --page 2        older messages (and unread ones there)
  INBOX: 0 unread messages left in your inbox     unread in all your chats

Markers on the peer's line:
  new                     not read before this command printed it
  answer goes to <member>   reply to <member>, not to the peer
  as <role>               sent under another role than the CHAT line's
  [partner]               the peer has no name

Reply:
  peers send <TARGET> --kind <kind> --seq <its seq> --body "<text>"

Notes:
  - Printing marks the messages read: read all of it, never pipe it through head or tail.
  - Unread messages on an OLDER page: open that page too before you act.
  - <TARGET> is any spelling of the peer: its member name, tab name
    (quote it when it holds spaces, as in \`peers open "Lena (lead)"\`),
    terminal or pane id. Every spelling opens the same merged chat.
  - Exit 2 when the page does not exist.

Examples:
  peers open lead
  peers open w1:p2 --page 2`,
  delete: `peers delete — hide a chat from your own view; the peer keeps its copy

Usage: peers delete <TARGET>

Output:
  DELETED your view of the chat with <peer>: 3 messages hidden from you; <peer> still sees the whole chat.
  No chat with <peer> in your inbox; nothing deleted.

Notes:
  - Only your view: the peer keeps every message.
  - <TARGET> is any spelling of the peer, quoted when it holds spaces.
  - A new message in either direction restarts the chat, showing only what came after.
  - Delete only when the user asks, or when the exchange is closed and its history is not needed.

Examples:
  peers delete lead`,
};

export async function dispatch(cmd: string, argv: string[]): Promise<number> {
  switch (cmd) {
    case "whoami":
      return cmdWhoami(argv);
    case "list":
      return cmdList(argv);
    case "send":
      return cmdSend(argv);
    case "contacts":
      return cmdContacts(argv);
    case "chats":
    case "inbox":
      return cmdChats(argv);
    case "open":
      return cmdOpen(argv);
    case "delete":
      return cmdDelete(argv);
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

function label(p: Profile | null): { name: string; role: string } {
  return { name: p?.name ?? "", role: p?.role ?? "unassigned" };
}

/** This session in the database it works in. */
interface Ctx {
  me: string;
  kind: string;
  dir: string;
  store: Store;
  /** Whether --squad chose the database, so commands for this chat must repeat it. */
  explicit: boolean;
}

function squadFlagOf(root: string, explicit: boolean): string {
  return explicit ? ` --squad ${shellWord(root)}` : "";
}

function openCtx(squad: string | undefined, record: boolean): Ctx {
  const { me, dir, kind } = ownContext();
  let root: string;
  let explicit: boolean;
  if (squad !== undefined) {
    root = path.resolve(squad);
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UsageError(`--squad ${squad}: no such directory`);
    }
    explicit = root !== squadRoot(dir);
  } else {
    root = squadRoot(dir);
    explicit = false;
  }
  const store = Store.open(root);
  if (record) register(store, me, dir, kind);
  return { me, kind, dir, store, explicit };
}

function shellWord(s: string): string {
  const plain = s !== "" && [...s].every((c) => /[A-Za-z0-9\-_./:@%+=,]/.test(c));
  if (plain) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function oneLine(s: string): string {
  return s.split(/\s+/).filter((w) => w !== "").join(" ");
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDate(ms)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function localHM(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function cmdWhoami(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["squad"]);
  if (p.positionals.length !== 0) throw new UsageError("whoami takes no arguments");
  const me = selfAddress();
  // The canonical key, never a tab with spaces: the output feeds straight
  // back into any peers command.
  try {
    const { dir } = ownContext();
    const store = Store.open(squadRoot(dir));
    try {
      const cctx = loadCtx(store.root, agentList(), store.contacts(""));
      console.log(primary(me, cctx));
    } finally {
      store.close();
    }
  } catch {
    console.log(me);
  }
  // Recording the profile is a courtesy; whoami answers even when the database cannot be written.
  try {
    const { dir, kind } = ownContext();
    const store = Store.open(squadRoot(dir));
    try {
      register(store, me, dir, kind);
    } finally {
      store.close();
    }
  } catch {
    // answer stands without the profile
  }
  return 0;
}

function cmdList(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["squad"]);
  if (p.positionals.length !== 0) throw new UsageError("list takes no arguments");
  let me: string | null = null;
  try {
    me = selfAddress();
  } catch {
    me = null;
  }
  const agents = agentList();
  // Your own session is never listed: match through the canonical key, so a
  // tab identity ("Tara (planner)") also hides its terminal ("t2").
  let mine = new Set<string>();
  if (me !== null) {
    mine.add(me.toLowerCase());
    try {
      const { dir } = ownContext();
      const cctx = loadCtx(squadRoot(dir), agents, []);
      mine = lowerSet(aliases(me, cctx));
    } catch {
      // alias expansion is best-effort; the raw address still hides itself
    }
  }
  for (const a of agents) {
    if (mine.has(a.address.toLowerCase()) || mine.has(a.pane.toLowerCase())) continue;
    console.log(`${a.address}  kind=${a.kind}  status=${a.state}  cwd=${a.cwd}  workspace=${a.workspace}`);
  }
  return 0;
}

function readBody(body: string | undefined): string {
  if (body !== undefined) return body;
  if (process.stdin.isTTY) return "";
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function withRole(name: string, role: string): string {
  return name.includes(`(${role})`) ? name : `${name} (${role})`;
}

type Status = "live" | "offline" | { replaced: string };

function statusWord(s: Status): string {
  return typeof s === "string" ? s : "replaced";
}

/** A role that one session holds at a time in a squad; the defaults are shared by many sessions. */
function exclusive(role: string | null): string | null {
  if (!role || role === "" || role === "unassigned" || role === "user") return null;
  return role;
}

/** The status of every profile, given which ones are live. A member that is not live is replaced
 * when another session of the same role is live, or was seen after it. */
function statuses(profiles: Profile[], live: boolean[]): Status[] {
  return profiles.map((p, i) => {
    if (live[i]) return "live" as Status;
    const role = exclusive(p.role);
    if (role === null) return "offline" as Status;
    const cands = profiles.flatMap((q, j) => {
      if (j === i || q.role !== role) return [];
      const lj = live[j] ?? false;
      if (!(lj || q.updated_at > p.updated_at)) return [];
      return [{ j, live: lj, at: q.updated_at }];
    });
    cands.sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at);
    const best = cands[0];
    if (!best) return "offline" as Status;
    return { replaced: profiles[best.j]!.address };
  });
}

/** Whether each profiled peer runs now in herdr. A peer is live when any
 * spelling of it — tab name, member name, terminal — is live, resolved
 * through the same canonical key as chats. `me` is live by definition. */
function liveness(store: Store, meAliases: Set<string>, agents: HerdrAgent[], cctx: CanonCtx): Map<string, boolean> {
  const live = new Set<string>();
  for (const a of agents) {
    live.add(a.address.toLowerCase());
    live.add(a.pane.toLowerCase());
  }
  const out = new Map<string, boolean>();
  for (const p of store.contacts("")) {
    const pal = aliases(p.address, cctx).map((a) => a.toLowerCase());
    out.set(p.address, pal.some((a) => meAliases.has(a) || live.has(a)));
  }
  return out;
}

function cmdSend(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["kind", "seq", "body", "reply-to", "role", "name", "squad"]);
  const target = p.positionals[0];
  if (!target || p.positionals.length !== 1) {
    throw new UsageError(
      `send needs exactly one <TARGET>, a herdr member name such as "lead" (see \`peers list\`)`,
    );
  }
  const stray = p.positionals.slice(1);
  if (stray.length > 0) {
    const got = oneLine(stray.join(" "));
    throw new UsageError(
      `unexpected text after the address (${JSON.stringify(got.length > 40 ? got.slice(0, 40) : got)}): ` +
        `the body goes in --body TEXT or on stdin, as in \`peers send ${target} --kind <kind> --seq <n> --body "<text>"\``,
    );
  }
  checkAddressTarget(target);
  const tab = resolveTabAddress(target, agentList().some((a) => a.address === target || a.pane === target));
  if (tab.error) throw new UsageError(tab.error);
  const kind = str(p, "kind");
  if (kind === undefined) {
    throw new UsageError(`missing --kind: one of ${KINDS.join(", ")} (see \`peers send --help\`)`);
  }
  if (!KINDS.includes(kind)) {
    throw new UsageError(
      `bad kind ${JSON.stringify(kind)}; expected one of ${KINDS.join(", ")} (see \`peers send --help\`)`,
    );
  }
  const seqRaw = str(p, "seq");
  if (seqRaw === undefined) {
    throw new UsageError("missing --seq: give the exchange number, for example --seq 1 (see `peers send --help`)");
  }
  const seq = Number(seqRaw);
  if (!Number.isInteger(seq)) throw new UsageError(`bad seq ${JSON.stringify(seqRaw)}; expected an integer exchange number`);
  const body = readBody(str(p, "body"));
  if (body.trim() === "") {
    throw new UsageError("empty message body; pass --body TEXT or pipe the body on stdin (see `peers send --help`)");
  }
  const replyRaw = str(p, "reply-to");
  let replyToRaw: string | null = null;
  if (replyRaw !== undefined) {
    checkAddressTarget(replyRaw.trim());
    replyToRaw = replyRaw.trim();
  }
  const senderRaw = selfAddress();

  const squad = str(p, "squad");
  const c = openCtx(squad, true);
  try {
    const agents = agentList();
    // Every spelling of the two sides maps to one canonical, whitespace-free
    // key: "Lena (lead)" sends as "lead", "planner" stays "planner".
    let cctx = canonCtx(c.store, agents);
    const senderKey = primary(senderRaw, cctx);
    const peerKey = primary(tab.canonical ?? target, cctx);
    if (senderKey.toLowerCase() === peerKey.toLowerCase()) {
      throw new UsageError("refusing to send a message to yourself");
    }
    const replyTo = replyToRaw === null ? null : primary(replyToRaw, cctx);
    const { role: statedRole, name: statedName } = ownIdentity(str(p, "role"), str(p, "name"), [
      process.cwd(),
      c.dir,
    ]);
    const stated = statedRole !== null;
    const role = statedRole ?? "unassigned";
    c.store.upsertProfile(
      {
        address: senderKey,
        runtime: c.kind,
        name: statedName,
        role: stated ? statedRole : null,
        cwd: c.dir,
        updated_at: nowMs(),
      },
      stated,
    );

    // A tab name is only the address: the notification and the live check
    // use the tab's terminal (a member word matches its "(member)" tab),
    // else any live spelling of the canonical peer, never the name in the
    // terminal's place.
    cctx = canonCtx(c.store, agents);
    const peerAliases = peerView(tab.canonical ?? target, cctx).aliases;
    const peerLow = lowerSet(peerAliases);
    let sendTo = tab.terminal ?? null;
    // Every other spelling of the peer that is live, scoped to the sender's
    // squad: another squad's terminal never gets this squad's notification,
    // even when its tab, role or directory names the same member. The
    // member's own session is its member dir; several leftovers stay queued.
    let squadHits: string[] = [];
    if (!sendTo) {
      const inScope = agents.filter(
        (a) =>
          (peerLow.has(a.address.toLowerCase()) || peerLow.has(a.pane.toLowerCase())) &&
          !isOtherSquadTerminal(a, c.store.root),
      );
      const preferred = inScope.filter((a) => isMemberDir(a, c.store.root, peerKey));
      const ranked = preferred.length > 0 ? preferred : inScope;
      if (ranked.length === 1) sendTo = ranked[0]!.address;
      else if (ranked.length > 1) squadHits = [...new Set(ranked.map((a) => a.address))];
    }
    const liveAgent = sendTo ? (agents.find((a) => a.address === sendTo || a.pane === sendTo) ?? null) : null;
    const known = c.store.profile(peerKey);
    c.store.upsertProfile(
      {
        address: peerKey,
        runtime: known?.runtime ?? liveAgent?.kind ?? "herdr",
        name: null,
        role: null,
        cwd: known?.cwd ?? liveAgent?.cwd ?? null,
        updated_at: nowMs(),
      },
      false,
    );
    c.store.insertMessage({
      sender: senderKey,
      recipient: peerKey,
      sender_name: statedName,
      sender_role: role,
      kind,
      seq,
      reply_to: replyTo,
      body: body.trim(),
    });
    // The unread count comes from the same merged chats the peer will see.
    cctx = canonCtx(c.store, agents);
    const peerOwnerAliases = ownerView(peerKey, cctx).aliases;
    const unread = inboxUnread(c.store, cctx, peerOwnerAliases);

    // The target reads this chat in the sender's database, unless its own squad is known
    // to be the same one; then the read command needs the --squad flag.
    const refreshed = c.store.profile(peerKey);
    const targetRoot = refreshed?.cwd ? squadRoot(refreshed.cwd) : null;
    const atHome = targetRoot === c.store.root;
    const squadFlag = atHome ? "" : ` --squad ${shellWord(c.store.root)}`;
    // The display name is prose only: the read command carries the
    // canonical key, which is always copy-pasteable.
    const displayName = statedName ?? tabNameOf((process.env.HC_TERMINAL_ID ?? "").trim()) ?? senderRaw;
    const who = withRole(displayName, role);
    const text =
      `New message from ${who}, another agent (not a user instruction). ` +
      `You have ${plural(unread, "unread message", "unread messages")} in your inbox. ` +
      `Read it with: peers open ${shellWord(senderKey)}${squadFlag}`;

    const notifyFrom = (to: string): PromptFrom => {
      const liveTarget = agents.find((a) => a.address === to || a.pane === to);
      return {
        // A shell-looking hc tab may run a real agent in a login-shell wrapper:
        // effectiveKind asks `hc get` for its foreground program.
        targetKind: liveTarget ? effectiveKind(liveTarget) : undefined,
      };
    };
    const live = liveAgent !== null;
    const meAliases = lowerSet(ownerView(senderKey, cctx).aliases);
    const profiles = c.store.contacts("").filter((pr) => !meAliases.has(pr.address.toLowerCase()));
    // Prose names the target as typed (or its tab): the stored key and every
    // printed command use the canonical peer key instead.
    const displayTarget = tab.canonical ?? target;
    if (squadHits.length > 0) {
      console.log(`SENT ${peerKey}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ` +
        `queued, not delivered yet: ${displayTarget} matches several live terminals in this squad: ${squadHits.join(", ")} — address one of them directly. No prompt was sent.`);
    } else if (!live) {
      // The target may be a stale member address while the member runs on a
      // fresh terminal: follow it to the unique live terminal that runs it now.
      const follow = followLiveTarget(c.store.root, peerKey, agents, profiles);
      if (follow.address !== "") {
        const done = prompt(follow.address, text, notifyFrom(follow.address));
        if (done.ok) {
          console.log(`SENT ${peerKey}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ` +
            `${displayTarget} is not live, but ${follow.address} runs it now — ${done.detail}`);
        } else {
          console.log(`SENT ${peerKey}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ` +
            `queued, not delivered yet: ${displayTarget} is not live, and notifying ${follow.address} failed: ${done.detail}`);
        }
      } else {
        const hint = follow.candidates.length > 1 ? ` Live terminals matching it: ${follow.candidates.join(", ")} — address one of them directly.` : "";
        console.log(`SENT ${peerKey}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ` +
          `queued, not delivered yet: ${displayTarget} is not a live agent. It gets the notification when it runs and the next message arrives. No prompt was sent.${hint}`);
      }
    } else {
      const done = prompt(sendTo!, text, notifyFrom(sendTo!));
      if (!done.ok) throw new Error(`the message is stored in ${peerKey}'s inbox, but its notification failed: ${done.detail}`);
      console.log(`SENT ${peerKey}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ${done.detail}`);
    }
    // A replaced target never answers: name the session that holds its role now.
    {
      const liveMap = liveness(c.store, meAliases, agents, cctx);
      const flags = profiles.map((pr) => liveMap.get(pr.address) ?? false);
      const st = statuses(profiles, flags);
      const i = profiles.findIndex((pr) => peerLow.has(pr.address.toLowerCase()));
      if (i >= 0) {
        const s = st[i]!;
        if (typeof s !== "string") {
          const role = profiles[i]!.role ?? "";
          console.log(
            `REPLACED: ${peerKey} no longer runs, and ${s.replaced} holds its role (${role}) now; it will not answer. ` +
              `Send this message to ${s.replaced} instead.`,
          );
        }
      }
    }
    if (replyTo) {
      console.log(`REPLY: the answer goes to ${replyTo}, not to you. End your turn now; do not wait for it.`);
    } else if (["request", "notice", "completion"].includes(kind)) {
      console.log(
        `REPLY: the notification of the answer arrives in this session as a new turn while it runs in herdr or herdr-core. ` +
          `Read the answer then with \`peers open ${shellWord(peerKey)}${squadFlag}\`. End your turn now. ` +
          `Do not sleep, poll, loop, re-read your inbox, list sessions or start a background task or timer to wait for it.`,
      );
    }
    return 0;
  } finally {
    c.store.close();
  }
}

function cmdContacts(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["squad"]);
  if (p.positionals.length !== 0) throw new UsageError("contacts takes no arguments");
  const c = openCtx(str(p, "squad"), true);
  try {
    const agents = agentList();
    const cctx = canonCtx(c.store, agents);
    const meAliases = lowerSet(ownerView(c.me, cctx).aliases);
    const profiles = c.store.contacts("").filter((pr) => !meAliases.has(pr.address.toLowerCase()));
    if (profiles.length === 0) {
      console.log(
        `No contacts yet in ${c.store.root}: a peer appears here once it runs any peers command in this squad, or once you message it.`,
      );
      return 0;
    }
    const liveMap = liveness(c.store, meAliases, agents, cctx);
    const flags = profiles.map((pr) => liveMap.get(pr.address) ?? false);
    const st = statuses(profiles, flags);
    const rank = (s: Status): number => (typeof s === "string" ? (s === "live" ? 0 : 1) : 2);
    const rows = profiles
      .map((pr, i) => ({ pr, s: st[i]! }))
      .sort((a, b) => rank(a.s) - rank(b.s));
    for (const { pr, s } of rows) {
      const { name, role } = label(pr);
      const by = typeof s !== "string" ? `  by=${s.replaced}` : "";
      console.log(
        `${pr.address}  status=${statusWord(s)}${by}  name=${JSON.stringify(name)}  role=${role}  kind=${pr.runtime}  cwd=${pr.cwd ?? "?"}  seen=${localTime(pr.updated_at)}`,
      );
    }
    return 0;
  } finally {
    c.store.close();
  }
}

function cmdChats(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["squad"]);
  if (p.positionals.length !== 0) throw new UsageError("chats takes no arguments");
  const c = openCtx(str(p, "squad"), true);
  try {
    const agents = agentList();
    const cctx = canonCtx(c.store, agents);
    const me = ownerView(c.me, cctx);
    const chats = mergedChats(c.store, cctx, me.aliases);
    const unread = chats.reduce((n, ch) => n + ch.unread, 0);
    const ownLow = lowerSet(me.aliases);
    console.log(`INBOX ${me.key} in ${c.store.root}: ${plural(unread, "unread message", "unread messages")} in ${plural(chats.length, "chat", "chats")}`);
    for (const ch of chats) {
      const { name, role } = label(ch.profile);
      const last = ch.last;
      const from = ownLow.has(last.sender.toLowerCase()) ? "you" : "them";
      const kind =
        ownLow.has(last.sender.toLowerCase())
          ? `${last.kind} seq ${last.seq}, ${last.read_at === null ? "not read yet" : `read ${localTime(last.read_at)}`}`
          : `${last.kind} seq ${last.seq}`;
      console.log(
        `${ch.peer}  name=${JSON.stringify(name)}  role=${role}  unread=${ch.unread}  messages=${ch.total}  last=${localTime(last.sent_at)} from ${from} [${kind}]: ${oneLine(last.body).slice(0, 80)}`,
      );
    }
    const first = chats.find((ch) => ch.unread > 0) ?? chats[0];
    if (first) console.log(`OPEN: peers open ${shellWord(first.peer)}${squadFlagOf(c.store.root, c.explicit)}`);
    return 0;
  } finally {
    c.store.close();
  }
}

/** The chat partner as its profile knows it, which its messages fall back to. */
interface Partner {
  name: string;
  role: string;
}

/** One message as a chat bubble, told from your side. */
function render(m: Msg, mine: boolean, partner: Partner): void {
  const day = localDate(m.sent_at);
  const meta: string[] = [`${m.kind} seq ${m.seq}`];
  if (m.reply_to) meta.push(`answer goes to ${m.reply_to}`);
  let who: string;
  if (mine) {
    meta.push(
      m.read_at === null
        ? "not read yet"
        : localDate(m.read_at) === day
          ? `read ${localHM(m.read_at)}`
          : `read ${localDate(m.read_at)} ${localHM(m.read_at)}`,
    );
    who = "you";
  } else {
    const name = m.sender_name && m.sender_name !== "" ? m.sender_name : partner.name;
    const role = m.sender_role;
    if (role !== "unassigned" && role !== partner.role && !name.includes(`(${role})`)) meta.push(`as ${role}`);
    if (m.read_at === null) meta.push("new");
    who = name === "" ? "partner" : name;
  }
  console.log(`[${who}] #${m.id} ${localHM(m.sent_at)}  ${meta.join(" · ")}`);
  for (const line of m.body.replace(/\s+$/, "").split("\n")) {
    console.log(line === "" ? "" : `  ${line}`);
  }
  console.log("");
}

function cmdOpen(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["page", "squad"]);
  const target = p.positionals[0];
  if (!target || p.positionals.length !== 1) throw new UsageError("open needs exactly one <TARGET>");
  checkAddressTarget(target);
  const tab = resolveTabAddress(target, agentList().some((a) => a.address === target || a.pane === target));
  if (tab.error) throw new UsageError(tab.error);
  const pageRaw = str(p, "page") ?? "1";
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) throw new UsageError(`bad --page ${JSON.stringify(pageRaw)}: expected an integer >= 1`);
  const c = openCtx(str(p, "squad"), true);
  try {
    const agents = agentList();
    const cctx = canonCtx(c.store, agents);
    const me = ownerView(c.me, cctx);
    const ownLow = lowerSet(me.aliases);
    const peer = peerView(tab.canonical ?? target, cctx);
    // A quoted tab name with whitespace opens the same merged chat.
    if (!tab.canonical && !isKnownPeer(tab.canonical ?? target, cctx, c.store)) {
      throw new UsageError(`no member, terminal or tab named ${JSON.stringify(target)}`);
    }
    const visible = visibleChat(c.store, cctx, me.aliases, peer.key);
    const total = visible.length;
    if (total === 0) {
      console.log(`No chat with ${peer.key} in your inbox in ${c.store.root}.`);
      return 0;
    }
    const pages = Math.ceil(total / PAGE_SIZE);
    if (page > pages) {
      throw new UsageError(
        `page ${page} does not exist: the chat with ${peer.key} has ${plural(pages, "page", "pages")} of ${PAGE_SIZE} messages`,
      );
    }
    const start = Math.max(0, total - page * PAGE_SIZE);
    const msgs = visible.slice(start, start + PAGE_SIZE);
    const { name, role } = label(bestProfile(cctx, peer.aliases));
    const partner: Partner = { name, role };
    const last = total - (page - 1) * PAGE_SIZE;
    const first = last - msgs.length + 1;
    if (name === "") console.log(`CHAT with ${peer.key} (${role})`);
    else console.log(`CHAT with ${withRole(name, role)} · ${peer.key}`);
    console.log(`page ${page} of ${pages}  (messages ${first}-${last} of ${total}, oldest first; page 1 holds the newest)\n`);
    const mine = (m: Msg): boolean => ownLow.has(m.sender.toLowerCase());
    const toMe = (m: Msg): boolean => ownLow.has(m.recipient.toLowerCase());
    const unread = msgs.filter((m) => toMe(m) && m.read_at === null).length;
    let day = "";
    let divided = false;
    for (const m of msgs) {
      const d = localDate(m.sent_at);
      if (d !== day) {
        console.log(`── ${d} ──\n`);
        day = d;
      }
      if (!divided && toMe(m) && m.read_at === null) {
        console.log(`── ${plural(unread, "unread message", "unread messages")} ──\n`);
        divided = true;
      }
      render(m, mine(m), partner);
    }
    c.store.markRead(
      me.aliases,
      msgs.filter((m) => toMe(m) && m.read_at === null).map((m) => m.id),
    );
    const flag = squadFlagOf(c.store.root, c.explicit);
    if (page < pages) {
      const older = visible.filter((m) => m.id < msgs[0]!.id && toMe(m) && m.read_at === null).length;
      const note = older > 0 ? `  (${plural(older, "unread message", "unread messages")} on older pages)` : "";
      console.log(`OLDER: peers open ${shellWord(peer.key)}${flag} --page ${page + 1}${note}`);
    }
    if (page > 1) console.log(`NEWER: peers open ${shellWord(peer.key)}${flag} --page ${page - 1}`);
    console.log(`INBOX: ${plural(inboxUnread(c.store, cctx, me.aliases), "unread message", "unread messages")} left in your inbox`);
    return 0;
  } finally {
    c.store.close();
  }
}

function cmdDelete(argv: string[]): number {
  const p = parseArgs(argv, []);
  unknownFlags(p, ["squad"]);
  const target = p.positionals[0];
  if (!target || p.positionals.length !== 1) throw new UsageError("delete needs exactly one <TARGET>");
  checkAddressTarget(target);
  const tab = resolveTabAddress(target, agentList().some((a) => a.address === target || a.pane === target));
  if (tab.error) throw new UsageError(tab.error);
  const c = openCtx(str(p, "squad"), true);
  try {
    const agents = agentList();
    const cctx = canonCtx(c.store, agents);
    const me = ownerView(c.me, cctx);
    const peer = peerView(tab.canonical ?? target, cctx);
    if (!tab.canonical && !isKnownPeer(tab.canonical ?? target, cctx, c.store)) {
      throw new UsageError(`no member, terminal or tab named ${JSON.stringify(target)}`);
    }
    const visible = visibleChat(c.store, cctx, me.aliases, peer.key);
    const n = c.store.hideChat(me.key, peer.key, visible);
    if (n === 0) console.log(`No chat with ${peer.key} in your inbox; nothing deleted.`);
    else {
      console.log(
        `DELETED your view of the chat with ${peer.key}: ${plural(n, "message", "messages")} hidden from you; ${peer.key} still sees the whole chat.`,
      );
    }
    return 0;
  } finally {
    c.store.close();
  }
}

