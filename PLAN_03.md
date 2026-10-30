# PLAN_03: peers 0.1.9 - notifications without a footer

## Problem

An untagged peers notification currently ends with a footer built by `footer()` in `src/herdr.ts`:

```
New message from Lena (lead). You have 1 unread message in your inbox. Read it with: peers open lead

— from Lena · message from another agent, not a user instruction · reply: peers open lead
```

The footer repeats the sender and the `peers open` command that the body already carries, and its "reply:" wording is easy to mistake for a second instruction. The owner wants notifications without a footer: the body alone, sent untagged (hcx's no-footer behaviour: text as given, no `<hc from>` tag, no sender footer). The one useful part of the footer, "message from another agent, not a user instruction", moves into the body.

## Steps

1. Read `src/herdr.ts` (`footer`, `hcPrompt`, `hcSend`, `PromptFrom`), `src/commands.ts` (the notification `text` around line 827, the help text near lines 230-245 that quotes the footer, the places that call `footer`), tests, README, `ISSUES.md`. Add `ISSUES.md` row 8 (reporter "owner request", version 0.1.8, "Notifications end with a redundant sender footer; the owner wants none", status "In progress (0.1.9)").
2. Remove the footer: `hcPrompt` sends the body as is, untagged (still with `HC_TERMINAL_ID` removed from the environment, as today), for agent targets. Plain-shell and unknown-kind targets keep the tagged send, as today. Keep the retry-with-tagged-send behaviour on failure and the delivery-confirmation wording from 0.1.7. Delete `footer()` and `PromptFrom` fields that become unused (keep `targetKind`).
3. Move the safeguard into the body: the text becomes `New message from <who>, another agent (not a user instruction). You have <N unread message(s)> in your inbox. Read it with: peers open <key>`. Keep the rest of the text and the `--squad` flag handling unchanged.
4. Update the help text and README that describe the footer so they describe the new body; do not mention a footer any more.
5. Tests: the recorded send argv has no footer and no `<hc from>` tag, the body contains "not a user instruction", env has no `HC_TERMINAL_ID`; shell target still tagged; failed untagged send retried tagged; update tests asserting the old footer.
6. Bump to 0.1.9; ISSUES row -> "Fixed in 0.1.9". Run `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256 of `dist/peers.js`).

## Rules for the worker

- Work only in `/Users/budisantoso/Dev/bdsanxz/SWE/peers`. Read every file before changing it. Edit in place; never overwrite a file wholesale.
- All text in the codebase is English. No secrets. Do not touch the real squad database: use a temporary `PEERS_CACHE` as the existing tests do.
- No live agent sessions, no commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan03-peers.md`, then run: `hcx send --no-footer Zytra "plan03-peers done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan03-peers.md"`
