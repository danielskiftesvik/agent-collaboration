/**
 * DeepSeek Harness Cordis plugin: registers `/ac` which forwards to
 * scripts/agent-companion.mjs with --driver dsh.
 *
 * Install into the web (interactive) profile:
 *   dsh plugin --profile web add github:danielskiftesvik/agent-collaboration
 *   # or a local checkout:
 *   dsh plugin --profile web add /path/to/agent-collaboration
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION = resolve(ROOT, "scripts/agent-companion.mjs");

export const name = "agent-collaboration";
export const inject = ["commands"];

function splitArgs(str) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "\\" && i + 1 < str.length && (str[i + 1] === '"' || str[i + 1] === "'" || str[i + 1] === "\\")) {
      current += str[++i];
    } else if (inQuote) {
      if (c === quoteChar) inQuote = false;
      else current += c;
    } else if (c === '"' || c === "'") {
      inQuote = true;
      quoteChar = c;
    } else if (c === " " || c === "\t" || c === "\n") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += c;
    }
  }
  if (current || inQuote) args.push(current);
  return args;
}

function withDriver(args) {
  const hasDriver = args.some((a, i) => a === "--driver" || (a.startsWith("--driver=") && i >= 0));
  if (hasDriver) return args;
  return [...args, "--driver", "dsh"];
}

export function apply(ctx) {
  process.env.DSH_PLUGIN_ROOT ??= ROOT;
  ctx.commands.register({
    name: "ac",
    description: "agent-collaboration companion (setup, recommend, delegate, review, …)",
    input: { hint: "<subcommand> [args]" },
    handler(invocation) {
      const extra = String(invocation.rawInput ?? invocation.input ?? "").trim();
      const parsed = extra ? splitArgs(extra) : ["setup"];
      const r = spawnSync(process.execPath, [COMPANION, ...withDriver(parsed)], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DSH_PLUGIN_ROOT: ROOT,
          AGENT_COLLAB_DRIVER: process.env.AGENT_COLLAB_DRIVER || "dsh"
        },
        maxBuffer: 20 * 1024 * 1024
      });
      const text = `${r.stdout || ""}${r.stderr || ""}`.trim() || "(no output)";
      return r.status === 0 ? { kind: "ok", text } : { kind: "error", text };
    }
  });
}
