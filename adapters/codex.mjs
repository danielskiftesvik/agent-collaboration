// Codex as a worker/reviewer. Rather than re-implement Codex's app-server broker,
// this adapter REUSES the installed codex-plugin-cc runtime (`codex-companion.mjs
// task --json`), which already maintains the broker, resume, and sandboxing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineAdapter } from "./contract.mjs";
import { extractJson } from "../core/schema.mjs";
import { resolvePin } from "../core/pins.mjs";
import { resolvePeersDir } from "../core/peers.mjs";

const CLEANUP_BROKER = fileURLToPath(new URL("../scripts/cleanup-codex-broker.mjs", import.meta.url));

function scopedDataDir(artifactDir) {
  return artifactDir ? path.join(artifactDir, "codex-companion") : null;
}

/** Shared peer mailbox the worker should treat as writable (env + addDirs). */
export function resolveCodexAddDirs(env = process.env) {
  const dirs = [];
  if (env.AGENT_COLLAB_CODEX_ADD_DIR) dirs.push(path.resolve(env.AGENT_COLLAB_CODEX_ADD_DIR));
  try {
    dirs.push(path.resolve(resolvePeersDir()));
  } catch {
    /* no data root yet */
  }
  return [...new Set(dirs)];
}

function scopedEnv(artifactDir) {
  const dataDir = scopedDataDir(artifactDir);
  const env = dataDir ? { CLAUDE_PLUGIN_DATA: dataDir } : {};
  // Prefer explicit AGENT_COLLAB_CODEX_HOME (companion knob), else ambient
  // CODEX_HOME (e.g. codex-business wrapper / instance overlay). Forward so
  // codex-companion + nested `codex` see the intended home.
  const home = process.env.AGENT_COLLAB_CODEX_HOME || process.env.CODEX_HOME;
  if (home) env.CODEX_HOME = home;
  const addDirs = resolveCodexAddDirs();
  if (addDirs[0]) env.AGENT_COLLAB_PEERS_DIR = addDirs[0];
  return env;
}

// Model/effort resolution. Precedence: the explicit generic env wins (the "this
// dispatch" escalation lever), then the role-scoped env (a standing default for
// that role), then the repo's tracked `.agent-collab.json` pin (the standing
// instrument, identical for every driver harness — see core/pins.mjs), else no
// flag at all — the user's ~/.codex/config.toml governs (which the codex TUI
// rewrites with the last interactively-used model, so it is drift, not doctrine).
function codexModel(role, workspace, profile) {
  return (
    process.env.AGENT_COLLAB_CODEX_MODEL ||
    (role === "reviewer" ? process.env.AGENT_COLLAB_CODEX_MODEL_REVIEW : null) ||
    resolvePin("codex", role, workspace, profile).model
  );
}

function codexEffort(role, workspace, profile) {
  return (
    process.env.AGENT_COLLAB_CODEX_EFFORT ||
    (role === "reviewer" ? process.env.AGENT_COLLAB_CODEX_EFFORT_REVIEW : null) ||
    resolvePin("codex", role, workspace, profile).effort
  );
}

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
  buildCommand({ role, brief, workspace, artifactDir, profile }) {
    const companion = resolveCompanion();
    const args = [companion, "task", "--json"];
    if (role !== "reviewer") args.push("--write");
    const model = codexModel(role, workspace, profile);
    if (model) args.push("--model", model);
    const effort = codexEffort(role, workspace, profile);
    if (effort) args.push("--effort", effort);
    args.push(brief);
    const env = scopedEnv(artifactDir);
    // Do not pass --add-dir to today's codex-companion (unknown flags become
    // prompt positionals). Record addDirs + PEERS_DIR so a newer companion or
    // `codex exec --add-dir` can consume them; sandbox write still needs that.
    return { command: process.execPath, args, env, addDirs: resolveCodexAddDirs() };
  },
  // Repair by RESUMING the worker's existing thread (`task --resume-last`) instead
  // of re-running the whole task cold — the reference's reliability trait. The
  // thread already holds the diff/context, so we send only a short "emit clean
  // JSON" ask. Disable with AGENT_COLLAB_CODEX_RESUME=off (-> fresh re-send).
  buildRetryCommand({ role, repairBrief, artifactDir }) {
    if (process.env.AGENT_COLLAB_CODEX_RESUME === "off") return null;
    const companion = resolveCompanion();
    if (!companion) return null;
    const args = [companion, "task", "--json", "--resume-last"];
    if (role !== "reviewer") args.push("--write");
    // No --model/--effort on resume: the resumed thread already carries the
    // model it was started with; re-pinning here could conflict with it.
    args.push(repairBrief);
    const env = scopedEnv(artifactDir);
    return { command: process.execPath, args, env, addDirs: resolveCodexAddDirs() };
  },
  progressDirs({ artifactDir }) {
    const dataDir = scopedDataDir(artifactDir);
    return dataDir ? [dataDir] : [];
  },
  buildCleanupCommand({ workspace, artifactDir }) {
    const companion = resolveCompanion();
    const dataDir = scopedDataDir(artifactDir);
    if (!companion || !dataDir || !workspace) return null;
    return {
      command: process.execPath,
      args: [
        CLEANUP_BROKER,
        "--companion", companion,
        "--workspace", workspace,
        "--plugin-data", dataDir
      ],
      // Same CODEX_HOME / CLAUDE_PLUGIN_DATA as task/retry so broker teardown
      // targets the home the worker actually used.
      env: scopedEnv(artifactDir)
    };
  },
  // codex-companion errors clearly when there's no thread to resume; detect that so
  // dispatch can fall back to a fresh re-send rather than fail the repair.
  isResumeMiss({ stdout, stderr }) {
    const t = `${stdout ?? ""}\n${stderr ?? ""}`;
    return /no previous[\s\S]*thread|no resumable task|thread was found/i.test(t);
  },
  // Codex responds best to XML-tagged, block-structured contracts.
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
      "\nPut the highest-value items first. Every actionable defect must be a finding; " +
      "never hide defects in summary or next_steps. A needs-attention verdict requires at least one finding. " +
      "Keep it compact.\n" +
      "</structured_output_contract>"
    );
  },
  parseOutput({ stdout }) {
    // codex-companion `task --json` wraps the answer in an envelope:
    // { status, threadId, rawOutput, touchedFiles, reasoningSummary }.
    // The agent's actual answer is the rawOutput string.
    const env = extractJson(stdout);
    if (env && typeof env.rawOutput === "string") {
      return {
        answerText: env.rawOutput,
        structured: null,
        telemetry: { threadId: env.threadId ?? null, resolvedModel: env.model ?? null }
      };
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
