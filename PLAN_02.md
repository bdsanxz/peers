# PLAN_02: peers 0.1.8 - send untagged to opencode agents

## Finding (investigated live on herdr-core, hc 0.1.15)

`hc ls --json` and `hc get <addr>` report `agent: "zsh"` for a tab that runs `opencode`, because the tab is a login shell wrapper (`argv: ["/bin/zsh","-lic","\"$@\"; exec \"$0\" -li","/bin/zsh","opencode"]`) and `hc` has no opencode classifier. muse, claude-code and pi are classified correctly (`agent: "muse"`, `"claude-code"`, `"pi"`). `hc get <addr>` (address only; a name often returns not_found) also has `foreground: {"argv":[...],"name":"<program>","pid":N}`:

- opencode tab: `agent: zsh`, `foreground.name: "opencode"`, `foreground.argv: ["opencode"]`.
- claude-code tab: `foreground.name` is a version string such as `"2.1.314"` (so the name alone is not a reliable kind, but it is not a shell).
- plain shell tab (idle prompt): `agent: zsh`, `foreground.name: "zsh"`.

Consequence: tools that treat `agent == zsh` as a plain shell (peers `SHELLS`, agent-shell `SHELLS`, hcx send route/agent field) wrongly send opencode agents the tagged `hc send` (or, for hcx, report `agent: zsh`).

## Shared rule (implement identically, in each repo own code)

`effectiveKind(addr)`: take `agent` from `hc ls --json`. If it is NOT in the shell set (zsh, sh, bash, fish, dash, ksh, nu, pwsh) use it. If it IS a shell kind, call `hc get <addr>` and read `foreground.name` (basename, lower case): if it is empty or is itself in the shell set, the target is a plain shell (keep shell kind); otherwise return that foreground program name (for example `opencode`) as the kind. Any failure of `hc get` or unparseable JSON keeps the shell kind (safe default: tagged `hc send`). Only the address form is passed to `hc get` (resolve names to addresses through `hc ls --json` first).

## Steps

1. Read `src/herdr.ts` (the `SHELLS` set, `targetKind`, the `hc ls --json` listing around lines 80-130, the untagged send around lines 240-260), `src/commands.ts` where targets are built, tests, README, `ISSUES.md`. Add `ISSUES.md` row 7 (reporter "owner review", version 0.1.7, "A notification to an opencode agent is sent tagged with <hc from> because hc lists the tab as zsh", status "In progress (0.1.8)").
2. Apply the shared rule where the target kind is decided (`targetKind`), so an opencode tab gets the untagged `hcx send` with the peers footer. Cache the `hc get` lookups per command run (one lookup per address).
3. Tests as in the Rules, using a temporary `PEERS_CACHE`.
4. Bump to 0.1.8; README only where it describes the shell exception; ISSUES row -> "Fixed in 0.1.8".
5. `bunx tsc --noEmit`, `bun test`, `bun run build` twice (identical sha256 of `dist/peers.js`).

## Rules for the worker

- Work only in this repo. Read every file before changing it. Edit in place; never overwrite a file wholesale.
- All text in the codebase is English. No secrets anywhere. Do not print environment values.
- Tests stub `hc`/`hcx` on PATH as the existing tests do; add cases: real shell (foreground zsh) stays shell, opencode (agent zsh, foreground opencode) becomes opencode, claude-code with a version-string foreground stays claude-code, `hc get` failing keeps shell, unparseable JSON keeps shell.
- No live agent sessions, no commits, pushes, tags, releases or installs: the lead does those.
- Finish with `git diff --stat`.

## Report

Write the report to `/private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan02-peers.md`, then run: `hcx send Zytra "plan02-peers done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-plan02-peers.md"`
