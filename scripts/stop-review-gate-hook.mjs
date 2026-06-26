#!/usr/bin/env node
// Claude Code Stop hook. Reads the hook payload on stdin and, when the opt-in
// review gate is enabled (and we are not already re-entrant), blocks the stop and
// asks for a cross-harness review. Derived from codex-plugin-cc's stop gate.
import { loadState } from "../core/state.mjs";
import { decideStop } from "../core/stop-gate.mjs";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // If nothing is piped, don't hang.
    setTimeout(() => resolve(data), 200).unref?.();
  });
}

const raw = await readStdin();
let payload = {};
try {
  payload = JSON.parse(raw || "{}");
} catch {
  payload = {};
}

const cwd = payload.cwd || process.cwd();
const config = loadState(cwd).config;
const decision = decideStop({ stopHookActive: payload.stop_hook_active, config });

if (decision.block) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: decision.reason }) + "\n");
}
process.exit(0);
