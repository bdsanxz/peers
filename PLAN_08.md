# PLAN_08: peers 0.3.1 - chats shows the wrong name and role

Bug (ISSUES row 26): run `PEERS_SELF=cy peers --squad /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/live-test chats` (and `--json`). Every chat line shows the caller's own profile: `di  name="Cy"  role=cy`, `bo  name="Cy"  role=cy`. Expected the peer's name and role (`di  name="Di"  role=di`). `peers open bo --json` is correct. The squad database is in /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/live-test (read-only for you: copy it to a temp dir before experimenting; do not write to it). Framesmith squads show correct names, so find what differs (profiles keyed by the wrong identity, a profile upsert on `chats`/`open` overwriting a peer's profile, canonical key vs member name, or label() reading the wrong side).

## Steps
1. Read src/commands.ts (chats, open, label), src/identity.ts, src/canonical.ts and the profile storage code; reproduce on a COPY of the live-test squad dir, then write a failing test in test/run.test.ts that builds a two/three-member squad (roster.json + .peers.json per member) and asserts `chats` and `chats --json` show the peer's name and role.
2. Fix the cause in src (minimal, in place). Check that contacts/open/send still show the right names.
3. If a stored profile in an existing database is already wrong because of the bug, make the next command repair it from the authoritative source (.peers.json / roster.json) when that is cheap; otherwise say so in the report.
4. ISSUES.md row 26: "Fixed in 0.3.1" with a one-line cause. README only if behaviour text changed. Bump package.json to 0.3.1.

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/peers. Read each file before editing; edit in place, never overwrite wholesale. English only. No secrets. No live sessions or real terminal messaging (stub tools). No commits, pushes, tags, installs.
- Run `bunx tsc --noEmit`, `bun test`, build twice (identical, report sha256), `git diff --stat`.
- Write the report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe08.md then try: hcx send --no-footer t3 "pe08 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe08.md" (raw address, no --agent-only/--json); if it fails just end with the path.
