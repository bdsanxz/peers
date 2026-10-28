//! Delivers the one-line notification of a new message into the receiver's session, by its
//! runtime, only where the session is live: steered into a running or open OpenCode session,
//! pushed through a Claude channel or watch queue, typed into an agy TUI in herdr, or pushed
//! through a pi session's peers extension. A session that is not live gets the notification queued
//! for when it next opens, never a headless run, unless the sender passes --headless because the
//! user asked for one.

use crate::address::Address;
use crate::runtime::{self, agy_home};
use crate::store::Store;
use crate::util::*;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Write;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// What a headless run would need to know, before anything is stored: an agy or muse TUI
/// outside herdr would interleave with a headless run, so --headless is refused for either.
pub fn precheck(target: &Address, headless: bool) -> Res<()> {
    if headless && target.runtime == "antigravity" {
        if let Tui::Terminal(tty) = antigravity_tui(&target.id) {
            return Err(format!(
                "{target} is open in an agy TUI on {tty}, outside herdr, and a headless run would interleave \
                 with it; send without --headless, or ask the user to close it there or to run it in herdr"
            ));
        }
    }
    if headless && target.runtime == "muse" {
        if let Tui::Terminal(tty) = muse_tui(&target.id) {
            return Err(format!(
                "{target} is open in a muse TUI on {tty}, outside herdr, and a headless run would interleave \
                 with it; send without --headless, or ask the user to close it there or to run it in herdr"
            ));
        }
    }
    Ok(())
}

/// The tail of a SENT line for a notification that waits instead of running headless.
fn queued(reason: &str, when: &str) -> String {
    format!(
        "queued, not delivered yet: {reason}; it gets the notification {when}. No headless run was started; \
         pass --headless only when the user asked for a headless run"
    )
}

/// Delivers `text` to `target`, whose own notification queue, logs and run queues live in
/// `home` (the database of the target's own squad). With `headless`, a session that is not live
/// is run headless for one turn. Returns how it went, for the SENT line.
pub fn notify(
    target: &Address,
    home: &Store,
    text: &str,
    meta: &Value,
    headless: bool,
) -> Res<String> {
    match target.runtime.as_str() {
        "opencode" => notify_opencode(&target.id, text, headless),
        "antigravity" => notify_antigravity(target, home, text, meta, headless),
        "pi" => notify_pi(target, home, text, meta, headless),
        "muse" => notify_muse(target, home, text, meta, headless),
        _ => {
            let address = target.to_string();
            // A listening channel proves the session is live; check it before asking claude.
            if home.listener_alive(&address)? {
                home.push_notification(&address, text, meta)?;
                Ok("notified via channel (it arrives in the session as a turn)".into())
            } else if runtime::claude_live(&target.id)? {
                home.push_notification(&address, text, meta)?;
                Ok("notified via notification queue (no peers channel is listening; the session sees it only \
                    with an armed `peers watch`, or when it next starts with the peers channel)"
                    .into())
            } else if headless {
                notify_claude_resume(&target.id, home, text)
            } else {
                home.push_notification(&address, text, meta)?;
                Ok(queued(
                    &format!("{target} is not running"),
                    "when it next starts with the peers channel or arms `peers watch`",
                ))
            }
        }
    }
}

