//! Command line: argument parsing, help texts and one function per command.

use crate::address::{Address, KINDS};
use crate::identity::{self, own_identity, self_address, session_dir, squad_root};
use crate::store::{Msg, NewMessage, Profile, Store, PAGE_SIZE};
use crate::util::*;
use crate::{channel, deliver, runtime};
use clap::{Args, Parser, Subcommand};
use serde_json::json;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

const ABOUT: &str = "Inbox messenger between OpenCode, Claude Code and Antigravity agent sessions on this machine.";

const LONG_ABOUT: &str = "Inbox messenger between OpenCode, Claude Code and Antigravity agent sessions on this machine.

A peer's address is <runtime>:<id>: opencode:<ses_...>, claude:<session uuid> or
antigravity:<conversation uuid>.

`send` stores a message in the squad's database and gives the receiver only a one-line
notification: \"New message from <name> (<role>). You have <n> unread messages in your inbox.
Read it with: peers open <sender>\". The receiver then reads the chat with `open`. Every chat
keeps its full history; `chats` lists them, `contacts` lists the peers, and `delete` hides a
chat from your own view only.

Conversations and peer profiles live in one SQLite database per squad:
~/.local/cache/peers/<dashed directory>/bd.sql, where the directory is the nearest one at or
above your session directory that holds roster.json (the squad workspace), else your session
directory itself. --squad <dir> uses another squad's database. $PEERS_CACHE moves the cache
root; $PEERS_CWD sets your session directory when your runtime cannot tell it.

Run `peers <command> --help` for one command.";

const AFTER_HELP: &str = "Examples:
  peers whoami
  peers list --all-dirs
  peers send opencode:ses_abc --kind request --seq 1 --body \"Review api/.\"
  peers chats
  peers open claude:<uuid>
  peers open claude:<uuid> --page 2

Exit codes: 0 on success, 2 on a usage error or a failed command (the error line says why).";

