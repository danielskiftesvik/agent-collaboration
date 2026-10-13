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

// Bounds for the telemetry scan. Every failed, oversized or incomplete read is
// ambiguous and yields null; nothing is ever inferred from a partial scan.
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const ROLLOUT_CHUNK_BYTES = 1024 * 1024;
const MAX_TURN_CONTEXT_LINE_BYTES = 1024 * 1024;
// A rollout line is `{"timestamp":…,"type":<kind>,"payload":…}`; the record
// kind sits in the first bytes, so only lines whose head names turn_context
// are kept and parsed. Other lines (tool output can be megabytes) are skipped
// without being held in memory.
const LINE_HEAD_BYTES = 256;
const TURN_CONTEXT_MARK = '"type":"turn_context"';

function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// Directory listing for the scan: [] when the directory does not exist, null
// (ambiguous) when it exists but cannot be read.
function listDir(dir, withFileTypes) {
  try {
    return fs.readdirSync(dir, withFileTypes ? { withFileTypes: true } : undefined);
  } catch (err) {
    return err && err.code === "ENOENT" ? [] : null;
  }
}

// Null when the file is unreadable, over the cap, or not a JSON object.
function readJsonFile(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function completedTurnId(artifactDir, threadId) {
  const realArtifactDir = realpathOrNull(artifactDir);
  if (!realArtifactDir) return null;
  const root = path.join(artifactDir, "codex-companion", "state");
  const slugs = listDir(root, true);
  if (!slugs) return null;
  const jobs = [];
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue;
    const jobsDir = path.join(root, slug.name, "jobs");
    const names = listDir(jobsDir, false);
    if (!names) return null;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(jobsDir, name);
      // Job records must resolve (symlinks followed) inside artifactDir.
      const real = realpathOrNull(full);
      if (!real || !isInside(realArtifactDir, real)) return null;
      const job = readJsonFile(full, MAX_JOB_BYTES);
      if (!job) return null;
      if (job.status !== "completed") continue;
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

// The sessions root may itself be a symlink (resolved first); each matching
// rollout must then resolve inside that real root.
function findRollout(home, threadId) {
  const sessions = path.join(home, "sessions");
  const realSessions = realpathOrNull(sessions);
  if (!realSessions) return null;
  const years = listDir(sessions, true);
  if (!years) return null;
  const matches = [];
  const suffix = `-${threadId}.jsonl`;
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearDir = path.join(sessions, year.name);
    const months = listDir(yearDir, true);
    if (!months) return null;
    for (const month of months) {
      if (!month.isDirectory()) continue;
      const monthDir = path.join(yearDir, month.name);
      const days = listDir(monthDir, true);
      if (!days) return null;
      for (const day of days) {
        if (!day.isDirectory()) continue;
        const dayDir = path.join(monthDir, day.name);
        const files = listDir(dayDir, false);
        if (!files) return null;
        for (const name of files) {
          if (!name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
          const full = path.join(dayDir, name);
          const real = realpathOrNull(full);
          if (!real || !isInside(realSessions, real)) return null;
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

// Null (ambiguous) unless every turn_context record for the turn parses, is
// complete, and agrees. The rollout is read in bounded chunks: a file over
// MAX_ROLLOUT_BYTES is refused before any read, at most the size seen at open
// is read, and only turn_context lines (each capped) are held in memory.
function readTurnContext(rolloutPath, turnId) {
  let fd;
  try {
    fd = fs.openSync(rolloutPath, "r");
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ROLLOUT_BYTES) return null;
    const found = [];
    let pieces = [];
    let lineBytes = 0;
    let mode = "head"; // head -> keep | skip, per line
    let ambiguous = false;

    const decide = () => {
      const head = Buffer.concat(pieces).subarray(0, LINE_HEAD_BYTES).toString("utf8");
      if (head.includes(TURN_CONTEXT_MARK)) {
        mode = "keep";
      } else {
        mode = "skip";
        pieces = [];
      }
    };
    const endLine = () => {
      if (mode === "head" && lineBytes > 0) decide();
      if (mode === "keep") {
        const row = turnContextRow(Buffer.concat(pieces).toString("utf8"), turnId);
        if (row === null) ambiguous = true;
        else if (row) found.push(row);
      }
      pieces = [];
      lineBytes = 0;
      mode = "head";
    };
    const take = (seg) => {
      if (!seg.length || mode === "skip") {
        lineBytes += seg.length;
        return;
      }
      pieces.push(seg);
      lineBytes += seg.length;
      if (mode === "head" && lineBytes >= LINE_HEAD_BYTES) decide();
      if (mode === "keep" && lineBytes > MAX_TURN_CONTEXT_LINE_BYTES) ambiguous = true;
    };

    const buf = Buffer.alloc(Math.min(ROLLOUT_CHUNK_BYTES, Math.max(1, st.size)));
    let remaining = st.size;
    while (remaining > 0 && !ambiguous) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), null);
      if (n <= 0) return null; // shrank under us: incomplete scan
      remaining -= n;
      const chunk = Buffer.from(buf.subarray(0, n));
      let pos = 0;
      while (pos < n && !ambiguous) {
        const nl = chunk.indexOf(10, pos);
        if (nl === -1) {
          take(chunk.subarray(pos));
          pos = n;
        } else {
          take(chunk.subarray(pos, nl));
          endLine();
          pos = nl + 1;
        }
      }
    }
    if (!ambiguous && lineBytes > 0) endLine(); // final line without a newline
    if (ambiguous || !found.length) return null;
    const first = found[0];
    for (const row of found.slice(1)) {
      if (row.model !== first.model || row.effort !== first.effort) return null;
    }
    return first;
  } catch {
    return null;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
}

// One kept line: false = not this turn's record (skip), null = ambiguous,
// otherwise { model, effort }.
function turnContextRow(line, turnId) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (rec?.type !== "turn_context") return false;
  if (!rec.payload || typeof rec.payload !== "object") return null;
  if (rec.payload.turn_id !== turnId) return false;
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
  return { model, effort };
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
    // Every path returns explicit telemetry: dispatch attributes the result to
    // this attempt alone, so a missing value must read as null, never as
    // "keep the previous attempt's".
    if (extracted && typeof extracted.output === "string") {
      return {
        answerText: extracted.output,
        structured: null,
        telemetry: resolveCodexTurnTelemetry({ artifactDir, env, threadId: extracted.threadId })
      };
    }
    return { answerText: (stdout ?? "").trim(), structured: null, telemetry: emptyTelemetry() };
  },
  probe() {
    const companion = resolveCompanion();
    if (!companion) return { available: false, error: "codex-companion not installed" };
    return { available: true, version: companion };
  }
});
