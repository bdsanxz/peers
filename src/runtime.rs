//! What each runtime knows about its sessions: listings, directories and transcripts.

use crate::address::Address;
use crate::util::*;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn agy_home() -> PathBuf {
    env_nonempty("AGY_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".gemini/antigravity-cli"))
}

pub fn claude_sessions(include_done: bool) -> Res<Vec<Value>> {
    let mut args = vec!["agents", "--json"];
    if include_done {
        args.push("--all");
    }
    Ok(run_json("claude", &args)?.and_then(|v| v.as_array().cloned()).unwrap_or_default())
}

pub fn claude_live(sid: &str) -> Res<bool> {
    Ok(claude_sessions(false)?.iter().any(|s| s["sessionId"].as_str() == Some(sid)))
}

/// OpenCode sessions, each with a "_status" of running, its outcome, or idle.
pub fn opencode_sessions() -> Res<Vec<Value>> {
    let Some(got) = run_json("opencode", &["api", "get", "/api/session"])? else {
        return Ok(vec![]);
    };
    let mut items = got.get("data").cloned().unwrap_or(got).as_array().cloned().unwrap_or_default();
    let active = run_json("opencode", &["api", "get", "/api/session/active"])?
        .and_then(|v| v.get("data").cloned())
        .unwrap_or(Value::Null);
    for s in items.iter_mut() {
        let id = s["id"].as_str().unwrap_or("").to_string();
        let running = match &active {
            Value::Object(m) => m.contains_key(&id),
            Value::Array(a) => a.iter().any(|x| x.as_str() == Some(&id) || x["id"].as_str() == Some(&id)),
            _ => false,
        };
        let status = if running {
            "running".to_string()
        } else {
            s["outcome"].as_str().filter(|v| !v.is_empty()).unwrap_or("idle").to_string()
        };
        s["_status"] = Value::String(status);
    }
    Ok(items)
}

pub fn opencode_dir(s: &Value) -> Option<String> {
    s["location"]["directory"].as_str().or_else(|| s["directory"].as_str()).map(String::from)
}

pub struct AgySession {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub modified: String,
    pub dirs: Vec<String>,
    pub status: String,
}

fn text_of(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null | ValueRef::Blob(_) => String::new(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
    }
}

fn read_agy(conn: &Connection) -> rusqlite::Result<Vec<AgySession>> {
    let mut stmt = conn.prepare(
        "select conversation_id, title, preview, last_modified_time, workspace_uris, status \
         from conversation_summaries order by last_modified_time",
    )?;
    let rows = stmt.query_map([], |r| {
        let col = |i| r.get_ref(i).map(text_of);
        let uris = col(4)?;
        let dirs = serde_json::from_str::<Vec<String>>(if uris.is_empty() { "[]" } else { &uris })
            .unwrap_or_default()
            .into_iter()
            .filter_map(|u| u.strip_prefix("file://").map(String::from))
            .collect();
        let status = col(5)?.replace("CASCADE_RUN_STATUS_", "").to_lowercase();
        Ok(AgySession {
            id: col(0)?,
            title: col(1)?,
            preview: col(2)?,
            modified: col(3)?,
            dirs,
            status: if status.is_empty() { "?".into() } else { status },
        })
    })?;
    rows.collect()
}

pub fn antigravity_sessions() -> Vec<AgySession> {
    let db = agy_home().join("conversation_summaries.db");
    if !db.exists() {
        return vec![];
    }
    let mut last_err = String::new();
    // agy may hold the database open for writing; an immutable read still works.
    for mode in ["mode=ro", "mode=ro&immutable=1"] {
        let uri = format!("file:{}?{mode}", db.display());
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        match Connection::open_with_flags(&uri, flags) {
            Ok(conn) => {
                let _ = conn.busy_timeout(Duration::from_secs(5));
                match read_agy(&conn) {
                    Ok(rows) => return rows,
                    Err(e) => last_err = e.to_string(),
                }
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    eprintln!("peers: warning: cannot read Antigravity conversations from {}: {last_err}", db.display());
    vec![]
}

pub fn claude_transcript(sid: &str) -> Option<PathBuf> {
    let projects = home().join(".claude/projects");
    fs::read_dir(projects).ok()?.flatten().map(|e| e.path().join(format!("{sid}.jsonl"))).find(|p| p.is_file())
}

/// A Claude session's directory: from its live session record, else its transcript, else
/// `claude agents --all`.
fn claude_cwd(sid: &str) -> Option<String> {
    if let Ok(rd) = fs::read_dir(home().join(".claude/sessions")) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Ok(v) = fs::read_to_string(&p).map(|t| serde_json::from_str::<Value>(&t).unwrap_or(Value::Null)) else {
                continue;
            };
            if v["sessionId"].as_str() == Some(sid) {
                if let Some(c) = v["cwd"].as_str() {
                    return Some(c.to_string());
                }
            }
        }
    }
    if let Some(t) = claude_transcript(sid) {
        if let Ok(f) = File::open(t) {
            for line in BufReader::new(f).lines().take(500).map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    if let Some(c) = v["cwd"].as_str() {
                        return Some(c.to_string());
                    }
                }
            }
        }
    }
    claude_sessions(true)
        .ok()?
        .into_iter()
        .find(|s| s["sessionId"].as_str() == Some(sid))
        .and_then(|s| s["cwd"].as_str().map(String::from))
}

