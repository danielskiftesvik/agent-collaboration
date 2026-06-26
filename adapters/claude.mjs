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
    const args = ["-p", brief, "--output-format", "json"];
    args.push("--permission-mode", role === "reviewer" ? "plan" : "acceptEdits");
    if (workspace) args.push("--add-dir", workspace);
    return { command: bin(), args };
  },
  parseOutput({ stdout }) {
    const text = stdout ?? "";
    // Try the whole thing, then the last non-empty line (stream-json).
    const tryParse = (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    let env = tryParse(text);
    if (!env) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      env = tryParse(lines[lines.length - 1] ?? "");
    }
    if (env && typeof env.result === "string") {
      return { answerText: env.result, structured: null };
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
