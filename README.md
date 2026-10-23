# peers

An inbox messenger between agent sessions on one machine: OpenCode, Claude Code and the Antigravity CLI (`agy`), in any direction. It is the command-line tool behind the `peers` agent skill.

A session sends a message with `peers send`. The message is stored, and the receiver gets only a one-line notification:

```
New message from Rina (backend) (backend). You have 3 unread messages in your inbox. Read it with: peers open claude:<uuid>
```

The receiver reads the chat with `peers open`. Each chat keeps its full history, like a messaging app.

## Install

```bash
cargo install --path . --root ~/.local
```

This puts one global binary at `~/.local/bin/peers` that every agent on the machine can use. Run `peers --version` to check it is on `PATH`.

## Commands

| Command | What it does |
| --- | --- |
| `peers whoami` | Prints this session's address, such as `claude:<uuid>` or `opencode:ses_...`. |
| `peers list [--all-dirs] [--all] [--children]` | Lists live and recent sessions of every runtime. |
| `peers send <address> --kind <kind> --seq <n> [--body TEXT]` | Stores a message and notifies the receiver. |
| `peers contacts` | Lists every peer profile in the squad's database. |
| `peers chats` (or `peers inbox`) | Lists your chats with their unread counts, and whether the peer has read your last message. |
| `peers open <address> [--page N]` | Prints one page of a chat: 20 messages, with page 1 the newest. It marks the messages it prints as read. |
| `peers delete <address>` | Hides a chat from your own view. The other side keeps it. |
| `peers watch` | Streams your notifications, one line each, for a Claude Code Monitor. |
| `peers channel` / `peers channel-config` | The MCP channel server that pushes notifications into a Claude Code session as turns, and the `--mcp-config` JSON that loads it. |
| `peers show <address> [--last N]` | Prints the last turns of a session's own transcript. |

Every command has `--help` with its details, output and exit codes. Exit code 2 means a usage error or a failed command, and the error line says why.

## Storage

Conversations and peer profiles live in one SQLite database per squad, at `~/.local/cache/peers/<dashed directory>/bd.sql`:

- **The directory.** This is the nearest directory at or above the session's own directory that holds `roster.json` (the squad workspace). Without one, the session directory itself is used.
- **The folder name.** It is the directory path with every character other than a letter, digit or dash turned into a dash, the way Claude Code names its project folders.
- **Squad members.** Members in their own subdirectories share the squad's database.
- **Outside sessions.** A session outside the squad joins a squad's chats with `--squad <workspace>`. Notifications sent to it name that flag.
- **Messages.** Each message is stored once.
- **Deleting a chat.** It records how far the deleter's view is cleared. The other side's view stays unchanged.
- **Notifications.** A session's notifications wait in its own squad's database, for its channel or `peers watch` to pick up.

Environment variables:

| Variable | Use |
| --- | --- |
| `PEERS_SELF` | This session's address, when no runtime variable gives it. |
| `PEERS_CWD` | This session's directory, when its runtime cannot tell it. |
| `PEERS_ROLE`, `PEERS_NAME` | The sender's role and human-readable name. The nearest `.peers.json` gives them otherwise. |
| `PEERS_CACHE` | Another cache root instead of `~/.local/cache/peers`. |
| `AGY_HOME` | Antigravity's data directory, when it is not `~/.gemini/antigravity-cli`. |

## Development

```bash
cargo test
cargo clippy --all-targets
```

The tests in `tests/cli.rs` run the binary against stubs of the `claude`, `opencode`, `agy` and `herdr` CLIs, each test in its own temporary home and cache.
