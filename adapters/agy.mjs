// Antigravity CLI (`agy`, v1.x). Headless via `-p`, unattended via
// `--dangerously-skip-permissions`, scoped to a worktree via `--add-dir`, and
// bounded by `--print-timeout`. It prints plain TEXT (no JSON flag), so the
// dispatch layer extracts/validates JSON from the text for structured roles.
import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";

const bin = () => process.env.AGENT_COLLAB_AGY_BIN || "agy";

/**
 * Resolve the model for a role. Mirrors codex-plugin-cc's philosophy: leave the
 * model UNSET by default so the CLI's own default is used; only pass `--model`
 * when explicitly requested via env.
 *
 * NB: empirically `agy -p` IGNORES `--model` — it stays on Gemini 3.5 Flash for
 * the display labels from `agy models` and for class names like `pro`, and a
 * value containing spaces breaks prompt delivery entirely. So we do NOT try to
 * force Pro for reviewers (an earlier attempt broke agy reviewer runs). agy is
 * effectively worker-only; route reviews to codex/claude. The env hooks remain
 * as an escape hatch should a known-good identifier exist.
 */
function resolveModel(role) {
  const roleEnv =
    role === "reviewer"
      ? process.env.AGENT_COLLAB_AGY_MODEL_PRO
      : process.env.AGENT_COLLAB_AGY_MODEL_FLASH;
  return process.env.AGENT_COLLAB_AGY_MODEL || roleEnv || null;
}

export default defineAdapter({
  name: "agy",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, timeoutMs }) {
    const seconds = Math.ceil((timeoutMs ?? 300000) / 1000);
    const args = ["-p", "--dangerously-skip-permissions"];

    const model = resolveModel(role);
    if (model) args.push("--model", model);

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
