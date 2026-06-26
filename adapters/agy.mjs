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
  buildCommand({ brief, workspace, timeoutMs }) {
    const seconds = Math.ceil((timeoutMs ?? 300000) / 1000);
    const args = ["-p", "--dangerously-skip-permissions"];
    if (workspace) args.push("--add-dir", workspace);
    args.push("--print-timeout", `${seconds}s`);
    args.push(brief); // Go-style flags: positional prompt must come last
    return { command: bin(), args };
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
