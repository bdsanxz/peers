//! Which peers in a squad are live, and which are replaced: a member that hit a limit and was
//! restarted on another runtime leaves its old session's profile behind, under the same role.
//! `peers contacts` shows each profile's status, and `peers send` names the session that took
//! over when it is asked to message a replaced one.

use crate::address::Address;
use crate::deliver::{antigravity_tui, opencode_open, Tui};
use crate::runtime;
use crate::store::{Profile, Store};
use crate::util::Res;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// The session runs now: a peers channel or extension listens, or its runtime shows it open.
    Live,
    /// The session is not running, and no other session holds its role.
    Offline,
    /// The session is not running, and the session at this address holds its role now.
    Replaced(String),
}

impl Status {
    pub fn word(&self) -> &'static str {
        match self {
            Status::Live => "live",
            Status::Offline => "offline",
            Status::Replaced(_) => "replaced",
        }
    }
}

/// Asks each runtime once per run, however many sessions are checked.
#[derive(Default)]
pub struct Presence {
    claude: Option<Vec<String>>,
    opencode: Option<Vec<Value>>,
}

impl Presence {
    /// Whether the session at `addr` runs now. Listeners are looked up in `store`, the squad's database.
    pub fn live(&mut self, addr: &str, store: &Store) -> Res<bool> {
        let Ok(a) = Address::parse(addr) else {
            return Ok(false);
        };
        Ok(match a.runtime.as_str() {
            "claude" => {
                if store.listener_alive(addr)? {
                    return Ok(true);
                }
                if self.claude.is_none() {
                    let ids = runtime::claude_sessions(false)
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|s| s["sessionId"].as_str().map(String::from))
                        .collect();
                    self.claude = Some(ids);
                }
                self.claude.as_ref().is_some_and(|ids| ids.contains(&a.id))
            }
            "opencode" => {
                if self.opencode.is_none() {
                    self.opencode = Some(runtime::opencode_sessions().unwrap_or_default());
                }
                let sessions = self.opencode.as_deref().unwrap_or_default();
                let running = sessions
                    .iter()
                    .any(|s| s["id"].as_str() == Some(&a.id) && s["_status"] == "running");
                running || opencode_open(&a.id, sessions)
            }
            "antigravity" => !matches!(antigravity_tui(&a.id), Tui::None),
            "pi" => store.listener_alive(addr)?,
            _ => false,
        })
    }
}

/// A role that one session holds at a time in a squad; the defaults are shared by many sessions.
fn exclusive(role: Option<&str>) -> Option<&str> {
    role.filter(|r| !r.is_empty() && *r != "unassigned" && *r != "user")
}

/// The status of every profile, given which ones are live. A session that is not live is replaced
/// when another session of the same role is live, or was seen after it; the live one, else the
/// most recently seen one, is named as its replacement. A live session is never replaced.
pub fn statuses(profiles: &[Profile], live: &[bool]) -> Vec<Status> {
    profiles
        .iter()
        .enumerate()
        .map(|(i, p)| {
            if live[i] {
                return Status::Live;
            }
            let Some(role) = exclusive(p.role.as_deref()) else {
                return Status::Offline;
            };
            let by = profiles
                .iter()
                .enumerate()
                .filter(|(j, q)| {
                    *j != i
                        && q.role.as_deref() == Some(role)
                        && (live[*j] || q.updated_at > p.updated_at)
                })
                .max_by_key(|(j, q)| (live[*j], q.updated_at));
            match by {
                Some((_, q)) => Status::Replaced(q.address.clone()),
                None => Status::Offline,
            }
        })
        .collect()
}

/// Every profile in `store` with its status. `me` is live by definition: the caller runs in it.
pub fn squad(store: &Store, me: Option<&str>) -> Res<Vec<(Profile, Status)>> {
    let profiles = store.contacts("")?;
    let mut presence = Presence::default();
    let mut live = Vec::with_capacity(profiles.len());
    for p in &profiles {
        live.push(Some(p.address.as_str()) == me || presence.live(&p.address, store)?);
    }
    let st = statuses(&profiles, &live);
    Ok(profiles.into_iter().zip(st).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(addr: &str, role: &str, at: i64) -> Profile {
        Profile {
            address: addr.into(),
            runtime: "claude".into(),
            name: None,
            role: Some(role.into()),
            cwd: None,
            updated_at: at,
        }
    }

    #[test]
    fn a_newer_or_live_session_of_the_same_role_replaces_a_dead_one() {
        let ps = [
            p("claude:old", "qa", 1),
            p("pi:new", "qa", 2),
            p("claude:lead", "lead", 1),
        ];
        assert_eq!(
            statuses(&ps, &[false, false, false]),
            [
                Status::Replaced("pi:new".into()),
                Status::Offline,
                Status::Offline
            ]
        );
        // The live one wins, even when it was seen earlier; a live session is never replaced.
        assert_eq!(
            statuses(&ps, &[true, false, false]),
            [
                Status::Live,
                Status::Replaced("claude:old".into()),
                Status::Offline
            ]
        );
    }

    #[test]
    fn shared_roles_never_replace_each_other() {
        let ps = [
            p("claude:a", "unassigned", 1),
            p("claude:b", "unassigned", 2),
            p("claude:u", "user", 1),
            p("claude:v", "user", 3),
        ];
        assert_eq!(
            statuses(&ps, &[false; 4]),
            [
                Status::Offline,
                Status::Offline,
                Status::Offline,
                Status::Offline
            ]
        );
    }
}
