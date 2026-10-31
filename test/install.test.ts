import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = fileURLToPath(new URL("../install.sh", import.meta.url));

function fakeAsset(): string {
  return '#!/usr/bin/env bun\nconsole.log("peers 0.3.0");\n';
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function makeRelease(body: string, sums?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "peers-fake-release-"));
  writeFileSync(join(dir, "peers.js"), body);
  chmodSync(join(dir, "peers.js"), 0o755);
  writeFileSync(join(dir, "peers.js.sha256"), sums ?? `${sha256Hex(body)}  peers.js\n`);
  return dir;
}

function testEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.PEERS_VERSION;
  delete env.PEERS_INSTALL_DIR;
  delete env.PEERS_FORCE;
  delete env.PEERS_ASSET;
  delete env.PEERS_BASE_URL;
  delete env.GITHUB_TOKEN;
  return Object.assign(env, extra);
}

function runInstaller(args: string[], extraEnv: Record<string, string>): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync(["sh", INSTALL, ...args], {
    env: testEnv(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout?.toString() ?? "", err: proc.stderr?.toString() ?? "" };
}

describe("install.sh against a fake release", () => {
  test("installs the asset when the hash matches", () => {
    const body = fakeAsset();
    const release = makeRelease(body);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const run = runInstaller(["--dir", dir], { PEERS_BASE_URL: `file://${release}` });
    expect(run.code).toBe(0);
    expect(run.err).toContain(`installed ${dir}/peers`);
    expect(run.err).toContain("not on PATH");
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe(body);
    expect(statSync(join(dir, "peers")).mode & 0o111).not.toBe(0);
  });

  test("a public download needs no token", () => {
    const body = fakeAsset();
    const release = makeRelease(body);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const bin = mkdtempSync(join(tmpdir(), "peers-fakebin-"));
    const gh = `#!/bin/bash\necho "gh should not run for a public release" >&2; exit 9\n`;
    writeFileSync(join(bin, "gh"), gh);
    chmodSync(join(bin, "gh"), 0o755);
    const run = runInstaller(["--dir", dir], {
      PEERS_BASE_URL: `file://${release}`,
      PATH: `${bin}:${process.env.PATH}`,
    });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe(body);
  });

  test("a 404 retries with a token that never appears on argv", () => {
    const body = fakeAsset();
    const sum = `${sha256Hex(body)}  peers.js\n`;
    const logDir = mkdtempSync(join(tmpdir(), "peers-token-log-"));
    const argvLog = join(logDir, "argv.log");
    const stdinLog = join(logDir, "stdin.log");
    const bodySrc = join(logDir, "body.js");
    const sumSrc = join(logDir, "sum.txt");
    writeFileSync(bodySrc, body);
    writeFileSync(sumSrc, sum);
    writeFileSync(argvLog, "");
    writeFileSync(stdinLog, "");
    const bin = mkdtempSync(join(tmpdir(), "peers-fakebin-"));
    const fakeCurl = `#!/bin/bash
printf 'ARGV:%s\\n' "$*" >>"${argvLog}"
if [[ " $* " == *" -w "* ]]; then printf '404'; exit 0; fi
if [[ " $* " == *" -K "* ]]; then
  cat >"${stdinLog}.tmp"
  cat "${stdinLog}.tmp" >>"${stdinLog}"
  OUT=""; PREV=""
  for a in "$@"; do
    if [ "$PREV" = "-o" ]; then OUT="$a"; fi
    PREV="$a"
  done
  URL="\${@: -1}"
  if [[ "$URL" == *"/releases/tags/"* ]]; then
    printf '%s\\n' '"url": "https://api.github.com/repos/bdsanxz/peers/releases/assets/111",' '"name": "peers.js",' '"url": "https://api.github.com/repos/bdsanxz/peers/releases/assets/222",' '"name": "peers.js.sha256",' >"$OUT"
    exit 0
  elif [[ "$URL" == *"/assets/111"* ]]; then cp "${bodySrc}" "$OUT"; exit 0
  elif [[ "$URL" == *"/assets/222"* ]]; then cp "${sumSrc}" "$OUT"; exit 0
  else echo "unexpected URL $URL" >&2; exit 9; fi
fi
exit 22
`;
    writeFileSync(join(bin, "curl"), fakeCurl);
    chmodSync(join(bin, "curl"), 0o755);
    const fakeGh = `#!/bin/bash\nif [ "$1 $2" = "auth token" ]; then printf 'SECRET123'; exit 0; fi\necho "unexpected gh call: $*" >&2; exit 9\n`;
    writeFileSync(join(bin, "gh"), fakeGh);
    chmodSync(join(bin, "gh"), 0o755);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const run = runInstaller(["--dir", dir, "--version", "v0.0.1"], { PATH: `${bin}:${process.env.PATH}` });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe(body);
    const argv = readFileSync(argvLog, "utf8");
    const stdinData = readFileSync(stdinLog, "utf8");
    expect(argv).not.toContain("Bearer");
    expect(stdinData).toContain("Authorization: Bearer ");
  });

  test("a hash mismatch refuses and leaves the old file untouched", () => {
    const release = makeRelease(fakeAsset(), `${"0".repeat(64)}  peers.js\n`);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    writeFileSync(join(dir, "peers"), "old peers\n");
    const run = runInstaller(["--dir", dir], { PEERS_BASE_URL: `file://${release}` });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("checksum mismatch");
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe("old peers\n");
  });

  test("shasum stands in when sha256sum is missing", () => {
    const body = fakeAsset();
    const release = makeRelease(body);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const bunDir = dirname(Bun.which("bun") ?? "/usr/bin");
    const run = runInstaller(["--dir", dir], { PEERS_BASE_URL: `file://${release}`, PATH: `${bunDir}:/usr/bin:/bin` });
    expect(run.code).toBe(0);
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe(body);
  });

  test("a foreign symlink needs --force", () => {
    const body = fakeAsset();
    const release = makeRelease(body);
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const target = join(dir, "dev-peers");
    writeFileSync(target, "dev build\n");
    symlinkSync(target, join(dir, "peers"));
    const refused = runInstaller(["--dir", dir], { PEERS_BASE_URL: `file://${release}` });
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("symlink");
    expect(refused.err).toContain(target);
    expect(lstatSync(join(dir, "peers")).isSymbolicLink()).toBe(true);
    const forced = runInstaller(["--dir", dir, "--force"], { PEERS_BASE_URL: `file://${release}` });
    expect(forced.code).toBe(0);
    expect(lstatSync(join(dir, "peers")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, "peers"), "utf8")).toBe(body);
  });

  test("peers.js without bun on PATH is a clear error", () => {
    const release = makeRelease(fakeAsset());
    const dir = mkdtempSync(join(tmpdir(), "peers-install-"));
    const run = runInstaller(["--dir", dir], { PEERS_BASE_URL: `file://${release}`, PATH: "/usr/bin:/bin" });
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("bun is required");
    expect(existsSync(join(dir, "peers"))).toBe(false);
  });

  test("unknown option is a clear error", () => {
    const run = runInstaller(["--bogus"], {});
    expect(run.code).not.toBe(0);
    expect(run.err).toContain("unknown option");
  });

  test("--help names every option", () => {
    const run = runInstaller(["--help"], {});
    expect(run.code).toBe(0);
    expect(run.out).toContain("--version");
    expect(run.out).toContain("--dir");
    expect(run.out).toContain("--force");
    expect(run.out).not.toContain("--from-source");
  });
});
