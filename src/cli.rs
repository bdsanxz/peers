//! Command line: argument parsing, help texts and one function per command.

use crate::address::{Address, KINDS};
use crate::identity::{self, own_identity, self_address, session_dir, squad_root};
use crate::presence::{self, Status};
use crate::store::{Msg, NewMessage, Profile, Store, PAGE_SIZE};
use crate::util::*;
use crate::{channel, deliver, runtime};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

const ABOUT: &str = "peers — inbox messenger between agent sessions on this machine (OpenCode, Claude Code, Antigravity, pi, Muse Code)";

const AFTER_HELP: &str = r#"How it works:
  1. peers send <peer> --kind request --seq 1 --body "<text>"
     stores the message; the peer gets only one notification line:
     New message from <name> (<role>). You have 1 unread message in your inbox. Read it with: peers open <you>
  2. The peer runs that `peers open`, then answers with its own `peers send`.
  3. The answer reaches you the same way, as a new turn. Nobody polls.

Addresses:
  opencode:<ses_...>               an OpenCode session
  claude:<session uuid>            a Claude Code session
  antigravity:<conversation uuid>  an Antigravity conversation
  pi:<session id>                  a pi session
  muse:<session uuid>              a Muse Code session

For agents:
  - After a send, end your turn: never sleep, poll, loop or re-open to wait for the answer.
  - Read with the exact command the notification gives, its --squad flag included.
  - Answer with the message's --seq, to `answer goes to <addr>` when it has one, else to the chat's peer.
  - Run `peers <command> --help` before you first use a command.

Storage:
  ~/.local/cache/peers/<dashed squad dir>/bd.sql   one SQLite database per squad
  squad dir       nearest directory at or above your session's that holds roster.json, else your session's
  --squad <dir>   use that squad's database instead

Environment:
  PEERS_SELF              your address, when no runtime variable gives it
  PEERS_CWD               your session directory, when your runtime cannot tell it
  PEERS_ROLE, PEERS_NAME  your role and name in the messages you send; a name without the role
  PEERS_CACHE             another cache root instead of ~/.local/cache/peers
  AGY_HOME                Antigravity's data directory (default ~/.gemini/antigravity-cli)
  PI_CODING_AGENT_SESSION_DIR, PI_CODING_AGENT_DIR
                          where pi saves its sessions (default ~/.pi/agent/sessions)
  XDG_DATA_HOME           where Muse Code keeps its data (its session index lives under
                          $XDG_DATA_HOME/muse, else ~/.local/share/muse)

Exit codes:
  0  success
  2  usage error or failed command; the error line says why

Examples:
  peers whoami
  peers send opencode:ses_abc --kind request --seq 1 --body "Review api/."
  peers chats
  peers open claude:<uuid>"#;

#[derive(Parser)]
#[command(name = "peers", version, about = ABOUT, after_help = AFTER_HELP)]
pub struct Cli {
    /// Use this squad's database (any directory) instead of your own squad's.
    #[arg(long, global = true, value_name = "DIR", display_order = 100)]
    squad: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print this session's peer address
    #[command(after_help = r#"Output:
  claude:<uuid>                  this session's address, one line

Identity, first match wins:
  PEERS_SELF=<address>           overrides everything below
  OPENCODE_SESSION_ID            OpenCode
  CLAUDE_CODE_SESSION_ID         Claude Code
  ANTIGRAVITY_CONVERSATION_ID    Antigravity
  PI_SESSION_ID                  pi
  MUSE_SESSION_ID                Muse Code
  (when several are set, the nearest runtime process among your ancestors decides)

Notes:
  - Also records your profile, so your squad sees you in `peers contacts`.
  - Exit 2 outside an agent session.

Examples:
  peers whoami"#)]
    Whoami,

    /// List live and recent sessions of every runtime
    #[command(after_help = r#"Output:
  claude:<uuid>  kind=<kind>  status=<status>  name="<name>"  [cwd=<dir>]
  one line per session; nothing when none matches

Default filter, each lifted by a flag:
  only sessions in this directory      --all-dirs (also prints cwd=)
  no finished Claude background ones   --all
  pi: only sessions that listen through the peers extension or changed in the last 24 hours
                                       --all
  no OpenCode child sessions           --children
  never your own session

Notes:
  - Asks each runtime directly, not the peers database.
  - Muse Code sessions come from its session index, live when their process runs.

Examples:
  peers list
  peers list --all-dirs --all"#)]
    List {
        /// Include sessions in every directory, and show each one's cwd.
        #[arg(long)]
        all_dirs: bool,
        /// Include finished Claude background sessions and every saved pi session.
        #[arg(long)]
        all: bool,
        /// Include OpenCode child sessions.
        #[arg(long)]
        children: bool,
    },

