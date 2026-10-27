//! End-to-end checks of the peers binary against stubs of the claude, opencode, agy and herdr
//! CLIs, each test in its own temporary HOME and cache. No real session, inbox or workspace is
//! touched.

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const A: &str = "claude:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B: &str = "claude:11111111-1111-1111-1111-111111111111";
const C: &str = "claude:cccccccc-cccc-cccc-cccc-cccccccccccc";
const STOPPED: &str = "claude:99999999-9999-9999-9999-999999999999";
const AGY: &str = "antigravity:33333333-3333-3333-3333-333333333333";
const PI: &str = "pi:01a176bc-0000-7000-8000-000000000001";

struct Env {
    tmp: PathBuf,
}

struct Out {
    code: i32,
    out: String,
    err: String,
}

impl Out {
    fn all(&self) -> String {
        format!("{}{}", self.out, self.err)
    }
}

fn stub(dir: &Path, name: &str, body: &str) {
    let p = dir.join(name);
    fs::write(&p, format!("#!/bin/bash\n{body}\n")).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
}

impl Env {
    fn new(name: &str) -> Env {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let tmp = std::env::temp_dir().join(format!("peers-test-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(tmp.join("bin")).unwrap();
        fs::create_dir_all(tmp.join("home")).unwrap();
        let tmp = fs::canonicalize(&tmp).unwrap();
        let bin = tmp.join("bin");
        // `claude agents --json` prints $HOME/claude-agents.json: the live sessions of the test.
        stub(
            &bin,
            "claude",
            r#"if [ "$1 $2" = "agents --json" ]; then cat "$HOME/claude-agents.json" 2>/dev/null || echo '[]'; exit 0; fi
if [ "$1" = "-p" ]; then printf '%s\n' "$@" >"$HOME/claude-args"; cat >"$HOME/claude-stdin"; echo '{"result":"ok"}'; exit 0; fi
echo "unexpected claude call: $*" >&2; exit 9"#,
        );
        stub(
            &bin,
            "opencode",
            r#"case "$*" in
  "api get /api/session") cat "$HOME/opencode-sessions.json" 2>/dev/null || echo '{"data":[]}' ;;
  "api get /api/session/active") echo '{"data":{}}' ;;
  "api post /api/session/ses_abc/prompt --data "*) printf '%s' "${@: -1}" >"$HOME/opencode-prompt"; echo '{"data":{"id":"msg_1","delivery":"steer"}}' ;;
  *) echo "unexpected opencode call: $*" >&2; exit 9 ;;
esac"#,
        );
        stub(
            &bin,
            "agy",
            r#"printf '%s\n' "$@" >"$HOME/agy-args"
echo start >>"$HOME/agy-timeline"; sleep 0.3; echo end >>"$HOME/agy-timeline"
echo '{"conversation_id":"33333333-3333-3333-3333-333333333333","status":"SUCCESS","response":"ok"}'"#,
        );
        // `pi --session <file> --mode json -- <prompt>` records its arguments and working directory.
        stub(
            &bin,
            "pi",
            r#"printf '%s\n' "$@" >"$HOME/pi-args"; pwd >"$HOME/pi-cwd"; env | grep '^PEERS_PI_HEADLESS=' >"$HOME/pi-env"
echo start >>"$HOME/pi-timeline"; sleep 0.3; echo end >>"$HOME/pi-timeline"
echo '{"type":"agent_end"}'"#,
        );
        Env { tmp }
    }

    /// Saves a pi session file for PI, working in `cwd`, as pi lays them out.
    fn save_pi_session(&self, cwd: &Path) -> PathBuf {
        let id = PI.trim_start_matches("pi:");
        let dir = self.home().join(".pi/agent/sessions/--work--");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(format!("2026-10-26T05-43-49-434Z_{id}.jsonl"));
        fs::write(
            &file,
            format!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{id}\",\"timestamp\":\"2026-10-26T05:43:49.434Z\",\"cwd\":\"{}\"}}\n\
                 {{\"type\":\"message\",\"id\":\"a1\",\"parentId\":null,\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"hello pi\"}}]}}}}\n\
                 {{\"type\":\"message\",\"id\":\"a2\",\"parentId\":\"a1\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"thinking\",\"thinking\":\"hmm\"}},{{\"type\":\"text\",\"text\":\"hi there\"}}]}}}}\n\
                 {{\"type\":\"session_info\",\"id\":\"a3\",\"parentId\":\"a2\",\"name\":\"debater\"}}\n",
                cwd.display()
            ),
        )
        .unwrap();
        file
    }

    fn home(&self) -> PathBuf {
        self.tmp.join("home")
    }

    fn dir(&self, rel: &str) -> PathBuf {
        let d = self.tmp.join(rel);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn set_claude_live(&self, live: &[(&str, &Path)]) {
        let rows: Vec<String> = live
            .iter()
            .map(|(addr, cwd)| {
                format!(
                    r#"{{"sessionId":"{}","kind":"interactive","status":"idle","cwd":"{}","name":"peer"}}"#,
                    addr.trim_start_matches("claude:"),
                    cwd.display()
                )
            })
            .collect();
        fs::write(self.home().join("claude-agents.json"), format!("[{}]", rows.join(","))).unwrap();
    }

    fn command(&self, me: Option<&str>, cwd: &Path, extra: &[(&str, &str)], args: &[&str]) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_peers"));
        cmd.env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", self.tmp.join("bin").display()))
            .env("HOME", self.home())
            .env("PEERS_CACHE", self.tmp.join("cache"))
            .env("AGY_HOME", self.tmp.join("agy"))
            .current_dir(cwd)
            .args(args);
        if let Some(me) = me {
            cmd.env("PEERS_SELF", me);
        }
        for (k, v) in extra {
            cmd.env(k, v);
        }
        cmd
    }

    fn run_env(&self, me: Option<&str>, cwd: &Path, extra: &[(&str, &str)], args: &[&str], stdin: Option<&str>) -> Out {
        let mut cmd = self.command(me, cwd, extra, args);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        {
            let mut input = child.stdin.take().unwrap();
            if let Some(s) = stdin {
                input.write_all(s.as_bytes()).unwrap();
            }
        }
        let o = child.wait_with_output().unwrap();
        Out {
            code: o.status.code().unwrap_or(-1),
            out: String::from_utf8_lossy(&o.stdout).into_owned(),
            err: String::from_utf8_lossy(&o.stderr).into_owned(),
        }
    }

    fn run(&self, me: &str, cwd: &Path, args: &[&str]) -> Out {
        self.run_env(Some(me), cwd, &[], args, None)
    }

    fn ok(&self, me: &str, cwd: &Path, args: &[&str]) -> String {
        let o = self.run(me, cwd, args);
        assert_eq!(o.code, 0, "peers {args:?} as {me} failed: {}", o.all());
        o.out
    }

    fn send(&self, me: &str, cwd: &Path, to: &str, seq: &str, body: &str) -> String {
        self.ok(me, cwd, &["send", to, "--kind", "notice", "--seq", seq, "--body", body])
    }

    /// Starts `peers watch` for `me` and returns the first `n` lines it prints.
    fn watch_lines(&self, me: &str, cwd: &Path, n: usize) -> Vec<String> {
        let mut child = self.command(Some(me), cwd, &[], &["watch"]).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let lines = read_lines(&mut child, n, Duration::from_secs(10));
        let _ = child.kill();
        let _ = child.wait();
        lines
    }

    fn watch_line(&self, me: &str, cwd: &Path) -> String {
        self.watch_lines(me, cwd, 1).join("")
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.tmp);
    }
}

