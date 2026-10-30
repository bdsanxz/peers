# Issues

Every issue reported against `peers` is logged here first, then worked. Newest last.

| # | Reported | Reporter | Version | Issue | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-30 | Lena, Wulan, Tara, Sari, Raka, Bima, Dewi | 0.1.4 | Notifications print `peers open Lena (lead)`, which `peers open` rejects for whitespace. `peers open lead` finds no chat. Notifications announce unread messages while `peers chats` shows 0. `peers whoami` prints a name with whitespace. Contacts show a live member offline. | Fixed in 0.1.5 (one canonical whitespace-free key per peer) |
| 2 | 2026-10-30 | Tara, Bima (also with `--squad` before `--page`), Dewi (also `peers --squad DIR open lead --page 2`) | 0.1.5 | `peers open lead --page 2` fails with `open needs exactly one <TARGET>`: `--page` is parsed as a boolean flag, in any position. `delete` has the same mistake with `--squad`. | Fixed in 0.1.6 |
| 3 | 2026-10-30 | Wulan, Raka (`peers send lead --squad ...` also notified `t6v`) | 0.1.5 | `peers send framesmith-lead ...` stores the message correctly but notifies the `lead` terminal of another squad (space `squad-demo`) instead of the sender's own squad. | Fixed in 0.1.6 |