    /// Store one message in the chat with a peer, then notify the peer
    #[command(
        override_usage = "peers send <TARGET> --kind <KIND> --seq <N> (--body <TEXT> | <body on stdin>) [OPTIONS]",
        after_help = r#"Output:
  SENT <target>: stored in its inbox (1 unread message); notified via channel (...)
  REPLY: <how the answer will reach you>. End your turn now. ...
  REPLY comes after a request, notice or completion; with --reply-to it names where the answer goes.

Kinds:
  request      asks for work; answered by one completion
  ack          confirms a request: restates its scope, or asks specific questions
  progress     a blocker, a decision request or missing input
  completion   the single final result of a request
  receipt      closes the exchange: OK, or NO and why; never answered
  notice       information that needs no work; answered by a receipt

Notification route, by target. Nothing runs headless unless you pass --headless:
  opencode:<id>, running or in a TUI  steered into the session; an open idle TUI starts a turn
  opencode:<id>, neither              waits in its OpenCode inbox for the session's next turn
  claude:<uuid>, live                 queued for its peers channel
  claude:<uuid>, stopped              queued for when it next starts with the channel
  antigravity:<uuid>, TUI in herdr    typed into the agy TUI
  antigravity:<uuid>, anything else   queued; the inbox keeps the message (`peers chats`)
  pi:<id>, peers extension listening  queued for the extension; arrives as a turn
  pi:<id>, no listener                queued for when it next starts with the peers extension
  muse:<uuid>, TUI in herdr           typed into the muse TUI
  muse:<uuid>, anything else          queued; the inbox keeps the message (`peers chats`)

With --headless, a target that is not live is run headless for one turn instead:
  opencode   resumed in the OpenCode service
  claude     `claude -p --resume`
  antigravity  `agy -p`, one run at a time, in order (refused for a TUI outside herdr)
  pi         `pi --session <file>`, one run at a time, in order
  muse       `muse exec --session-id <id>`, one run at a time, in order (refused for a TUI outside herdr)

Notes:
  - After it, end your turn: never sleep, poll or re-open the chat to wait for the answer.
  - Reuse the request's --seq for every message of its exchange; a new exchange takes a new number.
  - Write --name (and PEERS_NAME, .peers.json's display_name) without the role: --name Rina, not
    --name "Rina (backend)". peers adds the role itself, so the peer sees "Rina (backend)".
  - The body never holds secrets: it stays in the squad's chat history.
  - Exit 2 on a bad address or kind, an empty body, a send to yourself or a failing runtime CLI.
  - "stored ... but its notification failed": do not send it again; the message is in the chat.
  - "queued, not delivered yet": the target is not live; nothing ran. Pass --headless only when the
    user asked for a headless run.

Examples:
  peers send opencode:ses_abc --kind request --seq 1 --body "Summarize README.md."
  peers send claude:<uuid> --kind completion --seq 1 < result.md
  peers send antigravity:<uuid> --kind request --seq 2 --reply-to opencode:ses_boss --body "...""#
    )]
    Send(SendArgs),

    /// List every peer profile in the squad's database, with whether it is live
    #[command(after_help = r#"Output:
  claude:<uuid>  status=live  name="Lena"  role=lead  runtime=claude  cwd=<dir>  seen=<time>
  pi:<id>  status=replaced  by=claude:<uuid>  name="Sari"  role=qa  ...
  one line per peer, never you: live ones first, then offline, then replaced; most recently active
  first within each

Status:
  live      The session runs now: a peers channel or extension listens, or its runtime shows it open.
  offline   It does not run, and no other session holds its role. A message waits until it runs.
  replaced  It does not run, and another session of the same role is live or was seen after it,
            such as a member restarted on another runtime after hitting a limit. Message the
            session after `by=` instead; this one will not answer.

Notes:
  - A session is recorded the first time it runs any peers command, or once you message it.
  - The roles "unassigned" and "user" are shared, so they never replace each other.

Examples:
  peers contacts
  peers contacts --squad ~/squads/shop"#)]
    Contacts,

    /// List your chats, newest first, with their unread counts
    #[command(
        visible_alias = "inbox",
        after_help = r#"Output:
  INBOX <you> in <squad dir>: 2 unread messages in 3 chats
  claude:<uuid>  name="Lena"  role=lead  unread=2  messages=9  last=<time> from them [ack seq 3]: On it.
  claude:<uuid>  name="Oki"  role=ops  unread=0  messages=4  last=<time> from you [notice seq 2, not read yet]: ...
  OPEN: peers open claude:<uuid>

Markers:
  from them | from you             who sent the chat's last message
  [<kind> seq <n>]                 the last message's kind and exchange
  not read yet | read <time>       on your last message: whether the peer has read it
  OPEN: <command>                  the chat to open next: the newest with unread messages, else the newest

Notes:
  - Run it once when you start or resume; never loop on it to wait for a reply.