#[derive(Parser)]
#[command(name = "peers", version, about = ABOUT, long_about = LONG_ABOUT, after_help = AFTER_HELP)]
pub struct Cli {
    /// Use the database of this squad workspace (any directory) instead of your own squad's.
    #[arg(long, global = true, value_name = "DIR")]
    squad: Option<PathBuf>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Print this session's peer address.
    #[command(
        long_about = "Print this session's peer address.\n\n\
Reads OPENCODE_SESSION_ID, CLAUDE_CODE_SESSION_ID or ANTIGRAVITY_CONVERSATION_ID; when several
are set, the nearest runtime process among the ancestors decides. $PEERS_SELF=<address>
overrides them all. Also records your profile in your squad's database, so your squad sees
you in `peers contacts`.
Output: one line, the address. Fails (exit 2) outside an agent session.",
        after_help = "Examples:\n  peers whoami"
    )]
    Whoami,

    /// List live and recent sessions of every runtime.
    #[command(
        long_about = "List live and recent sessions of every runtime.\n\n\
Asks each runtime, not the database. By default only sessions whose directory is the current
directory, without your own session, finished Claude background sessions or OpenCode child
sessions.
Output: one line per session: address, kind, status and name (and cwd with --all-dirs).
Nothing is printed when no session matches.",
        after_help = "Examples:\n  peers list\n  peers list --all-dirs --all"
    )]
    List {
        /// Include sessions in every directory, and show each one's cwd.
        #[arg(long)]
        all_dirs: bool,
        /// Include finished Claude background sessions.
        #[arg(long)]
        all: bool,
        /// Include OpenCode child sessions.
        #[arg(long)]
        children: bool,
    },

    /// Send one message to a peer: store it, then notify the peer.
    #[command(
        long_about = "Send one message to a peer: store it, then notify the peer.\n\n\
Stores the body with its PEER-FROM, PEER-ROLE, PEER-KIND, PEER-SEQ (and PEER-NAME,
PEER-REPLY-TO) headers in the squad's database, then delivers only a one-line notification by
the target's runtime: steered into an OpenCode session, queued for a live Claude session's
channel or watch, a headless resume of a stopped Claude session, typed into an agy TUI in
herdr, or a headless agy run.
Output: a SENT line saying how it went, then for a request, notice or completion a REPLY line
saying how the answer will reach you.
Fails (exit 2) on a bad address or kind, an empty body, a send to yourself, or a runtime CLI
that is missing or fails; when only the notification failed, the error says the message is
stored.",
        override_usage = "peers send <TARGET> --kind <KIND> --seq <N> (--body <TEXT> | <body on stdin>) [OPTIONS]",
        after_help = "Examples:
  peers send opencode:ses_abc --kind request --seq 1 --body \"Summarize README.md.\"
  peers send claude:<uuid> --kind completion --seq 1 < result.md
  peers send antigravity:<uuid> --kind request --seq 2 --reply-to opencode:ses_boss --body \"...\""
    )]
    Send(SendArgs),

    /// List your contacts: every peer profile in the squad's database.
    #[command(
        long_about = "List your contacts: every peer profile in the squad's database.\n\n\
A session records its profile (address, name, role, runtime, directory) the first time it
runs any peers command, and a peer you message is recorded too.
Output: one line per contact, the most recently active first.",
        after_help = "Examples:\n  peers contacts\n  peers contacts --squad ~/squads/shop"
    )]
    Contacts,

    /// List your chats with their unread counts; also `peers inbox`.
    #[command(
        visible_alias = "inbox",
        long_about = "List your chats with their unread counts; also `peers inbox`.\n\n\
Output: an INBOX line with your unread total, then one line per chat, the most recent first:
the peer's address, name, role, unread and total message counts, and the last message with its
kind and sequence number. When you sent the last message, the line also says whether the peer
has read it (`not read yet` or `read <time>`).",
        after_help = "Examples:\n  peers chats\n  peers inbox --squad ~/squads/shop"
    )]
    Chats,

    /// Open a chat and print one page of its history.
    #[command(
        long_about = "Open a chat and print one page of its history.\n\n\
Page 1 holds the newest 20 messages, page 2 the 20 before them, and so on; each page prints
its messages oldest first, each with its PEER- headers and body. The messages printed are
marked read; when older pages still hold unread messages, an OLDER line says so.
Fails (exit 2) when the page does not exist.",
        after_help = "Examples:\n  peers open claude:<uuid>\n  peers open opencode:ses_abc --page 2"
    )]
    Open {
        /// The peer's address.
        target: String,
        /// Page to print; 1 is the newest.
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(i64).range(1..))]
        page: i64,
    },

    /// Delete a chat from your own view; the peer keeps its copy.
    #[command(
        long_about = "Delete a chat from your own view; the peer keeps its copy.\n\n\
Hides every message of the chat so far from you. The peer still sees the whole chat. A new
message in either direction starts the chat again, showing only what came after the delete.",
        after_help = "Examples:\n  peers delete claude:<uuid>"
    )]
    Delete {
        /// The peer's address.
        target: String,
    },

    /// Stream this session's notifications, one line each, for a Monitor.
    #[command(
        long_about = "Stream this session's notifications, one line each, for a Monitor.\n\n\
For a Claude Code session without the peers channel: run it as a Monitor command. It reads
your own squad's notification queue (ignoring --squad) and never exits on its own.",
        after_help = "Examples:\n  peers watch"
    )]
    Watch,

    /// Run the peers channel: an MCP stdio server for Claude Code.
    #[command(
        long_about = "Run the peers channel: an MCP stdio server for Claude Code.\n\n\
Claude Code starts it from --mcp-config or .mcp.json; it pushes each notification for its
session into the conversation as a turn. Do not run it by hand: it speaks JSON-RPC on stdin
and stdout until stdin closes.",
        after_help = "Examples:\n  claude --mcp-config \"$(peers channel-config)\" --dangerously-load-development-channels server:peers"
    )]
    Channel,

    /// Print the --mcp-config JSON that loads the peers channel.
    #[command(
        long_about = "Print the --mcp-config JSON that loads the peers channel.\n\n\
Output: one line of JSON for `claude --mcp-config`, with this binary's absolute path.",
        after_help = "Examples:\n  peers channel-config"
    )]
    ChannelConfig,

    /// Print the last turns of a session's own transcript.
    #[command(
        long_about = "Print the last turns of a session's own transcript.\n\n\
OpenCode and Claude: one line per turn, cut to 400 characters. Antigravity stores turns as
protobuf, so it prints the title, status and preview instead.
Fails (exit 2) when the session or its transcript does not exist.",
        after_help = "Examples:\n  peers show opencode:ses_abc\n  peers show claude:<uuid> --last 10"
    )]
    Show {
        /// The session's address.
        target: String,
        /// Number of turns to print.
        #[arg(long, default_value_t = 6)]
        last: usize,
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
    /// Message kind.
    #[arg(long, value_parser = KINDS)]
    kind: String,
    /// Exchange number: reuse the request's number for every reply in its exchange.
    #[arg(long, value_name = "N")]
    seq: i64,
    /// Message body (default: read from stdin).
    #[arg(long, value_name = "TEXT")]
    body: Option<String>,
    /// Address the receiver must answer, when not you (default: none; the receiver answers you).
    #[arg(long, value_name = "ADDRESS")]
    reply_to: Option<String>,
    /// Your role in the squad (default: $PEERS_ROLE, then the nearest .peers.json, else "unassigned").
    #[arg(long, value_name = "ROLE")]
    role: Option<String>,
    /// Your human-readable name, sent as PEER-NAME (default: $PEERS_NAME, then the display_name in
    /// the .peers.json that gave your role, else none).
    #[arg(long, value_name = "NAME")]
    name: Option<String>,
}

