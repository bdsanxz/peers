import { UsageError } from "./args.ts";
import { HELP, dispatch } from "./commands.ts";
import pkg from "../package.json" with { type: "json" };

let args = process.argv.slice(2);
// A global --squad <dir> may precede the command; move it behind so each command parses it.
if (args[0] === "--squad" && args.length >= 3) {
  const [, dir, cmd, ...rest] = args;
  args = [cmd!, ...rest, "--squad", dir!];
}
const [cmd, ...rest] = args;
if (cmd === "--version" || cmd === "-V" || cmd === "version") {
  console.log(`peers ${pkg.version}`);
  process.exit(0);
}
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  console.log(HELP[""]);
  process.exit(cmd ? 0 : 2);
}
const label = cmd;
try {
  if (rest.includes("--help") && rest.length === 1) {
    const text = HELP[cmd];
    if (!text) throw new UsageError(`unknown command "${cmd}"`);
    console.log(text);
    process.exit(0);
  }
  process.exitCode = await dispatch(cmd, rest);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof UsageError || msg.startsWith("the message is stored ")) {
    console.error(`peers ${label}: ${msg}\nRun \`peers ${label} --help\` for usage.`);
    process.exitCode = 2;
  } else {
    console.error(`peers ${label}: ${msg}`);
    process.exitCode = 1;
  }
}
