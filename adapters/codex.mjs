// Codex as a worker/reviewer. Rather than re-implement Codex's app-server broker,
// this adapter REUSES the installed codex-plugin-cc runtime (`codex-companion.mjs
// task --json`), which already maintains the broker, resume, and sandboxing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defineAdapter } from "./contract.mjs";
import { extractJson } from "../core/schema.mjs";

function resolveCompanion() {
  if (process.env.AGENT_COLLAB_CODEX_COMPANION) {
    return process.env.AGENT_COLLAB_CODEX_COMPANION;
  }
  const base = path.join(os.homedir(), ".claude/plugins/cache/openai-codex/codex");
  if (!fs.existsSync(base)) return null;
  const versions = fs
    .readdirSync(base)
    .filter((v) => fs.existsSync(path.join(base, v, "scripts/codex-companion.mjs")))
    .sort()
    .reverse();
  return versions.length
    ? path.join(base, versions[0], "scripts/codex-companion.mjs")
    : null;
}

export default defineAdapter({
  name: "codex",
  supportsStructuredOutput: true,
  background: true,
  buildCommand({ role, brief }) {
    const companion = resolveCompanion();
    const args = [companion, "task", "--json"];
    if (role !== "reviewer") args.push("--write");
    args.push(brief);
    return { command: process.execPath, args };
  },
  // Codex/GPT-5.x respond best to XML-tagged, block-structured contracts
  // (see codex-plugin-cc's gpt-5-4-prompting skill).
  outputContract(role) {
    const shape =
      role === "reviewer"
        ? "verdict (approve|needs-attention), summary, findings[] " +
          "(severity, title, body, file, line_start, line_end, confidence, recommendation), next_steps[]"
        : "status (completed|failed|blocked), summary, changed (boolean)";
    return (
      "\n\n<structured_output_contract>\n" +
      "Return only valid JSON with this shape and nothing else:\n" +
      shape +
      "\nPut the highest-value items first. Keep it compact.\n" +
      "</structured_output_contract>"
    );
  },
  parseOutput({ stdout }) {
    // codex-companion `task --json` wraps the answer in an envelope:
    // { status, threadId, rawOutput, touchedFiles, reasoningSummary }.
    // The agent's actual answer is the rawOutput string.
    const env = extractJson(stdout);
    if (env && typeof env.rawOutput === "string") {
      return { answerText: env.rawOutput, structured: null };
    }
    if (env && typeof env.output === "string") {
      return { answerText: env.output, structured: null };
    }
    return { answerText: (stdout ?? "").trim(), structured: null };
  },
  probe() {
    const companion = resolveCompanion();
    if (!companion) return { available: false, error: "codex-companion not installed" };
    return { available: true, version: companion };
  }
});
