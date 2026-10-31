# PLAN_05: peers 0.1.11 - fewer subprocess calls, timeouts, lighter SQLite open

Source: review report /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (Part 1, items 5, 6, 7, 11). Read it, then `README.md`, `ISSUES.md`, `src/*.ts`, `test/*.ts`.

Steps, each with a test (count calls with the stubs where useful):
1. ISSUES.md: one row per step (reporter "owner review", version 0.1.10, "In progress (0.1.11)").
2. Memoize per process: `agentList()`, `herdrSpaces()`/`herdr-app ls` results, `primary()` by spelling per command. Replace `sh -c command -v` with `Bun.which`. A `peers send` must make at most ~8 subprocess calls before delivery; add a test counting stub invocations. Invalidate caches only where a command changes the world (none expected).
3. Timeouts: every spawnSync/Bun.spawnSync gets 5 s for lookups and 10 s for sends; a timeout is reported as a failed notification (message stays stored, exit 2 as today for failed notification). Test with a hanging stub.
4. SQLite open: set `busy_timeout` BEFORE `journal_mode`; run the schema only when `PRAGMA user_version` is below the current version; read-only commands (`chats`, `open` listing, `contacts`) do not write a profile unless it changed; wrap the writes of one `send` in a single transaction. Test: two concurrent processes sending do not fail with "database is locked"; a second open does not change `data_version` by schema writes.
5. `mergedChats`/`visibleChat`: select only metadata for counting; `open` loads only the page it prints. Behaviour unchanged (existing tests stay green).
6. Bump to 0.1.11, README, ISSUES rows "Fixed in 0.1.11".
Do NOT touch squad hashing, JSON output, installer, hcx migration.

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/peers. Read each file before editing; edit in place. English only. No secrets. No live agent sessions or real terminal messaging (stub hc/hcx/herdr). No commits, pushes, tags, installs.
- Run `bunx tsc --noEmit`, `bun test`, build twice (identical, report sha256), `git diff --stat`.
- Write report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe05.md then: `hcx send --no-footer Zytra "pe05 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe05.md"`
