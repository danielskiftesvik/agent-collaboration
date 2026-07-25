// Grok Build (xAI `grok` CLI) as a worker/reviewer. Headless `--single` with
// `--output-format streaming-json`. Reviewers run read-only via
// `--permission-mode plan`; workers may edit via `--permission-mode acceptEdits`.
// Product: Grok Build. Binary / adapter id: grok. Home state: ~/.grok.
import os from "node:os";
import path from "node:path";

import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

const bin = () => process.env.AGENT_COLLAB_GROK_BIN || "grok";

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
    args.push("--permission-mode", role === "reviewer" ? "plan" : "acceptEdits");
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
    let answerText = "";
    let telemetry = null;
    let error = null;
    for (const line of lines) {
      const ev = tryParse(line);
      if (!ev) continue;
      if (ev.type === "text" && typeof ev.data === "string") {
        answerText += ev.data;
      } else if (ev.type === "end") {
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
    if (!answerText) {
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
    return { answerText: answerText || text.trim(), structured: null, telemetry, error };
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