/// Whether an OpenCode session is shown in a TUI: a process opened with its id; an OpenCode pane in
/// herdr whose title names the session's title and no other session's; or an OpenCode pane in herdr
/// working in the session's directory, when the session is the newest top-level one there (the one
/// a TUI started in that directory shows).
pub(crate) fn opencode_open(sid: &str, sessions: &[Value]) -> bool {
    let by_args = quiet("ps", &["-ax", "-o", "args="]).lines().any(|l| {
        let mut words = l.split_whitespace();
        words.next().map(identity_name).as_deref() == Some("opencode") && words.any(|w| w == sid)
    });
    if by_args {
        return true;
    }
    let Some(me) = sessions.iter().find(|s| s["id"].as_str() == Some(sid)) else {
        return false;
    };
    let panes = herdr_agents("opencode");
    if panes.is_empty() {
        return false;
    }
    if let Some(title) = me["title"].as_str().filter(|t| !t.is_empty()) {
        if sessions
            .iter()
            .filter(|s| s["title"].as_str() == Some(title))
            .count()
            == 1
        {
            let wanted = format!("OC | {title}");
            if panes
                .iter()
                .any(|(_, a)| a["terminal_title"].as_str().map(str::trim) == Some(wanted.as_str()))
            {
                return true;
            }
        }
    }
    let Some(dir) = runtime::opencode_dir(me).map(|d| canonical(Path::new(&d))) else {
        return false;
    };
    let top = |s: &&Value| s["parentID"].as_str().is_none_or(|p| p.is_empty());
    let updated = |s: &Value| s["time"]["updated"].as_i64().unwrap_or(0);
    let newest = sessions
        .iter()
        .filter(top)
        .filter(|s| {
            runtime::opencode_dir(s)
                .map(|d| canonical(Path::new(&d)))
                .as_ref()
                == Some(&dir)
        })
        .max_by_key(|s| updated(s));
    if newest.and_then(|s| s["id"].as_str()) != Some(sid) {
        return false;
    }
    panes.iter().any(|(_, a)| {
        ["foreground_cwd", "cwd"]
            .iter()
            .any(|k| a[*k].as_str().map(|c| canonical(Path::new(c))).as_ref() == Some(&dir))
    })
}

fn identity_name(word: &str) -> String {
    crate::identity::basename_lower(word)
}

fn notify_opencode(sid: &str, text: &str, headless: bool) -> Res<String> {
    if which("opencode").is_none() {
        return Err("opencode is not on PATH".into());
    }
    let sessions = runtime::opencode_sessions()?;
    let running = sessions
        .iter()
        .any(|s| s["id"].as_str() == Some(sid) && s["_status"].as_str() == Some("running"));
    let open = !running && opencode_open(sid, &sessions);
    // Steer, so the input shows in an open TUI at once. resume=false only admits it to the
    // session's inbox, where it waits for the session's next turn without a run of its own.
    let resume = running || open || headless;
    let payload = json!({"text": text, "delivery": "steer", "resume": resume}).to_string();
    let path = format!("/api/session/{sid}/prompt");
    let got = run_json("opencode", &["api", "post", &path, "--data", &payload])?
        .ok_or("opencode is not on PATH")?;
    let msg = got.get("data").unwrap_or(&got);
    let id = msg["id"].as_str().unwrap_or("?");
    Ok(if running {
        format!("notified by steering into its running turn (message={id})")
    } else if open {
        format!("notified by steering into the session open in its TUI, which starts a turn (message={id})")
    } else if headless {
        format!("notified via headless resume in the OpenCode service (message={id})")
    } else {
        queued(
            &format!("opencode:{sid} is neither running nor open in a TUI"),
            &format!("from its OpenCode inbox (message={id}) with the session's next turn, when someone opens it and sends"),
        )
    })
}

fn logs_dir(home: &Store) -> Res<PathBuf> {
    let logs = home.dir.join("logs");
    fs::create_dir_all(&logs).map_err(|e| format!("cannot create {}: {e}", logs.display()))?;
    Ok(logs)
}

fn notify_claude_resume(sid: &str, home: &Store, text: &str) -> Res<String> {
    if which("claude").is_none() {
        return Err("claude is not on PATH".into());
    }
    let log = logs_dir(home)?.join(format!("claude-{sid}-{}.json", stamp()));
    let out = File::create(&log).map_err(|e| format!("cannot create {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    // Claude peers always skip permission prompts: a headless peer has nobody to answer them.
    // The prompt goes on stdin so no multi-value flag can swallow it.
    let mut child = Command::new("claude")
        .args([
            "-p",
            "--resume",
            sid,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ])
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|e| format!("cannot write to claude: {e}"))?;
    }
    Ok(format!(
        "notified via headless resume pid={} log={}",
        child.id(),
        log.display()
    ))
}

