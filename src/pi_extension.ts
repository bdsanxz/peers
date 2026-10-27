/**
 * peers: delivers peer notifications into this pi session as user turns.
 *
 * The peers binary embeds this file: `peers pi-extension` prints it, and `pi -e "$(peers
 * pi-extension --path)"` loads it for one run. Install it for every pi session with
 * `peers pi-extension > ~/.pi/agent/extensions/peers.ts`.
 *
 * In an interactive (or RPC) session it runs `peers _pi-listen pi:<session id>`, which claims the
 * session's notification queue in its squad database and prints one line per notification. Each
 * line becomes a user turn: started at once when pi is idle, steered into the running turn
 * otherwise. One-shot runs (print and JSON modes, and the headless runs `peers send --headless`
 * starts) do not listen: `peers send` delivers to them itself. Loaded twice (installed and with
 * -e), only the first copy listens.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The copy that listens in this pi process, so a second copy of this file stays quiet.
const OWNER = Symbol.for("peers.pi-extension.owner");
const owners = globalThis as unknown as Record<symbol, object | undefined>;

export default function (pi: ExtensionAPI) {
	let child: ChildProcess | undefined;
	let current: string | undefined;
	const me = {};

	const stop = () => {
		if (owners[OWNER] === me) owners[OWNER] = undefined;
		const c = child;
		child = undefined;
		current = undefined;
		if (c && c.exitCode === null) {
			c.stdin?.end();
			c.kill("SIGTERM");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
		if (process.env.PEERS_PI_HEADLESS) return;
		const id = ctx.sessionManager.getSessionId();
		if (!id || !ctx.sessionManager.getSessionFile()) return; // ephemeral sessions have no address
		const address = `pi:${id}`;
		if (current === address && child && child.exitCode === null) return;
		stop();
		if (owners[OWNER] && owners[OWNER] !== me) return; // another copy of this extension listens
		owners[OWNER] = me;

		const cwd = ctx.sessionManager.getCwd();
		const proc = spawn("peers", ["_pi-listen", address, "--cwd", cwd], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PEERS_SELF: address },
		});
		child = proc;
		current = address;

		let stderr = "";
		proc.stderr?.on("data", (d) => {
			stderr = (stderr + String(d)).slice(-2000);
		});
		proc.on("error", (e) => {
			if (child !== proc) return;
			child = undefined;
			if (ctx.hasUI) ctx.ui.notify(`peers: cannot start the listener (${e.message}); is peers on PATH?`, "warning");
		});
		proc.on("exit", (code) => {
			if (child !== proc) return;
			child = undefined;
			if (code && ctx.hasUI) ctx.ui.notify(`peers: the listener stopped (exit ${code}): ${stderr.trim()}`, "warning");
		});

		readline.createInterface({ input: proc.stdout! }).on("line", (line) => {
			const text = line.trim();
			if (!text || child !== proc) return;
			if (ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "steer" });
		});
	});

	pi.on("session_shutdown", async () => {
		stop();
	});
}
