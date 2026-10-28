// One function per command, plus the help texts. `dispatch` routes them.

import fs from "node:fs";
import path from "node:path";
import { UsageError, parseArgs, str, unknownFlags } from "./args.ts";
import { agentList, checkTarget, prompt, type HerdrAgent } from "./herdr.ts";
import { ownContext, ownIdentity, register, selfAddress, squadRoot } from "./identity.ts";
import { PAGE_SIZE, Store, nowMs, type Msg, type Profile } from "./store.ts";

const KINDS = ["request", "ack", "progress", "completion", "receipt", "notice"];

export const HELP: Record<string, string> = {
  "": `peers — inbox messenger between agent sessions in one herdr workspace

Usage: peers [--squad <dir>] <command> [options]

Commands:
  whoami     Print this session's member address
  list       List live herdr agents
  send       Store one message in a chat, then notify the peer with one herdr agent prompt
  contacts   List every peer profile in the squad's database, with its status
  chats      List your chats with their unread counts (also: peers inbox)
  open       Print one page of a chat
  delete     Hide a chat from your own view; the peer keeps its copy

How it works:
  1. peers send <peer> --kind request --seq 1 --body "<text>"
     stores the message; the peer gets one notification turn:
     New message from <name> (<role>). You have 1 unread message in your inbox. Read it with: peers open <you>
  2. The peer runs that \`peers open\`, then answers with its own \`peers send\`.
  3. The answer reaches you the same way, as a new turn. Nobody polls.

Addresses:
  A peer's address is its herdr member name (such as "lead"), or its pane id
  (such as "w1:p1") wherever a name does. Find them with \`peers list\`.

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
  PEERS_SELF              your address, when herdr cannot tell it
  PEERS_CWD               your session directory, when herdr cannot tell it
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
  whoami: `peers whoami — print this session's member address

Usage: peers whoami

Output:
  lead                  this session's address, one line

Identity, first match wins:
  PEERS_SELF=<address>  overrides everything below
  HERDR_PANE_ID         matched against \`herdr agent list\`

Notes:
  - Also records your profile, so your squad sees you in \`peers contacts\`.
  - Exit 2 outside a herdr agent session with no PEERS_SELF.

Examples:
  peers whoami`,
  list: `peers list — list live herdr agents

Usage: peers list

Output:
  lead  kind=muse  status=done  cwd=<dir>  workspace=<id>
  one line per live agent; nothing when none matches

Notes:
  - Asks herdr, not the peers database: it shows live agents, including ones that never used peers.
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

Notification, one route for every peer:
  The message is stored, then delivered with one fire-and-forget
  \`herdr agent prompt <target> <notification>\`: no --wait, no polling.
  A peer that is not live gets the line \`queued, not delivered yet: <reason>\`:
  the message waits in its inbox until it runs and the next message arrives,
  when the notification carries every waiting message's count.

Notes:
  - After it, end your turn: never sleep, poll or re-open the chat to wait for the answer.
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
  console.log(me);
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
  for (const a of agentList()) {
    if (me !== null && (a.address === me || a.pane === me)) continue;
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

/** Whether each profiled peer runs now in herdr. `me` is live by definition. */
function liveness(store: Store, me: string, agents: HerdrAgent[]): Map<string, boolean> {
  const byAddress = new Map(agents.map((a) => [a.address, true]));
  const byPane = new Map(agents.map((a) => [a.pane, true]));
  const out = new Map<string, boolean>();
  for (const p of store.contacts("")) {
    out.set(p.address, p.address === me || byAddress.has(p.address) || byPane.has(p.address));
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
  const bad = checkTarget(target);
  if (bad) throw new UsageError(bad);
  const kind = str(p, "kind");
  if (!kind || !KINDS.includes(kind)) {
    throw new UsageError(
      `bad kind ${JSON.stringify(kind ?? "")}; expected one of ${KINDS.join(", ")} (see \`peers send --help\`)`,
    );
  }
  const seqRaw = str(p, "seq");
  const seq = seqRaw === undefined ? NaN : Number(seqRaw);
  if (!Number.isInteger(seq)) throw new UsageError(`bad seq ${JSON.stringify(seqRaw ?? "")}; expected an integer exchange number`);
  const body = readBody(str(p, "body"));
  if (body.trim() === "") {
    throw new UsageError("empty message body; pass --body TEXT or pipe the body on stdin (see `peers send --help`)");
  }
  const replyRaw = str(p, "reply-to");
  let replyTo: string | null = null;
  if (replyRaw !== undefined) {
    const err = checkTarget(replyRaw);
    if (err) throw new UsageError(`bad --reply-to ${err}`);
    replyTo = replyRaw.trim();
  }
  const sender = selfAddress();
  if (sender === target) throw new UsageError("refusing to send a message to yourself");

  const squad = str(p, "squad");
  const c = openCtx(squad, true);
  try {
    const { role: statedRole, name: statedName } = ownIdentity(str(p, "role"), str(p, "name"), [
      process.cwd(),
      c.dir,
    ]);
    const stated = statedRole !== null;
    const role = statedRole ?? "unassigned";
    c.store.upsertProfile(
      {
        address: sender,
        runtime: c.kind,
        name: statedName,
        role: stated ? statedRole : null,
        cwd: c.dir,
        updated_at: nowMs(),
      },
      stated,
    );

    const agents = agentList();
    const liveAgent = agents.find((a) => a.address === target || a.pane === target) ?? null;
    const known = c.store.profile(target);
    c.store.upsertProfile(
      {
        address: target,
        runtime: known?.runtime ?? liveAgent?.kind ?? "herdr",
        name: null,
        role: null,
        cwd: known?.cwd ?? liveAgent?.cwd ?? null,
        updated_at: nowMs(),
      },
      false,
    );
    c.store.insertMessage({
      sender,
      recipient: target,
      sender_name: statedName,
      sender_role: role,
      kind,
      seq,
      reply_to: replyTo,
      body: body.trim(),
    });
    const unread = c.store.unreadTotal(target);

    // The target reads this chat in the sender's database, unless its own squad is known
    // to be the same one; then the read command needs the --squad flag.
    const refreshed = c.store.profile(target);
    const targetRoot = refreshed?.cwd ? squadRoot(refreshed.cwd) : null;
    const atHome = targetRoot === c.store.root;
    const squadFlag = atHome ? "" : ` --squad ${shellWord(c.store.root)}`;
    const who = withRole(statedName ?? sender, role);
    const text =
      `New message from ${who}. You have ${plural(unread, "unread message", "unread messages")} in your inbox. ` +
      `Read it with: peers open ${sender}${squadFlag}`;

    const live = liveAgent !== null;
    if (!live) {
      console.log(`SENT ${target}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ` +
        `queued, not delivered yet: ${target} is not a live herdr agent. It gets the notification when it runs in herdr and the next message arrives. No prompt was sent.`);
    } else {
      const done = prompt(target, text);
      if (!done.ok) throw new Error(`the message is stored in ${target}'s inbox, but its notification failed: ${done.detail}`);
      console.log(`SENT ${target}: stored in its inbox (${plural(unread, "unread message", "unread messages")}); ${done.detail}`);
    }
    // A replaced target never answers: name the session that holds its role now.
    {
      const profiles = c.store.contacts(sender);
      const liveMap = liveness(c.store, sender, agents);
      const flags = profiles.map((pr) => liveMap.get(pr.address) ?? false);
      const st = statuses(profiles, flags);
      const i = profiles.findIndex((pr) => pr.address === target);
      if (i >= 0) {
        const s = st[i]!;
        if (typeof s !== "string") {
          const role = profiles[i]!.role ?? "";
          console.log(
            `REPLACED: ${target} no longer runs, and ${s.replaced} holds its role (${role}) now; it will not answer. ` +
              `Send this message to ${s.replaced} instead.`,
          );
        }
      }
    }
    if (replyTo) {
      console.log(`REPLY: the answer goes to ${replyTo}, not to you. End your turn now; do not wait for it.`);
    } else if (["request", "notice", "completion"].includes(kind)) {
      console.log(
        `REPLY: the notification of the answer arrives in this session as a new turn while it runs in herdr. ` +
          `Read the answer then with \`peers open ${target}${squadFlag}\`. End your turn now. ` +
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
    const me = c.me;
    const agents = agentList();
    const profiles = c.store.contacts(me).filter((pr) => pr.address !== me);
    if (profiles.length === 0) {
      console.log(
        `No contacts yet in ${c.store.root}: a peer appears here once it runs any peers command in this squad, or once you message it.`,
      );
      return 0;
    }
    const liveMap = liveness(c.store, me, agents);
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
    const owner = c.me;
    const chats = c.store.chats(owner);
    const unread = c.store.unreadTotal(owner);
    console.log(`INBOX ${owner} in ${c.store.root}: ${plural(unread, "unread message", "unread messages")} in ${plural(chats.length, "chat", "chats")}`);
    for (const ch of chats) {
      const { name, role } = label(ch.profile);
      const last = ch.last;
      const from = last.sender === owner ? "you" : "them";
      const kind =
        last.sender === owner
          ? `${last.kind} seq ${last.seq}, ${last.read_at === null ? "not read yet" : `read ${localTime(last.read_at)}`}`
          : `${last.kind} seq ${last.seq}`;
      console.log(
        `${ch.peer}  name=${JSON.stringify(name)}  role=${role}  unread=${ch.unread}  messages=${ch.total}  last=${localTime(last.sent_at)} from ${from} [${kind}]: ${oneLine(last.body).slice(0, 80)}`,
      );
    }
    const first = chats.find((ch) => ch.unread > 0) ?? chats[0];
    if (first) console.log(`OPEN: peers open ${first.peer}${squadFlagOf(c.store.root, c.explicit)}`);
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
function render(m: Msg, owner: string, partner: Partner): void {
  const day = localDate(m.sent_at);
  const meta: string[] = [`${m.kind} seq ${m.seq}`];
  if (m.reply_to) meta.push(`answer goes to ${m.reply_to}`);
  let who: string;
  if (m.sender === owner) {
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
  const p = parseArgs(argv, ["page"]);
  unknownFlags(p, ["page", "squad"]);
  const target = p.positionals[0];
  if (!target || p.positionals.length !== 1) throw new UsageError("open needs exactly one <TARGET>");
  const bad = checkTarget(target);
  if (bad) throw new UsageError(bad);
  const pageRaw = str(p, "page") ?? "1";
  const page = Number(pageRaw);
  if (!Number.isInteger(page) || page < 1) throw new UsageError(`bad --page ${JSON.stringify(pageRaw)}: expected an integer >= 1`);
  const c = openCtx(str(p, "squad"), true);
  try {
    const owner = c.me;
    const total = c.store.chatCount(owner, target);
    if (total === 0) {
      console.log(`No chat with ${target} in your inbox in ${c.store.root}.`);
      return 0;
    }
    const pages = Math.ceil(total / PAGE_SIZE);
    if (page > pages) {
      throw new UsageError(
        `page ${page} does not exist: the chat with ${target} has ${plural(pages, "page", "pages")} of ${PAGE_SIZE} messages`,
      );
    }
    const msgs = c.store.page(owner, target, page);
    const { name, role } = label(c.store.profile(target));
    const partner: Partner = { name, role };
    const last = total - (page - 1) * PAGE_SIZE;
    const first = last - msgs.length + 1;
    if (name === "") console.log(`CHAT with ${target} (${role})`);
    else console.log(`CHAT with ${withRole(name, role)} · ${target}`);
    console.log(`page ${page} of ${pages}  (messages ${first}-${last} of ${total}, oldest first; page 1 holds the newest)\n`);
    const unread = msgs.filter((m) => m.recipient === owner && m.read_at === null).length;
    let day = "";
    let divided = false;
    for (const m of msgs) {
      const d = localDate(m.sent_at);
      if (d !== day) {
        console.log(`── ${d} ──\n`);
        day = d;
      }
      if (!divided && m.recipient === owner && m.read_at === null) {
        console.log(`── ${plural(unread, "unread message", "unread messages")} ──\n`);
        divided = true;
      }
      render(m, owner, partner);
    }
    c.store.markRead(
      owner,
      msgs.filter((m) => m.recipient === owner && m.read_at === null).map((m) => m.id),
    );
    const flag = squadFlagOf(c.store.root, c.explicit);
    if (page < pages) {
      const older = c.store.unreadBefore(owner, target, msgs[0]!.id);
      const note = older > 0 ? `  (${plural(older, "unread message", "unread messages")} on older pages)` : "";
      console.log(`OLDER: peers open ${target}${flag} --page ${page + 1}${note}`);
    }
    if (page > 1) console.log(`NEWER: peers open ${target}${flag} --page ${page - 1}`);
    console.log(`INBOX: ${plural(c.store.unreadTotal(owner), "unread message", "unread messages")} left in your inbox`);
    return 0;
  } finally {
    c.store.close();
  }
}

function cmdDelete(argv: string[]): number {
  const p = parseArgs(argv, ["squad"]);
  unknownFlags(p, ["squad"]);
  const target = p.positionals[0];
  if (!target || p.positionals.length !== 1) throw new UsageError("delete needs exactly one <TARGET>");
  const bad = checkTarget(target);
  if (bad) throw new UsageError(bad);
  const c = openCtx(str(p, "squad"), true);
  try {
    const n = c.store.deleteChat(c.me, target);
    if (n === 0) console.log(`No chat with ${target} in your inbox; nothing deleted.`);
    else {
      console.log(
        `DELETED your view of the chat with ${target}: ${plural(n, "message", "messages")} hidden from you; ${target} still sees the whole chat.`,
      );
    }
    return 0;
  } finally {
    c.store.close();
  }
}