pub(crate) enum Tui {
    None,
    Herdr(String, String),
    Terminal(String),
}

/// Where the conversation is open in an agy TUI. Every agy process on a conversation holds its
/// presence lock; a TUI has a terminal, a headless run has none.
pub(crate) fn antigravity_tui(cid: &str) -> Tui {
    let lock = agy_home().join("presence").join(format!("{cid}.lock"));
    if !lock.exists() || which("lsof").is_none() {
        return Tui::None;
    }
    let pids = quiet("lsof", &["-t", &lock.to_string_lossy()]);
    let mut ttys = BTreeSet::new();
    let mut tui_pids = vec![];
    for pid in pids.split_whitespace() {
        let tty = quiet("ps", &["-o", "tty=", "-p", pid]);
        if !tty.is_empty() && !tty.contains('?') {
            ttys.insert(if tty.starts_with("/dev/") {
                tty
            } else {
                format!("/dev/{tty}")
            });
            tui_pids.push(pid.to_string());
        }
    }
    let Some(first) = ttys.into_iter().next() else {
        return Tui::None;
    };
    if which("herdr").is_some() {
        if let Some((session, pane)) = herdr_pane(&tui_pids) {
            return Tui::Herdr(session, pane);
        }
    }
    Tui::Terminal(first)
}

fn process_ancestors(pid: &str) -> BTreeSet<String> {
    let mut seen = BTreeSet::new();
    let mut pid = pid.to_string();
    while !pid.is_empty() && pid != "0" && pid != "1" && seen.insert(pid.clone()) {
        pid = quiet("ps", &["-o", "ppid=", "-p", &pid]);
    }
    seen
}

/// Every herdr agent of `kind` in every running herdr session, as (session, agent).
fn herdr_agents(kind: &str) -> Vec<(String, Value)> {
    let mut out = vec![];
    if which("herdr").is_none() {
        return out;
    }
    let sessions = herdr_json(&["session", "list", "--json"]);
    for session in sessions["sessions"].as_array().into_iter().flatten() {
        if session["running"].as_bool() != Some(true) {
            continue;
        }
        let Some(name) = session["name"].as_str() else {
            continue;
        };
        let agents = herdr_json(&["--session", name, "agent", "list"]);
        for agent in agents["result"]["agents"].as_array().into_iter().flatten() {
            if agent["agent"].as_str() == Some(kind) {
                out.push((name.to_string(), agent.clone()));
            }
        }
    }
    out
}

