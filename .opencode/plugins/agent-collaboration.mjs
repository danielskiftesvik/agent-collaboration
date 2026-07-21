// agent-collaboration plugin for OpenCode (driver-side integration).
//
// OpenCode loads plugins differently from Claude Code / Codex:
// - NOT via .opencode/plugin.json (that mechanism does not exist in OpenCode)
// - Instead: JS/TS files placed in .opencode/plugins/ are auto-loaded at startup
// - Or: npm packages listed in opencode.json's "plugin" array
//
// This plugin makes the agent-collaboration companion available inside OpenCode
// sessions by injecting the companion path into the environment and providing
// setup instructions via a custom slash command.
//
// Usage after installation:
//   /agent-collab:delegate --worker <name> "<task>"   — delegate a task
//   /agent-collab:review --worker <name> "<context>"   — request a review
//   /agent-collab:setup                                 — check worker harnesses
//   /agent-collab:recommend --task <type>               — get worker recommendation
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const COMPANION = resolve(PROJECT_ROOT, "scripts/agent-companion.mjs");

// Shell-aware tokenizer: splits on whitespace but preserves quoted strings
// as single arguments with quotes stripped. Handles single and double quotes,
// escaped characters (\\\", \\', \\ ), and unmatched quotes.
function splitArgs(str) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === "\\" && i + 1 < str.length) {
      current += str[++i];
    } else if (inQuote) {
      if (c === quoteChar) {
        inQuote = false;
      } else {
        current += c;
      }
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

export const AgentCollaborationPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "tui.command.execute": async (input, output) => {
      const cmd = input.text?.trim();
      if (!cmd || !cmd.startsWith("/agent-collab")) return;

      const args = cmd.replace(/^\/agent-collab:?\s*/, "").trim();
      if (!args) {
        output.text =
          "agent-collaboration: use /agent-collab:delegate --worker <name> \"<task>\", " +
          "/agent-collab:review --worker <name> \"<context>\", " +
          "/agent-collab:setup, or /agent-collab:recommend --task <type>";
        return;
      }

      try {
        const parsed = splitArgs(args);
        const result = await $`node ${COMPANION} ${parsed}`;
        output.text = result.stdout || result.stderr || "(no output)";
      } catch (e) {
        output.text = `agent-collaboration error: ${e.message || e}`;
      }
    }
  };
};