Examples:
  peers chats
  peers inbox --squad ~/squads/shop"#
    )]
    Chats,

    /// Print one page of a chat, like a messenger: you and the peer
    #[command(after_help = "Output:
  CHAT with Lena (lead) · claude:<uuid>           the peer: name (role) · address
  page 1 of 2  (messages 21-40 of 40, ...)        20 messages a page, oldest first

  ── 2026-10-26 ──                                a new day
  [you] #21 10:00  request seq 3 · read 10:01     your message; read or not read yet
    Review api/.                                  the body, indented
  ── 1 unread message ──                          unread messages start here
  [Lena] #22 10:05  ack seq 3 · new               the peer's message, by its name

  OLDER: peers open claude:<uuid> --page 2        older messages (and unread ones there)
  INBOX: 0 unread messages left in your inbox     unread in all your chats

Markers on the peer's line:
  new                     not read before this command printed it
  answer goes to <addr>   reply to <addr>, not to the peer
  as <role>               sent under another role than the CHAT line's
  [partner]               the peer has no name

Reply:
  peers send <TARGET> --kind <kind> --seq <its seq> --body \"<text>\"

Notes:
  - Printing marks the messages read: read all of it, never pipe it through head or tail.
  - Unread messages on an OLDER page: open that page too before you act.
  - Exit 2 when the page does not exist.

Examples:
  peers open claude:<uuid>
  peers open opencode:ses_abc --page 2")]
    Open {
        /// The peer's address, such as claude:<uuid>.
        target: String,
        /// Page to print; 1 holds the newest 20 messages.
        #[arg(long, default_value_t = 1, value_name = "N", value_parser = clap::value_parser!(i64).range(1..))]
        page: i64,
    },

    /// Hide a chat from your own view; the peer keeps its copy
    #[command(after_help = r#"Output:
  DELETED your view of the chat with <peer>: 3 messages hidden from you; <peer> still sees the whole chat.
  No chat with <peer> in your inbox; nothing deleted.

Notes:
  - Only your view: the peer keeps every message.
  - A new message in either direction restarts the chat, showing only what came after.
  - Delete only when the user asks, or when the exchange is closed and its history is not needed.

Examples:
  peers delete claude:<uuid>"#)]
    Delete {
        /// The peer's address, such as claude:<uuid>.
        target: String,
    },

    /// Run the peers channel: an MCP stdio server for Claude Code
    #[command(after_help = r#"Notes:
  - Claude Code starts it from --mcp-config; do not run it by hand.
  - Speaks MCP JSON-RPC on stdin and stdout until stdin closes.
  - Pushes each notification for its session into the conversation as a turn.

Examples:
  claude --mcp-config "$(peers channel-config)" --dangerously-load-development-channels server:peers"#)]
    Channel,

    /// Print the --mcp-config JSON that loads the peers channel
    #[command(after_help = r#"Output:
  {"mcpServers":{"peers":{"args":["channel"],"command":"/abs/path/to/peers"}}}

Examples:
  claude --mcp-config "$(peers channel-config)" --dangerously-load-development-channels server:peers"#)]
    ChannelConfig,

    /// Print the pi extension that delivers notifications into pi sessions
    #[command(after_help = r#"Output:
  the TypeScript source of the peers extension for pi; with --path, the absolute path of a file
  that holds it

Notes:
  - A pi session gets its notifications as turns only while this extension runs in it.
  - The extension runs `peers _pi-listen` for its session, so it must come from the same peers
    as the one on PATH: load it with --path, or install it again after updating peers.
  - --path writes the extension to <cache root>/pi-extension/peers.ts, rewriting it only when it
    differs, so the file always matches this binary.

Examples:
  pi -e "$(peers pi-extension --path)"     (this run only; installs nothing)
  mkdir -p ~/.pi/agent/extensions && peers pi-extension > ~/.pi/agent/extensions/peers.ts"#)]
    PiExtension {
        /// Write the extension to the peers cache and print the file's path instead.
        #[arg(long)]
        path: bool,
    },

    /// Print the last turns of a session's own transcript
    #[command(after_help = r#"Output, OpenCode, Claude, pi and muse:
  user: <turn text, cut to 400 characters>
  assistant: <turn text, cut to 400 characters>

Output, Antigravity (its turns are protobuf):
  title: <title>
  status: <status>
  modified: <time>
  preview: <preview>

Output, muse (from its session log):
  user: <prompt text, cut to 400 characters>
  assistant: <turn text, cut to 400 characters>

Notes:
  - Reads the session's own transcript, not the peers chat.
  - Exit 2 when the session or its transcript does not exist.

