# PLAN_06: peers 0.2.0 - notify through hcx 0.3.0

Source: review /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (Part 3). Read it, then README.md, ISSUES.md, src/herdr.ts, src/commands.ts, test/run.test.ts.

## The hcx 0.3.0 contract to use (read /Users/budisantoso/Dev/bdsanxz/SWE/hcx/README.md and /Users/budisantoso/Dev/bdsanxz/SWE/hcx/src/send.ts, lib.ts, passthrough.ts first)
- Send with argv, no shell: `hcx send --agent-only --no-footer --json <address> "<text>"`. hcx looks the kind up first and refuses a plain shell or unknown kind BEFORE sending (error JSON on stderr/stdout in hc's shape `{"error":{"kind","message","hint"}}`, kind `plain_shell`, exit 4). Success prints hc's JSON plus `delivered` (true / false / null), `route`, `agent`, `note`.
- Map the result: `delivered: true` = notified; `delivered: false` = stored but message not started, do not resend; `delivered: null` = unconfirmed (opencode TUI), never resend; exit 4 / kind `plain_shell` = queued, not delivered because the target is a plain shell or unknown; kind `timeout` or any other nonzero exit after the send may have landed = notification failed, NEVER retry automatically; kind `not_found` = target not found, queued.
- hcx is a required dependency. Detect it once per process with `hcx --version --json` (parse `contract` >= 1 and `capabilities` containing `agent-only` and `no-footer`); cache the answer. Missing or older hcx: do not fall back to typing into anything; report the notification as not delivered with the hint `install hcx >= 0.3.0` (the message/job result stays stored).
- Delete the code this replaces: shell-kind sets, hc foreground / effective-kind lookups, hc target-kind lookups, the confirm-delivery parser, HC_TERMINAL_ID plumbing for the hc route, the hcx version-parse for --no-footer, and the tests that only covered them. Keep behaviour the tests still describe (wording of messages stays unless the plan says otherwise).

## Steps
1. ISSUES.md row (reporter "owner review", version 0.1.11, "In progress (0.2.0)").
2. Replace the `hc send` delivery path in `src/herdr.ts` (`hcSend`, `hcPrompt`, `effectiveKind`, `hcForeground`, `isShellKind`, `KNOWN_FOREGROUND_AGENTS`, delivery confirmation) with one `hcxNotify` as described above. Keep the old `herdr agent prompt` route for the old herdr server exactly as it is. Keep peers' own roster/tab resolution; pass the resolved terminal address to hcx.
3. `peers list` still labels shells: keep its `kind` display working from `hc ls` data (it does not need effective-kind; an agent named zsh stays shell; a foreground lookup is no longer needed — if a label depended on it, show the hc agent field).
4. Messages for the five outcomes stay the ones peers 0.1.10 printed (confirmed / not started, do not resend / unconfirmed / queued plain shell / failed, stored, exit 2); the unconfirmed wording should say "(delivery not confirmed)" without naming a tool.
5. Tests: a fake `hcx` stub on PATH records argv and prints JSON for each outcome (delivered true/false/null, plain_shell error exit 4, timeout error, hcx missing, hcx old without agent-only capability). Assert argv is exactly the contract call, no retry after a nonzero exit, and that no `hc` binary is called for notification.
6. README: hcx 0.3.0 is required for notifications over herdr-core (how to install it); installer mentions it if it already mentions dependencies.
7. Bump to 0.2.0, ISSUES row "Fixed in 0.2.0".

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/peers. Read each file before editing; edit in place. English only. No secrets. No live sessions or real terminal messaging (stub hcx/hc/herdr). No commits, pushes, tags, installs.
- Run `bunx tsc --noEmit`, `bun test`, build twice (identical, report sha256), `git diff --stat`, and report the lines removed vs added in src/.
- Write the report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe06.md then: `hcx send --no-footer Zytra "pe06 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe06.md"`