/// The directory a session works in, as its runtime records it.
pub fn session_cwd(addr: &Address) -> Option<PathBuf> {
    let dir = match addr.runtime.as_str() {
        "claude" => claude_cwd(&addr.id),
        "opencode" => opencode_sessions()
            .ok()?
            .into_iter()
            .find(|s| s["id"].as_str() == Some(addr.id.as_str()))
            .and_then(|s| opencode_dir(&s)),
        _ => antigravity_sessions().into_iter().find(|s| s.id == addr.id).and_then(|s| s.dirs.into_iter().next()),
    }?;
    Some(canonical(Path::new(&dir)))
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            parts.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join(" ")
        }
        _ => String::new(),
    }
}

/// The last turns of a session, as (role, text); Antigravity gives its summary instead.
pub fn show(addr: &Address, last: usize) -> Res<Vec<String>> {
    let mut turns: Vec<(String, String)> = vec![];
    match addr.runtime.as_str() {
        "antigravity" => {
            // Its turns are stored as protobuf; the summary keeps a text preview.
            let s = antigravity_sessions()
                .into_iter()
                .find(|s| s.id == addr.id)
                .ok_or_else(|| format!("no Antigravity conversation {} in {}", addr.id, agy_home().display()))?;
            return Ok(vec![
                format!("title: {}", s.title),
                format!("status: {}", s.status),
                format!("modified: {}", s.modified),
                format!("preview: {}", s.preview.chars().take(1200).collect::<String>()),
            ]);
        }
        "opencode" => {
            let path = format!("/api/session/{}/message", addr.id);
            let got = run_json("opencode", &["api", "get", &path])?.ok_or("opencode is not on PATH")?;
            let mut items = got.get("data").cloned().unwrap_or(got).as_array().cloned().unwrap_or_default();
            items.sort_by_key(|m| m["time"]["created"].as_i64().unwrap_or(0));
            for m in items {
                let kind = m["type"].as_str().unwrap_or("");
                if kind != "user" && kind != "assistant" {
                    continue;
                }
                let txt = m["text"]
                    .as_str()
                    .or_else(|| m["payload"]["text"].as_str())
                    .map(String::from)
                    .unwrap_or_else(|| content_text(&m["content"]));
                turns.push((kind.to_string(), txt));
            }
        }
        _ => {
            let t = claude_transcript(&addr.id).ok_or_else(|| format!("no transcript found for {addr}"))?;
            let f = File::open(&t).map_err(|e| format!("cannot read {}: {e}", t.display()))?;
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                let Ok(d) = serde_json::from_str::<Value>(&line) else { continue };
                let kind = d["type"].as_str().unwrap_or("");
                if (kind == "user" || kind == "assistant") && d["message"].is_object() {
                    let txt = content_text(&d["message"]["content"]);
                    if !txt.trim().is_empty() {
                        turns.push((kind.to_string(), txt));
                    }
                }
            }
        }
    }
    let skip = turns.len().saturating_sub(last);
    Ok(turns
        .into_iter()
        .skip(skip)
        .map(|(k, t)| format!("{k}: {}", t.trim().chars().take(400).collect::<String>()))
        .collect())
}
