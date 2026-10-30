# Issues

Every issue reported against `peers` is logged here first, then worked. Newest last.

| # | Reported | Reporter | Version | Issue | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-30 | Lena, Wulan, Tara, Sari, Raka, Bima, Dewi | 0.1.4 | Notifications print `peers open Lena (lead)`, which `peers open` rejects for whitespace. `peers open lead` finds no chat. Notifications announce unread messages while `peers chats` shows 0. `peers whoami` prints a name with whitespace. Contacts show a live member offline. | Fixed in 0.1.5 (one canonical whitespace-free key per peer) |
| 2 | 2026-10-30 | Tara, Bima (also with `--squad` before `--page`), Dewi (also `peers --squad DIR open lead --page 2`) | 0.1.5 | `peers open lead --page 2` fails with `open needs exactly one <TARGET>`: `--page` is parsed as a boolean flag, in any position. `delete` has the same mistake with `--squad`. | Fixed in 0.1.6 |
| 3 | 2026-10-30 | Wulan, Raka (`peers send lead --squad ...` also notified `t6v`) | 0.1.5 | `peers send framesmith-lead ...` stores the message correctly but notifies the `lead` terminal of another squad (space `squad-demo`) instead of the sender's own squad. | Fixed in 0.1.6 |
| 4 | 2026-10-31 | Nanda | 0.1.6 | While inspecting scheduled-job state, a command failed with `{"error":{... "kind":"usage","message":"unrecognized subcommand 'chats'"}}` followed by the full `hc` usage text, exit 2. The command line was lost in the report. Either `hc chats` was typed instead of `peers chats`, or `peers` forwards `chats` to `hc`. | Not a bug: `chats` was run on `hc`/`hcx`, which has no such subcommand; the command is `peers chats`. `peers` only calls `hc ls --json` and `hc send`. No release. |
| 5 | 2026-10-31 | Nanda | 0.1.6 | `peers send lead --kind progress --body "..."` exited 2 with `peers send: bad seq ""; expected an integer exchange number`. | Not a bug: `--seq` is required and was omitted. The corrected command was accepted (`SENT lead ... notified via hc send to t6g`). No release. |
| 6 | 2026-10-31 | owner review | 0.1.6 | Unclear missing-`--seq` error; unconfirmed hcx delivery printed as sent | Fixed in 0.1.7 |
| 7 | 2026-10-31 | owner review | 0.1.7 | A notification to an opencode agent is sent tagged with <hc from> because hc lists the tab as zsh | Fixed in 0.1.8 |
| 8 | 2026-10-31 | owner request | 0.1.8 | Notifications end with a redundant sender footer; the owner wants none | Fixed in 0.1.9 |