Examples:
  peers show opencode:ses_abc
  peers show claude:<uuid> --last 10"#)]
    Show {
        /// The session's address, such as claude:<uuid>.
        target: String,
        /// Number of turns to print.
        #[arg(long, default_value_t = 6, value_name = "N")]
        last: usize,
    },

    /// Internal: print this session's pending notifications once and exit (tests).
    #[command(name = "_drain", hide = true)]
    Drain,

    /// Internal: holds a pi session's listener for its peers extension.
    #[command(name = "_pi-listen", hide = true)]
    PiListen {
        address: String,
        #[arg(long)]
        cwd: Option<PathBuf>,
    },

    /// Internal: runs spooled pi notifications in order.
    #[command(name = "_drain-pi", hide = true)]
    DrainPi {
        id: String,
        #[arg(long)]
        root: PathBuf,
    },

    /// Internal: runs spooled muse notifications in order.
    #[command(name = "_drain-muse", hide = true)]
    DrainMuse {
        id: String,
        #[arg(long)]
        root: PathBuf,
    },

    /// Internal: runs spooled Antigravity notifications in order.
    #[command(name = "_drain-antigravity", hide = true)]
    DrainAntigravity {
        cid: String,
        #[arg(long)]
        dir: PathBuf,
    },
}

#[derive(Args)]
struct SendArgs {
    /// The receiver's address, such as opencode:ses_abc.
    target: String,
    /// Words after the address: a body passed by mistake, refused with a hint.
    #[arg(hide = true)]
    stray: Vec<String>,
    /// Message kind (see Kinds below).
    #[arg(long, value_parser = KINDS, hide_possible_values = true)]
    kind: String,
    /// Exchange number: the request's number for every message of its exchange.
    #[arg(long, value_name = "N")]
    seq: i64,
    /// Message body [default: stdin].
    #[arg(long, value_name = "TEXT")]
    body: Option<String>,
    /// Where the receiver must send its answer, when not to you.
    #[arg(long, value_name = "ADDRESS")]
    reply_to: Option<String>,
    /// Your role in the squad [default: $PEERS_ROLE, then .peers.json, else unassigned].
    #[arg(long, value_name = "ROLE")]
    role: Option<String>,
    /// Your name in the peer's chat, without your role [default: $PEERS_NAME, then .peers.json, else none].
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
    /// Run a target that is not live headless for one turn. Only when the user asked for it.
    #[arg(long)]
    headless: bool,
}

pub fn run(cli: Cli) -> Res<()> {
    let squad = cli.squad.as_deref();
    match cli.cmd {
        Cmd::Whoami => cmd_whoami(),
        Cmd::List {
            all_dirs,
            all,
            children,
        } => cmd_list(all_dirs, all, children),
        Cmd::Send(a) => cmd_send(a, squad),
        Cmd::Contacts => cmd_contacts(squad),
        Cmd::Chats => cmd_chats(squad),
        Cmd::Open { target, page } => cmd_open(&target, page, squad),
        Cmd::Delete { target } => cmd_delete(&target, squad),
        Cmd::Drain => channel::run_drain_once(),
        Cmd::Channel => channel::run_channel(),
        Cmd::ChannelConfig => {
            println!(
                "{}",
                json!({"mcpServers": {"peers": {"command": exe(), "args": ["channel"]}}})
            );
            Ok(())
        }
        Cmd::Show { target, last } => {
            for line in runtime::show(&Address::parse(&target)?, last)? {
                println!("{line}");
            }
            Ok(())
        }
        Cmd::DrainAntigravity { cid, dir } => deliver::drain_antigravity(&cid, &dir),
        Cmd::PiExtension { path } => {
            if path {
                println!("{}", pi_extension_file()?.display());
            } else {
                print!("{PI_EXTENSION}");
            }
            Ok(())
        }
        Cmd::PiListen { address, cwd } => channel::run_pi_listen(&address, cwd.as_deref()),
        Cmd::DrainPi { id, root } => deliver::drain_pi(&id, &root),
        Cmd::DrainMuse { id, root } => deliver::drain_muse(&id, &root),
    }
}

/// This session in the database it works in.
struct Ctx {
    me: Address,
    /// The session's own directory.
    dir: PathBuf,
    store: Store,
    /// Whether --squad chose the database, so commands for this chat must repeat it.
    explicit: bool,
}

impl Ctx {
    fn open(squad: Option<&Path>) -> Res<Ctx> {
        let me = self_address()?;
        let dir = session_dir(&me);
        let (root, explicit) = match squad {
            Some(s) => {
                let root = canonical(s);
                if !root.is_dir() {
                    return Err(format!("--squad {}: no such directory", s.display()));
                }
                let explicit = root != squad_root(&dir);
                (root, explicit)
            }
            None => (squad_root(&dir), false),
        };
        let store = Store::open(&root)?;
        identity::register(&store, &me, &dir)?;
        Ok(Ctx {
            me,
            dir,
            store,
            explicit,
        })
    }

    fn squad_flag(&self) -> String {
        if self.explicit {
            format!(
                " --squad {}",
                shell_word(&self.store.root.display().to_string())
            )
        } else {
            String::new()
        }
    }
}

