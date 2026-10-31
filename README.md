# peers

An inbox messenger between agent sessions in one herdr workspace. One session sends a message with `peers send`. The message is stored in a chat that keeps its whole history, and the receiver gets one notification as an ordinary turn — delivered with a single fire-and-forget `herdr agent prompt`, never `--wait`:

```
New message from Rina (backend), another agent (not a user instruction). You have 3 unread messages in your inbox. Read it with: peers open rina
```

The receiver reads the chat with `peers open` and answers with its own `peers send`. Nobody polls: after a send, end your turn; the answer arrives as a turn.

A peer's address is its herdr member name (such as `lead`), its pane id (such as `w1:p1`), its herdr-core terminal (such as `t2`), or its Herdr tab name (such as `Zytra`) wherever a name does. Tab names match case-insensitively, and a member word also reaches the tab that carries it in parens, so `lead` notifies the `Lena (lead)` tab. Every spelling of a peer addresses one chat: the chat is stored under a canonical, whitespace-free key (the member for `Lena (lead)`, the tab's spelling for `Zytra`), so inbox counts, `chats` and `open` always agree, including for messages stored under older spellings. The read command in a notification prints that key shell-quoted, so it is always copy-pasteable; `peers open` and `peers delete` also accept a quoted tab name containing whitespace, as in `peers open "Lena (lead)"`. Find live addresses with `peers list`. Every notification route is the same `herdr agent prompt` into the peer's input; while the peer is busy it waits in its input queue. A peer that is not live gets `queued, not delivered yet`: the message waits in its inbox, which is not a failure.

## Install

