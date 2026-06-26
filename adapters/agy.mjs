// Antigravity CLI (`agy`, v1.x). Headless via `-p`, unattended via
// `--dangerously-skip-permissions`, scoped to a worktree via `--add-dir`, and
// bounded by `--print-timeout`. It prints plain TEXT (no JSON flag), so the
// dispatch layer extracts/validates JSON from the text for structured roles.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";

const bin = () => process.env.AGENT_COLLAB_AGY_BIN || "agy";

export default defineAdapter({
  name: "agy",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, timeoutMs }) {
    const seconds = Math.ceil((timeoutMs ?? 300000) / 1000);
    const args = ["-p", "--dangerously-skip-permissions"];
    
    // Support fine-grained model overrides or default to latest models within classes.
    // For reviewers, default to gemini-3.1-pro-preview for advanced reasoning.
    // For workers, default to using the CLI's default model (so it is always the latest)
    // unless explicitly overridden.
    if (role === "reviewer") {
      const model = process.env.AGENT_COLLAB_AGY_MODEL_PRO || process.env.AGENT_COLLAB_AGY_MODEL || "gemini-3.1-pro-preview";
      args.push("--model", model);
    } else {
      const model = process.env.AGENT_COLLAB_AGY_MODEL_FLASH || process.env.AGENT_COLLAB_AGY_MODEL;
      if (model) {
        args.push("--model", model);
      }
    }

    if (workspace) args.push("--add-dir", workspace);
    args.push("--print-timeout", `${seconds}s`);
    args.push(brief); // Go-style flags: positional prompt must come last
    return { command: bin(), args };
  },
  // Gemini (esp. Flash) is weak at strict JSON-only output, so the contract is
  // emphatic and example-anchored: demand JSON only, forbid surrounding prose,
  // and show the exact shape to fill in.
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n---\nReturn ONLY a JSON object and NOTHING else — no prose before or after it, " +
        "no markdown headings, no commentary. Do not edit any files; only review. " +
        "Match this exact shape (replace the values):\n" +
        '{"verdict":"approve" | "needs-attention","summary":"<one line>",' +
        '"findings":[{"severity":"high","title":"...","body":"...","file":"path",' +
        '"line_start":1,"line_end":1,"confidence":0.9,"recommendation":"..."}],' +
        '"next_steps":["..."]}'
      );
    }
    return (
      "\n\n---\nWhen finished, return ONLY a JSON object and NOTHING else — no prose " +
      "before or after it. Match this exact shape:\n" +
      '{"status":"completed" | "failed" | "blocked","summary":"<one line>","changed":true | false}'
    );
  },
  parseOutput({ stdout }) {
    return { answerText: (stdout ?? "").trim(), structured: null };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "not found" };
    }
    return { available: true, version: r.stdout.trim() };
  },
  unattendedProbe() {
    // `--dangerously-skip-permissions` is the contract; trustedWorkspaces +
    // toolPermission=always-proceed in settings.json reinforce it.
    return { ok: true, detail: "uses --dangerously-skip-permissions" };
  }
});
