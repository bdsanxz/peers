import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");

const AGENTS = {
  id: "cli:agent:list",
  result: {
    agents: [
      { agent: "muse", name: "me", pane_id: "w9:p9", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", name: "lead", pane_id: "w9:p1", agent_status: "done", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", name: "api", pane_id: "w9:p2", agent_status: "working", cwd: "/tmp/x", workspace_id: "w9" },
    ],
  },
};

function setup(): { tmp: string; bin: string; squad: string; hcxPrompts: string; hcxCalls: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peers-json-test-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const squad = path.join(tmp, "squad");
  fs.mkdirSync(squad, { recursive: true });
  fs.writeFileSync(path.join(tmp, "agents.json"), JSON.stringify(AGENTS));
  fs.writeFileSync(path.join(tmp, "hc.json"), JSON.stringify({ terminals: [] }));
  fs.writeFileSync(
    path.join(tmp, "hcx-version.json"),
    JSON.stringify({ hcx: "0.3.0", hc: "0.1.15", contract: 1, capabilities: ["no-footer", "agent-only", "json-delivery"] }),
  );
  fs.writeFileSync(
    path.join(tmp, "hcx-send.json"),
    JSON.stringify({ status: "idle", turn: 1, started: true, delivered: true, route: "hcx-raw", agent: "muse" }),
  );
  fs.writeFileSync(path.join(tmp, "hcx-send.exit"), "0");
  const stub = `#!/bin/bash
if [ "$1 $2" = "agent list" ]; then cat "${tmp}/agents.json"; exit 0; fi
if [ "$1 $2" = "agent prompt" ]; then printf '%s\\n' "$*" >>"${tmp}/prompts.log"; grep -q server_not_running "${tmp}/agents.json" 2>/dev/null && { echo "no herdr server is running" >&2; exit 1; }; exit 0; fi
echo "unexpected herdr call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "herdr"), stub);
  fs.chmodSync(path.join(bin, "herdr"), 0o755);
  const hcStub = `#!/bin/bash
if [ "$1" = "ls" ]; then cat "${tmp}/hc.json"; exit 0; fi
echo "unexpected hc call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "hc"), hcStub);
  fs.chmodSync(path.join(bin, "hc"), 0o755);
  const hcxStub = `#!/bin/bash
printf 'CALL:%s\\n' "$*" >>"${tmp}/hcx-calls.log"
if [ "$1" = "--version" ]; then cat "${tmp}/hcx-version.json"; exit 0; fi
if [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${tmp}/hcx-prompts.log"; cat "${tmp}/hcx-send.json"; exit $(cat "${tmp}/hcx-send.exit"); fi
echo "unexpected hcx call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "hcx"), hcxStub);
  fs.chmodSync(path.join(bin, "hcx"), 0o755);
  fs.writeFileSync(path.join(bin, "herdr-app"), `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`);
  fs.chmodSync(path.join(bin, "herdr-app"), 0o755);
  return { tmp, bin, squad, hcxPrompts: path.join(tmp, "hcx-prompts.log"), hcxCalls: path.join(tmp, "hcx-calls.log") };
}

function cli(s: { tmp: string; bin: string; squad: string }, args: string[], extraEnv: Record<string, string> = {}) {
  const p = Bun.spawnSync(["bun", MAIN, ...args], {
    env: {
      ...process.env,
      PATH: `${s.bin}:${process.env.PATH}`,
      PEERS_CACHE: path.join(s.tmp, "cache"),
      HOME: path.join(s.tmp, "home"),
      HERDR_PANE_ID: "w9:p9",
      HC_TERMINAL_ID: "",
      PEERS_CWD: s.squad,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}

function cliJson(s: { tmp: string; bin: string; squad: string }, args: string[], extraEnv: Record<string, string> = {}) {
  const r = cli(s, args, extraEnv);
  expect(r.err).toBe("");
  let v: unknown;
  expect(() => {
    v = JSON.parse(r.out);
  }).not.toThrow();
  return { code: r.code, value: v as Record<string, unknown>, raw: r.out };
}

function hcxSendJson(s: { tmp: string }, obj: unknown, exit = 0): void {
  fs.writeFileSync(s.tmp + "/hcx-send.json", typeof obj === "string" ? obj : JSON.stringify(obj));
  fs.writeFileSync(s.tmp + "/hcx-send.exit", String(exit));
}

describe("peers --json for every command", () => {
  test("whoami text and --json agree, one document, no stderr", () => {
    const s = setup();
    const text = cli(s, ["whoami"]);
    expect(text.code).toBe(0);
    expect(text.out).toBe("me");
    const j = cliJson(s, ["whoami", "--json"]);
    expect(j.code).toBe(0);
    expect(j.value["address"]).toBe("me");
    expect(typeof j.value["squad_root"]).toBe("string");
    expect(j.raw).not.toContain("\n");
  });

  test("whoami --json never leaks the environment", () => {
    const s = setup();
    const j = cliJson(s, ["whoami", "--json"], { GITHUB_TOKEN: "SECRET_XYZ", PEERS_SELF: "me" });
    expect(JSON.stringify(j.value)).not.toContain("SECRET_XYZ");
  });

  test("whoami --json with a bad squad is not_found on stdout", () => {
    const s = setup();
    const r = cli(s, ["whoami", "--json", "--squad", path.join(s.tmp, "nosuch")]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("");
    const v = JSON.parse(r.out) as { error: { kind: string; message: string; hint: string } };
    expect(v.error.kind).toBe("not_found");
    expect(v.error.message).toContain("no such directory");
    expect(v.error.hint).toContain("peers whoami --help");
  });

  test("list text and --json agree, self hidden, shells labelled", () => {
    const s = setup();
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({ terminals: [{ address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" }] }),
    );
    const text = cli(s, ["list"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("lead  kind=muse");
    expect(text.out).toContain("t2  kind=shell");
    const j = cliJson(s, ["list", "--json"]);
    expect(j.code).toBe(0);
    const agents = j.value["agents"] as { address: string; kind: string }[];
    expect(agents.some((a) => a.address === "me")).toBe(false);
    expect(agents.find((a) => a.address === "t2")?.kind).toBe("shell");
    expect(agents.find((a) => a.address === "lead")?.kind).toBe("muse");
  });

  test("send text and --json store and notify", () => {
    const s = setup();
    const text = cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Review api."]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("SENT lead");
    const s2 = setup();
    const j = cliJson(s2, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Review api.", "--json"]);
    expect(j.code).toBe(0);
    expect(j.value["peer"]).toBe("lead");
    expect(j.value["stored"]).toBe(true);
    expect(typeof j.value["message_id"]).toBe("number");
    expect(j.value["unread"]).toBe(1);
    expect(j.value["unknown_target"]).toBe(false);
    const notify = j.value["notify"] as { outcome: string; route: string };
    expect(notify.outcome).toBe("notified");
    expect(notify.route).toBe("herdr");
    expect(j.value["reply_to"]).toBeNull();
    expect(j.value["expects_reply"]).toBe(true);
  });

  test("send --json to an unknown target queues with hints", () => {
    const s = setup();
    const j = cliJson(s, ["send", "leed", "--kind", "request", "--seq", "1", "--body", "Hi.", "--json"]);
    expect(j.code).toBe(0);
    expect(j.value["unknown_target"]).toBe(true);
    expect(j.value["did_you_mean"]).toContain("lead");
    const notify = j.value["notify"] as { outcome: string; reason: string };
    expect(notify.outcome).toBe("queued");
  });

  test("send --json reports a plain shell without typing into it", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    hcxSendJson(s, { error: { kind: "plain_shell", message: 'tab "t2" is a plain shell' } }, 4);
    const j = cliJson(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi.", "--json"], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(j.code).toBe(0);
    const notify = j.value["notify"] as { outcome: string; reason: string };
    expect(notify.outcome).toBe("queued");
    expect(notify.reason).toBe("plain_shell");
  });

  test("send --json failure keeps exit 2 with kind timeout", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    hcxSendJson(s, { error: { kind: "timeout", message: "hc send timed out after 30 s" } }, 1);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi.", "--json"], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(2);
    expect(r.err).toBe("");
    const v = JSON.parse(r.out) as { error: { kind: string }; peer: string; stored: boolean };
    expect(v.error.kind).toBe("timeout");
    expect(v.peer).toBe("t2");
    expect(v.stored).toBe(true);
  });

  test("send --json failure with kind failed", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    hcxSendJson(s, { error: { kind: "error", message: "boom" } }, 1);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi.", "--json"], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(2);
    const v = JSON.parse(r.out) as { error: { kind: string } };
    expect(v.error.kind).toBe("failed");
  });

  test("send --json usage errors honour --json", () => {
    const s = setup();
    for (const args of [
      ["send", "lead", "--kind", "request", "--body", "Hi.", "--json"],
      ["send", "lead", "--kind", "request", "--seq", "abc", "--body", "Hi.", "--json"],
      ["send", "lead", "--seq", "1", "--body", "Hi.", "--json"],
      ["send", "lead", "--kind", "request", "--seq", "1", "--json"],
      ["send", "me", "--kind", "notice", "--seq", "1", "--body", "Hi.", "--json"],
      ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi.", "--bogus", "--json"],
    ]) {
      const r = cli(s, args);
      expect(r.code).toBe(2);
      expect(r.err).toBe("");
      const v = JSON.parse(r.out) as { error: { kind: string } };
      expect(v.error.kind).toBe("usage");
    }
  });

  test("contacts text and --json agree", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi."]).code).toBe(0);
    const text = cli(s, ["contacts"]);
    expect(text.out).toContain("lead  status=live");
    const j = cliJson(s, ["contacts", "--json"]);
    const contacts = j.value["contacts"] as { address: string; status: string; seen: string }[];
    expect(contacts.some((c) => c.address === "lead" && c.status === "live")).toBe(true);
    expect(typeof contacts[0]?.seen).toBe("string");
    expect(new Date(contacts[0]?.seen ?? "").toISOString()).toBe(contacts[0]?.seen ?? "");
  });

  test("chats and inbox --json agree with text", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi."], {}).code).toBe(0);
    const text = cli(s, ["chats"]);
    expect(text.out).toContain("1 chat");
    const j = cliJson(s, ["chats", "--json"]);
    expect(j.value["chat_count"]).toBe(1);
    expect((j.value["chats"] as unknown[]).length).toBe(1);
    const inbox = cliJson(s, ["inbox", "--json"]);
    expect(inbox.value["chat_count"]).toBe(1);
  });

  test("open --json prints one page and marks it read", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hello."], {}).code).toBe(0);
    const asLead = { HERDR_PANE_ID: "w9:p1" };
    const j = cliJson(s, ["open", "me", "--json"], asLead);
    expect(j.value["peer"]).toBe("me");
    expect((j.value["messages"] as unknown[]).length).toBe(1);
    expect(j.value["inbox_unread"]).toBe(0);
    expect(cli(s, ["chats"], asLead).out).toContain("unread=0");
  });

  test("open --json unknown peer is not_found", () => {
    const s = setup();
    const r = cli(s, ["open", "nosuchpeer", "--json"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("");
    expect((JSON.parse(r.out) as { error: { kind: string } }).error.kind).toBe("not_found");
  });

  test("delete text and --json agree", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi."]).code).toBe(0);
    const j = cliJson(s, ["delete", "lead", "--json"]);
    expect(j.value["peer"]).toBe("lead");
    expect(j.value["hidden"]).toBe(1);
    expect(j.value["had_chat"]).toBe(true);
    expect(cli(s, ["chats"]).out).toContain("0 chats");
  });

  test("unknown command honours --json", () => {
    const s = setup();
    const r = cli(s, ["boguscmd", "--json"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe("");
    expect((JSON.parse(r.out) as { error: { kind: string } }).error.kind).toBe("usage");
  });

  test("every help documents its JSON shape", () => {
    const s = setup();
    for (const cmd of ["whoami", "list", "send", "contacts", "chats", "open", "delete"]) {
      const args = cmd === "open" || cmd === "delete" || cmd === "send" ? [cmd, "--help"] : [cmd, "--help"];
      const r = cli(s, args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("JSON (--json)");
    }
  });
});
