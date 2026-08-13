// Grok Build (xAI `grok` CLI) as a worker/reviewer. Headless `--single` with
// `--output-format streaming-json`. Reviewers run read-only via
// `--permission-mode plan`; workers run `--permission-mode bypassPermissions`
// (every weaker mode cancels on the first shell tool call headlessly — see
// buildCommand).
// Product: Grok Build. Binary / adapter id: grok. Home state: ~/.grok.
import os from "node:os";
import path from "node:path";

import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

const bin = () => process.env.AGENT_COLLAB_GROK_BIN || "grok";

/** Normalize CLI stopReason spellings ("EndTurn" | "end_turn" | "end-turn"). */
export function normalizeStopReason(stopReason) {
  if (stopReason == null || stopReason === "") return null;
  return String(stopReason).toLowerCase().replace(/[_-\s]/g, "");
}

/** True when telemetry indicates an abnormal / truncated stop. */
export function isIncompleteStopReason(stopReason) {
  const norm = normalizeStopReason(stopReason);
  if (!norm) return false;
  return norm !== "endturn";
}

// Env wins (per-dispatch lever) > role-scoped MODEL_REVIEW > repo pin > default.
const model = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_GROK_MODEL ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_GROK_MODEL_REVIEW : null) ||
  resolvePin("grok", role, workspace, profile).model ||
  "grok-4.5";

const effort = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_GROK_EFFORT ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_GROK_EFFORT_REVIEW : null) ||
  resolvePin("grok", role, workspace, profile).effort;

export default defineAdapter({
  name: "grok",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, profile }) {
    const args = [
      "--single", brief,
      "--output-format", "streaming-json",
      "--model", model(role, workspace, profile)
    ];
    const e = effort(role, workspace, profile);
    if (e) args.push("--effort", e);
    // Reviewers are read-only (`plan`). Workers need `bypassPermissions`: measured
    // 2026-07-25 against grok-4.5, EVERY other mode (default/acceptEdits/auto/
    // dontAsk) cancels on the first shell tool call in a headless run — there's no
    // TTY to approve it, so the run ends with stopReason=Cancelled on turn 1 and
    // the command never executes. Under `acceptEdits` grok could edit files but
    // never build or test, so it could not verify its own work and died at the
    // verification step. Write safety comes from the isolated worktree + breach
    // detection (and the optional sandbox profile), not from this flag.
    args.push("--permission-mode", role === "reviewer" ? "plan" : "bypassPermissions");
    if (workspace) args.push("--cwd", workspace);
    return { command: bin(), args };
  },
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n<output_contract>\nReturn ONLY a JSON object of the form:\n" +
        '{"verdict":"approve"|"needs-attention","summary":string,' +
        '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":string,"body":string,' +
        '"file":string,"line_start":int,"line_end":int,"confidence":0..1,"recommendation":string}],' +
        '"next_steps":[string]}\nPut the highest-severity findings first. Every actionable defect must be a finding; ' +
        'never hide defects in summary or next_steps. A needs-attention verdict requires at least one finding. ' +
        'No prose outside the JSON.\n</output_contract>'
      );
    }
    return (
      "\n\n<output_contract>\nWhen done, return ONLY a JSON object of the form:\n" +
      '{"status":"completed"|"failed"|"blocked","summary":string,"changed":boolean}\n</output_contract>'
    );
  },
  parseOutput({ stdout }) {
    const text = stdout ?? "";
    const tryParse = (s) => {
      try { return JSON.parse(s); } catch { return null; }
    };
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    // Grok streams interim narration as `text` events and closes each agentic
    // segment with an `end`. Accumulating across segments yields run-on progress
    // notes rather than the answer, so keep only the final segment's text —
    // the same "last terminal step wins" shape claude/opencode use.
    let segmentText = "";
    let answerText = "";
    let sawSegment = false;
    let telemetry = null;
    let error = null;
    for (const line of lines) {
      const ev = tryParse(line);
      if (!ev) continue;
      if (ev.type === "text" && typeof ev.data === "string") {
        segmentText += ev.data;
      } else if (ev.type === "end") {
        answerText = segmentText;
        segmentText = "";
        sawSegment = true;
        telemetry = {
          sessionId: ev.sessionId ?? null,
          requestId: ev.requestId ?? null,
          stopReason: ev.stopReason ?? null,
          numTurns: ev.num_turns ?? null,
          usage: ev.usage ?? null,
          modelUsage: ev.modelUsage ?? null,
          resolvedModels: ev.modelUsage && typeof ev.modelUsage === "object"
            ? Object.keys(ev.modelUsage)
            : []
        };
      } else if (ev.type === "error" && ev.message) {
        error = ev.message;
      }
    }
    // Trailing text with no closing `end` (killed mid-segment) is still the
    // freshest thing the worker said — don't drop it.
    if (segmentText && !answerText) answerText = segmentText;
    if (!sawSegment && !answerText) {
      const whole = tryParse(text) || tryParse(lines[0] ?? "");
      if (whole && typeof whole.text === "string") {
        answerText = whole.text;
        telemetry = telemetry || {
          sessionId: whole.sessionId ?? null,
          requestId: whole.requestId ?? null,
          stopReason: whole.stopReason ?? null,
          usage: whole.usage ?? null,
          modelUsage: whole.modelUsage ?? null,
          resolvedModels: whole.modelUsage ? Object.keys(whole.modelUsage) : []
        };
      }
    }
    // grok exits 0 even when it stopped early, and for workers dispatch derives
    // success from `changed && patchApplies` — so a cancelled run whose PARTIAL
    // patch happens to apply reads as a clean success. Surface it in the report
    // itself, which is the artifact the driver actually reads.
    //
    // Success stop reasons: CLI has used both CamelCase "EndTurn" and snake_case
    // "end_turn". Normalize before comparing so casing/underscore drift does not
    // false-positive every clean finish as incomplete.
    const stopReason = telemetry?.stopReason ?? null;
    const incomplete = isIncompleteStopReason(stopReason);
    let finalText = answerText || text.trim();
    if (incomplete) {
      finalText =
        `⚠️ INCOMPLETE RUN — grok stopped with stopReason "${stopReason}" ` +
        `(not a normal end_turn), so this work may be partially done. Any patch it produced ` +
        `may apply cleanly while still missing steps — verify against the brief ` +
        `before trusting it.\n\n---\n\n${finalText}`;
    }
    return {
      answerText: finalText,
      structured: null,
      telemetry: telemetry
        ? { ...telemetry, stopReason, stopReasonNormalized: normalizeStopReason(stopReason) }
        : telemetry,
      error,
      ...(incomplete ? { incomplete: true } : {})
    };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "not found" };
    }
    return { available: true, version: r.stdout.trim() };
  },
  resolveModel({ role, workspace, profile }) {
    return model(role, workspace, profile);
  },
  // Sessions/logs under ~/.grok count as progress when stdout is quiet between turns.
  progressDirs() {
    const home = process.env.GROK_HOME || process.env.HOME || os.homedir();
    return [
      path.join(home, ".grok", "sessions"),
      path.join(home, ".grok", "logs")
    ];
  }
});
