# PLAN_04: peers 0.1.10 - help safety and notification correctness

Source: review report at /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (Part 1, items 1, 2, 3, 4, 10, 12, 13). Read that part first, then `README.md`, `ISSUES.md`, `src/*.ts`, `test/*.ts`.

Steps, each with tests that fail before the fix:
1. Add one ISSUES.md row per step (reporter "owner review", version 0.1.9, status "In progress (0.1.10)").
2. `--help`/`-h` anywhere before `--` shows the help of that command and does nothing else (also after `--squad X` and for `delete`, `open`, `send`). `peers --squad=D open` works.
3. Delivery result: `started: false` is never "confirmed"; print a distinct message (message not started, do not resend; it is stored). Fix the wording "not confirmed by hcx" when the route is hc.
4. Foreground detection uses an allowlist of agent programs like hcx (`hcx/src/herdr.ts` around lines 90 and 110: read it) so a shell running `vim` is not an agent; an unknown kind is treated like a shell.
5. Never type a notification into a plain shell: print `queued, not delivered yet: <target> is a plain shell` and keep the message stored. `peers list` labels shell terminals as `shell`.
6. `send` to a target that is no known member, tab or terminal still stores the message but prints an `UNKNOWN:` line with close matches.
7. `contacts`: group by canonical key (register `primary(me)`), refresh `updated_at` on the session's own registration.
8. Small items: `--seq=` (empty) is refused; `whoami`/`list` honour `--squad` or the README says otherwise (pick the smaller change and document); `peers list` help matches the real status mapping; exit codes in help match reality (other errors exit 1).
9. Bump `package.json` to 0.1.10, update README and the skill-facing help text, ISSUES rows to "Fixed in 0.1.10".
Do NOT do memoization, timeouts, SQLite changes, squad hashing, JSON output, installer or hcx migration: later plans.

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/peers. Read each file before editing; edit in place, never overwrite wholesale. English only. No secrets. No live agent sessions, no real terminal messaging (stub hc/hcx/herdr as existing tests do). No commits, pushes, tags, installs: the lead does them.
- Run `bunx tsc --noEmit`, `bun test`, the build twice (identical bytes, report sha256), finish with `git diff --stat`.
- Write a report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe04.md, then run: `hcx send --no-footer Zytra "pe04 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe04.md"`
