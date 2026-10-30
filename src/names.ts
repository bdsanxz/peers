// Shared name helpers with no imports: the member inside a display name such
// as "Lena (lead)", and squad-prefixed stale addresses such as
// "framesmith-lead". Both herdr.ts (address resolution) and canonical.ts
// (chat keys) use these, so they live here to avoid an import cycle.

/// The member inside a trailing "(member)": "Lena (lead)" -> "lead".
/// Returns null when there is no parenthesised suffix or when the inside
/// holds whitespace (a real member name never does).
export function parenMember(s: string): string | null {
  const m = s.match(/\(([^()]+)\)\s*$/);
  if (!m) return null;
  const inner = m[1]!.trim();
  if (inner === "" || /\s/.test(inner)) return null;
  return inner;
}

/// A member word: what checkTarget accepts as a bare name (no whitespace,
// no pane colons or machine slashes).
export function isMemberWord(s: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(s);
}

/// Strips a squad prefix: ("framesmith-lead", "framesmith") -> "lead".
/// Returns null when the address does not start with "<squad>-".
export function stripSquadPrefix(addr: string, squad: string | null): string | null {
  if (!squad) return null;
  if (!addr.startsWith(`${squad}-`)) return null;
  const rest = addr.slice(squad.length + 1).trim();
  return rest === "" ? null : rest;
}