fn plural(n: i64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn label(p: Option<&Profile>) -> (String, String) {
    let name = p.and_then(|p| p.name.clone()).unwrap_or_default();
    let role = p
        .and_then(|p| p.role.clone())
        .unwrap_or_else(|| "unassigned".into());
    (name, role)
}

fn cmd_whoami() -> Res<()> {
    let me = self_address()?;
    println!("{me}");
    // Recording the profile is a courtesy; whoami answers even when the database cannot be written.
    let dir = session_dir(&me);
    if let Ok(store) = Store::open(&squad_root(&dir)) {
        let _ = identity::register(&store, &me, &dir);
    }
    Ok(())
}

fn cmd_list(all_dirs: bool, all: bool, children: bool) -> Res<()> {
    let cwd = process_cwd().display().to_string();
    let me = if identity::in_session() {
        self_address().ok().map(|a| a.to_string())
    } else {
        None
    };
    let mut rows: Vec<(String, String, String, String, String)> = vec![];
    for s in runtime::claude_sessions(all)? {
        rows.push((
            format!("claude:{}", s["sessionId"].as_str().unwrap_or("?")),
            s["kind"].as_str().unwrap_or("?").into(),
            s["status"].as_str().unwrap_or("?").into(),
            s["cwd"].as_str().unwrap_or("").into(),
            s["name"].as_str().unwrap_or("").into(),
        ));
    }
    for s in runtime::opencode_sessions()? {
        let child = s["parentID"].as_str().is_some_and(|p| !p.is_empty());
        if child && !children {
            continue;
        }
        rows.push((
            format!("opencode:{}", s["id"].as_str().unwrap_or("?")),
            if child { "child" } else { "top" }.into(),
            s["_status"].as_str().unwrap_or("idle").into(),
            runtime::opencode_dir(&s).unwrap_or_default(),
            s["title"].as_str().unwrap_or("").into(),
        ));
    }
    for s in runtime::antigravity_sessions() {
        rows.push((
            format!("antigravity:{}", s.id),
            "conversation".into(),
            s.status,
            s.dirs.first().cloned().unwrap_or_default(),
            s.title,
        ));
    }
    for s in runtime::muse_sessions() {
        rows.push((
            format!("muse:{}", s.id),
            "session".into(),
            if runtime::muse_live(&s.id) {
                "live"
            } else {
                "idle"
            }
            .into(),
            s.dir,
            s.title,
        ));
    }
    // A pi session listens while its peers extension holds a listener in its squad's database.
    let recent = now_ms() - 24 * 3600 * 1000;
    for s in runtime::pi_sessions() {
        let root = squad_root(&canonical(Path::new(&s.cwd)));
        let live = !s.cwd.is_empty()
            && crate::store::db_dir(&root).join("bd.sql").is_file()
            && Store::open(&root)
                .and_then(|st| st.listener_alive(&format!("pi:{}", s.id)))
                .unwrap_or(false);
        if !live && !all && s.modified < recent {
            continue;
        }
        rows.push((
            format!("pi:{}", s.id),
            "session".into(),
            if live { "listening" } else { "saved" }.into(),
            s.cwd,
            s.name,
        ));
    }
    for (addr, kind, status, dir, name) in rows {
        if Some(&addr) == me.as_ref()
            || (!all_dirs && canonical(Path::new(&dir)).display().to_string() != cwd)
        {
            continue;
        }
        let where_ = if all_dirs {
            format!("  cwd={dir}")
        } else {
            String::new()
        };
        println!("{addr}  kind={kind}  status={status}  name={name:?}{where_}");
    }
    Ok(())
}

fn read_body(body: Option<String>) -> Res<String> {
    if let Some(b) = body {
        return Ok(b);
    }
    let mut stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Ok(String::new());
    }
    let mut s = String::new();
    stdin
        .read_to_string(&mut s)
        .map_err(|e| format!("cannot read the body from stdin: {e}"))?;
    Ok(s)
}