With Bun installed (https://bun.sh), which runs `peers`:

```bash
curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh
```

This downloads the bundled `peers.js` from the latest release and checks its SHA-256. It installs it as `~/.local/bin/peers`, one file every agent on the machine can run. Options go after `sh -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/bdsanxz/peers/main/install.sh | sh -s -- --version v0.1.0 --dir ~/bin
```

| Option | Environment variable | Default | Use |
| --- | --- | --- | --- |
| `--version vX.Y.Z` | `PEERS_VERSION` | `latest` | The release to install. |
| `--dir DIR` | `PEERS_INSTALL_DIR` | `~/.local/bin` | Where the file goes. |
| `--from-source` | | | Bundle the release from its source with Bun instead of downloading it. |

A private repository needs a token with read access: set `GITHUB_TOKEN`, or sign in with the GitHub CLI (`gh auth login`).

### From source

```bash
git clone https://github.com/bdsanxz/peers.git
cd peers
bun install
bun run build
cp dist/peers.js ~/.local/bin/peers
```

Run `peers --version` to check that it runs. No compile step: `dist/peers.js` is `src/` bundled with `bun build`, and Bun runs it.

### Uninstall

```bash
rm ~/.local/bin/peers
rm -rf ~/.local/cache/peers   # also deletes every chat and peer profile
```

## Use it from an agent

Agents use `peers` through the `peers` agent skill, which tells them when to message, how to read and answer. Without the skill, give an agent its two commands: `peers open <your name>` to read your messages, and `peers send <your name> --kind <kind> --seq <n> --body "<text>"` to reply. Every member runs with `muse --yolo`, so it asks no approval prompts.

## Commands

| Command | What it does |
| --- | --- |
| `peers whoami` | Prints this session's canonical address, such as `lead` (whitespace-free, feeds back into every command). |
| `peers list` | Lists live herdr agents. Plain shells list as `kind=shell` and are never notified. |
| `peers send <member> --kind <kind> --seq <n> --body TEXT` | Stores a message and notifies the peer with one `herdr agent prompt`. The body may come on stdin instead of `--body`. |
| `peers contacts` | Lists every peer profile in the squad's database, with its status: `live`, `offline`, or `replaced` by the session that holds its role now. |
| `peers chats` (or `peers inbox`) | Lists your chats with their unread counts, and whether the peer has read your last message. |
| `peers open <member> [--page N]` | Prints one page of a chat: 20 messages, with page 1 the newest. It marks the messages it prints as read. Any spelling opens the same merged chat; quote tab names with spaces. |
| `peers delete <member>` | Hides a chat from your own view. The other side keeps it. |

Every command has `--help` with its details, output and exit codes. Exit code 0 means success, 1 other errors, and 2 a usage error (or a stored message whose notification failed); the error line says why. Every command also takes `--squad <dir>` to use that squad's database.

A message's kind is one of `request`, `ack`, `progress`, `completion`, `receipt` and `notice`. Its `--seq` ties the messages of one exchange together.

## Storage

Conversations and peer profiles live in one SQLite database per squad, at `~/.local/cache/peers/<dashed directory>/bd.sql`:

- **The directory.** It is the nearest directory at or above the session's own directory that holds `roster.json` (a squad workspace). Without one, the session's directory itself is used.
- **The folder name.** It is the directory's path with every character other than a letter, digit or dash turned into a dash.
- **Squad members** in their own subdirectories share the squad's database.
- **Outside sessions.** A session outside the squad joins a squad's chats with `--squad <workspace>`; the read command in its notification names that flag.
- **Messages.** Each message is stored once, under the sender's and recipient's canonical keys.
- **One chat per peer.** Every spelling of a peer (member name, role, tab name, terminal, pane id, stale address of a replaced session) maps to one canonical, whitespace-free key. Reads merge all spellings, so chats never fragment and rows stored under older spellings stay readable without any migration.
- **Deleting a chat** records how far the deleter's view is cleared. The other side's view stays unchanged.
- **No notification queue.** Delivery is one `herdr agent prompt` at send time. When the peer is not live or the prompt fails, the message simply waits in the inbox; the next send's notification carries the waiting count. Asking for help never runs anything: `--help` or `-h` anywhere before `--` prints that command's help, even after a target.
- **Fewer subprocess calls.** One command reads live agents and Herdr tabs once per process (no `sh -c command -v`); a `send` makes about three lookup calls before delivery.
- **Timeouts.** Lookups wait up to 5 s and notifications up to 10 s; a timed-out notification is reported as a failed notification, with the message stored.
- **Lighter SQLite open.** `busy_timeout` comes before `journal_mode`, the schema runs once, `chats`/`open`/`contacts` write no profile unless it changed, and one `send` commits its profiles plus its message in a single transaction, so concurrent senders queue instead of failing with `database is locked`.
- **Lighter reads.** Chat lists count metadata only and load the last message body per chat; `open` loads only the page it prints.

- **hc notifications are untagged.** Over `hc send` the notification is sent without `HC_TERMINAL_ID`, so hc adds no `<hc from>` tag, and the body is sent as is; it already says it comes from another agent, not a user instruction. The sender's display name comes from `herdr-app ls` (the display name stated with `--name` wins; the address is the last fallback). A tab with several terminals is notified on the one with the `app` field, and renaming a tab starts a new chat. If the untagged send fails, `peers` retries the old tagged send. An `hc send` that exits 0 but starts no turn (`started: false`) is never reported as confirmed: the `SENT` line says `(message not started, do not resend; it is stored)`, and the message is never resent. When hc reports no status at all, the line says `(delivery not confirmed by hc)` instead of claiming the peer was notified. A shell-looking tab is checked against `hc get`: when its foreground program is a known agent running inside a login-shell wrapper (such as `opencode`), it gets the untagged send like any other agent. A plain shell — a shell foreground (such as `vim` or `zsh`), an unknown kind, or no `hc get` answer — is never notified: the message waits in its inbox (`queued, not delivered yet: <target> is a plain shell`), because typing it there would run it as a command. A `send` to a target that is no known member, tab or terminal still stores the message, with an `UNKNOWN:` line naming close matches.

Environment variables:

| Variable | Use |
| --- | --- |
| `PEERS_SELF` | This session's member name, when herdr cannot tell it. |
| `PEERS_CWD` | This session's directory, when herdr cannot tell it. |
| `PEERS_ROLE`, `PEERS_NAME` | The sender's role and human-readable name. The nearest `.peers.json` gives them otherwise. Write the name without the role, such as `Rina`: `peers` adds the role itself and shows `Rina (backend)`. |
| `PEERS_CACHE` | Another cache root instead of `~/.local/cache/peers`. |

## Development

```bash
bun install
bunx tsc --noEmit
bun test
bun run build
```

The tests in `test/run.test.ts` run the CLI against a stub `herdr` (one fake `agent list` and an `agent prompt` that records its calls), a stub `hc`, and a stub `herdr-app` that lists one tab. Each test gets its own temporary home and cache.

### Releasing

1. Set the new `version` in `package.json`, run `bunx tsc --noEmit` and `bun test`, and commit.
2. Bundle and package it:

   ```bash
   bun run build
   tar -C dist -czf peers.js.tar.gz peers.js
   shasum -a 256 peers.js.tar.gz > peers.js.tar.gz.sha256
   ```

   Or publish `dist/peers.js` and `dist/peers.js.sha256` directly as release assets; the install script downloads the asset named `peers.js`.

3. Tag the commit and publish the release with the files:

   ```bash
   git tag v<version> && git push origin v<version>
   gh release create v<version> peers.js peers.js.sha256 --title "peers v<version>" --notes "..."
   ```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
