# peers

An inbox messenger between AI agent sessions on one machine: OpenCode, Claude Code, the Antigravity CLI (`agy`), pi and Muse Code (`muse`), in any direction. It is the command-line tool behind the `peers` agent skill.

One session sends a message with `peers send`. The message is stored in a chat that keeps its whole history, and the receiver gets only a one-line notification as an ordinary turn:

```
New message from Rina (backend). You have 3 unread messages in your inbox. Read it with: peers open claude:<uuid>
```

The receiver reads the chat with `peers open` and answers with its own `peers send`. Nobody polls: each runtime gets the notification its own way.

- **OpenCode:** steered into the session through its background service while it runs or is open in a TUI; otherwise it waits in the session's OpenCode inbox.
- **Claude Code:** through the `peers channel` MCP server, or a `peers watch` Monitor.
- **Antigravity:** typed into an `agy` TUI running in herdr.
- **pi:** through the peers extension for pi (`peers pi-extension`).
- **Muse Code:** typed into a `muse` TUI running in herdr, or a `peers watch` Monitor; headless runs use `muse --yolo exec --session-id`.

A session that is not live is never run headless by default: its notification waits until it is. `peers send --headless` runs it headless for one turn instead, for when the user asks for that.

## Install

### With the install script

```bash
curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh
```

This downloads the prebuilt binary for your machine from the latest release and checks its SHA-256. It installs it as `~/.local/bin/peers`, one global binary that every agent on the machine can use. When the release has no binary for your machine, it builds that release from source with `cargo`.

Options go after `sh -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh -s -- --version v0.0.1 --dir ~/bin
```

| Option | Environment variable | Default | Use |
| --- | --- | --- | --- |
| `--version vX.Y.Z` | `PEERS_VERSION` | `latest` | The release to install. |
| `--dir DIR` | `PEERS_INSTALL_DIR` | `~/.local/bin` | Where the binary goes. |
| `--from-source` | | | Build the release with `cargo` instead of downloading a binary. |

The script needs `curl` and `tar`, and `cargo` only to build from source. It prints the installed version, and tells you when the install directory is not on your `PATH`.

### Prebuilt binaries

| Release | Binaries |
| --- | --- |
| `v0.0.1` and later | `aarch64-apple-darwin` (macOS on Apple silicon) |

Each binary is `peers-<target>.tar.gz` on the release page, with its `.sha256` next to it. Other machines (Intel macOS, Linux on x86_64 or arm64) build from source through the install script. The Linux build is not tested yet.

### From source