fn read_lines(child: &mut Child, n: usize, timeout: Duration) -> Vec<String> {
    let out = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if tx.send(format!("{line}\n")).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + timeout;
    let mut lines = vec![];
    while lines.len() < n {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(l) => lines.push(l),
            Err(_) => break,
        }
    }
    lines
}

fn wait_for(what: &str, secs: u64, mut cond: impl FnMut() -> bool) {
    let start = Instant::now();
    while !cond() {
        assert!(start.elapsed() < Duration::from_secs(secs), "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(100));
    }
}

fn has(hay: &str, needle: &str) {
    assert!(hay.contains(needle), "expected {needle:?} in:\n{hay}");
}

fn lacks(hay: &str, needle: &str) {
    assert!(!hay.contains(needle), "did not expect {needle:?} in:\n{hay}");
}

// ---------------------------------------------------------------------------
// Addressing and validation
// ---------------------------------------------------------------------------

#[test]
fn whoami_reads_each_runtime() {
    let e = Env::new("whoami");
    let d = e.dir("w");
    has(&e.run_env(None, &d, &[], &["whoami"], None).err, "cannot tell which session");
    has(&e.run_env(None, &d, &[("OPENCODE_SESSION_ID", "ses_me")], &["whoami"], None).out, "opencode:ses_me");
    has(&e.run_env(None, &d, &[("CLAUDE_CODE_SESSION_ID", "abc")], &["whoami"], None).out, "claude:abc");
    has(&e.run_env(None, &d, &[("ANTIGRAVITY_CONVERSATION_ID", "conv1")], &["whoami"], None).out, "antigravity:conv1");
    let o = e.run_env(None, &d, &[("PEERS_SELF", "opencode:ses_x"), ("CLAUDE_CODE_SESSION_ID", "abc")], &["whoami"], None);
    has(&o.out, "opencode:ses_x");
}

#[test]
fn send_rejects_bad_input() {
    let e = Env::new("validate");
    let d = e.dir("w");
    let send = |args: &[&str]| e.run(A, &d, &[&["send"], args].concat()).all();
    has(&send(&["foo", "--kind", "ack", "--seq", "1", "--body", "x"]), "bad address");
    has(&send(&["opencode:abc", "--kind", "ack", "--seq", "1", "--body", "x"]), "must start with 'ses'");
    has(&send(&["opencode:ses_abc", "--kind", "nope", "--seq", "1", "--body", "x"]), "invalid value 'nope'");
    has(&send(&["opencode:ses_abc", "--kind", "ack", "--seq", "1", "--body", " "]), "empty message body");
    has(&send(&[A, "--kind", "ack", "--seq", "1", "--body", "x"]), "to yourself");
    has(&send(&["opencode:ses_abc", "--kind", "ack", "--seq", "1", "--delivery", "queue", "--body", "x"]), "unexpected argument '--delivery'");
    has(&send(&["opencode:ses_abc", "--kind", "request", "--seq", "1", "--reply-to", "nope", "--body", "x"]), "bad address");
    has(&send(&["opencode:ses_abc", "--kind", "ack", "--seq", "1", "hello there"]), "the body goes in --body TEXT or on stdin");
    has(&send(&["opencode:ses_abc", "hello there"]), "(--body <TEXT> | <body on stdin>)");
    let o = e.run(A, &d, &["open", B, "--page", "0"]);
    assert_eq!(o.code, 2);
}

// ---------------------------------------------------------------------------
// The inbox: notification, history, pagination, read state, delete
// ---------------------------------------------------------------------------

#[test]
fn receiver_gets_only_a_notification_and_reads_the_chat() {
    let e = Env::new("notify");
    let d = e.dir("w");
    e.set_claude_live(&[(B, &d)]);
    e.ok(B, &d, &["chats"]); // B registers its profile
    let sent = e.ok(A, &d, &["send", B, "--kind", "request", "--seq", "1", "--role", "lead", "--name", "Lena", "--body", "Review api/."]);
    has(&sent, &format!("SENT {B}: stored in its inbox (1 unread message); notified via notification queue"));
    e.send(A, &d, B, "2", "Second note.");
    let lines = e.watch_lines(B, &d, 2);
    assert_eq!(lines.len(), 2, "expected two notifications, got {lines:?}");
    let line = &lines[0];
    assert_eq!(line.trim(), format!("New message from Lena (lead). You have 1 unread message in your inbox. Read it with: peers open {A}"));
    has(&lines[1], "You have 2 unread messages in your inbox.");
    // The notification carries no body.
    lacks(line, "Review api/.");

    let chats = e.ok(B, &d, &["chats"]);
    has(&chats, "2 unread messages in 1 chat");
    has(&chats, &format!("{A}  name=\"Lena\"  role=lead  unread=2  messages=2"));
    has(&chats, "from them [notice seq 2]: Second note.");
    // The sender's chat list says whether its last message was read.
    has(&e.ok(A, &d, &["chats"]), "from you [notice seq 2, not read yet]: Second note.");
    let page = e.ok(B, &d, &["open", A]);
    has(&page, "page 1 of 1  (messages 1-2 of 2");
    // The chat reads like a messenger, told from the reader's side.
    has(&page, &format!("CHAT with Lena (lead) · {A}\npage 1 of 1"));
    has(&page, "──\n\n── 2 unread messages ──\n\n[Lena] #1 ");
    // A message sent without a name still shows the partner's.
    has(&page, "[Lena] #2 ");
    has(&page, "  request seq 1 · new\n  Review api/.\n");
    has(&page, "INBOX: 0 unread messages left in your inbox");
    // History stays after reading, now as read.
    let again = e.ok(B, &d, &["open", A]);
    has(&again, "  request seq 1\n  Review api/.\n");
    // A message sent without a role does not name one.
    has(&again, "  notice seq 2\n  Second note.\n");
    lacks(&again, "unread message ──");
    lacks(&again, " · new");
    has(&e.ok(B, &d, &["chats"]), "0 unread messages in 1 chat");
    has(&e.ok(A, &d, &["chats"]), "from you [notice seq 2, read ");
    // The sender sees its own sent messages in the same chat.
    let mine = e.ok(A, &d, &["open", B]);
    has(&mine, &format!("CHAT with {B} (unassigned)\npage 1 of 1"));
    has(&mine, "[you] #2 ");
    has(&mine, "  notice seq 2 · read ");
    lacks(&mine, "not read yet");
    has(&mine, "\n  Second note.\n");
}

#[test]
fn unread_count_spans_the_whole_inbox() {
    let e = Env::new("unread");
    let d = e.dir("w");
    e.set_claude_live(&[(B, &d)]);
    e.ok(B, &d, &["chats"]);
    e.send(A, &d, B, "1", "from a");
    let sent = e.send(C, &d, B, "1", "from c");
    has(&sent, "(2 unread messages)");
    let lines = e.watch_lines(B, &d, 2);
    has(lines.get(1).map(String::as_str).unwrap_or(""), "You have 2 unread messages in your inbox.");
    has(&e.ok(B, &d, &["inbox"]), "2 unread messages in 2 chats");
}

#[test]
fn chat_history_pages_by_twenty_newest_first() {
    let e = Env::new("pages");
    let d = e.dir("w");
    e.set_claude_live(&[(B, &d)]);
    e.ok(B, &d, &["chats"]);
    for i in 1..=45 {
        e.send(A, &d, B, &i.to_string(), &format!("message {i}"));
    }
    let p1 = e.ok(B, &d, &["open", A]);
    has(&p1, "page 1 of 3  (messages 26-45 of 45");
    has(&p1, "message 26\n");
    has(&p1, "message 45\n");
    lacks(&p1, "message 25\n");
    assert!(p1.find("message 26\n").unwrap() < p1.find("message 45\n").unwrap(), "oldest first within a page");
    has(&p1, &format!("OLDER: peers open {A} --page 2  (25 unread messages on older pages)"));
    has(&p1, "INBOX: 25 unread messages left");
    let p3 = e.ok(B, &d, &["open", A, "--page", "3"]);
    has(&p3, "page 3 of 3  (messages 1-5 of 45");
    has(&p3, &format!("NEWER: peers open {A} --page 2"));
    lacks(&p3, "OLDER:");
    has(&p3, "INBOX: 20 unread messages left");
    let p4 = e.run(B, &d, &["open", A, "--page", "4"]);
    assert_eq!(p4.code, 2);
    has(&p4.err, "page 4 does not exist: the chat with");
    let p2 = e.ok(B, &d, &["open", A, "--page", "2"]);
    has(&p2, "messages 6-25 of 45");
    has(&p2, "INBOX: 0 unread messages left");
}

#[test]
fn delete_hides_the_chat_only_for_the_deleter() {
    let e = Env::new("delete");
    let d = e.dir("w");
    e.set_claude_live(&[(B, &d)]);
    e.ok(B, &d, &["chats"]);
    e.send(A, &d, B, "1", "old one");
    e.send(A, &d, B, "2", "old two");
    has(&e.ok(B, &d, &["delete", A]), &format!("DELETED your view of the chat with {A}: 2 messages hidden from you"));
    has(&e.ok(B, &d, &["chats"]), "0 unread messages in 0 chats");
    has(&e.ok(B, &d, &["open", A]), "No chat with");
    has(&e.ok(B, &d, &["delete", A]), "nothing deleted");
    // The other side keeps the whole chat.
    let theirs = e.ok(A, &d, &["open", B]);
    has(&theirs, "old one");
    has(&theirs, "messages 1-2 of 2");
    has(&theirs, "not read yet");
    // A new message starts the chat again with only what came after the delete.
    let sent = e.send(A, &d, B, "3", "new one");
    has(&sent, "(1 unread message)");
    let mine = e.ok(B, &d, &["open", A]);
    has(&mine, "new one");
    lacks(&mine, "old one");
    has(&e.ok(A, &d, &["open", B]), "messages 1-3 of 3");
}

#[test]
fn contacts_list_every_profile_but_yours() {
    let e = Env::new("contacts");
    let d = e.dir("w");
    has(&e.ok(A, &d, &["contacts"]), "No contacts yet");
    e.ok(B, &d, &["whoami"]);
    fs::write(d.join(".peers.json"), r#"{"role": "backend", "display_name": "Rina (backend)"}"#).unwrap();
    e.ok(C, &d, &["whoami"]);
    let list = e.ok(A, &d, &["contacts"]);
    has(&list, &format!("{C}  name=\"Rina (backend)\"  role=backend  runtime=claude  cwd={}", d.display()));
    has(&list, &format!("{B}  name=\"\"  role=unassigned"));
    lacks(&list, &format!("{A} "));
}

// ---------------------------------------------------------------------------
// Where the database lives: one per squad
// ---------------------------------------------------------------------------

#[test]
fn squad_members_in_their_own_directories_share_one_database() {
    let e = Env::new("squad");
    let ws = e.dir("squads/shop");
    fs::write(ws.join("roster.json"), "{}").unwrap();
    let lead = e.dir("squads/shop/lead");
    let backend = e.dir("squads/shop/backend/repo");
    e.set_claude_live(&[(B, &backend)]);
    e.ok(B, &backend, &["chats"]);
    let sent = e.send(A, &lead, B, "1", "hello squad");
    lacks(&sent, "--squad");
    has(&e.watch_line(B, &backend), &format!("Read it with: peers open {A}"));
    has(&e.ok(B, &backend, &["open", A]), "hello squad");
    let db = e.tmp.join("cache").join(ws.display().to_string().replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "-")).join("bd.sql");
    assert!(db.is_file(), "expected the squad database at {}", db.display());
    assert!(fs::read_dir(e.tmp.join("cache")).unwrap().count() == 1, "only the squad database exists");
}

#[test]
fn outsider_talks_to_a_squad_through_the_squad_database() {
    let e = Env::new("outsider");
    let ws = e.dir("squads/shop");
    fs::write(ws.join("roster.json"), "{}").unwrap();
    let lead = e.dir("squads/shop/lead");
    let mine = e.dir("dev/me");
    e.set_claude_live(&[(B, &lead), (C, &mine)]);
    e.ok(B, &lead, &["whoami"]);
    // The outsider C picks the squad's database with --squad.
    let ws_s = ws.display().to_string();
    let sent = e.ok(C, &mine, &["--squad", &ws_s, "send", B, "--kind", "request", "--seq", "1", "--role", "user", "--body", "Build it."]);
    has(&sent, &format!("the answer then with `peers open {B} --squad {ws_s}`"));
    has(&e.watch_line(B, &lead), &format!("Read it with: peers open {C}\n"));
    has(&e.ok(B, &lead, &["open", C]), "Build it.");
    // The lead's answer lands in the squad database; C's notification names it.
    e.ok(B, &lead, &["send", C, "--kind", "completion", "--seq", "1", "--body", "Built."]);
    has(&e.watch_line(C, &mine), &format!("Read it with: peers open {B} --squad {ws_s}"));
    has(&e.ok(C, &mine, &["open", B, "--squad", &ws_s]), "Built.");
    // C's own directory holds no squad chat.
    has(&e.ok(C, &mine, &["chats"]), "0 chats");
}

// ---------------------------------------------------------------------------
// Delivery routes
// ---------------------------------------------------------------------------

#[test]
fn opencode_target_is_steered_the_notification() {
    let e = Env::new("opencode");
    let d = e.dir("w");
    fs::write(
        e.home().join("opencode-sessions.json"),
        format!(r#"{{"data":[{{"id":"ses_abc","title":"t","location":{{"directory":"{}"}}}}]}}"#, d.display()),
    )
    .unwrap();
    let sent = e.ok(A, &d, &["send", "opencode:ses_abc", "--kind", "request", "--seq", "1", "--body", "secret body"]);
    // Neither running nor open in a TUI: admitted to its inbox, no run.
    has(&sent, "queued, not delivered yet: opencode:ses_abc is neither running nor open in a TUI");
    has(&sent, "No headless run was started");
    let prompt = fs::read_to_string(e.home().join("opencode-prompt")).unwrap();
    has(&prompt, r#""delivery":"steer""#);
    has(&prompt, r#""resume":false"#);
    has(&prompt, &format!("New message from {A} (unassigned). You have 1 unread message in your inbox. Read it with: peers open {A}\""));
    lacks(&prompt, "secret body");
    has(&e.ok("opencode:ses_abc", &d, &["open", A]), "secret body");
    // --headless resumes it in the service.
    let sent = e.ok(A, &d, &["send", "opencode:ses_abc", "--kind", "notice", "--seq", "2", "--body", "x", "--headless"]);
    has(&sent, "notified via headless resume in the OpenCode service (message=msg_1)");
    has(&fs::read_to_string(e.home().join("opencode-prompt")).unwrap(), r#""resume":true"#);
    // A session open in a TUI (a process opened with its id) is steered with a turn.
    stub(&e.tmp.join("bin"), "ps", r#"[ "$*" = "-ax -o args=" ] && { echo "/opt/homebrew/bin/opencode -s ses_abc"; exit 0; }
exec /bin/ps "$@""#);
    let sent = e.ok(A, &d, &["send", "opencode:ses_abc", "--kind", "notice", "--seq", "3", "--body", "y"]);
    has(&sent, "notified by steering into the session open in its TUI");
    has(&fs::read_to_string(e.home().join("opencode-prompt")).unwrap(), r#""resume":true"#);
    // A TUI in herdr without the id in its arguments: found by its directory, for the newest session there.
    stub(&e.tmp.join("bin"), "ps", r#"[ "$*" = "-ax -o args=" ] && { echo "opencode --prompt hi"; exit 0; }
exec /bin/ps "$@""#);
    stub(
        &e.tmp.join("bin"),
        "herdr",
        &format!(
            r#"case "$*" in
  "session list --json") echo '{{"sessions":[{{"name":"main","running":true}}]}}' ;;
  "--session main agent list") echo '{{"result":{{"agents":[{{"agent":"opencode","pane_id":"w1:p2","terminal_title":"OpenCode","cwd":"{}"}}]}}}}' ;;
  *) echo "unexpected herdr call: $*" >&2; exit 9 ;;
esac"#,
            d.display()
        ),
    );
    let sessions = |newest: &str| {
        format!(
            r#"{{"data":[{{"id":"ses_abc","time":{{"updated":{}}},"location":{{"directory":"{d}"}}}},{{"id":"ses_old","time":{{"updated":5}},"location":{{"directory":"{d}"}}}}]}}"#,
            if newest == "ses_abc" { 9 } else { 1 },
            d = d.display()
        )
    };
    fs::write(e.home().join("opencode-sessions.json"), sessions("ses_abc")).unwrap();
    has(&e.send(A, &d, "opencode:ses_abc", "4", "z"), "notified by steering into the session open in its TUI");
    fs::write(e.home().join("opencode-sessions.json"), sessions("ses_old")).unwrap();
    has(&e.send(A, &d, "opencode:ses_abc", "5", "z"), "queued, not delivered yet");
}

#[test]
fn unknown_target_directory_names_the_squad_in_the_notification() {
    let e = Env::new("unknown");
    let d = e.dir("w");
    e.ok(A, &d, &["send", "opencode:ses_abc", "--kind", "notice", "--seq", "1", "--body", "x"]);
    let prompt = fs::read_to_string(e.home().join("opencode-prompt")).unwrap();
    has(&prompt, &format!("peers open {A} --squad {}", d.display()));
}

#[test]
fn reply_hints_tell_the_sender_to_end_its_turn() {
    let e = Env::new("hints");
    let d = e.dir("w");
    let send = |me: &str, extra: &[&str]| {
        let args = [&["send", "opencode:ses_abc", "--seq", "1", "--body", "hi"][..], extra].concat();
        e.ok(me, &d, &args)
    };
    has(&send("opencode:ses_me", &["--kind", "request"]), "steered into this session as a new user turn");
    has(&send("antigravity:66666666-6666-6666-6666-666666666666", &["--kind", "request"]), "Do not sleep, poll");
    has(&send(A, &["--kind", "request"]), "Arm one Monitor watch on `peers watch`");
    has(&send(A, &["--kind", "request", "--reply-to", "opencode:ses_boss"]), "goes to opencode:ses_boss, not to you");
    lacks(&send(A, &["--kind", "ack"]), "REPLY:");
}

#[test]
fn stopped_claude_target_is_resumed_headless_with_the_notification() {
    let e = Env::new("resume");
    let d = e.dir("w");
    e.set_claude_live(&[]);
    e.ok(STOPPED, &d, &["whoami"]);
    let queued = e.send(A, &d, STOPPED, "1", "wake up");
    has(&queued, &format!("queued, not delivered yet: {STOPPED} is not running"));
    assert!(!e.home().join("claude-args").exists(), "a stopped claude ran without --headless");
    // The queued notification reaches it when it next starts with a watch.
    has(&e.watch_line(STOPPED, &d), "You have 1 unread message");
    let sent = e.ok(A, &d, &["send", STOPPED, "--kind", "notice", "--seq", "1", "--body", "wake up", "--headless"]);
    has(&sent, "notified via headless resume pid=");
    wait_for("the headless claude run", 10, || e.home().join("claude-stdin").is_file() && e.home().join("claude-args").is_file());
    let args = fs::read_to_string(e.home().join("claude-args")).unwrap();
    has(&args, "--resume\n99999999-9999-9999-9999-999999999999\n");
    has(&args, "--dangerously-skip-permissions");
    wait_for("the notification on stdin", 10, || fs::read_to_string(e.home().join("claude-stdin")).unwrap().contains("Read it with"));
    lacks(&fs::read_to_string(e.home().join("claude-stdin")).unwrap(), "wake up");
}

#[test]
fn antigravity_headless_runs_one_at_a_time_in_order() {
    let e = Env::new("agy");
    let d = e.dir("w");
    let queued = e.ok(A, &d, &["send", AGY, "--kind", "notice", "--seq", "3", "--body", "not yet"]);
    has(&queued, &format!("queued, not delivered yet: {AGY} is not open in an agy TUI"));
    assert!(!e.home().join("agy-args").exists(), "agy ran without --headless");
    let sent = e.ok(A, &d, &["send", AGY, "--kind", "request", "--seq", "4", "--reply-to", "opencode:ses_boss", "--body", "relay me", "--headless"]);
    has(&sent, &format!("SENT {AGY}: stored in its inbox (2 unread messages); notified via headless resume (queued"));
    // The chat names where the answer goes.
    has(&e.ok(A, &d, &["open", AGY]), "  request seq 4 · answer goes to opencode:ses_boss · not read yet\n  relay me\n");
    wait_for("the first agy run", 20, || fs::read_to_string(e.home().join("agy-timeline")).unwrap_or_default().contains("end"));
    let args = fs::read_to_string(e.home().join("agy-args")).unwrap();
    has(&args, "--dangerously-skip-permissions");
    has(&args, "-p\nNew message from");
    fs::remove_file(e.home().join("agy-timeline")).unwrap();
    for n in 5..=7 {
        e.ok(A, &d, &["send", AGY, "--kind", "notice", "--seq", &n.to_string(), "--body", &format!("n{n}"), "--headless"]);
    }
    wait_for("three agy runs", 30, || {
        fs::read_to_string(e.home().join("agy-timeline")).unwrap_or_default().matches("end").count() == 3
    });
    let timeline = fs::read_to_string(e.home().join("agy-timeline")).unwrap();
    let order: Vec<&str> = timeline.lines().collect();
    assert_eq!(order, ["start", "end", "start", "end", "start", "end"], "runs overlapped:\n{timeline}");
    let queue = e.tmp.join("cache").read_dir().unwrap().next().unwrap().unwrap().path().join("queue/antigravity-33333333-3333-3333-3333-333333333333");
    wait_for("an empty queue", 10, || fs::read_dir(&queue).unwrap().flatten().all(|f| !f.path().to_string_lossy().ends_with(".md")));
}

#[test]
fn antigravity_tui_in_herdr_gets_the_notification_typed_in() {
    let e = Env::new("herdr");
    let d = e.dir("w");
    let agy = e.dir("agy/presence");
    fs::write(agy.join("55555555-5555-5555-5555-555555555555.lock"), "").unwrap();
    let bin = e.tmp.join("bin");
    stub(&bin, "lsof", "echo 4242");
    stub(&bin, "ps", r#"[ "$*" = "-o tty= -p 4242" ] && { cat "$HOME/tui-tty"; exit 0; }
exec /bin/ps "$@""#);
    fs::write(e.home().join("tui-tty"), "ttys901").unwrap();
    stub(
        &bin,
        "herdr",
        r#"case "$*" in
  "session list --json") echo '{"sessions":[{"name":"main","running":true}]}' ;;
  "--session main agent list") echo '{"result":{"agents":[{"agent":"agy","pane_id":"w1:p3"}]}}' ;;
  "--session main pane process-info --pane w1:p3") echo '{"result":{"process_info":{"shell_pid":1,"foreground_processes":[{"pid":4242}]}}}' ;;
  "--session main agent prompt w1:p3 "*)
    [ -f "$HOME/herdr-blocked" ] && { echo '{"error":{"code":"agent_blocked"}}' >&2; exit 1; }
    printf '%s' "${@: -1}" >"$HOME/herdr-prompt" ;;
  *) echo "unexpected herdr call: $*" >&2; exit 9 ;;
esac"#,
    );
    let t = "antigravity:55555555-5555-5555-5555-555555555555";
    has(&e.send(A, &d, t, "11", "to herdr"), "herdr session main pane w1:p3");
    has(&fs::read_to_string(e.home().join("herdr-prompt")).unwrap(), "You have 1 unread message");
    fs::write(e.home().join("herdr-blocked"), "").unwrap();
    let blocked = e.run(A, &d, &["send", t, "--kind", "notice", "--seq", "12", "--body", "x"]);
    has(&blocked.err, "the message is stored");
    has(&blocked.err, "agent_blocked");
    // A TUI outside herdr: queued by default; --headless is refused before anything is stored.
    stub(&bin, "herdr", r#"[ "$*" = "session list --json" ] && { echo '{"sessions":[]}'; exit 0; }
echo "unexpected herdr call: $*" >&2; exit 9"#);
    let queued = e.send(A, &d, t, "8", "waits");
    has(&queued, "outside herdr, where peers cannot type");
    has(&queued, "queued, not delivered yet");
    let refused = e.run(A, &d, &["send", t, "--kind", "notice", "--seq", "9", "--body", "never stored", "--headless"]);
    has(&refused.err, "outside herdr");
    lacks(&e.ok(A, &d, &["open", t]), "never stored");
}

// ---------------------------------------------------------------------------
// Identity: role and name
// ---------------------------------------------------------------------------

#[test]
fn role_and_name_come_from_flags_env_and_peers_json() {
    let e = Env::new("roles");
    let d = e.dir("w");
    let member = e.dir("member/repo/src");
    fs::write(e.tmp.join("member/.peers.json"), r#"{"role": "frontend", "squad": "s", "display_name": "Fia (frontend)"}"#).unwrap();
    e.set_claude_live(&[(B, &d)]);
    e.ok(B, &d, &["chats"]);
    e.send(A, &d, B, "1", "default");
    e.ok(A, &d, &["send", B, "--kind", "notice", "--seq", "2", "--role", "lead", "--name", "Lena\n (lead)", "--body", "flags"]);
    e.run_env(Some(A), &d, &[("PEERS_ROLE", "ops"), ("PEERS_NAME", "Oki")], &["send", B, "--kind", "notice", "--seq", "3", "--body", "env"], None);
    // A member's own directory holds its .peers.json; its session directory keys the database.
    let d_s = d.display().to_string();
    let in_member = |args: &[&str]| {
        let o = e.run_env(Some(A), &member, &[("PEERS_CWD", &d_s)], args, None);
        assert_eq!(o.code, 0, "{}", o.all());
    };
    in_member(&["send", B, "--kind", "notice", "--seq", "4", "--body", "file"]);
    in_member(&["send", B, "--kind", "notice", "--seq", "5", "--role", "user", "--body", "user"]);
    // The notification names the sender with its role once, even when the name holds it.
    let lines = e.watch_lines(B, &d, 5);
    assert_eq!(lines.len(), 5, "expected five notifications, got {lines:?}");
    has(&lines[0], &format!("New message from {A} (unassigned). You have"));
    has(&lines[1], "New message from Lena (lead). You have");
    has(&lines[2], "New message from Oki (ops). You have");
    has(&lines[3], "New message from Fia (frontend). You have");
    let page = e.ok(B, &d, &["open", A]);
    // Each bubble carries the name the message was sent under, and its role when that differs from
    // the CHAT line's and the name does not hold it. Without a name it is "partner"; without a role
    // it names none.
    has(&page, &format!("CHAT with {A} (user)\n"));
    has(&page, "[partner] #1 ");
    has(&page, "  notice seq 1 · new\n  default\n");
    has(&page, "[Lena (lead)] #2 ");
    has(&page, "  notice seq 2 · new\n  flags\n");
    has(&page, "[Oki] #3 ");
    has(&page, "  notice seq 3 · as ops · new\n  env\n");
    has(&page, "[Fia (frontend)] #4 ");
    has(&page, "  notice seq 4 · new\n  file\n");
    has(&page, "[partner] #5 ");
    has(&page, "  notice seq 5 · new\n  user\n");
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

#[test]
fn channel_config_names_this_binary() {
    let e = Env::new("config");
    let d = e.dir("w");
    let out = e.ok(A, &d, &["channel-config"]);
    has(&out, r#""args":["channel"]"#);
    has(&out, env!("CARGO_BIN_EXE_peers"));
}

#[test]
fn channel_pushes_notifications_as_channel_turns() {
    let e = Env::new("channel");
    let d = e.dir("w");
    let me = "claude:44444444-4444-4444-4444-444444444444";
    let mut child = e.command(Some(me), &d, &[], &["channel"]).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let out = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let _ = tx.send(line);
        }
    });
    writeln!(stdin, r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"2025-06-18"}}}}"#).unwrap();
    let init = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    has(&init, r#""claude/channel":{}"#);
    has(&init, "peers open");
    writeln!(stdin, r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#).unwrap();
    let mut sent = String::new();
    wait_for("the channel to listen", 15, || {
        sent = e.send("opencode:ses_sender", &d, me, "7", "ping");
        sent.contains("via channel")
    });
    let note = rx.recv_timeout(Duration::from_secs(10)).unwrap();
    has(&note, "notifications/claude/channel");
    has(&note, "New message from opencode:ses_sender (unassigned).");
    has(&note, r#""from":"opencode:ses_sender""#);
    drop(stdin);
    let _ = child.wait();
    // Once the channel has exited, the session no longer counts as listening.
    e.set_claude_live(&[(me, &d)]);
    has(&e.send("opencode:ses_sender", &d, me, "8", "pong"), "via notification queue");
}

// ---------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------

#[test]
fn pi_session_is_found_listed_and_shown() {
    let e = Env::new("pi-show");
    let d = e.dir("w");
    e.save_pi_session(&d);
    let id = PI.trim_start_matches("pi:");
    let who = e.run_env(None, &d, &[("PI_SESSION_ID", id)], &["whoami"], None);
    assert_eq!(who.out.trim(), PI, "{}", who.all());
    let list = e.ok(A, &d, &["list"]);
    has(&list, &format!("{PI}  kind=session  status=saved  name=\"debater\""));
    let shown = e.ok(A, &d, &["show", PI]);
    has(&shown, "user: hello pi\nassistant: hi there\n");
    // The session's directory decides its squad, so a sender elsewhere names its own squad.
    let other = e.dir("elsewhere");
    let sent = e.ok(A, &other, &["send", PI, "--kind", "notice", "--seq", "1", "--body", "hi", "--headless"]);
    has(&sent, "notified via headless resume");
    wait_for("the headless pi run", 20, || e.home().join("pi-args").is_file());
}

#[test]
fn pi_without_a_listener_runs_headless_one_at_a_time_in_order() {
    let e = Env::new("pi-headless");
    let d = e.dir("w");
    let file = e.save_pi_session(&d);
    let queued = e.ok(A, &d, &["send", PI, "--kind", "notice", "--seq", "0", "--body", "not yet"]);
    has(&queued, &format!("queued, not delivered yet: {PI} has no peers extension listening"));
    let sent = e.ok(A, &d, &["send", PI, "--kind", "request", "--seq", "1", "--body", "debate me", "--headless"]);
    has(&sent, &format!("SENT {PI}: stored in its inbox (2 unread messages); notified via headless resume (no peers extension"));
    wait_for("the first pi run", 20, || fs::read_to_string(e.home().join("pi-timeline")).unwrap_or_default().contains("end"));
    let args = fs::read_to_string(e.home().join("pi-args")).unwrap();
    has(&args, &format!("--session\n{}\n--mode\njson\n--\nNew message from", file.display()));
    lacks(&args, "debate me");
    assert_eq!(fs::read_to_string(e.home().join("pi-cwd")).unwrap().trim(), d.display().to_string());
    has(&fs::read_to_string(e.home().join("pi-env")).unwrap(), "PEERS_PI_HEADLESS=1");
    fs::remove_file(e.home().join("pi-timeline")).unwrap();
    for n in 2..=4 {
        e.ok(A, &d, &["send", PI, "--kind", "notice", "--seq", &n.to_string(), "--body", &format!("n{n}"), "--headless"]);
    }
    wait_for("three pi runs", 30, || fs::read_to_string(e.home().join("pi-timeline")).unwrap_or_default().matches("end").count() == 3);
    let timeline = fs::read_to_string(e.home().join("pi-timeline")).unwrap();
    assert_eq!(timeline.lines().collect::<Vec<_>>(), ["start", "end", "start", "end", "start", "end"], "runs overlapped:\n{timeline}");
}

#[test]
fn pi_listener_gets_notifications_and_releases_on_stdin_close() {
    let e = Env::new("pi-listen");
    let d = e.dir("w");
    e.save_pi_session(&d);
    let mut child = e
        .command(None, &d, &[], &["_pi-listen", PI, "--cwd", &d.display().to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_for("the listener to register", 10, || e.ok(A, &d, &["list"]).contains("status=listening"));
    let sent = e.ok(A, &d, &["send", PI, "--kind", "request", "--seq", "1", "--body", "debate me"]);
    has(&sent, "notified via the peers pi extension");
    let lines = read_lines(&mut child, 1, Duration::from_secs(10));
    has(&lines.join(""), &format!("Read it with: peers open {A}"));
    // The pi session's own reply hint names the extension.
    let reply = e.ok(PI, &d, &["send", A, "--kind", "completion", "--seq", "1", "--body", "done"]);
    has(&reply, "through the peers extension");
    drop(child.stdin.take());
    let status = child.wait().unwrap();
    assert!(status.success());
    // Released: the next notification waits for the next listener, and it gets it on start.
    has(&e.ok(A, &d, &["send", PI, "--kind", "notice", "--seq", "2", "--body", "x"]), "queued, not delivered yet");
    let mut again = e
        .command(None, &d, &[], &["_pi-listen", PI, "--cwd", &d.display().to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    has(&read_lines(&mut again, 1, Duration::from_secs(10)).join(""), "Read it with");
    drop(again.stdin.take());
    let _ = again.wait();
}

#[test]
fn pi_extension_is_printed_and_rejects_other_runtimes() {
    let e = Env::new("pi-ext");
    let d = e.dir("w");
    let ext = e.ok(A, &d, &["pi-extension"]);
    has(&ext, "_pi-listen");
    has(&ext, "deliverAs: \"steer\"");
    // --path writes the same extension to the cache, once, and prints where.
    let path = e.ok(A, &d, &["pi-extension", "--path"]);
    let file = std::path::PathBuf::from(path.trim());
    assert!(file.starts_with(e.tmp.join("cache")), "{}", file.display());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), ext);
    let written = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(Duration::from_millis(20));
    assert_eq!(e.ok(A, &d, &["pi-extension", "--path"]), path);
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), written);
    let o = e.run(A, &d, &["_pi-listen", A]);
    assert_eq!(o.code, 2);
    has(&o.all(), "serves pi sessions only");
}
