// Claude Code as a worker/reviewer. Headless `-p` with `--output-format json`
// (a result envelope). Reviewers run read-only via `--permission-mode plan`;
// workers may edit via `--permission-mode acceptEdits`.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";

const bin = () => process.env.AGENT_COLLAB_CLAUDE_BIN || "claude";

export default defineAdapter({
  name: "claude",
  supportsStructuredOutput: false, // envelope is JSON; the answer inside is text
  buildCommand({ role, brief, workspace }) {
    // STREAM the run (NDJSON events) rather than a single JSON at the end, so a
    // long implementation emits a continuous stdout heartbeat — otherwise the
    // idle watchdog can't tell "working" from "frozen" (claude is silent until
    // done in plain --output-format json). stream-json needs --verbose headless.
    const args = ["-p", brief, "--output-format", "stream-json", "--verbose"];
    args.push("--permission-mode", role === "reviewer" ? "plan" : "acceptEdits");
    if (workspace) args.push("--add-dir", workspace);
    return { command: bin(), args };
  },
  // Claude follows instructions well, so the contract can be concise/structured
  // (no need for agy's emphatic example-anchoring).
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n<output_contract>\nReturn ONLY a JSON object of the form:\n" +
        '{"verdict":"approve"|"needs-attention","summary":string,' +
        '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":string,"body":string,' +
        '"file":string,"line_start":int,"line_end":int,"confidence":0..1,"recommendation":string}],' +
        '"next_steps":[string]}\nPut the highest-severity findings first. No prose outside the JSON.\n</output_contract>'
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
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    // stream-json: NDJSON events; the final {"type":"result","result":"…"} carries
    // the answer. Scan from the end for it.
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      const ev = tryParse(lines[i]);
      if (ev && ev.type === "result" && typeof ev.result === "string") {
        return { answerText: ev.result, structured: null };
      }
    }
    // Fallbacks: a single JSON envelope (older --output-format json) or raw text.
    const whole = tryParse(text) || tryParse(lines[lines.length - 1] ?? "");
    if (whole && typeof whole.result === "string") {
      return { answerText: whole.result, structured: null };
    }
    return { answerText: text.trim(), structured: null };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "not found" };
    }
    return { available: true, version: r.stdout.trim() };
  }
});