fn herdr_json(args: &[&str]) -> Value {
    match Command::new("herdr")
        .args(args)
        .stdin(Stdio::null())
        .output()
    {
        Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// (session, pane) of the herdr pane that runs one of `pids`. Herdr shows no pane ttys, so the
/// match is by process: the pane's shell or foreground process is the agent process or one of its
/// ancestors.
fn herdr_pane_for(kind: &str, pids: &[String]) -> Option<(String, String)> {
    let ancestors: BTreeSet<String> = pids.iter().flat_map(|p| process_ancestors(p)).collect();
    for (name, agent) in herdr_agents(kind) {
        let Some(pane) = agent["pane_id"].as_str() else {
            continue;
        };
        let info = herdr_json(&["--session", &name, "pane", "process-info", "--pane", pane]);
        let info = &info["result"]["process_info"];
        let mut owned: BTreeSet<String> = info["foreground_processes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|p| p["pid"].to_string())
            .collect();
        owned.insert(info["shell_pid"].to_string());
        if owned.iter().any(|p| ancestors.contains(p)) {
            return Some((name, pane.to_string()));
        }
    }
    None
}

fn herdr_pane(pids: &[String]) -> Option<(String, String)> {
    herdr_pane_for("agy", pids)
}

/// Where a Muse Code session's TUI runs, if anywhere. Its lease pid has a terminal when it is
/// a TUI; a headless run has none.
pub(crate) fn muse_tui(sid: &str) -> Tui {
    let pids = runtime::muse_pids(sid);
    if pids.is_empty() {
        return Tui::None;
    }
    let mut ttys = BTreeSet::new();
    for pid in &pids {
        let tty = quiet("ps", &["-o", "tty=", "-p", pid]);
        if !tty.is_empty() && !tty.contains('?') {
            ttys.insert(if tty.starts_with("/dev/") {
                tty
            } else {
                format!("/dev/{tty}")
            });
        }
    }
    let Some(first) = ttys.into_iter().next() else {
        return Tui::None;
    };
    if which("herdr").is_some() {
        if let Some((session, pane)) = herdr_pane_for("muse", &pids) {
            return Tui::Herdr(session, pane);
        }
    }
    Tui::Terminal(first)
}

fn queue_dir(home_dir: &Path, cid: &str) -> Res<PathBuf> {
    runtime_queue_dir(home_dir, "antigravity", cid)
}

/// The spool of one session's notifications that wait for a headless run.
fn runtime_queue_dir(home_dir: &Path, runtime: &str, id: &str) -> Res<PathBuf> {
    let q = home_dir.join("queue").join(format!("{runtime}-{id}"));
    fs::create_dir_all(&q).map_err(|e| format!("cannot create {}: {e}", q.display()))?;
    Ok(q)
}

/// herdr agent prompt pastes with the pane's bracketed-paste mode, so newlines do not submit
/// early, then presses Enter; a busy agy queues it until its turn ends. The lock keeps
/// concurrent senders in order.
fn paste_into_tui(qdir: &Path, session: &str, pane: &str, text: &str) -> Res<()> {
    let _lock = flock(&qdir.join(".paste.lock"), false)?;
    let out = Command::new("herdr")
        .args([
            "--session",
            session,
            "agent",
            "prompt",
            pane,
            text.trim_end_matches('\n'),
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run herdr: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            err
        };
        return Err(format!("herdr agent prompt failed: {msg}"));
    }
    Ok(())
}

fn notify_antigravity(
    target: &Address,
    home: &Store,
    text: &str,
    meta: &Value,
    headless: bool,
) -> Res<String> {
    let cid = target.id.as_str();
    let address = target.to_string();
    let qdir = queue_dir(&home.dir, cid)?;
    match antigravity_tui(cid) {
        Tui::Herdr(session, pane) => {
            // This notification counts every unread message, so earlier queued ones are stale.
            let mut h = Store::open(&home.root)?;
            let _ = h.take_notifications(&address);
            paste_into_tui(&qdir, &session, &pane, text).map_err(|e| {
                format!(
                    "antigravity:{cid} is open in an agy TUI (herdr session {session} pane {pane}) but the \
                     notification did not reach it: {e}; look at that pane, since agy may be waiting on a dialog"
                )
            })?;
            return Ok(format!(
                "notified by typing into its live agy TUI (herdr session {session} pane {pane}; it queues while agy is busy)"
            ));
        }
        Tui::Terminal(tty) => {
            home.push_notification(&address, text, meta)?;
            return Ok(queued(
                &format!("{target} is open in an agy TUI on {tty}, outside herdr, where peers cannot type"),
                "when its TUI runs in herdr and the next message arrives; until then it shows in `peers chats`",
            ));
        }
        Tui::None if !headless => {
            home.push_notification(&address, text, meta)?;
            return Ok(queued(
                &format!("{target} is not open in an agy TUI"),
                "when its TUI runs in herdr and the next message arrives; until then it shows in `peers chats`",
            ));
        }
        Tui::None => {}
    }
    if which("agy").is_none() {
        return Err("agy is not on PATH".into());
    }
    // Concurrent runs on one conversation interleave their turns, so notifications are spooled
    // and one drainer per conversation runs them in order.
    let s = stamp();
    let entry = qdir.join(format!("{s}.md"));
    let tmp = qdir.join(format!("{s}.md.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &entry).map_err(|e| format!("cannot write {}: {e}", entry.display()))?;
    let child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("_drain-antigravity")
        .arg(cid)
        .arg("--dir")
        .arg(&home.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start the antigravity drainer: {e}"))?;
    let log = home
        .dir
        .join("logs")
        .join(format!("antigravity-{cid}-{s}.json"));
    Ok(format!(
        "notified via headless resume (queued behind any run in progress) drainer={} log={}",
        child.id(),
        log.display()
    ))
}

fn pending(qdir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(qdir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md"))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// Runs the spooled notifications of one conversation, one headless agy run at a time.
pub fn drain_antigravity(cid: &str, home_dir: &Path) -> Res<()> {
    let qdir = queue_dir(home_dir, cid)?;
    let logs = home_dir.join("logs");
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    loop {
        let Some(lock) = flock(&qdir.join(".lock"), true)? else {
            return Ok(()); // the drainer holding the lock takes this one next
        };
        while let Some(entry) = pending(&qdir).into_iter().next() {
            let text = fs::read_to_string(&entry).map_err(|e| e.to_string())?;
            if let Tui::Herdr(session, pane) = antigravity_tui(cid) {
                // Opened in a TUI meanwhile: deliver there instead.
                paste_into_tui(&qdir, &session, &pane, &text)?;
                let _ = fs::remove_file(&entry);
                continue;
            }
            let s = entry
                .file_stem()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            let log = logs.join(format!("antigravity-{cid}-{s}.json"));
            let _ = fs::write(logs.join(format!("antigravity-{cid}-{s}.prompt.md")), &text);
            let out = File::create(&log).map_err(|e| e.to_string())?;
            let err = out.try_clone().map_err(|e| e.to_string())?;
            // Antigravity peers always skip permission prompts; -p takes the prompt, so it goes last.
            let _ = Command::new("agy")
                .args([
                    "--conversation",
                    cid,
                    "--dangerously-skip-permissions",
                    "--output-format",
                    "json",
                    "-p",
                    &text,
                ])
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err)
                .status();
            let _ = fs::remove_file(&entry);
        }
        drop(lock);
        if pending(&qdir).is_empty() {
            return Ok(()); // a notification spooled while unlocking needs another pass
        }
    }
}

/// Spools `text` for a headless run of `runtime` on session `id`, and starts a drainer for it.
fn spool(
    home: &Store,
    runtime: &str,
    id: &str,
    text: &str,
    drain_args: &[&std::ffi::OsStr],
) -> Res<(u32, String)> {
    let qdir = runtime_queue_dir(&home.dir, runtime, id)?;
    let s = stamp();
    let entry = qdir.join(format!("{s}.md"));
    let tmp = qdir.join(format!("{s}.md.tmp"));
    fs::write(&tmp, text).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &entry).map_err(|e| format!("cannot write {}: {e}", entry.display()))?;
    let child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args(drain_args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start the {runtime} drainer: {e}"))?;
    Ok((child.id(), s))
}

/// A live pi session with the peers extension takes the notification from its queue as a turn;
/// any other pi session finds it queued when it next starts with the extension, or, with
/// `headless`, gets one headless run per notification, in order.
fn notify_pi(
    target: &Address,
    home: &Store,
    text: &str,
    meta: &Value,
    headless: bool,
) -> Res<String> {
    let address = target.to_string();
    if home.listener_alive(&address)? {
        home.push_notification(&address, text, meta)?;
        return Ok(
            "notified via the peers pi extension (it arrives in the session as a turn)".into(),
        );
    }
    if !headless {
        home.push_notification(&address, text, meta)?;
        return Ok(queued(
            &format!("{target} has no peers extension listening"),
            "as a turn when it next starts with the peers extension",
        ));
    }
    if which("pi").is_none() {
        return Err("pi is not on PATH".into());
    }
    if runtime::pi_session(&target.id).is_none() {
        return Err(format!(
            "no saved pi session {} in {}; a pi session is saved once it has run a turn",
            target.id,
            runtime::pi_sessions_dir().display()
        ));
    }
    let (pid, s) = spool(
        home,
        "pi",
        &target.id,
        text,
        &[
            "_drain-pi".as_ref(),
            target.id.as_ref(),
            "--root".as_ref(),
            home.root.as_os_str(),
        ],
    )?;
    let log = home
        .dir
        .join("logs")
        .join(format!("pi-{}-{s}.jsonl", target.id));
    Ok(format!(
        "notified via headless resume (no peers extension is listening in it; queued behind any run in progress) \
         drainer={pid} log={}",
        log.display()
    ))
}

/// A muse session with an armed `peers watch` takes the notification from its queue as a
/// Monitor event; a live muse TUI in herdr gets it typed in; any other muse session finds it
/// queued when it next arms a watch, or, with `headless`, gets one headless run per notification,
/// in order.
fn notify_muse(
    target: &Address,
    home: &Store,
    text: &str,
    meta: &Value,
    headless: bool,
) -> Res<String> {
    let sid = target.id.as_str();
    let address = target.to_string();
    let qdir = runtime_queue_dir(&home.dir, "muse", sid)?;
    match muse_tui(sid) {
        Tui::Herdr(session, pane) => {
            // This notification counts every unread message, so earlier queued ones are stale.
            let mut h = Store::open(&home.root)?;
            let _ = h.take_notifications(&address);
            paste_into_tui(&qdir, &session, &pane, text).map_err(|e| {
                format!(
                    "muse:{sid} is open in a muse TUI (herdr session {session} pane {pane}) but the \
                     notification did not reach it: {e}; look at that pane, since muse may be waiting on a dialog"
                )
            })?;
            return Ok(format!(
                "notified by typing into its live muse TUI (herdr session {session} pane {pane}; it queues while muse is busy)"
            ));
        }
        Tui::Terminal(tty) => {
            home.push_notification(&address, text, meta)?;
            return Ok(queued(
                &format!("{target} is open in a muse TUI on {tty}, outside herdr, where peers cannot type"),
                "when its TUI runs in herdr and the next message arrives, or through its armed `peers watch`; until then it shows in `peers chats`",
            ));
        }
        Tui::None if !headless => {
            home.push_notification(&address, text, meta)?;
            return Ok(queued(
                &format!("{target} is not open in a muse TUI"),
                "through its armed `peers watch` (as a Monitor event), or when its TUI runs in herdr and the next message arrives; until then it shows in `peers chats`",
            ));
        }
        Tui::None => {}
    }
    if which("muse").is_none() {
        return Err("muse is not on PATH".into());
    }
    // A muse session is indexed once it has run; headless runs join it by id.
    if runtime::muse_session(sid).is_none() {
        return Err(format!(
            "no Muse Code session {sid} in {}; a muse session is indexed once it has run",
            runtime::muse_home().join("session-index.db").display()
        ));
    }
    let (pid, s) = spool(
        home,
        "muse",
        sid,
        text,
        &[
            "_drain-muse".as_ref(),
            sid.as_ref(),
            "--root".as_ref(),
            home.root.as_os_str(),
        ],
    )?;
    let log = home
        .dir
        .join("logs")
        .join(format!("muse-{sid}-{s}.jsonl"));
    Ok(format!(
        "notified via headless resume (queued behind any run in progress) drainer={pid} log={}",
        log.display()
    ))
}

/// Runs the spooled notifications of one muse session, one headless run at a time. A notification
/// whose session meanwhile arms `peers watch` or opens its TUI in herdr goes there instead.
pub fn drain_muse(id: &str, root: &Path) -> Res<()> {
    let store = Store::open(root)?;
    let address = Address::new("muse", id).to_string();
    let qdir = runtime_queue_dir(&store.dir, "muse", id)?;
    let logs = logs_dir(&store)?;
    let sess = runtime::muse_session(id);
    loop {
        let Some(lock) = flock(&qdir.join(".lock"), true)? else {
            return Ok(()); // the drainer holding the lock takes this one next
        };
        while let Some(entry) = pending(&qdir).into_iter().next() {
            let text = fs::read_to_string(&entry).map_err(|e| e.to_string())?;
            if store.listener_alive(&address)? {
                store.push_notification(&address, &text, &json!({}))?;
                let _ = fs::remove_file(&entry);
                continue;
            }
            if let Tui::Herdr(session, pane) = muse_tui(id) {
                // Opened in a TUI meanwhile: deliver there instead.
                paste_into_tui(&qdir, &session, &pane, &text)?;
                let _ = fs::remove_file(&entry);
                continue;
            }
            let s = entry
                .file_stem()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            let log = logs.join(format!("muse-{id}-{s}.jsonl"));
            let prompt_file = logs.join(format!("muse-{id}-{s}.prompt.md"));
            let _ = fs::write(&prompt_file, &text);
            let out = File::create(&log).map_err(|e| e.to_string())?;
            let err = out.try_clone().map_err(|e| e.to_string())?;
            // A headless peer always runs with --yolo: nobody answers approval prompts, and the
            // prompt goes in a file so no quoting can swallow it.
            let mut cmd = Command::new("muse");
            cmd.args([
                "exec",
                "--session-id",
                id,
                "--prompt-file",
                &prompt_file.to_string_lossy(),
                "--json",
                "--yolo",
            ]);
            if let Some(sess) = sess.as_ref() {
                if Path::new(&sess.dir).is_dir() {
                    cmd.current_dir(&sess.dir);
                }
            }
            let _ = cmd.stdin(Stdio::null()).stdout(out).stderr(err).status();
            let _ = fs::remove_file(&entry);
        }
        drop(lock);
        if pending(&qdir).is_empty() {
            return Ok(()); // a notification spooled while unlocking needs another pass
        }
    }
}

/// Runs the spooled notifications of one pi session, one headless pi run at a time. A notification
/// whose session meanwhile started listening through the peers extension goes to its queue instead.
pub fn drain_pi(id: &str, root: &Path) -> Res<()> {
    let store = Store::open(root)?;
    let address = Address::new("pi", id).to_string();
    let qdir = runtime_queue_dir(&store.dir, "pi", id)?;
    let logs = logs_dir(&store)?;
    loop {
        let Some(lock) = flock(&qdir.join(".lock"), true)? else {
            return Ok(()); // the drainer holding the lock takes this one next
        };
        while let Some(entry) = pending(&qdir).into_iter().next() {
            let text = fs::read_to_string(&entry).map_err(|e| e.to_string())?;
            if store.listener_alive(&address)? {
                store.push_notification(&address, &text, &json!({}))?;
                let _ = fs::remove_file(&entry);
                continue;
            }
            let s = entry
                .file_stem()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            let log = logs.join(format!("pi-{id}-{s}.jsonl"));
            let _ = fs::write(logs.join(format!("pi-{id}-{s}.prompt.md")), &text);
            let out = File::create(&log).map_err(|e| e.to_string())?;
            let err = out.try_clone().map_err(|e| e.to_string())?;
            let mut cmd = Command::new("pi");
            match runtime::pi_session(id) {
                Some(sess) => {
                    cmd.arg("--session").arg(&sess.file);
                    if Path::new(&sess.cwd).is_dir() {
                        cmd.current_dir(&sess.cwd);
                    }
                }
                None => {
                    cmd.arg("--session").arg(id);
                }
            }
            // The prompt goes after `--`, so no option parsing can take it. PEERS_PI_HEADLESS keeps
            // the peers extension from listening inside this one-shot run.
            let _ = cmd
                .args(["--mode", "json", "--"])
                .arg(text.trim_end())
                .env("PEERS_PI_HEADLESS", "1")
                .stdin(Stdio::null())
                .stdout(out)
                .stderr(err)
                .status();
            let _ = fs::remove_file(&entry);
        }
        drop(lock);
        if pending(&qdir).is_empty() {
            return Ok(()); // a notification spooled while unlocking needs another pass
        }
    }
}
