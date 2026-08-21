// OpenCode as a worker/reviewer. Headless via `opencode run --format json`, which
// emits NDJSON event-stream on stdout (step_start/text/tool_use/step_finish/error).
// The final step's text event(s) carry the answer; tool_use events show operations
// under the worktree; error events must abort with a terminal failure.
//
// Permission model: opencode has no per-tool exclusion flag (unlike Claude Code's
// --exclude-tools). Safety relies on --auto (auto-approve allowed tools) combined
// with worktree isolation + breach detection. Workers have full tool access
// including webfetch (network); the OS sandbox (opt-in) is the only network gate.
// Reviewers are NOT tool-restricted — write safety is by worktree isolation alone
// (codex adversarial review — acknowledged limitation).
//
// Plugin mechanism (finding #1): opencode does NOT use .opencode/plugin.json.
// See .opencode/plugins/agent-collaboration.mjs for the driver-side integration.
//
// Error events (finding #3): type:"error" events set a terminal failure on the
// result, preventing the dispatcher from accepting a misleading answerText.
//
// Multi-step output (finding #7): text events are collected per step boundary;
// only the final step's text is returned as the answer.
//
// Telemetry (finding #8): step_finish events carry tokens (input/output/reasoning)
// and cost, aggregated into workerTelemetry.
//
// No atomic --resume-last analogue: continue uses explicit --session from
// telemetry (never bare --continue, which resolves the LAST session under
// concurrency). Fresh re-send remains the fallback when no session id exists.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

const bin = () => process.env.AGENT_COLLAB_OPENCODE_BIN || "opencode";

// Model precedence: generic env flag > per-role env > repo .agent-collab.json pin > null
const model = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_OPENCODE_MODEL ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_OPENCODE_MODEL_REVIEW : null) ||
  resolvePin("opencode", role, workspace, profile).model;

// Variant (reasoning effort) precedence: env > repo .agent-collab.json pin > null
const variant = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_OPENCODE_VARIANT ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_OPENCODE_VARIANT_REVIEW : null) ||
  resolvePin("opencode", role, workspace, profile).effort;

// OpenCode has no --exclude-tools flag. The full tool set (live-confirmed) is:
// bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write.
// Safety relies on --auto + worktree isolation + breach detection.

function resolveModel({ role, workspace, profile } = {}) {
  return model(role, workspace, profile);
}

function parseNdjson(stdout) {
  const events = [];
  for (const line of (stdout ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // partial/malformed line — skip; the caller's coerceArtifact handles
      // missing-answer fallback
    }
  }
  return events;
}

function buildRunArgs({ role, brief, workspace, profile, sessionId }) {
  const args = ["run", "--format", "json", "--auto"];
  if (sessionId) {
    args.push("--session", sessionId);
  }
  const m = model(role, workspace, profile);
  if (m) args.push("--model", m);
  const v = variant(role, workspace, profile);
  if (v) args.push("--variant", v);
  if (workspace) args.push(`--dir=${workspace}`);
  args.push(brief);
  return args;
}

