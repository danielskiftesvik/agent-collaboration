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

export const AgentCollaborationPlugin = async ({ project, client, $, directory, worktree }) => {
  return {
    // Provide a slash command that users can type in the TUI prompt line.
    // The command executes the companion CLI via bun's shell API.
    "tui.command.execute": async (input, output) => {
      const cmd = input.text?.trim();
      if (!cmd || !cmd.startsWith("/agent-collab")) return;

      // Strip the leading "/agent-collab:" prefix to get the subcommand
      const args = cmd.replace(/^\/agent-collab:?\s*/, "").trim();
      if (!args) {
        output.text =
          "agent-collaboration: use /agent-collab:delegate --worker <name> \"<task>\", " +
          "/agent-collab:review --worker <name> \"<context>\", " +
          "/agent-collab:setup, or /agent-collab:recommend --task <type>";
        return;
      }

      // Run the companion CLI — use `node` since opencode provides Bun's `$`
      try {
        const result = await $`node ${COMPANION} ${args.split(/\s+/)}`;
        output.text = result.stdout || result.stderr || "(no output)";
      } catch (e) {
        output.text = `agent-collaboration error: ${e.message || e}`;
      }
    }
  };
};
