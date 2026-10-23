//! Small helpers shared by every module: errors, processes, paths and time.

use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Every failure is a message the agent can act on; main prints it and exits 2.
pub type Res<T> = Result<T, String>;

pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn local_time(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| ms.to_string())
}

pub fn stamp() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S-%6f").to_string()
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

pub fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

pub fn process_cwd() -> PathBuf {
    canonical(&std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")))
}

/// Absolute path of this binary, for configs that start it without a PATH lookup.
pub fn exe() -> String {
    std::env::current_exe()
        .map(|p| canonical(&p).display().to_string())
        .unwrap_or_else(|_| "peers".into())
}

/// Quotes a word for a shell command line only when it needs it.
pub fn shell_word(s: &str) -> String {
    let plain = !s.is_empty()
        && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@%+=,".contains(c));
    if plain {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

pub fn which(prog: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let executable = |p: &Path| {
        p.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    };
    if prog.contains('/') {
        let p = PathBuf::from(prog);
        return executable(&p).then_some(p);
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(prog)).find(|p| executable(p))
}

/// Runs a command to completion with a timeout, capturing stdout and stderr.
pub fn capture(prog: &str, args: &[&str], timeout: Duration) -> Res<Output> {
    let line = format!("{prog} {}", args.join(" "));
    let mut child = Command::new(prog)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run {line}: {e}"))?;
    let mut out = child.stdout.take().expect("piped stdout");
    let mut err = child.stderr.take().expect("piped stderr");
    let out_reader = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let err_reader = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| format!("{line}: {e}"))? {
            break s;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("timed out after {}s: {line}", timeout.as_secs()));
        }
        thread::sleep(Duration::from_millis(20));
    };
    Ok(Output {
        status,
        stdout: out_reader.join().unwrap_or_default(),
        stderr: err_reader.join().unwrap_or_default(),
    })
}

/// Stdout of a command, trimmed; empty when it cannot run. For probes such as ps and lsof.
pub fn quiet(prog: &str, args: &[&str]) -> String {
    Command::new(prog)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// Runs a runtime CLI that prints JSON. Ok(None) when the CLI is not on PATH.
pub fn run_json(prog: &str, args: &[&str]) -> Res<Option<serde_json::Value>> {
    if which(prog).is_none() {
        return Ok(None);
    }
    let line = format!("{prog} {}", args.join(" "));
    let out = capture(prog, args, Duration::from_secs(60))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        return Err(format!("{line} failed (exit {}): {msg}", out.status.code().unwrap_or(-1)));
    }
    serde_json::from_slice(&out.stdout).map(Some).map_err(|_| {
        format!("{line} did not print JSON: {}", truncate(&String::from_utf8_lossy(&out.stdout), 300))
    })
}

pub fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

pub fn process_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    // SAFETY: kill with signal 0 only checks that the process exists.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// An exclusive advisory lock on a file, released on drop.
pub struct Flock(File);

impl Drop for Flock {
    fn drop(&mut self) {
        // SAFETY: the descriptor belongs to the open file this guard owns.
        unsafe { libc::flock(self.0.as_raw_fd(), libc::LOCK_UN) };
    }
}

/// Takes the lock, waiting for it; with `try_only`, returns None when another process holds it.
pub fn flock(path: &Path, try_only: bool) -> Res<Option<Flock>> {
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path)
        .map_err(|e| format!("cannot open lock {}: {e}", path.display()))?;
    let op = libc::LOCK_EX | if try_only { libc::LOCK_NB } else { 0 };
    // SAFETY: flock on a descriptor we own.
    if unsafe { libc::flock(f.as_raw_fd(), op) } == 0 {
        return Ok(Some(Flock(f)));
    }
    let e = std::io::Error::last_os_error();
    if try_only && e.raw_os_error() == Some(libc::EWOULDBLOCK) {
        Ok(None)
    } else {
        Err(format!("cannot lock {}: {e}", path.display()))
    }
}
