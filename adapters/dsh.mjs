// DeepSeek Harness (`dsh` CLI) as a worker/reviewer and driver.
// Headless: `dsh --profile headless "<task>"` prints the last assistant
// message and exits. Unattended workers set DSH_PERMISSION_MODE=danger-full-access
// so the run cannot block on an approval prompt (there is no TTY). Write safety
// is the isolated worktree + breach detection, not that flag.
// Product: DeepSeek Harness. Binary / adapter id: dsh. Home state: ~/.dsh.
import os from "node:os";
import path from "node:path";

import { defineAdapter } from "./contract.mjs";
import { run } from "../core/process.mjs";
import { resolvePin } from "../core/pins.mjs";

const bin = () => process.env.AGENT_COLLAB_DSH_BIN || "dsh";

const model = (role, workspace, profile) =>
  process.env.AGENT_COLLAB_DSH_MODEL ||
  (role === "reviewer" ? process.env.AGENT_COLLAB_DSH_MODEL_REVIEW : null) ||
  resolvePin("dsh", role, workspace, profile).model ||
  null;

function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

export default defineAdapter({
  name: "dsh",
  supportsStructuredOutput: false,
  buildCommand({ role, brief, workspace, profile }) {
    const args = ["--profile", "headless", brief];
    // danger-full-access + never-ask: headless has no approval UI. Reviewers
    // still run in an isolated worktree; the brief is what keeps them read-only
    // (dsh has no grok-style `plan` permission mode).
    const env = {
      DSH_PERMISSION_MODE: "danger-full-access"
    };
    const m = model(role, workspace, profile);
    if (m) env.AGENT_COLLAB_DSH_RESOLVED_MODEL = m;
    return { command: bin(), args, env };
  },
  outputContract(role) {
    if (role === "reviewer") {
      return (
        "\n\n<output_contract>\nReturn ONLY a JSON object of the form:\n" +
        '{"verdict":"approve"|"needs-attention","summary":string,' +
        '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":string,"body":string,' +
        '"file":string,"line_start":int,"line_end":int,"confidence":0..1,"recommendation":string}],' +
        '"next_steps":[string]}\nPut the highest-severity findings first. Every actionable defect must be a finding; ' +
        "never hide defects in summary or next_steps. A needs-attention verdict requires at least one finding. " +
        "No prose outside the JSON.\n</output_contract>"
      );
    }
    return (
      "\n\n<output_contract>\nWhen done, return ONLY a JSON object of the form:\n" +
      '{"status":"completed"|"failed"|"blocked","summary":string,"changed":boolean}\n</output_contract>'
    );
  },
  parseOutput({ stdout }) {
    const text = (stdout ?? "").trim();
    return { answerText: text, structured: null };
  },
  probe() {
    const r = run(bin(), ["--version"]);
    if (r.error || r.status !== 0) {
      return { available: false, error: r.error?.message || r.stderr || "dsh CLI not found" };
    }
    return { available: true, version: r.stdout.trim() };
  },
  unattendedProbe() {
    return {
      ok: true,
      detail: "uses --profile headless with DSH_PERMISSION_MODE=danger-full-access"
    };
  },
  resolveModel({ role, workspace, profile }) {
    return model(role, workspace, profile);
  },
  progressDirs() {
    const home = homeDir();
    return [path.join(home, "sessions")];
  }
});