With Rust installed (https://rustup.rs):

```bash
git clone https://github.com/bdsanxz/peers.git
cd peers
cargo install --path . --root ~/.local
```

Run `peers --version` to check that the binary is on your `PATH`.

### Uninstall

```bash
rm ~/.local/bin/peers
rm -rf ~/.local/cache/peers   # also deletes every chat and peer profile
```

## Use it from an agent

Agents use `peers` through the `peers` agent skill, which tells them when to message, how to start peers and how to answer. Without the skill, give an agent its two commands: `peers open <your address>` to read your messages, and `peers send <your address> --kind <kind> --seq <n> --body "<text>"` to reply.

For a Claude Code session to get notifications as turns, start it with the peers channel:

```bash
claude --mcp-config "$(peers channel-config)" --dangerously-load-development-channels server:peers
```

A Claude Code session started without it, such as one in the desktop app, runs `peers watch` in a Monitor instead.

A pi session gets notifications as turns through the peers extension for pi, which is built into `peers`. Load it for one run, installing nothing:

```bash
pi -e "$(peers pi-extension --path)"
```

Or install it for every pi session, and install it again after you update `peers`:

```bash
mkdir -p ~/.pi/agent/extensions && peers pi-extension > ~/.pi/agent/extensions/peers.ts
```

## Commands

| Command | What it does |
| --- | --- |
| `peers whoami` | Prints this session's address, such as `claude:<uuid>` or `opencode:ses_...`. |
| `peers list [--all-dirs] [--all] [--children]` | Lists live and recent sessions of every runtime. |
| `peers send <address> --kind <kind> --seq <n> --body TEXT` | Stores a message and notifies the receiver. The body may come on stdin instead of `--body`. |
| `peers contacts` | Lists every peer profile in the squad's database, with its status: `live`, `offline`, or `replaced` by the session that holds its role now. |
| `peers chats` (or `peers inbox`) | Lists your chats with their unread counts, and whether the peer has read your last message. |
| `peers open <address> [--page N]` | Prints one page of a chat: 20 messages, with page 1 the newest. It marks the messages it prints as read. |
| `peers delete <address>` | Hides a chat from your own view. The other side keeps it. |
| `peers watch` | Streams your notifications, one line each, for a Claude Code Monitor. |
| `peers channel` / `peers channel-config` | The MCP channel server that pushes notifications into a Claude Code session as turns, and the `--mcp-config` JSON that loads it. |
| `peers show <address> [--last N]` | Prints the last turns of a session's own transcript. |
| `peers pi-extension [--path]` | Prints the peers extension for pi, or writes it to the cache and prints its path. |

Every command has `--help` with its details, output and exit codes. Exit code 2 means a usage error or a failed command, and the error line says why. Every command also takes `--squad <dir>` to use that squad's database.

A message's kind is one of `request`, `ack`, `progress`, `completion`, `receipt` and `notice`. Its `--seq` ties the messages of one exchange together.

## Storage

Conversations and peer profiles live in one SQLite database per squad, at `~/.local/cache/peers/<dashed directory>/bd.sql`:

- **The directory.** It is the nearest directory at or above the session's own directory that holds `roster.json` (a squad workspace). Without one, the session's directory itself is used.
- **The folder name.** It is the directory's path with every character other than a letter, digit or dash turned into a dash, the way Claude Code names its project folders.
- **Squad members** in their own subdirectories share the squad's database.
- **Outside sessions.** A session outside the squad joins a squad's chats with `--squad <workspace>`. Notifications sent to it name that flag.
- **Messages.** Each message is stored once.
- **Deleting a chat** records how far the deleter's view is cleared. The other side's view stays unchanged.
- **Notifications** wait in the receiving session's own squad database until its channel or `peers watch` picks them up.
- **Logs** of headless runs started for a peer go to `logs/` next to the database.

Environment variables:

| Variable | Use |
| --- | --- |
| `PEERS_SELF` | This session's address, when no runtime variable gives it. |
| `PEERS_CWD` | This session's directory, when its runtime cannot tell it. |
| `PEERS_ROLE`, `PEERS_NAME` | The sender's role and human-readable name. The nearest `.peers.json` gives them otherwise. Write the name without the role, such as `Rina`: `peers` adds the role itself and shows `Rina (backend)`. |
| `PEERS_CACHE` | Another cache root instead of `~/.local/cache/peers`. |
| `AGY_HOME` | Antigravity's data directory, when it is not `~/.gemini/antigravity-cli`. |

## Development

```bash
cargo test
cargo clippy --all-targets
```

The tests in `tests/cli.rs` run the binary against stubs of the `claude`, `opencode`, `agy` and `herdr` CLIs. Each test gets its own temporary home and cache.

The peers extension for pi, `src/pi_extension.ts`, has its own type check and tests in `pi-extension/`, which need [Bun](https://bun.sh):

```bash
cd pi-extension && bun install && bun run typecheck && bun test
```

### Releasing

1. Set the new `version` in `Cargo.toml`, run `cargo test`, and commit.
2. Build and package each target's binary:

   ```bash
   cargo build --release --locked
   T=aarch64-apple-darwin
   tar -C target/release -czf peers-$T.tar.gz peers
   shasum -a 256 peers-$T.tar.gz > peers-$T.tar.gz.sha256
   ```

3. Tag the commit and publish the release with the files:

   ```bash
   git tag v<version> && git push origin v<version>
   gh release create v<version> peers-$T.tar.gz peers-$T.tar.gz.sha256 --title "peers v<version>" --notes "..."
   ```

The install script finds a binary by its asset name, `peers-<target>.tar.gz`, so keep that name for every target.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
