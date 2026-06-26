// The companion's brain: decide native vs cross-harness routing, probe harnesses
// for `setup`, and run a cross-harness worker/reviewer to completion, producing
// validated artifacts that only the driver later applies.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { resolveStateDir, appendJob, updateJob, getJob } from "./state.mjs";
import { createWorktree, removeWorktree } from "./workspace.mjs";
import { headRef, captureWorkingDiff, applyPatch } from "./git.mjs";
import { run } from "./process.mjs";
import { coerceArtifact } from "./schema.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewSchema = JSON.parse(
  fs.readFileSync(path.join(here, "../schemas/review-output.schema.json"))
);
const resultSchema = JSON.parse(
  fs.readFileSync(path.join(here, "../schemas/result.schema.json"))
);

const NATIVE_INSTRUCTION = {
  claude: "Use the Agent tool (a Claude Code subagent) instead of a cross-harness job.",
  agy: "Use Antigravity's invoke_subagent instead of a cross-harness job.",
  codex: "Use Codex's native subagent instead of a cross-harness job."
};

function schemaInstruction(role) {
  if (role === "reviewer") {
    return (
      '\n\n---\nReturn ONLY a JSON object (optionally in a ```json fence) of the form:\n' +
      '{"verdict":"approve"|"needs-attention","summary":string,' +
      '"findings":[{"severity":"critical"|"high"|"medium"|"low","title":string,"body":string,' +
      '"file":string,"line_start":int,"line_end":int,"confidence":0..1,"recommendation":string}],' +
      '"next_steps":[string]}'
    );
  }
  return (
    '\n\n---\nWhen done, return ONLY a JSON object (optionally in a ```json fence) of the form:\n' +
    '{"status":"completed"|"failed"|"blocked","summary":string,"changed":boolean}'
  );
}

export function decideRoute({ driver, worker }) {
  if (driver && worker && driver === worker) {
    return {
      mode: "native",
      harness: driver,
      instruction: NATIVE_INSTRUCTION[driver] ?? "Use this harness's native subagent."
    };
  }
  return { mode: "cross", worker };
}

export function runSetup(adapters = listAdapters()) {
  return adapters.map((a) => {
    const p = a.probe();
    if (!p.available) {
      return { name: a.name, available: false, validWorker: false, reason: p.error };
    }
    const u = a.unattendedProbe ? a.unattendedProbe() : { ok: true };
    return {
      name: a.name,
      available: true,
      version: p.version,
      validWorker: u.ok,
      reason: u.ok ? undefined : u.detail
    };
  });
}

function ensureDirs(base, role) {
  const dirs = ["reports", "outputs"].concat(role === "worker" ? ["patches", "checks"] : []);
  for (const d of dirs) fs.mkdirSync(path.join(base, d), { recursive: true });
}

/**
 * Run a cross-harness worker/reviewer synchronously to completion. Workers run in
 * an isolated worktree; the captured patch is the artifact and is NOT applied
 * here (only the driver applies). Returns a summary including the artifact.
 */
export function runWorkerSync(cwd, opts) {
  const { driver, worker, role = "worker", brief, timeoutMs = 300000, maxAttempts = 2 } = opts;
  const adapter = getAdapter(worker);
  const schema = role === "reviewer" ? reviewSchema : resultSchema;

  const jobId = randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");

  let baseRef = null;
  let workspace = cwd;
  let worktree = null;
  if (role === "worker") {
    try {
      baseRef = headRef(cwd);
      worktree = createWorktree(cwd, jobId, baseRef);
      workspace = worktree;
    } catch {
      workspace = cwd; // not a git repo: run in place, no patch isolation
    }
  }

  appendJob(cwd, {
    id: jobId,
    driver,
    worker,
    role,
    status: "running",
    pid: process.pid,
    baseRef,
    workspace,
    artifactDir,
    heartbeatAt: new Date().toISOString()
  });

  let answerText = "";
  let coerce = { ok: false, value: null, errors: ["no attempts ran"] };
  let exitCode = null;
  let attempts = 0;
  let promptBrief = `${brief ?? ""}${schemaInstruction(role)}`;

  while (attempts < maxAttempts) {
    attempts += 1;
    const cmd = adapter.buildCommand({ role, brief: promptBrief, workspace, timeoutMs });
    const proc = run(cmd.command, cmd.args, {
      cwd: workspace,
      timeout: timeoutMs,
      env: { ...process.env, ...(cmd.env ?? {}) }
    });
    exitCode = proc.status;
    const parsed = adapter.parseOutput({
      stdout: proc.stdout,
      stderr: proc.stderr,
      exitCode: proc.status,
      workspace
    });
    answerText = parsed.answerText ?? "";
    const candidate = parsed.structured ? JSON.stringify(parsed.structured) : answerText;
    coerce = coerceArtifact(schema, candidate);
    if (coerce.ok) break;
    promptBrief =
      `${brief ?? ""}${schemaInstruction(role)}\n\nIMPORTANT: your previous reply was not valid. ` +
      `Respond with ONLY a single JSON object matching the schema above — no prose.`;
  }

  // Capture the worker's patch, then tear down the worktree (the diff is the artifact).
  let patchPath = null;
  if (role === "worker") {
    let diff = "";
    try {
      diff = captureWorkingDiff(workspace);
    } catch {
      diff = "";
    }
    patchPath = path.join(artifactDir, "patches", `${worker}.diff`);
    fs.writeFileSync(patchPath, diff);
  }
  if (worktree) removeWorktree(cwd, worktree);

  fs.writeFileSync(path.join(artifactDir, "reports", `${worker}.md`), answerText);
  fs.writeFileSync(
    path.join(artifactDir, "outputs", `${worker}.json`),
    JSON.stringify(coerce.value ?? { raw: answerText }, null, 2)
  );

  const status = coerce.ok ? "completed" : "failed";
  updateJob(cwd, jobId, {
    status,
    exitCode,
    valid: coerce.ok,
    attempts,
    patchPath,
    errors: coerce.ok ? undefined : coerce.errors
  });

  return {
    jobId,
    status,
    valid: coerce.ok,
    artifact: coerce.value,
    artifactDir,
    patchPath,
    errors: coerce.ok ? undefined : coerce.errors
  };
}

/** Driver-side: apply a completed worker's patch to the main branch (3-way). */
export function applyResult(cwd, jobId) {
  const job = getJob(cwd, jobId);
  if (!job) return { applied: false, error: "unknown job" };
  if (!job.patchPath || !fs.existsSync(job.patchPath)) {
    return { applied: false, error: "no patch for this job (reviewer or empty result)" };
  }
  const diff = fs.readFileSync(job.patchPath, "utf8");
  const result = applyPatch(cwd, diff);
  updateJob(cwd, jobId, { applied: result.applied, conflicted: result.conflicted });
  return result;
}