export default defineAdapter({
  name: "opencode",
  supportsStructuredOutput: false,
  // Background runs are inherently concurrency-prone: opencode's bare
  // --continue resolves the LAST session, which under concurrency could be a
  // different job's session. Session-continue uses explicit --session instead.
  // Keep background off until job-scoped session tracking is solid end-to-end.
  background: false,
  buildCommand({ role, brief, workspace, profile }) {
    // NOTE: opencode has no --exclude-tools flag, so --auto applies to ALL roles.
    // Reviewer write-safety relies on worktree isolation + breach detection, not
    // tool-level gating (codex adversarial review — acknowledged limitation).
    return { command: bin(), args: buildRunArgs({ role, brief, workspace, profile }) };
  },
  // Same-session nudge after a null turn (or other resume). Requires an
  // explicit session id from a prior parseOutput — never bare --continue.
  buildRetryCommand({ role, repairBrief, workspace, profile, sessionId }) {
    if (!sessionId) return null;
    return {
      command: bin(),
      args: buildRunArgs({ role, brief: repairBrief, workspace, profile, sessionId })
    };
  },
  isResumeMiss({ stdout, stderr }) {
    const t = `${stdout ?? ""}\n${stderr ?? ""}`;
    return /session not found|unknown session|no such session|invalid session/i.test(t);
  },
  // Reviewer gets read-only tools; worker gets write tools but not network fetch.
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n---\nReturn ONLY a JSON object and NOTHING else — no prose before or after it. " +
        "Match this exact shape:\n" +
        '{"verdict":"approve" | "needs-attention","summary":"<one line>",' +
        '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":"...","body":"...",' +
        '"file":"path","line_start":1,"line_end":1,"confidence":0.9,"recommendation":"..."}],' +
        '"next_steps":["..."]}. Every actionable defect must be in findings; never hide defects in ' +
        'summary or next_steps. A needs-attention verdict requires at least one finding.'
      );
    }
    return (
      "\n\n---\nWhen finished, return ONLY a JSON object and NOTHING else — no prose before " +
      "or after it. Match this exact shape:\n" +
      '{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}'
    );
  },
  // NDJSON stream from --format json. Events: step_start, text, tool_use,
  // step_finish, error.
  // - Text events within the final step carry the answer (finding #7).
  // - Error events set a terminal failure (finding #3).
  // - step_finish provides token/cost telemetry (finding #8).
  // - A terminal step with no text (e.g. x-preview-f reason=unknown + 0
  //   tokens) is a null turn: return error so dispatch can fail as
  //   empty-output / auto-fallback, and never dump the raw NDJSON stream
  //   as a fake report.
  parseOutput({ stdout }) {
    const events = parseNdjson(stdout);
    let answerText = "";
    let error = null;
    let telemetry = null;
    let foundFinalStep = false;
    let truncated = false;
    let inStep = false;
    let stepText = "";
    let stepTokens = null;
    let stepCost = null;
    let finalReason = null;
    let toolCallSteps = 0;
    for (const ev of events) {
      if (ev.type === "step_start") {
        if (inStep) {
          if (stepText) answerText = stepText;
        }
        inStep = true;
        stepText = "";
        stepTokens = null;
        stepCost = null;
      } else if (ev.type === "text" && inStep) {
        stepText += ev.part?.text ?? "";
      } else if (ev.type === "error") {
        error = ev.error?.data?.message || ev.error?.message || JSON.stringify(ev.error);
      } else if (ev.type === "step_finish") {
        if (inStep) {
          inStep = false;
          const reason = ev.part?.reason;
          const tokens = ev.part?.tokens ?? {};
          const cost = ev.part?.cost;
          if (tokens.input !== undefined) stepTokens = tokens;
          if (cost !== undefined) stepCost = cost;
          // Accept text from any terminal step (stop, length, etc.)
          // and mark truncation when the model hit length limits.
          // Only skip intermediate tool-calling steps.
          if (reason === "tool-calls") {
            toolCallSteps += 1;
          } else {
            foundFinalStep = true;
            truncated = reason === "length";
            finalReason = reason ?? null;
            answerText = stepText;
            telemetry = {
              sessionId: ev.sessionID ?? null,
              inputTokens: stepTokens?.input ?? null,
              outputTokens: stepTokens?.output ?? null,
              reasoningTokens: stepTokens?.reasoning ?? null,
              totalTokens: stepTokens?.total ?? null,
              cacheWrite: stepTokens?.cache?.write ?? null,
              cacheRead: stepTokens?.cache?.read ?? null,
              costUsd: stepCost ?? null,
              finishReason: finalReason
            };
          }
        }
      }
    }
    // Trailing text with no step_finish (killed mid-step) is still the
    // freshest thing the worker said — don't drop it for an NDJSON dump.
    if (inStep && stepText && !answerText) answerText = stepText;

    if (error) {
      return { answerText, structured: null, error, telemetry };
    }

    // Null turn: a real terminal step produced no answer text. Do not fall
    // back to raw stdout (that made reviewers look "completed" with a prose
    // dump of the event stream).
    if (foundFinalStep && !String(answerText).trim()) {
      const inTok = telemetry?.inputTokens ?? 0;
      const outTok = telemetry?.outputTokens ?? 0;
      const reasonLabel = finalReason ?? "unknown";
      const detail =
        `opencode returned a null turn (reason=${reasonLabel}, ` +
        `${inTok} input/${outTok} output tokens` +
        (toolCallSteps ? ` after ${toolCallSteps} tool-call step(s)` : "") +
        ")";
      const marker =
        `⚠️ INCOMPLETE RUN — ${detail}. No usable answer was produced; ` +
        `treat this as empty-output, not a successful no-op.`;
      return {
        answerText: marker,
        structured: null,
        error: detail,
        telemetry: { ...(telemetry ?? {}), nullTurn: true },
        truncated: truncated || undefined
      };
    }

    // Three-way salvage: terminal/unterminated text already in answerText;
    // raw stdout only when nothing parsed as NDJSON.
    if (!answerText && events.length === 0) {
      answerText = (stdout ?? "").trim();
    }
    return {
      answerText: answerText || (events.length === 0 ? (stdout ?? "").trim() : ""),
      structured: null,
      telemetry,
      truncated: truncated || undefined
    };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "opencode CLI not found" };
    }
    // NOTE: this only confirms the binary is present, not that the user has
    // configured a provider/model or that --format json works. The doctor
    // --live flag exercises those. (Finding #10)
    return { available: true, version: r.stdout.trim() };
  },
  // Resolve the model that would be used for a dispatch. Used by the runtime
  // to apply per-model timeout policies (e.g. 3 min for free models instead of
  // the 20 min default).
  resolveModel
});
