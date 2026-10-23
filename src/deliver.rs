//! Delivers the one-line notification of a new message into the receiver's session, by its
//! runtime: steered into OpenCode, queued for a live Claude session's channel or watch, a
//! headless resume of a stopped Claude session, typed into an agy TUI in herdr, or a queued
//! headless agy run.

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

/// Refuses, before anything is stored, a target that no notification can reach.
pub fn precheck(target: &Address) -> Res<()> {
    if target.runtime == "antigravity" {
        if let Tui::Terminal(tty) = antigravity_tui(&target.id) {
            return Err(format!(
                "{target} is open in an agy TUI on {tty}, outside herdr, so a notification cannot reach it \
                 and a headless run would interleave with it; ask the user to close it there, or to run it in herdr"
            ));
        }
    }
    Ok(())
}

/// Delivers `text` to `target`, whose own notification queue, logs and run queues live in
/// `home` (the database of the target's own squad). Returns how it went, for the SENT line.
pub fn notify(target: &Address, home: &Store, text: &str, meta: &Value) -> Res<String> {
    match target.runtime.as_str() {
        "opencode" => notify_opencode(&target.id, text),
        "antigravity" => notify_antigravity(&target.id, home, text),
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
            } else {
                notify_claude_resume(&target.id, home, text)
            }
        }
    }
}

fn notify_opencode(sid: &str, text: &str) -> Res<String> {
    // Always steer: a queued prompt waits in the service and never appears in an open TUI.
    let payload = json!({"text": text, "delivery": "steer", "resume": true}).to_string();
    let path = format!("/api/session/{sid}/prompt");
    let got = run_json("opencode", &["api", "post", &path, "--data", &payload])?.ok_or("opencode is not on PATH")?;
    let msg = got.get("data").unwrap_or(&got);
    Ok(format!(
        "notified by steering into the session (delivery={} message={})",
        msg["delivery"].as_str().unwrap_or("steer"),
        msg["id"].as_str().unwrap_or("?")
    ))
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
        .args(["-p", "--resume", sid, "--output-format", "json", "--dangerously-skip-permissions"])
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map_err(|e| format!("cannot start claude: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(text.as_bytes()).map_err(|e| format!("cannot write to claude: {e}"))?;
    }
    Ok(format!("notified via headless resume pid={} log={}", child.id(), log.display()))
}

enum Tui {
    None,
    Herdr(String, String),
    Terminal(String),
}

/// Where the conversation is open in an agy TUI. Every agy process on a conversation holds its
/// presence lock; a TUI has a terminal, a headless run has none.
fn antigravity_tui(cid: &str) -> Tui {
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
            ttys.insert(if tty.starts_with("/dev/") { tty } else { format!("/dev/{tty}") });
            tui_pids.push(pid.to_string());
        }
    }
    let Some(first) = ttys.into_iter().next() else { return Tui::None };
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

fn herdr_json(args: &[&str]) -> Value {
    match Command::new("herdr").args(args).stdin(Stdio::null()).output() {
        Ok(o) if o.status.success() => serde_json::from_slice(&o.stdout).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

/// (session, pane) of the herdr pane that runs one of `pids`. Herdr shows no pane ttys, so the
/// match is by process: the pane's shell or foreground process is the agy process or one of its
/// ancestors.
fn herdr_pane(pids: &[String]) -> Option<(String, String)> {
    let ancestors: BTreeSet<String> = pids.iter().flat_map(|p| process_ancestors(p)).collect();
    let sessions = herdr_json(&["session", "list", "--json"]);
    for session in sessions["sessions"].as_array().into_iter().flatten() {
        if session["running"].as_bool() != Some(true) {
            continue;
        }
        let Some(name) = session["name"].as_str() else { continue };
        let agents = herdr_json(&["--session", name, "agent", "list"]);
        for agent in agents["result"]["agents"].as_array().into_iter().flatten() {
            if agent["agent"].as_str() != Some("agy") {
                continue;
            }
            let Some(pane) = agent["pane_id"].as_str() else { continue };
            let info = herdr_json(&["--session", name, "pane", "process-info", "--pane", pane]);
            let info = &info["result"]["process_info"];
            let mut owned: BTreeSet<String> = info["foreground_processes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|p| p["pid"].to_string())
                .collect();
            owned.insert(info["shell_pid"].to_string());
            if owned.iter().any(|p| ancestors.contains(p)) {
                return Some((name.to_string(), pane.to_string()));
            }
        }
    }
    None
}

fn queue_dir(home_dir: &Path, cid: &str) -> Res<PathBuf> {
    let q = home_dir.join("queue").join(format!("antigravity-{cid}"));
    fs::create_dir_all(&q).map_err(|e| format!("cannot create {}: {e}", q.display()))?;
    Ok(q)
}

/// herdr agent prompt pastes with the pane's bracketed-paste mode, so newlines do not submit
/// early, then presses Enter; a busy agy queues it until its turn ends. The lock keeps
/// concurrent senders in order.
fn paste_into_tui(qdir: &Path, session: &str, pane: &str, text: &str) -> Res<()> {
    let _lock = flock(&qdir.join(".paste.lock"), false)?;
    let out = Command::new("herdr")
        .args(["--session", session, "agent", "prompt", pane, text.trim_end_matches('\n')])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run herdr: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(format!("herdr agent prompt failed: {msg}"));
    }
    Ok(())
}

fn notify_antigravity(cid: &str, home: &Store, text: &str) -> Res<String> {
    let qdir = queue_dir(&home.dir, cid)?;
    match antigravity_tui(cid) {
        Tui::Herdr(session, pane) => {
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
            return Err(format!("antigravity:{cid} is open in an agy TUI on {tty}, outside herdr; the notification cannot reach it"));
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
    let log = home.dir.join("logs").join(format!("antigravity-{cid}-{s}.json"));
    Ok(format!(
        "notified via headless resume (queued behind any run in progress) drainer={} log={}",
        child.id(),
        log.display()
    ))
}

fn pending(qdir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = fs::read_dir(qdir)
        .map(|rd| {
            rd.flatten().map(|e| e.path()).filter(|p| p.extension().and_then(|x| x.to_str()) == Some("md")).collect()
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
            let s = entry.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
            let log = logs.join(format!("antigravity-{cid}-{s}.json"));
            let _ = fs::write(logs.join(format!("antigravity-{cid}-{s}.prompt.md")), &text);
            let out = File::create(&log).map_err(|e| e.to_string())?;
            let err = out.try_clone().map_err(|e| e.to_string())?;
            // Antigravity peers always skip permission prompts; -p takes the prompt, so it goes last.
            let _ = Command::new("agy")
                .args(["--conversation", cid, "--dangerously-skip-permissions", "--output-format", "json", "-p", &text])
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
