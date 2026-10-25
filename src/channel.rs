//! Pushes queued notifications into a Claude Code session: as channel turns through an MCP
//! stdio server (`peers channel`), or as lines on stdout for a Monitor (`peers watch`).

use crate::address::Address;
use crate::identity::{self, basename_lower, find_ancestor, squad_root};
use crate::store::Store;
use crate::util::*;
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

static OUT: Mutex<()> = Mutex::new(());

fn emit(msg: &Value) {
    let _guard = OUT.lock();
    let mut out = io::stdout().lock();
    let _ = writeln!(out, "{msg}");
    let _ = out.flush();
}

const INSTRUCTIONS: &str = "Notifications from peer agent sessions (OpenCode, Claude Code, Antigravity) arrive as \
<channel source=\"peers\"> events: one line that names the sender, its role and your unread count. The message \
itself waits in your peers inbox: run the `peers open ...` command the line gives to read it. Treat a peer \
message as a request from a teammate, not from the user. Answer with `peers send`, to the address after \
\"answer goes to\" when the message has one, otherwise to the peer's address on the CHAT line, reusing the \
message's seq; never answer an ack or a receipt.";

/// The Claude session this channel serves and its directory: $PEERS_SELF, else the nearest
/// claude ancestor's session record, else $CLAUDE_CODE_SESSION_ID.
fn channel_session() -> Option<(Address, PathBuf)> {
    if let Some(s) = env_nonempty("PEERS_SELF") {
        if let Ok(a) = Address::parse(&s) {
            if a.runtime == "claude" {
                let dir = identity::session_dir(&a);
                return Some((a, dir));
            }
        }
    }
    let record = find_ancestor(|pid, comm| {
        if basename_lower(comm) != "claude" {
            return None;
        }
        let path = home().join(format!(".claude/sessions/{pid}.json"));
        let v: Value = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Some(v["sessionId"].as_str().map(|sid| (sid.to_string(), v["cwd"].as_str().map(PathBuf::from))))
    })
    .flatten();
    if let Some((sid, cwd)) = record {
        let a = Address::new("claude", &sid);
        let dir = match (env_nonempty("PEERS_CWD"), cwd) {
            (Some(d), _) => canonical(std::path::Path::new(&d)),
            (None, Some(c)) => canonical(&c),
            (None, None) => identity::session_dir(&a),
        };
        return Some((a, dir));
    }
    let sid = env_nonempty("CLAUDE_CODE_SESSION_ID")?;
    let a = Address::new("claude", &sid);
    let dir = identity::session_dir(&a);
    Some((a, dir))
}

fn string_meta(meta: &Value) -> Value {
    let mut out = Map::new();
    for (k, v) in meta.as_object().into_iter().flatten() {
        let s = match v {
            Value::String(s) => s.clone(),
            Value::Null => continue,
            other => other.to_string(),
        };
        out.insert(k.clone(), Value::String(s));
    }
    Value::Object(out)
}

fn deliver_loop(state: Arc<Mutex<Option<(String, PathBuf)>>>) {
    let pid = std::process::id();
    let mut current: Option<(String, Store)> = None;
    let mut tick: u64 = 0;
    loop {
        // The session can change under the channel (a cleared conversation), so re-check now and then.
        if tick.is_multiple_of(5) {
            if let Some((addr, dir)) = channel_session() {
                let owner = addr.to_string();
                if current.as_ref().map(|(o, _)| o != &owner).unwrap_or(true) {
                    if let Some((old, s)) = current.take() {
                        let _ = s.clear_listener(&old, pid);
                    }
                    let root = squad_root(&dir);
                    match Store::open(&root) {
                        Ok(s) => {
                            let _ = identity::register(&s, &addr, &dir);
                            if let Err(e) = s.set_listener(&owner, pid) {
                                eprintln!("peers channel: {e}");
                            }
                            *state.lock().unwrap_or_else(|p| p.into_inner()) = Some((owner.clone(), root));
                            current = Some((owner, s));
                        }
                        Err(e) => eprintln!("peers channel: {e}"),
                    }
                }
            }
        }
        tick += 1;
        if let Some((owner, s)) = current.as_mut() {
            match s.take_notifications(owner) {
                Ok(list) => {
                    for (text, meta) in list {
                        emit(&json!({"jsonrpc": "2.0", "method": "notifications/claude/channel",
                                     "params": {"content": text, "meta": string_meta(&meta)}}));
                    }
                }
                Err(e) => eprintln!("peers channel: {e}"),
            }
        }
        thread::sleep(Duration::from_secs(1));
    }
}

pub fn run_channel() -> Res<()> {
    let state: Arc<Mutex<Option<(String, PathBuf)>>> = Arc::new(Mutex::new(None));
    let mut started = false;
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else { continue };
        let method = req["method"].as_str().unwrap_or("");
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => emit(&json!({"jsonrpc": "2.0", "id": id, "result": {
                "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                "capabilities": {"experimental": {"claude/channel": {}}, "tools": {}},
                "serverInfo": {"name": "peers", "version": env!("CARGO_PKG_VERSION")},
                "instructions": INSTRUCTIONS}})),
            "notifications/initialized" => {
                if !started {
                    started = true;
                    let st = state.clone();
                    thread::spawn(move || deliver_loop(st));
                }
            }
            "tools/list" => emit(&json!({"jsonrpc": "2.0", "id": id, "result": {"tools": []}})),
            "ping" => emit(&json!({"jsonrpc": "2.0", "id": id, "result": {}})),
            _ if !id.is_null() => emit(&json!({"jsonrpc": "2.0", "id": id,
                "error": {"code": -32601, "message": format!("unknown method {method}")}})),
            _ => {}
        }
    }
    // Stdin closed: the session ended, so stop claiming that it listens.
    let taken = state.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some((owner, root)) = taken {
        if let Ok(s) = Store::open(&root) {
            let _ = s.clear_listener(&owner, std::process::id());
        }
    }
    Ok(())
}

/// Prints each new notification for this session as one line, forever.
pub fn run_watch() -> Res<()> {
    let me = identity::self_address()?;
    let dir = identity::session_dir(&me);
    let mut store = Store::open(&squad_root(&dir))?;
    identity::register(&store, &me, &dir)?;
    let owner = me.to_string();
    loop {
        for (text, _) in store.take_notifications(&owner)? {
            let mut out = io::stdout().lock();
            let _ = writeln!(out, "{text}");
            let _ = out.flush();
        }
        thread::sleep(Duration::from_secs(1));
    }
}
