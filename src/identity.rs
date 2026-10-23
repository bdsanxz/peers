//! Who this session is: its address, session directory, squad and role.

use crate::address::Address;
use crate::runtime;
use crate::store::{Profile, Store};
use crate::util::*;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Each runtime's own session id variable, as it sets it in its tool shells.
pub const SELF_VARS: [(&str, &str); 3] = [
    ("opencode", "OPENCODE_SESSION_ID"),
    ("claude", "CLAUDE_CODE_SESSION_ID"),
    ("antigravity", "ANTIGRAVITY_CONVERSATION_ID"),
];

pub fn basename_lower(comm: &str) -> String {
    Path::new(comm.trim()).file_name().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}

/// Walks the ancestor processes, nearest first, calling `f(pid, command)` until it returns Some.
pub fn find_ancestor<T>(mut f: impl FnMut(u32, &str) -> Option<T>) -> Option<T> {
    let mut pid = std::os::unix::process::parent_id();
    for _ in 0..40 {
        let out = quiet("ps", &["-o", "ppid=,comm=", "-p", &pid.to_string()]);
        let (ppid, comm) = out.trim().split_once(char::is_whitespace)?;
        if let Some(found) = f(pid, comm.trim()) {
            return Some(found);
        }
        let ppid: u32 = ppid.trim().parse().ok()?;
        if ppid <= 1 {
            return None;
        }
        pid = ppid;
    }
    None
}

/// Runtime of the nearest ancestor process that is opencode, claude or agy.
fn innermost_runtime() -> Option<&'static str> {
    find_ancestor(|_, comm| match basename_lower(comm).as_str() {
        "opencode" => Some("opencode"),
        "claude" => Some("claude"),
        "agy" => Some("antigravity"),
        _ => None,
    })
}

pub fn in_session() -> bool {
    env_nonempty("PEERS_SELF").is_some() || SELF_VARS.iter().any(|(_, v)| env_nonempty(v).is_some())
}

pub fn self_address() -> Res<Address> {
    if let Some(s) = env_nonempty("PEERS_SELF") {
        return Address::parse(&s);
    }
    let found: Vec<(&str, String)> =
        SELF_VARS.iter().filter_map(|(rt, var)| env_nonempty(var).map(|id| (*rt, id))).collect();
    let names = |all: bool| {
        SELF_VARS
            .iter()
            .filter(|(rt, _)| all || found.iter().any(|(f, _)| f == rt))
            .map(|(_, v)| *v)
            .collect::<Vec<_>>()
            .join(", ")
    };
    match found.len() {
        0 => Err(format!(
            "cannot tell which session this is: none of {} is set. Run this from inside an OpenCode, \
             Claude Code or Antigravity session, or set PEERS_SELF=<address>.",
            names(true)
        )),
        1 => Ok(Address::new(found[0].0, &found[0].1)),
        _ => {
            // A peer launched from another runtime's shell inherits that runtime's
            // variable too; the nearest ancestor process says which session we are.
            if let Some(rt) = innermost_runtime() {
                if let Some((_, id)) = found.iter().find(|(r, _)| *r == rt) {
                    return Ok(Address::new(rt, id));
                }
            }
            Err(format!(
                "cannot tell which session this is: several of {} are set and no runtime process is \
                 among the ancestors. Set PEERS_SELF=<address>.",
                names(false)
            ))
        }
    }
}

/// The directory the session works in: $PEERS_CWD, else what its runtime records, else the
/// current directory.
pub fn session_dir(me: &Address) -> PathBuf {
    if let Some(d) = env_nonempty("PEERS_CWD") {
        return canonical(Path::new(&d));
    }
    runtime::session_cwd(me).unwrap_or_else(process_cwd)
}

/// The squad workspace a directory belongs to: the nearest directory at or above it that holds
/// roster.json, else the directory itself. Its database holds the squad's conversations.
pub fn squad_root(dir: &Path) -> PathBuf {
    let mut d = Some(dir);
    while let Some(x) = d {
        if x.join("roster.json").is_file() {
            return x.to_path_buf();
        }
        d = x.parent();
    }
    dir.to_path_buf()
}

/// Records this session's own profile in a squad database. A role from $PEERS_ROLE or
/// .peers.json replaces the stored role and name; without one, only missing values are filled.
pub fn register(store: &Store, me: &Address, dir: &Path) -> Res<()> {
    let (role, name) = own_identity(None, None, &[process_cwd(), dir.to_path_buf()]);
    let overwrite = role.is_some();
    store.upsert_profile(
        &Profile {
            address: me.to_string(),
            runtime: me.runtime.clone(),
            name,
            role,
            cwd: Some(dir.display().to_string()),
            updated_at: now_ms(),
        },
        overwrite,
    )
}

/// The nearest .peers.json at or above one of `dirs` that names a role.
fn identity_file(dirs: &[PathBuf]) -> Option<Value> {
    for start in dirs {
        let mut d = Some(start.as_path());
        while let Some(x) = d {
            let path = x.join(".peers.json");
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    if v.get("role").and_then(Value::as_str).map(|r| !r.trim().is_empty()) == Some(true) {
                        return Some(v);
                    }
                }
            }
            d = x.parent();
        }
    }
    None
}

/// The sender's squad role and human-readable name. The role comes from --role, then
/// $PEERS_ROLE, then the nearest .peers.json; None means "unassigned". The name comes from
/// --name, then $PEERS_NAME, then that .peers.json's display_name, but only when the role came
/// from it too, so `--role user` never borrows a member's name.
pub fn own_identity(role_flag: Option<&str>, name_flag: Option<&str>, dirs: &[PathBuf]) -> (Option<String>, Option<String>) {
    let clean = |s: Option<String>| s.map(|v| one_line(&v)).filter(|v| !v.is_empty());
    let mut role = clean(role_flag.map(String::from)).or_else(|| clean(std::env::var("PEERS_ROLE").ok()));
    let mut name = clean(name_flag.map(String::from)).or_else(|| clean(std::env::var("PEERS_NAME").ok()));
    if role.is_none() {
        if let Some(data) = identity_file(dirs) {
            role = clean(data.get("role").and_then(Value::as_str).map(String::from));
            name = name.or_else(|| clean(data.get("display_name").and_then(Value::as_str).map(String::from)));
        }
    }
    (role, name)
}
