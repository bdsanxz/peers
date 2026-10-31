// Helpers for `--json`: one JSON document on stdout, stable snake_case names,
// ISO timestamps, and `{"error":{"kind","message","hint"}}` errors on stdout.

import { bool, type Parsed } from "./args.ts";

export type JsonErrorKind = "usage" | "not_found" | "plain_shell" | "timeout" | "failed";

/** Whether `--json` appears before `--`: used for error reporting when parsing fails. */
export function argvWantsJson(argv: string[]): boolean {
  const dash = argv.indexOf("--");
  const before = dash === -1 ? argv : argv.slice(0, dash);
  return before.includes("--json");
}

export function wantsJson(p: Parsed): boolean {
  return bool(p, "json");
}

export function iso(ms: number | null): string | null {
  if (ms === null || ms === undefined) return null;
  return new Date(ms).toISOString();
}

export function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

export function jsonError(kind: JsonErrorKind, message: string, hint?: string): { error: { kind: string; message: string; hint?: string } } {
  const inner: { kind: string; message: string; hint?: string } = { kind, message };
  if (hint !== undefined && hint !== "") inner.hint = hint;
  return { error: inner };
}

/** Stable kind for a thrown failure: usage for flag and argument mistakes,
 * not_found for unknown peers, pages and squad dirs, timeout for timed-out
 * notifications, failed for other stored-but-not-notified sends and misc. */
export function kindFor(message: string, isUsage: boolean): JsonErrorKind {
  if (isUsage) {
    if (/no member, terminal or tab named/.test(message)) return "not_found";
    if (/page \d+ does not exist/.test(message)) return "not_found";
    if (/no such directory/.test(message)) return "not_found";
    if (/unknown command/.test(message)) return "usage";
    return "usage";
  }
  if (/timed out after/.test(message)) return "timeout";
  if (/^the message is stored /.test(message)) return "failed";
  return "failed";
}

/** Hint for a thrown failure, when the message carries a next step. */
export function hintFor(message: string): string | undefined {
  const m = message.match(/Run `([^`]+)` for usage\./);
  if (m) return `run ${m[1]} for usage`;
  if (/^the message is stored /.test(message)) return "do not resend; the message is stored";
  if (/cannot tell which session/.test(message)) return "run inside a live agent session or set PEERS_SELF";
  return undefined;
}