pub fn run(cli: Cli) -> Res<()> {
    let squad = cli.squad.as_deref();
    match cli.cmd {
        Cmd::Whoami => cmd_whoami(),
        Cmd::List { all_dirs, all, children } => cmd_list(all_dirs, all, children),
        Cmd::Send(a) => cmd_send(a, squad),
        Cmd::Contacts => cmd_contacts(squad),
        Cmd::Chats => cmd_chats(squad),
        Cmd::Open { target, page } => cmd_open(&target, page, squad),
        Cmd::Delete { target } => cmd_delete(&target, squad),
        Cmd::Watch => channel::run_watch(),
        Cmd::Channel => channel::run_channel(),
        Cmd::ChannelConfig => {
            println!("{}", json!({"mcpServers": {"peers": {"command": exe(), "args": ["channel"]}}}));
            Ok(())
        }
        Cmd::Show { target, last } => {
            for line in runtime::show(&Address::parse(&target)?, last)? {
                println!("{line}");
            }
            Ok(())
        }
        Cmd::DrainAntigravity { cid, dir } => deliver::drain_antigravity(&cid, &dir),
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
        Ok(Ctx { me, dir, store, explicit })
    }

    fn squad_flag(&self) -> String {
        if self.explicit {
            format!(" --squad {}", shell_word(&self.store.root.display().to_string()))
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
    let role = p.and_then(|p| p.role.clone()).unwrap_or_else(|| "unassigned".into());
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
    let me = if identity::in_session() { self_address().ok().map(|a| a.to_string()) } else { None };
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
    for (addr, kind, status, dir, name) in rows {
        if Some(&addr) == me.as_ref() || (!all_dirs && canonical(Path::new(&dir)).display().to_string() != cwd) {
            continue;
        }
        let where_ = if all_dirs { format!("  cwd={dir}") } else { String::new() };
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
    stdin.read_to_string(&mut s).map_err(|e| format!("cannot read the body from stdin: {e}"))?;
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
    deliver::precheck(&target)?;

    let c = Ctx::open(squad)?;
    let (role, name) = own_identity(a.role.as_deref(), a.name.as_deref(), &[process_cwd(), c.dir.clone()]);
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
        stated,
    )?;

    // The target's own directory decides its own squad, whose database holds its notification queue.
    let known = c.store.profile(&target.to_string())?;
    let target_dir = known.and_then(|p| p.cwd).map(PathBuf::from).or_else(|| runtime::session_cwd(&target));
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
        format!(" --squad {}", shell_word(&c.store.root.display().to_string()))
    };
    let who = name.clone().unwrap_or_else(|| sender.to_string());
    let text = format!(
        "New message from {who} ({role}). You have {} in your inbox. Read it with: peers open {sender}{squad_flag}",
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
    let how = deliver::notify(&target, home, &text, &meta)
        .map_err(|e| format!("the message is stored in {target}'s inbox, but its notification failed: {e}"))?;
    println!("SENT {target}: stored in its inbox ({}); {how}", plural(unread, "unread message", "unread messages"));
    if let Some(r) = &reply_to {
        println!("REPLY: the answer goes to {r}, not to you. End your turn now; do not wait for it.");
    } else if ["request", "notice", "completion"].contains(&a.kind.as_str()) {
        println!("{}", reply_hint(&c, &target)?);
    }
    Ok(())
}

/// How the answer reaches the sender, so it ends its turn instead of polling for it.
fn reply_hint(c: &Ctx, target: &Address) -> Res<String> {
    let stop = "End your turn now. Do not sleep, poll, loop, re-read your inbox, list sessions or start a \
                background task or timer to wait for it.";
    let open = format!("peers open {target}{}", c.squad_flag());
    Ok(match c.me.runtime.as_str() {
        "opencode" => format!(
            "REPLY: a notification of the answer arrives in this session as a new user turn; read the answer then with `{open}`. {stop}"
        ),
        "antigravity" => format!(
            "REPLY: a notification of the answer is typed into your agy TUI or run as a new turn after this one ends; \
             read the answer then with `{open}`. {stop}"
        ),
        _ => {
            let home_root = squad_root(&c.dir);
            let other;
            let home = if home_root == c.store.root {
                &c.store
            } else {
                other = Store::open(&home_root)?;
                &other
            };
            if home.listener_alive(&c.me.to_string())? {
                format!(
                    "REPLY: a notification of the answer arrives in this session through the peers channel as a new turn; \
                     read the answer then with `{open}`. {stop}"
                )
            } else {
                format!(
                    "REPLY: this session has no peers channel; the notification of the answer lands in its notification \
                     queue. Arm one Monitor watch on `peers watch` if none is armed, then end your turn; do not poll. \
                     Read the answer then with `{open}`."
                )
            }
        }
    })
}

fn cmd_contacts(squad: Option<&Path>) -> Res<()> {
    let c = Ctx::open(squad)?;
    let contacts = c.store.contacts(&c.me.to_string())?;
    if contacts.is_empty() {
        println!(
            "No contacts yet in {}: a peer appears here once it runs any peers command in this squad, or once you message it.",
            c.store.root.display()
        );
    }
    for p in contacts {
        let (name, role) = label(Some(&p));
        println!(
            "{}  name={name:?}  role={role}  runtime={}  cwd={}  seen={}",
            p.address,
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
            let read = ch.last.read_at.map(|t| format!("read {}", local_time(t))).unwrap_or_else(|| "not read yet".into());
            ("you", format!("{} seq {}, {read}", ch.last.kind, ch.last.seq))
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

fn render(m: &Msg, owner: &str) {
    let status = if m.sender == owner {
        let read = m.read_at.map(|t| format!("read {}", local_time(t))).unwrap_or_else(|| "not read yet".into());
        format!("sent by you to {}, {read}", m.recipient)
    } else if m.read_at.is_none() {
        "received, new".to_string()
    } else {
        "received".to_string()
    };
    println!("=== #{} {} {status}", m.id, local_time(m.sent_at));
    println!("PEER-FROM: {}", m.sender);
    println!("PEER-ROLE: {}", m.sender_role);
    if let Some(n) = &m.sender_name {
        println!("PEER-NAME: {n}");
    }
    println!("PEER-KIND: {}", m.kind);
    println!("PEER-SEQ: {}", m.seq);
    if let Some(r) = &m.reply_to {
        println!("PEER-REPLY-TO: {r}");
    }
    println!("---");
    println!("{}", m.body.trim_end());
    println!();
}

fn cmd_open(target: &str, page: i64, squad: Option<&Path>) -> Res<()> {
    let peer = Address::parse(target)?;
    let mut c = Ctx::open(squad)?;
    let owner = c.me.to_string();
    let peer_s = peer.to_string();
    let total = c.store.chat_count(&owner, &peer_s)?;
    if total == 0 {
        println!("No chat with {peer} in your inbox in {}.", c.store.root.display());
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
    let last = total - (page - 1) * PAGE_SIZE;
    let first = last - msgs.len() as i64 + 1;
    println!(
        "CHAT {peer}  name={name:?}  role={role}  page {page} of {pages}  (messages {first}-{last} of {total}, oldest \
         first; page 1 holds the newest)\n"
    );
    for m in &msgs {
        render(m, &owner);
    }
    let new: Vec<i64> = msgs.iter().filter(|m| m.recipient == owner && m.read_at.is_none()).map(|m| m.id).collect();
    c.store.mark_read(&owner, &new)?;
    let flag = c.squad_flag();
    if page < pages {
        let older_unread = c.store.unread_before(&owner, &peer_s, msgs[0].id)?;
        let note = if older_unread > 0 {
            format!("  ({} on older pages)", plural(older_unread, "unread message", "unread messages"))
        } else {
            String::new()
        };
        println!("OLDER: peers open {peer}{flag} --page {}{note}", page + 1);
    }
    if page > 1 {
        println!("NEWER: peers open {peer}{flag} --page {}", page - 1);
    }
    let left = c.store.unread_total(&owner)?;
    println!("INBOX: {} left in your inbox", plural(left, "unread message", "unread messages"));
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
