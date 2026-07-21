// OpenCode as a worker/reviewer. Headless via `opencode run --format json`, which
// emits NDJSON event-stream on stdout (step_start/text/tool_use/step_finish/error).
// The final step's text event(s) carry the answer; tool_use events show operations
// under the worktree; error events must abort with a terminal failure.
//
// Permission model: opencode has no per-tool exclusion flag (unlike Claude Code's
// --exclude-tools). Safety relies on --auto (auto-approve allowed tools) combined
// with worktree isolation + breach detection. The worker has full tool access
// within the worktree; network access is gated by the sandbox (if enabled).
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
// No buildRetryCommand (finding #5): opencode has no atomic thread-resume primitive
// analogous to codex's --resume-last. The shared dispatcher's fresh re-send path
// repeats side effects; this is documented as a known limitation.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

const bin = () => process.env.AGENT_COLLAB_OPENCODE_BIN || "opencode";

// Model precedence: generic env flag > per-role env > repo .agent-collab.json pin > null
const model = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_OPENCODE_MODEL ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_OPENCODE_MODEL_REVIEW : null) ||
  resolvePin("opencode", role, workspace, profile).model;

// Opencode has no --exclude-tools flag. The full tool set (live-confirmed) is:
// bash, edit, glob, grep, read, skill, task, todowrite, webfetch, write.
// Safety relies on --auto + worktree isolation + breach detection.

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

export default defineAdapter({
  name: "opencode",
  supportsStructuredOutput: false,
  // Background runs are inherently concurrency-prone: opencode's --continue
  // resolves the LAST session, which under concurrency could be a different
  // job's session. Disable background for now; can be re-enabled with explicit
  // session ID tracking.
  background: false,
  buildCommand({ role, brief, workspace, profile }) {
    const args = ["run", "--format", "json", "--auto"];
    // Model selection: opencode requires provider/model format (finding #6)
    // e.g. anthropic/claude-sonnet-4-20250514
    const m = model(role, workspace, profile);
    if (m) args.push("--model", m);
    if (workspace) args.push(`--dir=${workspace}`);
    args.push(brief);
    return { command: bin(), args };
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
  parseOutput({ stdout }) {
    const events = parseNdjson(stdout);
    let answerText = "";
    let error = null;
    let telemetry = null;
    let foundFinalStep = false;
    // Track step boundaries to only collect text from the terminal step.
    // Walk forward: step_start opens a step; step_finish closes it with
    // reason="stop" for the final assistant response (vs "tool-calls" for
    // intermediate tool-using steps).
    let inStep = false;
    let stepText = "";
    let stepTokens = null;
    let stepCost = null;
    for (const ev of events) {
      if (ev.type === "step_start") {
        if (inStep) {
          // Previous step ended without a finish event (malformed stream);
          // flush accumulated text as the last resort
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
          // Only the final step (reason="stop") produces the assistant's
          // answer text. Intermediate steps (reason="tool-calls") contain
          // only tool results.
          if (reason === "stop") {
            foundFinalStep = true;
            answerText = stepText;
            telemetry = {
              sessionId: ev.sessionID ?? null,
              inputTokens: stepTokens?.input ?? null,
              outputTokens: stepTokens?.output ?? null,
              reasoningTokens: stepTokens?.reasoning ?? null,
              totalTokens: stepTokens?.total ?? null,
              cacheWrite: stepTokens?.cache?.write ?? null,
              cacheRead: stepTokens?.cache?.read ?? null,
              costUsd: stepCost ?? null
            };
          }
        }
      }
    }
    // If we saw an error event and no final step completed, signal failure.
    // The dispatcher checks answerText first; an empty answerText from an
    // error-only stream would otherwise fall through as "no-changes".
    if (error && !foundFinalStep) {
      return { answerText: "", structured: null, error, telemetry };
    }
    if (!answerText && !error) {
      // Fall back to raw trimmed text when no structured events matched
      answerText = (stdout ?? "").trim();
    }
    return { answerText: answerText || (stdout ?? "").trim(), structured: null, telemetry };
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
  }
});
