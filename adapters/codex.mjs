// Codex as a worker/reviewer. Rather than re-implement Codex's app-server broker,
// this adapter REUSES the installed codex-plugin-cc runtime (`codex-companion.mjs
// task --json`), which already maintains the broker, resume, and sandboxing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineAdapter } from "./contract.mjs";
import { extractJson, REACHABLE_SCENARIO_INSTRUCTION } from "../core/schema.mjs";
import { resolvePin } from "../core/pins.mjs";

const CLEANUP_BROKER = fileURLToPath(new URL("../scripts/cleanup-codex-broker.mjs", import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyTelemetry(threadId = null, turnId = null) {
  return { threadId, turnId, resolvedModel: null, effort: null };
}

function resolveCodexHome(env = {}) {
  return (
    env.CODEX_HOME ||
    env.AGENT_COLLAB_CODEX_HOME ||
    process.env.CODEX_HOME ||
    path.join(os.homedir(), ".codex")
  );
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Job records must resolve (symlinks followed) inside artifactDir: a link that
// escapes it is ignored. Rollouts keep the lexical isInside check because a
// Codex home may legitimately symlink its sessions directory elsewhere.
function isInsideReal(root, candidate) {
  try {
    return isInside(fs.realpathSync.native(root), fs.realpathSync.native(candidate));
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function completedTurnId(artifactDir, threadId) {
  const root = path.join(artifactDir, "codex-companion", "state");
  let slugs;
  try {
    slugs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const jobs = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const jobsDir = path.join(root, slug.name, "jobs");
    let names;
    try {
      names = fs.readdirSync(jobsDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(jobsDir, name);
      if (!isInsideReal(artifactDir, full)) continue;
      const job = readJsonFile(full);
      if (!job || job.status !== "completed") continue;
      if (job.threadId !== threadId) continue;
      if (!UUID_RE.test(job.turnId || "")) return null;
      const ms = parseCanonicalUtcMs(job.completedAt);
      if (ms === null) return null;
      jobs.push({ turnId: job.turnId, ms });
    }
  }
  if (!jobs.length) return null;
  let latest = jobs[0].ms;
  for (const job of jobs) {
    if (job.ms > latest) latest = job.ms;
  }
  const top = jobs.filter((job) => job.ms === latest);
  const ids = new Set(top.map((job) => job.turnId));
  if (ids.size !== 1) return null;
  return top[0].turnId;
}

function findRollout(home, threadId) {
  const sessions = path.join(home, "sessions");
  let years;
  try {
    years = fs.readdirSync(sessions, { withFileTypes: true });
  } catch {
    return null;
  }
  const matches = [];
  const suffix = `-${threadId}.jsonl`;
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearDir = path.join(sessions, year.name);
    let months;
    try {
      months = fs.readdirSync(yearDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(yearDir, month.name);
      let days;
      try {
        days = fs.readdirSync(monthDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayDir = path.join(monthDir, day.name);
        let files;
        try {
          files = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        for (const name of files) {
          if (!name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
          const full = path.join(dayDir, name);
          if (!isInside(home, full)) continue;
          matches.push(full);
        }
      }
    }
  }
  if (matches.length !== 1) return null;
  return matches[0];
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCanonicalUtcMs(value) {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString() !== value) return null;
  return ms;
}

function settingsField(settings, key) {
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, key)) return undefined;
  return settings[key];
}

function readTurnContext(rolloutPath, turnId) {
  let text;
  try {
    text = fs.readFileSync(rolloutPath, "utf8");
  } catch {
    return null;
  }
  const found = [];
  for (const line of text.split("\n")) {
    if (!line.includes("turn_context")) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== "turn_context" || !rec.payload) continue;
    if (rec.payload.turn_id !== turnId) continue;
    const model = nonemptyString(rec.payload.model);
    const effort = nonemptyString(rec.payload.effort);
    if (!model || !effort) return null;
    const settings = rec.payload.collaboration_mode?.settings;
    const nestedModel = settingsField(settings, "model");
    if (nestedModel !== undefined) {
      const nested = nonemptyString(nestedModel);
      if (!nested || nested !== model) return null;
    }
    const nestedEffort = settingsField(settings, "reasoning_effort");
    if (nestedEffort !== undefined) {
      const reasoning = nonemptyString(nestedEffort);
      if (!reasoning || reasoning !== effort) return null;
    }
    found.push({ model, effort });
  }
  if (!found.length) return null;
  const first = found[0];
  for (const row of found.slice(1)) {
    if (row.model !== first.model || row.effort !== first.effort) return null;
  }
  return first;
}

function resolveCodexTurnTelemetry({ artifactDir, env, threadId }) {
  const tid = nonemptyString(threadId);
  if (!tid || !UUID_RE.test(tid)) return emptyTelemetry(null, null);
  if (!artifactDir) return emptyTelemetry(tid, null);
  const turnId = completedTurnId(artifactDir, tid);
  if (!turnId) return emptyTelemetry(tid, null);
  const home = resolveCodexHome(env || {});
  const rollout = findRollout(home, tid);
  if (!rollout) return emptyTelemetry(tid, turnId);
  const ctx = readTurnContext(rollout, turnId);
  if (!ctx) return emptyTelemetry(tid, turnId);
  return { threadId: tid, turnId, resolvedModel: ctx.model, effort: ctx.effort };
}

function scopedDataDir(artifactDir) {
  return artifactDir ? path.join(artifactDir, "codex-companion") : null;
}

function scopedEnv(artifactDir) {
  const dataDir = scopedDataDir(artifactDir);
  const env = dataDir ? { CLAUDE_PLUGIN_DATA: dataDir } : {};
  // Prefer explicit AGENT_COLLAB_CODEX_HOME (companion knob), else ambient
  // CODEX_HOME (e.g. codex-business wrapper / instance overlay). Forward so
  // codex-companion + nested `codex` see the intended home.
  const home = process.env.AGENT_COLLAB_CODEX_HOME || process.env.CODEX_HOME;
  if (home) env.CODEX_HOME = home;
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
    return { command: process.execPath, args, env: scopedEnv(artifactDir) };
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
    return { command: process.execPath, args, env: scopedEnv(artifactDir) };
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
          "(severity, title, body, file, line_start, line_end, confidence, recommendation, reachable_scenario), " +
          "next_steps[]"
        : "status (completed|failed|blocked), summary, changed (boolean)";
    return (
      "\n\n<structured_output_contract>\n" +
      "Return only valid JSON with this shape and nothing else:\n" +
      shape +
      "\nPut the highest-value items first. Every actionable defect must be a finding; " +
      "never hide defects in summary or next_steps. A needs-attention verdict requires at least one finding. " +
      (role === "reviewer" ? REACHABLE_SCENARIO_INSTRUCTION + " " : "") +
      "Keep it compact.\n" +
      "</structured_output_contract>"
    );
  },
  parseOutput({ stdout, artifactDir, env }) {
    // codex-companion `task --json` wraps the answer in an envelope:
    // { status, threadId, rawOutput, touchedFiles, reasoningSummary }.
    // Model/effort come from the bound turn_context, never the envelope.
    const extracted = extractJson(stdout);
    if (extracted && typeof extracted.rawOutput === "string") {
      return {
        answerText: extracted.rawOutput,
        structured: null,
        telemetry: resolveCodexTurnTelemetry({
          artifactDir,
          env,
          threadId: extracted.threadId
        })
      };
    }
    if (extracted && typeof extracted.output === "string") {
      return { answerText: extracted.output, structured: null };
    }
    return { answerText: (stdout ?? "").trim(), structured: null };
  },
  probe() {
    const companion = resolveCompanion();
    if (!companion) return { available: false, error: "codex-companion not installed" };
    return { available: true, version: companion };
  }
});