fn cmd_send(a: SendArgs, squad: Option<&Path>) -> Res<()> {
    let target = Address::parse(&a.target)?;
    if !a.stray.is_empty() {
        return Err(format!(
            "unexpected text after the address ({:?}): the body goes in --body TEXT or on stdin, as in \
             `peers send {} --kind <kind> --seq <n> --body \"<text>\"`",
            truncate(&a.stray.join(" "), 40),
            a.target
        ));
    }
    let body = read_body(a.body)?;
    if body.trim().is_empty() {
        return Err("empty message body; pass --body TEXT or pipe the body on stdin (see `peers send --help`)".into());
    }
    let sender = self_address()?;
    if sender == target {
        return Err("refusing to send a message to yourself".into());
    }
    let reply_to = a.reply_to.as_deref().map(Address::parse).transpose()?;
    deliver::precheck(&target, a.headless)?;

    let c = Ctx::open(squad)?;
    let (role, name) = own_identity(
        a.role.as_deref(),
        a.name.as_deref(),
        &[process_cwd(), c.dir.clone()],
    );
    // A role you state updates your profile; the "unassigned" default never replaces a known one.
    let stated = role.is_some();
    let role = role.unwrap_or_else(|| "unassigned".into());
    c.store.upsert_profile(
        &Profile {
            address: sender.to_string(),
            runtime: sender.runtime.clone(),
            name: name.clone(),
            role: stated.then(|| role.clone()),
            cwd: Some(c.dir.display().to_string()),
            updated_at: now_ms(),
        },
        stated && !identity::acting_for_another(),
    )?;

    // The target's own directory decides its own squad, whose database holds its notification queue.
    let known = c.store.profile(&target.to_string())?;
    let target_dir = known
        .and_then(|p| p.cwd)
        .map(PathBuf::from)
        .or_else(|| runtime::session_cwd(&target));
    c.store.upsert_profile(
        &Profile {
            address: target.to_string(),
            runtime: target.runtime.clone(),
            name: None,
            role: None,
            cwd: target_dir.as_ref().map(|d| d.display().to_string()),
            updated_at: now_ms(),
        },
        false,
    )?;
    let reply_to_s = reply_to.as_ref().map(|r| r.to_string());
    c.store.insert_message(&NewMessage {
        sender: &sender.to_string(),
        recipient: &target.to_string(),
        sender_name: name.as_deref(),
        sender_role: &role,
        kind: &a.kind,
        seq: a.seq,
        reply_to: reply_to_s.as_deref(),
        body: body.trim(),
    })?;
    let unread = c.store.unread_total(&target.to_string())?;

    let target_home = target_dir.as_deref().map(squad_root);
    let at_home = target_home.as_deref() == Some(c.store.root.as_path());
    let squad_flag = if at_home {
        String::new()
    } else {
        format!(
            " --squad {}",
            shell_word(&c.store.root.display().to_string())
        )
    };
    let who = with_role(&name.clone().unwrap_or_else(|| sender.to_string()), &role);
    let text = format!(
        "New message from {who}. You have {} in your inbox. Read it with: peers open {sender}{squad_flag}",
        plural(unread, "unread message", "unread messages")
    );
    let meta = json!({"from": sender.to_string(), "name": name, "role": role, "unread": unread,
                      "squad": c.store.root.display().to_string()});
    let other;
    let home: &Store = match target_home {
        Some(h) if !at_home => {
            other = Store::open(&h)?;
            &other
        }
        _ => &c.store,
    };
    let how = deliver::notify(&target, home, &text, &meta, a.headless).map_err(|e| {
        format!("the message is stored in {target}'s inbox, but its notification failed: {e}")
    })?;
    println!(
        "SENT {target}: stored in its inbox ({}); {how}",
        plural(unread, "unread message", "unread messages")
    );
    if how.starts_with("queued") {
        let me = sender.to_string();
        let replaced = presence::squad(home, Some(&me))?
            .into_iter()
            .find_map(|(p, st)| match st {
                Status::Replaced(by) if p.address == target.to_string() => Some((by, p.role)),
                _ => None,
            });
        if let Some((by, role)) = replaced {
            let role = role.unwrap_or_default();
            println!(
                "REPLACED: {target} no longer runs, and {by} holds its role ({role}) now; it will not answer. \
                 Send this message to {by} instead."
            );
        }
    }
    if let Some(r) = &reply_to {
        println!(
            "REPLY: the answer goes to {r}, not to you. End your turn now; do not wait for it."
        );
    } else if ["request", "notice", "completion"].contains(&a.kind.as_str()) {
        println!("{}", reply_hint(&c, &target)?);
    }
    Ok(())
}

/// Whether this session's own squad database has a live listener for it.
fn home_listens(c: &Ctx) -> Res<bool> {
    let home_root = squad_root(&c.dir);
    if home_root == c.store.root {
        c.store.listener_alive(&c.me.to_string())
    } else {
        Store::open(&home_root)?.listener_alive(&c.me.to_string())
    }
}

/// How the answer reaches the sender, so it ends its turn instead of polling for it.
fn reply_hint(c: &Ctx, target: &Address) -> Res<String> {
    let stop = "End your turn now. Do not sleep, poll, loop, re-read your inbox, list sessions or start a \
                background task or timer to wait for it.";
    let open = format!("peers open {target}{}", c.squad_flag());
    Ok(match c.me.runtime.as_str() {
        "opencode" => format!(
            "REPLY: a notification of the answer is steered into this session as a new user turn while it runs or is \
             open in a TUI; otherwise it waits in its OpenCode inbox for its next turn. Read the answer then with \
             `{open}`. {stop}"
        ),
        "antigravity" => format!(
            "REPLY: a notification of the answer is typed into your agy TUI when it runs in herdr; otherwise it waits \
             and the answer shows in `peers chats`. Read the answer then with `{open}`. {stop}"
        ),
        "pi" if home_listens(c)? => format!(
            "REPLY: a notification of the answer arrives in this session through the peers extension as a new turn; \
             read the answer then with `{open}`. {stop}"
        ),
        "pi" => format!(
            "REPLY: this pi session has no peers extension listening, so the notification of the answer waits until \
             this session next starts with it. Tell the user, and ask them to install the extension \
             (`peers pi-extension --help`) and run /reload. Read the answer then with `{open}`. {stop}"
        ),
        _ => {
            if home_listens(c)? {
                format!(
                    "REPLY: a notification of the answer arrives in this session through the peers channel as a new turn; \
                     read the answer then with `{open}`. {stop}"
                )
            } else {
                format!(
                    "REPLY: this session has no peers channel (Claude Code) or live herdr TUI (Muse Code); the \
                     notification of the answer waits in its notification queue. Start it with the peers channel, or \
                     run its TUI in herdr, then read the answer with `{open}`."
                )
            }
        }
    })
}

