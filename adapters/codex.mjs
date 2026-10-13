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
// Memory stays at one chunk plus one kept line; the file cap only bounds time.
const MAX_JOB_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 1024 * 1024 * 1024;
const ROLLOUT_CHUNK_BYTES = 1024 * 1024;
const MAX_TURN_CONTEXT_LINE_BYTES = 1024 * 1024;
// A turn_context record names its kind as `"type":"turn_context"` with any
// JSON whitespace and in any key position. Inside a JSON string the quotes
// are escaped (\"type\"), so a mention in tool output never matches.
const TURN_CONTEXT_RE = /"type"\s*:\s*"turn_context"/;
const TURN_CONTEXT_WORD = Buffer.from("turn_context");
// Overflow lines (over the per-line cap) are scanned for the marker through a
// sliding window instead of being held.
const MARK_WINDOW_BYTES = 256;

function realpathOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

// Directory listing for the scan. A missing ROOT is an empty scan ([]); any
// error on a child that its parent just listed, ENOENT included, means the
// scan is incomplete and returns null.
function listDir(dir, withFileTypes, { root = false } = {}) {
  try {
    return fs.readdirSync(dir, withFileTypes ? { withFileTypes: true } : undefined);
  } catch (err) {
    return root && err && err.code === "ENOENT" ? [] : null;
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

// The turn id of a SINGLE-ATTEMPT job, else null. artifactDir is one
// agent-collaboration job; each companion task (the first attempt and every
// repair re-send or resume) leaves one record in a jobs directory under it.
// Telemetry binds only when there is exactly one such record, it is
// completed, and it names this thread. Any repair attempt or sibling job
// returns null, so no turn is ever chosen by wall-clock order.
function singleAttemptTurnId(artifactDir, threadId) {
  const realArtifactDir = realpathOrNull(artifactDir);
  if (!realArtifactDir) return null;
  const root = path.join(artifactDir, "codex-companion", "state");
  const slugs = listDir(root, true, { root: true });
  if (!slugs) return null;
  const records = [];
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
      records.push(job);
      if (records.length > 1) return null; // a repair attempt or a sibling job
    }
  }
  if (records.length !== 1) return null;
  const job = records[0];
  if (job.status !== "completed" || job.threadId !== threadId) return null;
  return UUID_RE.test(job.turnId || "") ? job.turnId : null;
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

function settingsField(settings, key) {
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, key)) return undefined;
  return settings[key];
}

// Null (ambiguous) unless every turn_context record for the turn parses, is
// complete, and agrees. The rollout is read in ROLLOUT_CHUNK_BYTES chunks up to
// the size seen at open; a file over MAX_ROLLOUT_BYTES is refused before any
// read. Lines up to MAX_TURN_CONTEXT_LINE_BYTES are held until their end and
// parsed only if they carry the turn_context marker; a longer line is dropped
// as it streams and, if the marker shows up in it, the scan is ambiguous. The
// first matching row is kept and each later one compared at once.
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
    let first = null;
    let ambiguous = false;
    let pieces = [];
    let lineBytes = 0;
    let overflow = false;
    let tail = Buffer.alloc(0); // overflow window carry

    const consider = (row) => {
      if (row === null) ambiguous = true;
      else if (row) {
        if (!first) first = row;
        else if (row.model !== first.model || row.effort !== first.effort) ambiguous = true;
      }
    };
    const overflowScan = (seg) => {
      const win = Buffer.concat([tail, seg]);
      if (win.includes(TURN_CONTEXT_WORD) && TURN_CONTEXT_RE.test(win.toString("utf8"))) ambiguous = true;
      tail = Buffer.from(win.subarray(Math.max(0, win.length - MARK_WINDOW_BYTES)));
    };
    const take = (seg) => {
      if (!seg.length) return;
      lineBytes += seg.length;
      if (overflow) {
        overflowScan(seg);
        return;
      }
      pieces.push(seg);
      if (lineBytes > MAX_TURN_CONTEXT_LINE_BYTES) {
        overflow = true;
        const held = Buffer.concat(pieces);
        pieces = [];
        overflowScan(held);
      }
    };
    const endLine = () => {
      if (!overflow && lineBytes > 0) {
        const line = Buffer.concat(pieces);
        if (line.includes(TURN_CONTEXT_WORD)) {
          const text = line.toString("utf8");
          if (TURN_CONTEXT_RE.test(text)) consider(turnContextRow(text, turnId));
        }
      }
      pieces = [];
      lineBytes = 0;
      overflow = false;
      tail = Buffer.alloc(0);
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
    return ambiguous ? null : first;
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

// One candidate line: false = not this turn's record (skip), null =
// ambiguous, otherwise { model, effort }.
function turnContextRow(line, turnId) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  if (rec.type !== "turn_context") return false; // the marker sat in a nested object
  const payload = rec.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const recTurn = nonemptyString(payload.turn_id);
  if (!recTurn) return null;
  if (recTurn !== turnId) return false;
  const model = nonemptyString(payload.model);
  const effort = nonemptyString(payload.effort);
  if (!model || !effort) return null;
  const settings = payload.collaboration_mode?.settings;
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
  const turnId = singleAttemptTurnId(artifactDir, tid);
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
