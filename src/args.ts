// A small argument reader: `--flag value`, `--flag=value`, boolean flags, `--` and positionals.

export class UsageError extends Error {}

export interface Parsed {
  positionals: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[], booleans: string[] = []): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (booleans.includes(name) || name === "help") flags.set(name, true);
    else {
      const v = argv[i + 1];
      if (v === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, v);
      i++;
    }
  }
  return { positionals, flags };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  if (v === true) throw new UsageError(`--${name} needs a value`);
  return v;
}

export function bool(p: Parsed, name: string): boolean {
  return p.flags.get(name) === true;
}

export function unknownFlags(p: Parsed, allowed: string[]): void {
  for (const k of p.flags.keys())
    if (k !== "help" && !allowed.includes(k)) throw new UsageError(`unknown option --${k}`);
}
