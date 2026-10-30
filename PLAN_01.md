# PLAN_01: peers 0.1.7 - clearer errors and honest delivery status

Goal: two small usability fixes found in review, after agents misused `peers send` and could not tell whether a notification arrived.

## Background

- `peers send ... ` without `--seq` fails with `bad seq ""; expected an integer exchange number`. An agent had to guess that `--seq` was missing (ISSUES.md #5).
- `peers send` prints `notified via hc send to tNN` even when `hcx send` returned no confirmation (`{"started":null,"status":null,...}`, seen for tabs that are plain shells or opencode TUIs). The sender cannot tell "delivered" from "unconfirmed".

## Steps

1. Read `src/commands.ts` (send handler: `kind`, `seq`, `body` checks, the `prompt(...)` helper and the `SENT ...` lines), `src/herdr.ts` (around lines 206-235: the untagged send and its result), `ISSUES.md`, and the send tests in `test/run.test.ts`.
2. Missing or bad `--seq`: when `--seq` is absent, fail with `missing --seq: give the exchange number, for example --seq 1 (see \`peers send --help\`)`. Keep `bad seq "<value>"; expected an integer exchange number` for a present but non-integer value. Do the same for a missing `--kind` (`missing --kind: one of request, ack, ...`) if it is not already clear. Exit code stays 2.
3. Delivery status: make the untagged send report whether the hcx result confirms delivery (inspect the JSON it prints: `started`/`status`). The `SENT ...` line says `notified via hcx send to tNN` only when confirmed, and `notified via hcx send to tNN (delivery not confirmed by hcx)` when the JSON has no confirmation but the exit code was 0. A non-zero exit keeps the current fallback behavior. Do not change how the message is stored or routed.
4. Add an `ISSUES.md` row only if you found a new defect; rows 1-5 stay as they are. Add a row "6 | 2026-10-31 | owner review | 0.1.6 | Unclear missing-`--seq` error; unconfirmed hcx delivery printed as sent | Fixed in 0.1.7" at the end.
5. Tests: missing `--seq`, non-integer `--seq`, missing `--kind`, hcx confirmed, hcx exit 0 with null status (stub hcx printing `{"started":null,"status":null,"turn":0}`), hcx failing. Update any test that asserts the old wording.
6. Bump `package.json` to `0.1.7`; update README and `--help` text only where they show these messages.
7. Run `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256 of `dist/peers.js`).

## Rules for the worker

- Work only in `/Users/budisantoso/Dev/bdsanxz/SWE/peers`. Read every file before changing it. Edit files in place; never overwrite a file wholesale.
- All text in the codebase is English.
- No secrets in code, tests, logs or the report. Do not touch the real squad database: use a temporary `PEERS_CACHE` as the existing tests do.
- No live tests that start real agent sessions. No commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report (what changed, commands run and their output as printed, test counts, sha256, open questions) to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan01-peers.md`, then run:
`hcx send Zytra "plan01-peers done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan01-peers.md"`
