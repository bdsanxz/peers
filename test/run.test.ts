import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.ts";

const MAIN = path.join(import.meta.dir, "..", "src", "main.ts");

const AGENTS = {
  id: "cli:agent:list",
  result: {
    agents: [
      { agent: "muse", name: "me", pane_id: "w9:p9", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", name: "lead", pane_id: "w9:p1", agent_status: "done", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", name: "api", pane_id: "w9:p2", agent_status: "working", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", name: "flaky", pane_id: "w9:p3", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", pane_id: "w3G:p7", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w3G" },
    ],
  },
};

function setup(): { tmp: string; bin: string; prompts: string; hcPrompts: string; squad: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peers-test-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const squad = path.join(tmp, "squad");
  fs.mkdirSync(squad, { recursive: true });
  fs.writeFileSync(path.join(tmp, "agents.json"), JSON.stringify(AGENTS));
  fs.writeFileSync(path.join(tmp, "hc.json"), JSON.stringify({ terminals: [] }));
  const stub = `#!/bin/bash
if [ "$1 $2" = "agent list" ]; then cat "${tmp}/agents.json"; exit 0; fi
if [ "$1 $2" = "agent prompt" ]; then printf '%s\\n' "$*" >>"${tmp}/prompts.log"; [ "$3" = "flaky" ] && { echo "no such agent: flaky" >&2; exit 1; }; grep -q server_not_running "${tmp}/agents.json" 2>/dev/null && { echo "no herdr server is running" >&2; exit 1; }; exit 0; fi
echo "unexpected herdr call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "herdr"), stub);
  fs.chmodSync(path.join(bin, "herdr"), 0o755);
  const hcStub = `#!/bin/bash
if [ "$1" = "ls" ]; then cat "${tmp}/hc.json"; exit 0; fi
if [ "$1" = "get" ]; then printf '%s\\n' "$2" >>"${tmp}/hc-get.log"; printf '%s\\n' '{"foreground":{"name":"zsh"}}'; exit 0; fi
if [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${tmp}/hc-prompts.log"; printf '%s\\n' "\${HC_TERMINAL_ID-unset}" >>"${tmp}/hc-env.log"; [ -n "$HC_FAIL_PLAIN" ] && [ -z "\${HC_TERMINAL_ID+x}" ] && { echo "plain send refused" >&2; exit 1; }; [ "$2" = "flaky" ] && { echo "no such terminal: flaky" >&2; exit 1; }; [ "$2" = "ghost" ] && { echo "no such terminal: ghost" >&2; exit 1; }; printf '%s\\n' '{"started":true,"status":"ok","turn":1}'; exit 0; fi
echo "unexpected hc call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "hc"), hcStub);
  fs.chmodSync(path.join(bin, "hc"), 0o755);
  fs.writeFileSync(path.join(bin, "herdr-app"), `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"tabs":[{"name":"Zytra","terminals":[{"terminal":"t9","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`);
  fs.chmodSync(path.join(bin, "herdr-app"), 0o755);
  return { tmp, bin, prompts: path.join(tmp, "prompts.log"), hcPrompts: path.join(tmp, "hc-prompts.log"), squad };
}

function cli(
  s: { tmp: string; bin: string; squad: string },
  args: string[],
  extraEnv: Record<string, string> = {},
) {
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

function prompts(s: { prompts: string }): string {
  try {
    return fs.readFileSync(s.prompts, "utf8");
  } catch {
    return "";
  }
}

describe("peers over herdr agent prompt", () => {
  test("whoami resolves the herdr agent by pane", () => {
    const s = setup();
    const r = cli(s, ["whoami"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("me");
  });

  test("send stores the message and prompts fire-and-forget", () => {
    const s = setup();
    const r = cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Review api."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    expect(r.out).toContain("notified via herdr agent prompt to lead");
    expect(r.out).toContain("REPLY:");
    const log = prompts(s);
    expect(log).toContain("agent prompt lead New message from me (unassigned).");
    expect(log).toContain("peers open me");
    expect(log).not.toContain("--wait");
  });

  test("the peer reads the chat and replies; the reply arrives the same way", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Review api."], {}).code).toBe(0);
    const asLead = { HERDR_PANE_ID: "w9:p1" };
    const open = cli(s, ["open", "me"], asLead);
    expect(open.code).toBe(0);
    expect(open.out).toContain("CHAT with me (unassigned)");
    expect(open.out).toContain("Review api.");
    const chats = cli(s, ["chats"], asLead);
    expect(chats.out).toContain("INBOX lead");
    expect(chats.out).toContain("unread=0");
    const reply = cli(s, ["send", "me", "--kind", "completion", "--seq", "1", "--body", "Done."], asLead);
    expect(reply.code).toBe(0);
    expect(prompts(s)).toContain("agent prompt me New message from lead (unassigned).");
    const back = cli(s, ["open", "lead"]);
    expect(back.out).toContain("Done.");
  });

  test("a message to a peer that is not live waits in its inbox", () => {
    const s = setup();
    const r = cli(s, ["send", "ghost", "--kind", "notice", "--seq", "2", "--body", "Heads up."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("queued, not delivered yet");
    expect(prompts(s)).toBe("");
    const inbox = cli(s, ["chats"], { PEERS_SELF: "ghost", HERDR_PANE_ID: "" });
    expect(inbox.code).toBe(0);
    expect(inbox.out).toContain("1 unread message");
  });

  test("a failed prompt is recorded, never retried, and exits 2", () => {
    const s = setup();
    const r = cli(s, ["send", "flaky", "--kind", "request", "--seq", "1", "--body", "Ping."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("stored in flaky's inbox, but its notification failed");
    const inbox = cli(s, ["chats"], { PEERS_SELF: "flaky", HERDR_PANE_ID: "" });
    expect(inbox.out).toContain("1 unread message");
  });

  test("alphanumeric pane ids are accepted as targets", () => {
    const s = setup();
    const r = cli(s, ["send", "w3G:p7", "--kind", "notice", "--seq", "1", "--body", "Hi."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT w3G:p7: stored in its inbox (1 unread message)");
    expect(prompts(s)).toContain("agent prompt w3G:p7 New message");
  });

  test("legacy runtime:id addresses are rejected with a hint", () => {
    const s = setup();
    const r = cli(s, ["send", "claude:aaaaaaaa-0000-0000-0000-000000000000", "--kind", "request", "--seq", "1", "--body", "Hi."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("peers addresses are member names");
  });

  test("sending to yourself is refused", () => {
    const s = setup();
    expect(cli(s, ["send", "me", "--kind", "notice", "--seq", "1", "--body", "Hi."]).code).toBe(2);
  });

  test("a send without --seq names the missing flag", () => {
    const s = setup();
    const r = cli(s, ["send", "lead", "--kind", "request", "--body", "Hi."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "missing --seq: give the exchange number, for example --seq 1 (see `peers send --help`)",
    );
  });

  test("a non-integer --seq keeps the bad seq error", () => {
    const s = setup();
    const r = cli(s, ["send", "lead", "--kind", "request", "--seq", "abc", "--body", "Hi."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`bad seq "abc"; expected an integer exchange number`);
  });

  test("a send without --kind names the missing flag", () => {
    const s = setup();
    const r = cli(s, ["send", "lead", "--seq", "1", "--body", "Hi."]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "missing --kind: one of request, ack, progress, completion, receipt, notice (see `peers send --help`)",
    );
  });

  test("contacts, list and delete work", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi."], {}).code).toBe(0);
    const contacts = cli(s, ["contacts"]);
    expect(contacts.out).toContain("lead  status=live");
    const list = cli(s, ["list"]);
    expect(list.out).toContain("lead  kind=muse");
    expect(list.out).not.toMatch(/^me /m);
    expect(cli(s, ["delete", "lead"]).code).toBe(0);
    expect(cli(s, ["chats"]).out).toContain("0 chats");
  });

  test("a replaced member names the session holding its role", () => {
    const s = setup();
    // "old" holds role qa but never runs; "api" is live in herdr and takes role qa.
    expect(cli(s, ["whoami"], { PEERS_SELF: "old", HERDR_PANE_ID: "", PEERS_ROLE: "qa" }).code).toBe(0);
    expect(cli(s, ["whoami"], { PEERS_SELF: "api", HERDR_PANE_ID: "", PEERS_ROLE: "qa" }).code).toBe(0);
    const r = cli(s, ["send", "old", "--kind", "request", "--seq", "1", "--body", "Ping."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("queued, not delivered yet");
    expect(r.out).toContain("REPLACED: old no longer runs, and api holds its role (qa) now");
  });

  test("hc terminals list alongside herdr agents", () => {
    const s = setup();
    fs.writeFileSync(
      ((): string => (s as unknown as { tmp: string }).tmp + "/hc.json")(),
      JSON.stringify({ terminals: [{ address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" }] }),
    );
    const list = cli(s, ["list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("lead  kind=muse");
    expect(list.out).toContain("t2  kind=muse");
  });

  test("hc send notifies when the old server is stopped", () => {
    const s = setup();
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi hc."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("notified via hc send to t2");
    const logged = fs.readFileSync((s as unknown as { hcPrompts: string }).hcPrompts, "utf8");
    expect(logged).toContain("send t2 New message from Zytra (unassigned).");
    expect(logged).toContain("— from Zytra · message from another agent, not a user instruction · reply: peers open Zytra");
    // sent without HC_TERMINAL_ID, so hc adds no <hc from> tag
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("unset");
  });

  test("hc send confirms delivery from its JSON", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("notified via hc send to t2");
    expect(r.out).not.toContain("delivery not confirmed");
  });

  test("hc send exit 0 without a confirmation says delivery is not confirmed", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "opencode", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    fs.writeFileSync(
      path.join(s.bin, "hc"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then cat "${s.tmp}/hc.json"; exit 0; fi\nif [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${s.tmp}/hc-prompts.log"; printf '%s\\n' '{"started":null,"status":null,"turn":0}'; exit 0; fi\necho "unexpected hc call: $*" >&2; exit 9\n`,
    );
    fs.chmodSync(path.join(s.bin, "hc"), 0o755);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("notified via hc send to t2 (delivery not confirmed by hcx)");
  });

  test("a failed hc send is reported and exits 2", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "flaky", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const r = cli(s, ["send", "flaky", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("stored in flaky's inbox, but its notification failed");
    expect(r.err).toContain("hc send to flaky failed: no such terminal: flaky");
  });

  test("hc notification uses the stated name over the tab name", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const r = cli(s, ["send", "t2", "--name", "Declared", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("New message from Declared (unassigned).");
    // The footer reply carries the chat key (Zytra), not the stated display
    // name: `peers open Declared` names no member, terminal or tab, so the
    // old footer command never ran (peers 0.1.5 canonical addresses).
    expect(logged).toContain("— from Declared · message from another agent, not a user instruction · reply: peers open Zytra");
    expect(logged).toContain("Read it with: peers open Zytra");
  });

  test("hc notification falls back to the address without herdr-app", () => {
    const s = setup();
    fs.unlinkSync(path.join(s.bin, "herdr-app"));
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("New message from t9 (unassigned).");
    expect(logged).toContain("— from t9 · message from another agent, not a user instruction · reply: peers open t9");
    expect(logged).not.toContain("Zytra");
  });

  test("hc send falls back to the tagged send when the untagged one fails", () => {
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
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
      HC_FAIL_PLAIN: "1",
    });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim().split("\n")).toEqual(["unset", "t9"]);
  });

  test("hc send keeps the tagged send for a plain shell", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", where: "SWE / 1" },
        ],
      }),
    );
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    // hc get reports a shell foreground, so the target stays a plain shell.
    expect(fs.readFileSync(s.tmp + "/hc-get.log", "utf8").trim()).toBe("t2");
    expect(fs.readFileSync(s.tmp + "/hc-prompts.log", "utf8")).not.toContain("· message from another agent");
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("t9");
  });

  test("an opencode tab listed as a shell is notified untagged", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    // hc lists the tab as zsh, but its foreground program is opencode.
    fs.writeFileSync(
      path.join(s.bin, "hc"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then cat "${s.tmp}/hc.json"; exit 0; fi\nif [ "$1" = "get" ]; then printf '%s\\n' "$2" >>"${s.tmp}/hc-get.log"; printf '%s\\n' '{"foreground":{"name":"opencode"}}'; exit 0; fi\nif [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${s.tmp}/hc-prompts.log"; printf '%s\\n' "\${HC_TERMINAL_ID-unset}" >>"${s.tmp}/hc-env.log"; printf '%s\\n' '{"started":true,"status":"ok","turn":1}'; exit 0; fi\necho "unexpected hc call: $*" >&2; exit 9\n`,
    );
    fs.chmodSync(path.join(s.bin, "hc"), 0o755);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("notified via hc send to t2");
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("New message from Zytra (unassigned).");
    expect(logged).toContain("— from Zytra · message from another agent, not a user instruction · reply: peers open Zytra");
    // Untagged: hc gets no <hc from> tag.
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("unset");
    // One lookup for the address, by its address form.
    expect(fs.readFileSync(s.tmp + "/hc-get.log", "utf8").trim()).toBe("t2");
  });

  test("a claude-code tab keeps its kind despite a version-string foreground", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "claude-code", foreground: { name: "2.1.314" }, cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("notified via hc send to t2");
    // A non-shell agent kind is used as-is, so the odd foreground name is never read.
    expect(fs.existsSync(s.tmp + "/hc-get.log")).toBe(false);
    expect(fs.readFileSync(s.hcPrompts, "utf8")).toContain("· message from another agent");
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("unset");
  });

  test("a failed hc get keeps the shell's tagged send", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    fs.writeFileSync(
      path.join(s.bin, "hc"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then cat "${s.tmp}/hc.json"; exit 0; fi\nif [ "$1" = "get" ]; then echo "no such terminal: $2" >&2; exit 1; fi\nif [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${s.tmp}/hc-prompts.log"; printf '%s\\n' "\${HC_TERMINAL_ID-unset}" >>"${s.tmp}/hc-env.log"; printf '%s\\n' '{"started":true,"status":"ok","turn":1}'; exit 0; fi\necho "unexpected hc call: $*" >&2; exit 9\n`,
    );
    fs.chmodSync(path.join(s.bin, "hc"), 0o755);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("t9");
    expect(fs.readFileSync(s.hcPrompts, "utf8")).not.toContain("· message from another agent");
  });

  test("unparseable hc get JSON keeps the shell's tagged send", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "zsh", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    fs.writeFileSync(
      path.join(s.bin, "hc"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then cat "${s.tmp}/hc.json"; exit 0; fi\nif [ "$1" = "get" ]; then printf '%s\\n' '{not json'; exit 0; fi\nif [ "$1" = "send" ]; then printf '%s\\n' "$*" >>"${s.tmp}/hc-prompts.log"; printf '%s\\n' "\${HC_TERMINAL_ID-unset}" >>"${s.tmp}/hc-env.log"; printf '%s\\n' '{"started":true,"status":"ok","turn":1}'; exit 0; fi\necho "unexpected hc call: $*" >&2; exit 9\n`,
    );
    fs.chmodSync(path.join(s.bin, "hc"), 0o755);
    const r = cli(s, ["send", "t2", "--kind", "request", "--seq", "1", "--body", "Hi."], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t9" });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(s.tmp + "/hc-env.log", "utf8").trim()).toBe("t9");
    expect(fs.readFileSync(s.hcPrompts, "utf8")).not.toContain("· message from another agent");
  });

  test("a Herdr tab name is the address, stored under its canonical spelling", () => {
    const s = setup();
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const fromT2 = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t2" };
    const r = cli(s, ["send", "zytra", "--kind", "request", "--seq", "1", "--body", "Hi tab."], fromT2);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT Zytra: stored in its inbox (1 unread message)");
    expect(r.out).toContain("notified via hc send to t9");
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("send t9 New message from t2 (unassigned).");
    expect(logged).toContain("Read it with: peers open t2");
    const open = cli(s, ["open", "ZYTRA"], fromT2);
    expect(open.code).toBe(0);
    expect(open.out).toContain("CHAT with Zytra (unassigned)");
    expect(open.out).toContain("Hi tab.");
    const reply = cli(s, ["send", "t2", "--kind", "completion", "--seq", "1", "--body", "Back."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(reply.code).toBe(0);
    const back = cli(s, ["open", "Zytra"], fromT2);
    expect(back.code).toBe(0);
    expect(back.out).toContain("Back.");
  });

  test("an ambiguous tab name is refused with its terminal ids", () => {
    const s = setup();
    fs.writeFileSync(
      path.join(s.bin, "herdr-app"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"tabs":[{"name":"Zytra","terminals":[{"terminal":"t3","app":true}]},{"name":"Zytra","terminals":[{"terminal":"t9","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`,
    );
    const r = cli(s, ["send", "zytra", "--kind", "request", "--seq", "1", "--body", "Hi."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t2",
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain(`ambiguous tab name "zytra"; use one of: t3, t9`);
  });

  test("an exact member name beats a tab name", () => {
    const s = setup();
    const withZytra = {
      ...AGENTS,
      result: {
        agents: [
          ...AGENTS.result.agents,
          { agent: "muse", name: "Zytra", pane_id: "w9:p5", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w9" },
        ],
      },
    };
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify(withZytra));
    const r = cli(s, ["send", "Zytra", "--kind", "request", "--seq", "1", "--body", "Hi member."]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT Zytra: stored in its inbox (1 unread message)");
    expect(r.out).toContain("notified via herdr agent prompt to Zytra");
    expect(prompts(s)).toContain("agent prompt Zytra New message from me (unassigned).");
    let hcLogged = "";
    try {
      hcLogged = fs.readFileSync(s.hcPrompts, "utf8");
    } catch {
      hcLogged = "";
    }
    expect(hcLogged).not.toContain("send t9");
  });

  test("open and delete refuse a name that is no member, terminal or tab", () => {
    const s = setup();
    const open = cli(s, ["open", "nosuchpeer"]);
    expect(open.code).toBe(2);
    expect(open.err).toContain(`no member, terminal or tab named "nosuchpeer"`);
    const del = cli(s, ["delete", "nosuchpeer"]);
    expect(del.code).toBe(2);
    expect(del.err).toContain(`no member, terminal or tab named "nosuchpeer"`);
  });

  test("without herdr-app a tab name stays as typed", () => {
    const s = setup();
    fs.unlinkSync(path.join(s.bin, "herdr-app"));
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(s.tmp + "/hc.json", JSON.stringify({ terminals: [
      { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
      { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
    ] }));
    const fromT2 = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t2" };
    const r = cli(s, ["send", "zytra", "--kind", "request", "--seq", "1", "--body", "Hi."], fromT2);
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT zytra: stored in its inbox (1 unread message)");
    expect(r.out).toContain("queued, not delivered yet");
    const open = cli(s, ["open", "zytra"], fromT2);
    expect(open.code).toBe(0);
    expect(open.out).toContain("CHAT with zytra (unassigned)");
  });

  test("whoami resolves the hc terminal by id", () => {
    const s = setup();
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({ terminals: [{ address: "t7", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" }] }),
    );
    const r = cli(s, ["whoami"], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t7" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("t7");
  });

  test("a finished hc turn lists as idle, not done", () => {
    const s = setup();
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({ terminals: [{ address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "done", where: "SWE / 1" }] }),
    );
    const list = cli(s, ["list"], { PEERS_SELF: "me", HERDR_PANE_ID: "", HC_TERMINAL_ID: "" });
    expect(list.code).toBe(0);
    expect(list.out).toContain("t2  kind=muse  status=idle");
  });

  test("a stale member address follows the live terminal by directory", () => {
    const s = setup();
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/squad/roster.json", JSON.stringify({ squad: "demo", goal: "g" }));
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/work/qa", state: "live", status: "idle", where: "SWE / 1" },
        ],
      }),
    );
    const r = cli(s, ["send", "demo-qa", "--kind", "request", "--seq", "1", "--body", "Ping."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("demo-qa is not live, but t2 runs it now");
    expect(r.out).toContain("notified via hc send to t2");
    const logged = fs.readFileSync((s as unknown as { hcPrompts: string }).hcPrompts, "utf8");
    expect(logged).toContain("send t2 New message from Zytra (unassigned).");
  });

  test("ambiguous live terminals stay queued with a hint", () => {
    const s = setup();
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/squad/roster.json", JSON.stringify({ squad: "demo", goal: "g" }));
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/a/qa", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t7", agent: "muse", cwd: "/b/qa", state: "live", status: "idle", where: "SWE / 1" },
        ],
      }),
    );
    const r = cli(s, ["send", "demo-qa", "--kind", "request", "--seq", "1", "--body", "Ping."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("queued, not delivered yet");
    expect(r.out).toContain("Live terminals matching it: t2, t7");
  });

  test("remote hc addresses validate as machine/terminal", () => {
    const s = setup();
    fs.writeFileSync((s as unknown as { tmp: string }).tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      (s as unknown as { tmp: string }).tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t9", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "vps/t7", agent: "muse", cwd: "/srv/x", state: "live", status: "idle", where: "remote" },
        ],
      }),
    );
    const r = cli(s, ["send", "vps/t7", "--kind", "notice", "--seq", "1", "--body", "Hi remote."], {
      HERDR_PANE_ID: "",
      HC_TERMINAL_ID: "t9",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT vps/t7");
  });
});

describe("peers canonical addresses (0.1.5)", () => {
  const TABS_APP = `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"tabs":[{"name":"Lena (lead)","terminals":[{"terminal":"t1","app":true}]},{"name":"Tara (planner)","terminals":[{"terminal":"t2","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`;

  function setupSquadTabs(s: { tmp: string; bin: string }): void {
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t1", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    fs.writeFileSync(path.join(s.bin, "herdr-app"), TABS_APP);
  }

  const fromLead = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t1" };
  const asTara = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t2" };

  test("a tab with spaces sends to a member word; the peer reads it under any spelling", () => {
    const s = setup();
    setupSquadTabs(s);
    const sent = cli(s, ["send", "planner", "--kind", "request", "--seq", "1", "--body", "Hi Tara."], fromLead);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("SENT planner: stored in its inbox (1 unread message)");
    expect(sent.out).toContain("notified via hc send to t2");
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("Read it with: peers open lead");
    expect(logged).not.toContain("peers open Lena (lead)");

    const chats = cli(s, ["chats"], asTara);
    expect(chats.code).toBe(0);
    expect(chats.out).toContain("INBOX planner");
    expect(chats.out).toContain("1 unread message in 1 chat");
    expect(chats.out).toContain("OPEN: peers open lead");

    const openTab = cli(s, ["open", "Lena (lead)"], asTara);
    expect(openTab.code).toBe(0);
    expect(openTab.out).toContain("CHAT with lead (unassigned)");
    expect(openTab.out).toContain("Hi Tara.");
    const openLead = cli(s, ["open", "lead"], asTara);
    expect(openLead.code).toBe(0);
    expect(openLead.out).toContain("Hi Tara.");

    // A quoted tab name sends back to the same merged chat.
    const reply = cli(s, ["send", "Lena (lead)", "--kind", "ack", "--seq", "1", "--body", "On it."], asTara);
    expect(reply.code).toBe(0);
    expect(reply.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    const back = cli(s, ["open", "planner"], fromLead);
    expect(back.code).toBe(0);
    expect(back.out).toContain("On it.");

    // Deleting by the quoted tab name hides only the deleter's view.
    const del = cli(s, ["delete", "Lena (lead)"], asTara);
    expect(del.code).toBe(0);
    expect(del.out).toContain("DELETED your view of the chat with lead");
    expect(cli(s, ["chats"], asTara).out).toContain("0 chats");
    expect(cli(s, ["chats"], fromLead).out).toContain("1 chat");
  });

  test("old rows stored under other spellings are still found", () => {
    const s = setup();
    const prevCache = process.env.PEERS_CACHE;
    process.env.PEERS_CACHE = path.join(s.tmp, "cache");
    const db = Store.open(s.squad);
    try {
      db.insertMessage({ sender: "Lena (lead)", recipient: "planner", sender_name: "Lena (lead)", sender_role: "lead", kind: "notice", seq: 1, reply_to: null, body: "Old hello planner." });
      db.insertMessage({ sender: "Lena (lead)", recipient: "qa-picture", sender_name: "Lena (lead)", sender_role: "lead", kind: "notice", seq: 1, reply_to: null, body: "Old hello qa-picture." });
    } finally {
      db.close();
      if (prevCache === undefined) delete process.env.PEERS_CACHE;
      else process.env.PEERS_CACHE = prevCache;
    }
    // Whitespace identities read the rows stored under the member words.
    const tara = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "", PEERS_SELF: "Tara (planner)" };
    const wulan = { HERDR_PANE_ID: "", HC_TERMINAL_ID: "", PEERS_SELF: "Wulan (qa-picture)" };
    const chats = cli(s, ["chats"], tara);
    expect(chats.code).toBe(0);
    expect(chats.out).toContain("INBOX planner");
    expect(chats.out).toContain("1 unread message in 1 chat");
    const openTab = cli(s, ["open", "Lena (lead)"], tara);
    expect(openTab.code).toBe(0);
    expect(openTab.out).toContain("Old hello planner.");
    const openLead = cli(s, ["open", "lead"], tara);
    expect(openLead.code).toBe(0);
    expect(openLead.out).toContain("Old hello planner.");
    const wchats = cli(s, ["chats"], wulan);
    expect(wchats.out).toContain("INBOX qa-picture");
    expect(wchats.out).toContain("1 unread message in 1 chat");
    const wopen = cli(s, ["open", "lead"], wulan);
    expect(wopen.code).toBe(0);
    expect(wopen.out).toContain("Old hello qa-picture.");
  });

describe("peers 0.1.6 --page and --squad flag parsing", () => {
  const TABS_APP = `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"tabs":[{"name":"Lena (lead)","terminals":[{"terminal":"t1","app":true}]},{"name":"Tara (planner)","terminals":[{"terminal":"t2","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`;

  function setupSquadTabs(s: { tmp: string; bin: string }): void {
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t1", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    fs.writeFileSync(path.join(s.bin, "herdr-app"), TABS_APP);
  }

  // More than one page (PAGE_SIZE is 20) without 25 CLI spawns: the rows the
  // CLI itself would store, with distinct bodies so pages are tellable apart.
  function seedChat(s: { tmp: string; squad: string }, sender: string, recipient: string, count: number): void {
    const prevCache = process.env.PEERS_CACHE;
    process.env.PEERS_CACHE = path.join(s.tmp, "cache");
    const db = Store.open(s.squad);
    try {
      for (let i = 1; i <= count; i++) {
        db.insertMessage({
          sender,
          recipient,
          sender_name: "Lena",
          sender_role: "lead",
          kind: "notice",
          seq: i,
          reply_to: null,
          body: `Seed message ${i} of ${count}.`,
        });
      }
    } finally {
      db.close();
      if (prevCache === undefined) delete process.env.PEERS_CACHE;
      else process.env.PEERS_CACHE = prevCache;
    }
  }

  // A session directory outside the squad: with --squad <dir> every command
  // must still use the squad's database.
  function elsewhere(s: { tmp: string }): string {
    const dir = path.join(s.tmp, "elsewhere");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  test("open lead --page 2 prints the oldest page", () => {
    const s = setup();
    seedChat(s, "lead", "me", 40);
    const r = cli(s, ["open", "lead", "--page", "2"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("page 2 of 2");
    expect(r.out).toContain("messages 1-20 of 40");
    expect(r.out).toContain("Seed message 1 of 40.");
    expect(r.out).not.toContain("Seed message 40 of 40.");
    expect(r.out).toContain("NEWER: peers open lead --page 1");
    expect(r.out).not.toContain("OLDER:");
  });

  test("open --page 2 lead takes the flag before the target", () => {
    const s = setup();
    seedChat(s, "lead", "me", 25);
    const r = cli(s, ["open", "--page", "2", "lead"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("page 2 of 2");
    expect(r.out).toContain("Seed message 1 of 25.");
  });

  test('open "Lena (lead)" --page=2 takes the = form with a quoted tab name', () => {
    const s = setup();
    setupSquadTabs(s);
    seedChat(s, "lead", "planner", 25);
    const r = cli(s, ["open", "Lena (lead)", "--page=2"], { HERDR_PANE_ID: "", HC_TERMINAL_ID: "t2" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CHAT with lead");
    expect(r.out).toContain("page 2 of 2");
    expect(r.out).toContain("Seed message 1 of 25.");
    expect(r.out).not.toContain("Seed message 25 of 25.");
  });

  test("open lead --page 2 --squad <dir> uses the squad database", () => {
    const s = setup();
    seedChat(s, "lead", "me", 25);
    const other = elsewhere(s);
    const r = cli(s, ["open", "lead", "--page", "2", "--squad", s.squad], { PEERS_CWD: other });
    expect(r.code).toBe(0);
    expect(r.out).toContain("page 2 of 2");
    expect(r.out).toContain("Seed message 1 of 25.");
  });

  test("peers --squad <dir> open lead --page 2 works with the squad before the command", () => {
    const s = setup();
    seedChat(s, "lead", "me", 25);
    const r = cli(s, ["--squad", s.squad, "open", "lead", "--page", "2"], { PEERS_CWD: elsewhere(s) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("page 2 of 2");
    expect(r.out).toContain("Seed message 1 of 25.");
  });

  test("a page past the end is a clear usage error", () => {
    const s = setup();
    seedChat(s, "lead", "me", 25);
    const r = cli(s, ["open", "lead", "--page", "3"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("page 3 does not exist");
  });

  test("delete lead --squad <dir> takes the squad as a value, in any position", () => {
    const s = setup();
    seedChat(s, "lead", "me", 3);
    const other = elsewhere(s);
    const first = cli(s, ["delete", "lead", "--squad", s.squad], { PEERS_CWD: other });
    expect(first.code).toBe(0);
    expect(first.out).toContain("DELETED your view of the chat with lead");
    expect(cli(s, ["chats", "--squad", s.squad], { PEERS_CWD: other }).out).toContain("0 chats");
    // The flag-first order parses too (nothing left to hide, but no usage error).
    const second = cli(s, ["delete", "--squad", s.squad, "lead"], { PEERS_CWD: other });
    expect(second.code).toBe(0);
    expect(second.out).toContain("nothing deleted");
  });

  test("whoami accepts a global --squad before the command", () => {
    const s = setup();
    const r = cli(s, ["--squad", s.squad, "whoami"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("me");
  });

  test("list accepts --squad=<dir>", () => {
    const s = setup();
    const r = cli(s, ["list", `--squad=${s.squad}`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lead  kind=muse");
  });

  test("send --squad <dir> before the target stores in the squad database", () => {
    const s = setup();
    const other = elsewhere(s);
    const r = cli(s, ["send", "--squad", s.squad, "lead", "--kind", "notice", "--seq", "1", "--body", "Hi via squad."], {
      PEERS_CWD: other,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    expect(cli(s, ["open", "lead"]).out).toContain("Hi via squad.");
  });

  test("contacts --squad <dir> lists the squad database from elsewhere", () => {
    const s = setup();
    expect(cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Hi."], {}).code).toBe(0);
    const r = cli(s, ["contacts", "--squad", s.squad], { PEERS_CWD: elsewhere(s) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("lead  status=live");
  });

  test("chats and inbox accept --squad in either form", () => {
    const s = setup();
    seedChat(s, "lead", "me", 1);
    const other = elsewhere(s);
    const chats = cli(s, ["chats", "--squad", s.squad], { PEERS_CWD: other });
    expect(chats.code).toBe(0);
    expect(chats.out).toContain("1 unread message in 1 chat");
    const inbox = cli(s, ["inbox", `--squad=${s.squad}`], { PEERS_CWD: other });
    expect(inbox.code).toBe(0);
    expect(inbox.out).toContain("1 unread message in 1 chat");
  });

  test("open --squad <dir> lead takes the squad before the target", () => {
    const s = setup();
    seedChat(s, "lead", "me", 1);
    const r = cli(s, ["open", "--squad", s.squad, "lead"], { PEERS_CWD: elsewhere(s) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("CHAT with lead");
    expect(r.out).toContain("Seed message 1 of 1.");
  });

  test("delete --squad=<dir> lead takes the = form before the target", () => {
    const s = setup();
    seedChat(s, "lead", "me", 1);
    const r = cli(s, ["delete", `--squad=${s.squad}`, "lead"], { PEERS_CWD: elsewhere(s) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("DELETED your view of the chat with lead");
  });
});

describe("peers 0.1.6 squad-scoped notify", () => {
  // Two squads that both run a live "lead": the sender's squad keeps its own
  // notification, and the other squad's terminal never gets it. t6v sorts
  // first, so a first-match-wins order picks the wrong terminal.
  function setupTwoSquads(s: { tmp: string; bin: string; squad: string }): { framesmith: string; demo: string } {
    const framesmith = s.squad;
    const demo = path.join(s.tmp, "demo");
    fs.mkdirSync(demo, { recursive: true });
    fs.writeFileSync(framesmith + "/roster.json", JSON.stringify({ squad: "framesmith", members: [{ name: "lead" }, { name: "qa-picture" }] }));
    fs.writeFileSync(demo + "/roster.json", JSON.stringify({ squad: "demo", members: [{ name: "lead" }] }));
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t6v", agent: "muse", cwd: path.join(demo, "lead"), state: "live", status: "idle", where: "SWE / 2" },
          { address: "t6g", agent: "muse", cwd: path.join(framesmith, "lead"), state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(s.bin, "herdr-app"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"name":"squad-demo","tabs":[{"name":"Rina (lead)","terminals":[{"terminal":"t6v","app":true}]}]},{"name":"squad-framesmith","tabs":[{"name":"Lena (lead)","terminals":[{"terminal":"t6g","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`,
    );
    return { framesmith, demo };
  }

  test("send framesmith-lead notifies the sender squad's lead, not the other squad's", () => {
    const s = setup();
    setupTwoSquads(s);
    const r = cli(s, ["send", "framesmith-lead", "--kind", "ack", "--seq", "444", "--body", "Seeded report."], {
      PEERS_SELF: "qa-picture",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    expect(r.out).toContain("notified via hc send to t6g");
    expect(r.out).not.toContain("t6v");
    expect(fs.readFileSync(s.hcPrompts, "utf8")).toContain("send t6g New message from");
    // The message itself was stored under the right key all along: lead's
    // inbox holds the chat with its sender.
    const open = cli(s, ["open", "qa-picture"], { PEERS_SELF: "lead", HERDR_PANE_ID: "", HC_TERMINAL_ID: "" });
    expect(open.code).toBe(0);
    expect(open.out).toContain("Seeded report.");
  });

  test("send demo-lead from the other squad notifies its own lead", () => {
    const s = setup();
    const { demo } = setupTwoSquads(s);
    const r = cli(s, ["send", "demo-lead", "--kind", "ack", "--seq", "1", "--body", "Demo report."], {
      PEERS_SELF: "qa",
      PEERS_CWD: demo,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    expect(r.out).toContain("notified via hc send to t6v");
    expect(r.out).not.toContain("t6g");
    expect(fs.readFileSync(s.hcPrompts, "utf8")).toContain("send t6v New message from");
  });

  test("two live leads in one squad stay queued instead of guessing", () => {
    const s = setup();
    fs.writeFileSync(s.squad + "/roster.json", JSON.stringify({ squad: "framesmith", members: [{ name: "lead" }] }));
    fs.writeFileSync(s.tmp + "/agents.json", JSON.stringify({ id: "cli:agent:list", error: { code: "server_not_running" } }));
    fs.writeFileSync(
      s.tmp + "/hc.json",
      JSON.stringify({
        terminals: [
          { address: "t1", agent: "muse", cwd: "/tmp/x", state: "live", status: "idle", where: "SWE / 1" },
          { address: "t2", agent: "muse", cwd: "/tmp/x", state: "live", status: "working", where: "SWE / 1" },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(s.bin, "herdr-app"),
      `#!/bin/bash\nif [ "$1" = "ls" ]; then printf '%s\\n' '{"spaces":[{"tabs":[{"name":"Lena (lead)","terminals":[{"terminal":"t1","app":true}]},{"name":"Rina (lead)","terminals":[{"terminal":"t2","app":true}]}]}]}'; exit 0; fi\necho "unexpected herdr-app call: $*" >&2; exit 9\n`,
    );
    const r = cli(s, ["send", "framesmith-lead", "--kind", "ack", "--seq", "1", "--body", "Which lead?"], {
      PEERS_SELF: "qa-picture",
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    expect(r.out).toContain("queued, not delivered yet");
    expect(r.out).toContain("matches several live terminals in this squad: t1, t2");
    expect(r.out).toContain("No prompt was sent.");
    expect(r.out).not.toContain("notified via");
    expect(prompts(s)).toBe("");
  });
});

describe("peers canonical addresses (0.1.5) continued", () => {
  test("whoami prints the whitespace-free key, which feeds back into every command", () => {
    const s = setup();
    setupSquadTabs(s);
    const who = cli(s, ["whoami"], asTara);
    expect(who.code).toBe(0);
    expect(who.out).toBe("planner");
    expect(who.out).not.toContain(" ");
    const sent = cli(s, ["send", who.out, "--kind", "request", "--seq", "1", "--body", "Via whoami."], fromLead);
    expect(sent.code).toBe(0);
    expect(cli(s, ["chats"], asTara).out).toContain("1 unread message in 1 chat");
  });

  test("a send to a member word is visible in the tab owner's chats", () => {
    const s = setup();
    setupSquadTabs(s);
    const sent = cli(s, ["send", "lead", "--kind", "request", "--seq", "1", "--body", "Tara here."], asTara);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("SENT lead: stored in its inbox (1 unread message)");
    const chats = cli(s, ["chats"], fromLead);
    expect(chats.code).toBe(0);
    expect(chats.out).toContain("INBOX lead");
    expect(chats.out).toContain("1 unread message in 1 chat");
    expect(chats.out).toContain("planner");
    const openTab = cli(s, ["open", "Tara (planner)"], fromLead);
    expect(openTab.code).toBe(0);
    expect(openTab.out).toContain("Tara here.");
    const openMember = cli(s, ["open", "planner"], fromLead);
    expect(openMember.code).toBe(0);
    expect(openMember.out).toContain("Tara here.");
  });

  test("a stated display name never becomes the chat key", () => {
    const s = setup();
    setupSquadTabs(s);
    const first = cli(s, ["send", "planner", "--name", "Lena (lead)", "--role", "lead", "--kind", "request", "--seq", "1", "--body", "First."], fromLead);
    expect(first.code).toBe(0);
    const second = cli(s, ["send", "planner", "--name", "Vrax", "--role", "lead", "--kind", "ack", "--seq", "1", "--body", "Second."], fromLead);
    expect(second.code).toBe(0);
    const logged = fs.readFileSync(s.hcPrompts, "utf8");
    expect(logged).toContain("New message from Lena (lead).");
    expect(logged).toContain("reply: peers open lead");
    expect(logged).not.toContain("peers open Lena (lead)");
    const chats = cli(s, ["chats"], asTara);
    expect(chats.out).toContain("2 unread messages in 1 chat");
    const open = cli(s, ["open", "lead"], asTara);
    expect(open.out).toContain("First.");
    expect(open.out).toContain("Second.");
  });

  test("contacts resolves live status through the canonical key", () => {
    const s = setup();
    expect(cli(s, ["whoami"], { PEERS_SELF: "Lena (lead)", HERDR_PANE_ID: "", PEERS_ROLE: "lead" }).code).toBe(0);
    const contacts = cli(s, ["contacts"]);
    expect(contacts.code).toBe(0);
    expect(contacts.out).toContain("Lena (lead)  status=live");
  });
});
});