fn cmd_contacts(squad: Option<&Path>) -> Res<()> {
    let c = Ctx::open(squad)?;
    let me = c.me.to_string();
    let mut rows: Vec<(Profile, Status)> = presence::squad(&c.store, Some(&me))?
        .into_iter()
        .filter(|(p, _)| p.address != me)
        .collect();
    if rows.is_empty() {
        println!(
            "No contacts yet in {}: a peer appears here once it runs any peers command in this squad, or once you message it.",
            c.store.root.display()
        );
    }
    let rank = |s: &Status| match s {
        Status::Live => 0,
        Status::Offline => 1,
        Status::Replaced(_) => 2,
    };
    // A stable sort keeps the database's order, most recently active first, within each status.
    rows.sort_by_key(|(_, s)| rank(s));
    for (p, st) in rows {
        let (name, role) = label(Some(&p));
        let by = match &st {
            Status::Replaced(by) => format!("  by={by}"),
            _ => String::new(),
        };
        println!(
            "{}  status={}{by}  name={name:?}  role={role}  runtime={}  cwd={}  seen={}",
            p.address,
            st.word(),
            p.runtime,
            p.cwd.as_deref().unwrap_or("?"),
            local_time(p.updated_at)
        );
    }
    Ok(())
}

fn cmd_chats(squad: Option<&Path>) -> Res<()> {
    let c = Ctx::open(squad)?;
    let owner = c.me.to_string();
    let chats = c.store.chats(&owner)?;
    let unread = c.store.unread_total(&owner)?;
    println!(
        "INBOX {owner} in {}: {} in {}",
        c.store.root.display(),
        plural(unread, "unread message", "unread messages"),
        plural(chats.len() as i64, "chat", "chats")
    );
    for ch in &chats {
        let (name, role) = label(ch.profile.as_ref());
        // The last message's kind and, when you sent it, whether the peer has read it.
        let (from, kind) = if ch.last.sender == owner {
            let read = ch
                .last
                .read_at
                .map(|t| format!("read {}", local_time(t)))
                .unwrap_or_else(|| "not read yet".into());
            (
                "you",
                format!("{} seq {}, {read}", ch.last.kind, ch.last.seq),
            )
        } else {
            ("them", format!("{} seq {}", ch.last.kind, ch.last.seq))
        };
        println!(
            "{}  name={name:?}  role={role}  unread={}  messages={}  last={} from {from} [{kind}]: {}",
            ch.peer,
            ch.unread,
            ch.total,
            local_time(ch.last.sent_at),
            truncate(&one_line(&ch.last.body), 80)
        );
    }
    if let Some(first) = chats.iter().find(|ch| ch.unread > 0).or(chats.first()) {
        println!("OPEN: peers open {}{}", first.peer, c.squad_flag());
    }
    Ok(())
}

/// A name with its role, without repeating a role the name already holds.
fn with_role(name: &str, role: &str) -> String {
    if name.contains(&format!("({role})")) {
        name.to_string()
    } else {
        format!("{name} ({role})")
    }
}

/// The chat partner as its profile knows it, which its messages fall back to.
struct Partner<'a> {
    name: &'a str,
    role: &'a str,
}

/// One message as a chat bubble, told from your side: `[you]` for yours, the sender's name for the
/// peer's. A peer message names its role only when it was sent under another role than the CHAT line's.
fn render(m: &Msg, owner: &str, partner: &Partner) {
    let day = local_fmt(m.sent_at, "%Y-%m-%d");
    let mut meta = vec![format!("{} seq {}", m.kind, m.seq)];
    if let Some(r) = &m.reply_to {
        meta.push(format!("answer goes to {r}"));
    }
    let who = if m.sender == owner {
        meta.push(match m.read_at {
            Some(t) if local_fmt(t, "%Y-%m-%d") == day => format!("read {}", local_fmt(t, "%H:%M")),
            Some(t) => format!("read {}", local_fmt(t, "%Y-%m-%d %H:%M")),
            None => "not read yet".into(),
        });
        "you".to_string()
    } else {
        // A message sent without a name or role speaks as the partner its profile knows.
        let name = m
            .sender_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .unwrap_or(partner.name);
        let role = &m.sender_role;
        if role != "unassigned" && role != partner.role && !name.contains(&format!("({role})")) {
            meta.push(format!("as {role}"));
        }
        if m.read_at.is_none() {
            meta.push("new".into());
        }
        if name.is_empty() {
            "partner".to_string()
        } else {
            name.to_string()
        }
    };
    println!(
        "[{who}] #{} {}  {}",
        m.id,
        local_fmt(m.sent_at, "%H:%M"),
        meta.join(" · ")
    );
    for line in m.body.trim_end().lines() {
        if line.is_empty() {
            println!();
        } else {
            println!("  {line}");
        }
    }
    println!();
}

