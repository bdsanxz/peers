# PLAN_07.md: peers 0.3.0 - machine-readable output and installer parity with hcx

Source: review /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-review-peers-agentshell.md (items: `--json` output, installer parity). Read it, then README.md, ISSUES.md, src/commands.ts (and the other src files you touch), install.sh, test/. For the installer reference read /Users/budisantoso/Dev/bdsanxz/SWE/hcx/install.sh and /Users/budisantoso/Dev/bdsanxz/SWE/hcx/test/install.test.ts.

## Part A: --json for every command (whoami, list, send, contacts, chats/inbox, open, delete)
- Every command accepts `--json`: stdout is exactly one JSON document (object or array, or JSON lines only where a command already does that and says so in its help), no table, no prose, no color. Without `--json` the human output is byte-identical to today.
- Field names are stable snake_case and cover everything the human view shows (ids, states, exit codes, timestamps as ISO strings, counts, notify outcome, hints).
- Errors with `--json`: print `{"error":{"kind":"<snake_case>","message":"...","hint":"..."}}` (hint may be omitted) on stdout, keep today's exit codes, and keep human stderr text only when `--json` is absent. Give each existing failure a stable `kind` (for example usage, not_found, plain_shell, timeout, failed).
- `--help` for each command documents the JSON shape in one short block. Unknown-flag and missing-argument errors honour `--json` too.
- Never put a secret or full environment in JSON output.

## Part B: installer parity with hcx
Bring install.sh to the same behaviour as hcx/install.sh, adapted to this tool (asset names, repo, install name):
1. The GitHub token never appears on a command line: try the public URL first; only after a 404 look the token up (GITHUB_TOKEN, else `gh auth token`) and pass it through a curl stdin config (`-K -`), as hcx does.
2. Checksum: use sha256sum, else shasum -a 256, else die with a clear message; verify against the release's .sha256 asset and refuse on mismatch.
3. `--force` and the symlink rule exactly as in hcx (a symlinked target from a local dev install is left alone without --force).
4. `--from-source`: either make it work (build from a repo checkout or a downloaded source tag with Bun, as hcx does) or remove it from usage, header and code. Pick whichever keeps the script smaller and honest; do not leave a flag that only dies.
5. Env overrides like hcx (version and install dir env names for this tool), a clear message when node is missing, `--help`.
6. Add test/install.test.ts modelled on hcx's (fake curl/gh/shasum on PATH): public download, 404 then token via stdin config (assert the token is not in argv), checksum mismatch, shasum fallback, symlink + --force, unknown option, --help.

## Steps
1. ISSUES.md rows (reporter "owner review", "In progress (0.3.0)") for Part A and Part B.
2. Implement Part A, tests for every command in text and --json mode, including error kinds.
3. Implement Part B and its tests.
4. README: document --json (shapes) and the installer options. Bump package.json to 0.3.0. ISSUES rows "Fixed in 0.3.0".

## Rules
- Work only in /Users/budisantoso/Dev/bdsanxz/SWE/peers. Read each file before editing; edit in place, never overwrite wholesale. English only (code, comments, help, README, tests, ISSUES). No secrets; never print tokens. No live sessions or real terminal messaging (stub tools). No commits, pushes, tags, installs.
- Run `bunx tsc --noEmit`, `bun test`, build twice (identical, report sha256), `git diff --stat`, and report lines removed vs added in src/.
- Write the report to /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe07.md then: `hcx send --no-footer Zytra "pe07 done, report: /private/tmp/claude-501/-Users-budisantoso-Dev-bdsanxz-SWE/b22ac8cc-e39c-43ce-8990-7eda0c4d7dfc/scratchpad/report-pe07.md"`
