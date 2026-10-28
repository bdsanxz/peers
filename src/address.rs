//! Peer addresses: <runtime>:<session id>.

use crate::util::Res;
use std::fmt;

pub const RUNTIMES: [&str; 5] = ["opencode", "claude", "antigravity", "pi", "muse"];
pub const KINDS: [&str; 6] = [
    "request",
    "ack",
    "progress",
    "completion",
    "receipt",
    "notice",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub runtime: String,
    pub id: String,
}

impl Address {
    pub fn new(runtime: &str, id: &str) -> Self {
        Address {
            runtime: runtime.to_string(),
            id: id.to_string(),
        }
    }

    pub fn parse(s: &str) -> Res<Self> {
        let s = s.trim();
        let (runtime, id) = s.split_once(':').unwrap_or(("", ""));
        if !RUNTIMES.contains(&runtime) || id.is_empty() {
            return Err(format!(
                "bad address {s:?}; expected opencode:<ses_...>, claude:<uuid>, antigravity:<uuid>, pi:<session id> or muse:<uuid> (see `peers --help`)"
            ));
        }
        if runtime == "opencode" && !id.starts_with("ses") {
            return Err(format!(
                "bad OpenCode session id {id:?}; it must start with 'ses'"
            ));
        }
        Ok(Address::new(runtime, id))
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.runtime, self.id)
    }
}