fn cmd_open(target: &str, page: i64, squad: Option<&Path>) -> Res<()> {
    let peer = Address::parse(target)?;
    let mut c = Ctx::open(squad)?;
    let owner = c.me.to_string();
    let peer_s = peer.to_string();
    let total = c.store.chat_count(&owner, &peer_s)?;
    if total == 0 {
        println!(
            "No chat with {peer} in your inbox in {}.",
            c.store.root.display()
        );
        return Ok(());
    }
    let pages = (total + PAGE_SIZE - 1) / PAGE_SIZE;
    if page > pages {
        return Err(format!(
            "page {page} does not exist: the chat with {peer} has {} of {PAGE_SIZE} messages",
            plural(pages, "page", "pages")
        ));
    }
    let msgs = c.store.page(&owner, &peer_s, page)?;
    let (name, role) = label(c.store.profile(&peer_s)?.as_ref());
    let partner = Partner {
        name: &name,
        role: &role,
    };
    let last = total - (page - 1) * PAGE_SIZE;
    let first = last - msgs.len() as i64 + 1;
    if name.is_empty() {
        println!("CHAT with {peer} ({role})");
    } else {
        println!("CHAT with {} · {peer}", with_role(&name, &role));
    }
    println!("page {page} of {pages}  (messages {first}-{last} of {total}, oldest first; page 1 holds the newest)\n");
    // Like a messenger: a line for each new day, and one above the first unread message.
    let unread = msgs
        .iter()
        .filter(|m| m.recipient == owner && m.read_at.is_none())
        .count() as i64;
    let mut day = String::new();
    let mut divided = false;
    for m in &msgs {
        let d = local_fmt(m.sent_at, "%Y-%m-%d");
        if d != day {
            println!("── {d} ──\n");
            day = d;
        }
        if !divided && m.recipient == owner && m.read_at.is_none() {
            println!(
                "── {} ──\n",
                plural(unread, "unread message", "unread messages")
            );
            divided = true;
        }
        render(m, &owner, &partner);
    }
    let new: Vec<i64> = msgs
        .iter()
        .filter(|m| m.recipient == owner && m.read_at.is_none())
        .map(|m| m.id)
        .collect();
    c.store.mark_read(&owner, &new)?;
    let flag = c.squad_flag();
    if page < pages {
        let older_unread = c.store.unread_before(&owner, &peer_s, msgs[0].id)?;
        let note = if older_unread > 0 {
            format!(
                "  ({} on older pages)",
                plural(older_unread, "unread message", "unread messages")
            )
        } else {
            String::new()
        };
        println!("OLDER: peers open {peer}{flag} --page {}{note}", page + 1);
    }
    if page > 1 {
        println!("NEWER: peers open {peer}{flag} --page {}", page - 1);
    }
    let left = c.store.unread_total(&owner)?;
    println!(
        "INBOX: {} left in your inbox",
        plural(left, "unread message", "unread messages")
    );
    Ok(())
}

fn cmd_delete(target: &str, squad: Option<&Path>) -> Res<()> {
    let peer = Address::parse(target)?;
    let c = Ctx::open(squad)?;
    let n = c.store.delete_chat(&c.me.to_string(), &peer.to_string())?;
    if n == 0 {
        println!("No chat with {peer} in your inbox; nothing deleted.");
    } else {
        println!(
            "DELETED your view of the chat with {peer}: {} hidden from you; {peer} still sees the whole chat.",
            plural(n, "message", "messages")
        );
    }
    Ok(())
}

/// The peers extension for pi, built into the binary so that it always matches `_pi-listen`.
const PI_EXTENSION: &str = include_str!("pi_extension.ts");

/// Writes the extension to `<cache root>/pi-extension/peers.ts` when the file is missing or
/// differs, and returns its path.
fn pi_extension_file() -> Res<PathBuf> {
    let file = crate::store::cache_root()
        .join("pi-extension")
        .join("peers.ts");
    if std::fs::read_to_string(&file).ok().as_deref() != Some(PI_EXTENSION) {
        let dir = file.parent().expect("the file has a directory");
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        let tmp = dir.join(format!(".peers.ts.{}", std::process::id()));
        std::fs::write(&tmp, PI_EXTENSION)
            .map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        std::fs::rename(&tmp, &file)
            .map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    }
    Ok(file)
}
