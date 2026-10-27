// The peers extension for pi, src/pi_extension.ts, against a fake pi API and a fake `peers` on
// PATH: what it starts, how it delivers each notification, and when it stays quiet.
// Run: bun test (in pi-extension)

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The part of pi's context the extension reads; the tests build only that much. */
type Context = Pick<ExtensionContext, "mode" | "hasUI" | "isIdle"> & {
  ui: Pick<ExtensionContext["ui"], "notify">;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId" | "getSessionFile" | "getCwd">;
};

const SOURCE = path.resolve(import.meta.dir, "..", "..", "src", "pi_extension.ts");
const OWNER = Symbol.for("peers.pi-extension.owner");

let tmp = "";
let log = "";
let savedPath = "";

/** A fake `peers _pi-listen`: logs its arguments and PEERS_SELF, prints one notification, and
 * logs "closed" when it is stopped (SIGTERM) or its stdin closes. */
const PEERS = `#!/bin/bash
trap 'echo closed >>"$PEERS_LOG"; exit 0' TERM
echo "start $* self=$PEERS_SELF" >>"$PEERS_LOG"
echo "New message from Rina (api). You have 1 unread message in your inbox. Read it with: peers open claude:abc"
cat >/dev/null
echo closed >>"$PEERS_LOG"
`;

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "peers-pi-test-")));
  fs.mkdirSync(path.join(tmp, "bin"));
  fs.writeFileSync(path.join(tmp, "bin", "peers"), PEERS, { mode: 0o755 });
  log = path.join(tmp, "peers.log");
  savedPath = process.env.PATH ?? "";
  process.env.PATH = `${path.join(tmp, "bin")}:${savedPath}`;
  process.env.PEERS_LOG = log;
});

afterAll(() => {
  process.env.PATH = savedPath;
  delete process.env.PEERS_LOG;
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: Context) => unknown;

/** One loaded copy of the extension, with the handlers it registered and the messages it sent. */
async function load() {
  const mod = await import(`${SOURCE}?copy=${Math.random()}`);
  const handlers = new Map<string, Handler>();
  const sent: [string, unknown][] = [];
  // Only the members the extension calls; the rest of pi's API is never touched.
  const api = {
    on: (event: string, handler: Handler) => void handlers.set(event, handler),
    sendUserMessage: (content: unknown, options?: unknown) => void sent.push([String(content), options]),
  } as unknown as ExtensionAPI;
  mod.default(api);
  return { handlers, sent };
}

function ctx(over: { mode?: Context["mode"]; idle?: boolean; file?: string | undefined; id?: string } = {}): Context {
  const file = "file" in over ? over.file : "/sessions/s.jsonl";
  return {
    mode: over.mode ?? "tui",
    hasUI: false,
    isIdle: () => over.idle ?? true,
    ui: { notify: () => {} },
    sessionManager: { getSessionId: () => over.id ?? "s1", getSessionFile: () => file, getCwd: () => tmp },
  };
}

const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);

async function until(what: string, cond: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const loaded: Awaited<ReturnType<typeof load>>[] = [];
afterEach(async () => {
  for (const copy of loaded.splice(0)) await copy.handlers.get("session_shutdown")?.({}, ctx());
  // Every listener started must have stopped before the next test reads the log.
  const count = (word: string) => lines().filter((l) => l.startsWith(word)).length;
  await until("every listener to stop", () => count("closed") >= count("start"));
  fs.rmSync(log, { force: true });
  (globalThis as unknown as Record<symbol, unknown>)[OWNER] = undefined;
});

describe("the peers extension for pi", () => {
  test("at run time it imports only Node built-ins, so pi loads it with nothing installed", () => {
    const code = fs.readFileSync(SOURCE, "utf8");
    // Type-only imports are erased when pi loads the file, so only the others must be built-ins.
    const imports = [...code.matchAll(/^import\s+(?!type\s)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const name of imports) expect(name).toMatch(/^node:/);
  });

  test("an interactive session listens and gets each notification as a turn", async () => {
    const copy = await load();
    loaded.push(copy);
    await copy.handlers.get("session_start")!({}, ctx());
    await until("the notification", () => copy.sent.length === 1);
    expect(lines()[0]).toBe(`start _pi-listen pi:s1 --cwd ${tmp} self=pi:s1`);
    expect(copy.sent[0]![0]).toStartWith("New message from Rina (api).");
    expect(copy.sent[0]![1]).toBeUndefined(); // idle: a new turn
  });

  test("a busy session gets the notification steered into its running turn", async () => {
    const copy = await load();
    loaded.push(copy);
    await copy.handlers.get("session_start")!({}, ctx({ mode: "rpc", idle: false }));
    await until("the notification", () => copy.sent.length === 1);
    expect(copy.sent[0]![1]).toEqual({ deliverAs: "steer" });
  });

  test("one-shot runs, headless runs and unsaved sessions do not listen", async () => {
    const copy = await load();
    loaded.push(copy);
    await copy.handlers.get("session_start")!({}, ctx({ mode: "json" }));
    await copy.handlers.get("session_start")!({}, ctx({ mode: "print" }));
    await copy.handlers.get("session_start")!({}, ctx({ file: undefined }));
    process.env.PEERS_PI_HEADLESS = "1";
    try {
      await copy.handlers.get("session_start")!({}, ctx());
    } finally {
      delete process.env.PEERS_PI_HEADLESS;
    }
    await Bun.sleep(300);
    expect(lines()).toEqual([]);
  });

  test("loaded twice, only the first copy listens; shutdown releases it for a reload", async () => {
    const first = await load();
    const second = await load();
    loaded.push(first, second);
    await first.handlers.get("session_start")!({}, ctx());
    await second.handlers.get("session_start")!({}, ctx());
    await until("the notification", () => first.sent.length === 1);
    await Bun.sleep(200);
    expect(lines().filter((l) => l.startsWith("start"))).toHaveLength(1);
    expect(second.sent).toHaveLength(0);
    // pi shuts the session down on /reload; the listener stops, and a copy loaded afterwards listens.
    await first.handlers.get("session_shutdown")!({}, ctx());
    await until("the listener to close", () => lines().includes("closed"));
    await second.handlers.get("session_start")!({}, ctx());
    await until("the second copy's notification", () => second.sent.length === 1);
  });

  test("a new session restarts the listener on its own address", async () => {
    const copy = await load();
    loaded.push(copy);
    await copy.handlers.get("session_start")!({}, ctx({ id: "s1" }));
    await until("the first listener", () => lines().length === 1);
    await copy.handlers.get("session_start")!({}, ctx({ id: "s2" }));
    await until("the second listener", () => lines().some((l) => l.includes("pi:s2")));
    await until("the first to close", () => lines().includes("closed"));
  });
});
