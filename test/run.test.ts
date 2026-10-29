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
      { agent: "muse", name: "flaky", pane_id: "w9:p3", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w9" },
      { agent: "muse", pane_id: "w3G:p7", agent_status: "idle", cwd: "/tmp/x", workspace_id: "w3G" },
    ],
  },
};

function setup(): { tmp: string; bin: string; prompts: string; squad: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "peers-test-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const squad = path.join(tmp, "squad");
  fs.mkdirSync(squad, { recursive: true });
  fs.writeFileSync(path.join(tmp, "agents.json"), JSON.stringify(AGENTS));
  const stub = `#!/bin/bash
if [ "$1 $2" = "agent list" ]; then cat "${tmp}/agents.json"; exit 0; fi
if [ "$1 $2" = "agent prompt" ]; then printf '%s\\n' "$*" >>"${tmp}/prompts.log"; [ "$3" = "flaky" ] && { echo "no such agent: flaky" >&2; exit 1; }; exit 0; fi
echo "unexpected herdr call: $*" >&2; exit 9
`;
  fs.writeFileSync(path.join(bin, "herdr"), stub);
  fs.chmodSync(path.join(bin, "herdr"), 0o755);
  return { tmp, bin, prompts: path.join(tmp, "prompts.log"), squad };
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
    expect(r.err).toContain("peers addresses are herdr member names");
  });

  test("sending to yourself is refused", () => {
    const s = setup();
    expect(cli(s, ["send", "me", "--kind", "notice", "--seq", "1", "--body", "Hi."]).code).toBe(2);
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
});
