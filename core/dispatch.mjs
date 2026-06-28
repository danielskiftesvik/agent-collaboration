// The companion's brain: decide native vs cross-harness routing, probe harnesses
// for `setup`, and run a cross-harness worker/reviewer to completion, producing
// validated artifacts that only the driver later applies.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getAdapter, listAdapters } from "../adapters/index.mjs";
import { resolveStateDir, appendJob, updateJob, getJob, loadState } from "./state.mjs";
import { createWorktree, removeWorktree } from "./workspace.mjs";
import { headRef, captureWorkingDiff, applyPatch, checkPatchApplies, workingTreeStatus, newStatusPaths } from "./git.mjs";
import { run } from "./process.mjs";
import { coerceArtifact, normalizeReviewArtifact } from "./schema.mjs";
import { buildFromTemplate } from "./prompts.mjs";
import { classifyFailure, isFallbackKind } from "./failures.mjs";
import { MODEL_PROFILES, TASK_ROUTING, DEFAULT_ROUTING } from "./model-profiles.mjs";

const TEMPLATE_KINDS = new Set(["review", "adversarial-review"]);

/**
 * Default per-attempt worker timeout. Generous on purpose: a deep reasoner (codex)
 * on a large diff can run 10+ minutes, and the worker prints its JSON only at the
 * END, so a too-short timeout SIGTERMs it mid-run and yields the dreaded
 * "no JSON found" no-output. Configurable via AGENT_COLLAB_TIMEOUT (seconds).
 */
export function defaultTimeoutMs() {
  const s = Number(process.env.AGENT_COLLAB_TIMEOUT);
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : 1200000; // 20 min
}

/**
 * Recommend a worker for a task by matching the task type to the strongest
 * available harness (excluding the driver, so it stays cross-harness). The driver
 * (an LLM) classifies the task type; this mapping is deterministic so routing is
 * consistent and explainable. Returns the chosen worker, the underlying model's
 * profile, and a reason. Falls back to `native` when the driver itself is the
 * best/only fit.
 */
export function recommendWorker({ task, driver, available = [] }) {
  const entry = TASK_ROUTING[task] || DEFAULT_ROUTING;
  const avail = new Set(available);

  const cross = entry.workers.filter((w) => avail.has(w) && w !== driver);
  if (cross.length) {
    const worker = cross[0];
    return { mode: "cross", task, driver, worker, reason: entry.why, profile: MODEL_PROFILES[worker], alternatives: cross.slice(1) };
  }
  if (entry.workers.includes(driver) && avail.has(driver)) {
    return {
      mode: "native",
      task,
      driver,
      harness: driver,
      reason: `the driver (${driver}) is the strongest available for this task — use your own subagent`,
      profile: MODEL_PROFILES[driver]
    };
  }
  const other = available.find((w) => w !== driver);
  if (other) {
    return { mode: "cross", task, driver, worker: other, reason: "preferred workers unavailable; using the next worker-ready harness", profile: MODEL_PROFILES[other], alternatives: [] };
  }
  return { mode: "none", task, driver, worker: null, reason: "no worker-ready harness available" };
}

/**
 * Best-effort detection of which harness is DRIVING from environment signals.
 * Checked actively-running-harness-first: Codex/agy launched from inside a Claude
 * Code shell can INHERIT Claude's env vars, so the running harness's own signal
 * must win over an inherited one. Returns null when nothing matches.
 *
 * All three are CONFIRMED from live sessions:
 *   - Codex: CODEX_THREAD_ID (every session) / CODEX_MANAGED_* (npm) / CODEX_SANDBOX.
 *   - agy:   ANTIGRAVITY_AGENT / ANTIGRAVITY_CONVERSATION_ID / ANTIGRAVITY_PROJECT_ID.
 *   - Claude Code: CLAUDECODE / CLAUDE_PLUGIN_ROOT (tiebreaker; its slash commands
 *     already pass --driver claude explicitly).
 * Claude is checked LAST so an actively-running Codex/agy beats an inherited
 * Claude env. `AGENT_COLLAB_DRIVER` remains the deterministic override.
 */
export function detectDriver(env = process.env) {
  if (env.CODEX_THREAD_ID || env.CODEX_MANAGED_BY_NPM || env.CODEX_MANAGED_PACKAGE_ROOT || env.CODEX_SANDBOX)
    return "codex";
  if (env.ANTIGRAVITY_AGENT || env.ANTIGRAVITY_CONVERSATION_ID || env.ANTIGRAVITY_PROJECT_ID)
    return "agy";
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDE_PLUGIN_ROOT) return "claude";
  return null;
}

/**
 * Resolve the driver harness + WHERE the value came from. Precedence:
 *   1. explicit `--driver` flag  (authoritative)
 *   2. AGENT_COLLAB_DRIVER env    (authoritative)
 *   3. env detection             (label only — NOT authoritative)
 *   4. "claude" fallback         (label only — NOT authoritative)
 * Only an *authoritative* driver may trigger the native (same-harness) path: a
 * mere guess must never silently turn a real cross-harness delegation into a
 * "use your own subagent" no-op (the Codex/agy raw-CLI footgun).
 */
export function resolveDriver(options = {}, env = process.env) {
  if (options.driver) return { driver: options.driver, source: "flag" };
  if (env.AGENT_COLLAB_DRIVER) return { driver: env.AGENT_COLLAB_DRIVER, source: "env" };
  const detected = detectDriver(env);
  if (detected) return { driver: detected, source: "detected" };
  return { driver: "claude", source: "fallback" };
}

export function isAuthoritativeDriver(source) {
  return source === "flag" || source === "env";
}

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
  const { driver, worker, role = "worker", brief, kind, focus, targetLabel, timeoutMs = defaultTimeoutMs(), maxAttempts = 2 } = opts;
  const adapter = getAdapter(worker);
  const schema = role === "reviewer" ? reviewSchema : resultSchema;

  const jobId = randomUUID();
  const artifactDir = path.join(resolveStateDir(cwd), "tasks", jobId);
  ensureDirs(artifactDir, role);
  fs.writeFileSync(path.join(artifactDir, "brief.md"), brief ?? "");

  // Both workers AND reviewers run in an ephemeral worktree so an unattended
  // harness (e.g. `agy --dangerously-skip-permissions`) can never write to the
  // live tree. Only a worker's changes are captured as a patch; a reviewer's are
  // discarded with the worktree.
  let baseRef = null;
  let workspace = cwd;
  let worktree = null;
  try {
    baseRef = headRef(cwd);
    worktree = createWorktree(cwd, jobId, baseRef);
    workspace = worktree;
  } catch {
    workspace = cwd; // not a git repo: cannot isolate, run in place
  }

  // Breach detection: snapshot the driver's REAL tree so we can tell if an
  // unattended worker escapes its worktree and writes into the live checkout
  // (observed with agy resolving the canonical $HOME repo under
  // --dangerously-skip-permissions). Only meaningful when we actually isolated;
  // in the run-in-place fallback the worker is supposed to write to cwd.
  const breachBefore = worktree ? workingTreeStatus(cwd) : null;

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
  let lastStdout = "";
  let lastStderr = "";
  let timedOut = false;
  // Reviewers' output is normalized (severity case, etc.) before validation so a
  // complete report isn't false-failed over cosmetics; workers are not.
  const normalize = role === "reviewer" ? normalizeReviewArtifact : undefined;
  // Harness-aware output contract: each adapter may tune how it asks for the
  // structured shape (agy gets emphatic JSON-only; codex gets XML blocks);
  // otherwise fall back to the generic instruction.
  const contract = adapter.outputContract ? adapter.outputContract(role) : schemaInstruction(role);

  // Review-grade work uses a code-loaded template (with the harness contract
  // filling {{OUTPUT_CONTRACT}}); free-form work is the driver-composed brief.
  const basePrompt = TEMPLATE_KINDS.has(kind)
    ? buildFromTemplate(kind, {
        TARGET_LABEL: targetLabel || "the provided changes",
        USER_FOCUS: focus || "No extra focus provided.",
        REVIEW_INPUT: brief ?? "",
        OUTPUT_CONTRACT: contract
      })
    : `${brief ?? ""}${contract}`;

  // Sandbox is OPT-IN: it is not yet proven safe for every harness (a deny-default
  // profile crashed agy), so it stays off unless explicitly enabled.
  const state = loadState(cwd);
  const useSandbox = state.config.sandbox === true || process.env.AGENT_COLLAB_SANDBOX === "on";

  const exec = (cmd) =>
    run(cmd.command, cmd.args, {
      cwd: workspace,
      timeout: timeoutMs,
      env: { ...process.env, ...(cmd.env ?? {}) },
      sandbox: useSandbox,
      sandboxWorkspace: workspace,
      sandboxArtifactDir: artifactDir
    });

  // Repair prompts: a full fresh re-send vs. a short ask used when CONTINUING the
  // worker's existing thread (resume) — there the context is already loaded.
  const freshRepair =
    `${basePrompt}\n\nIMPORTANT: your previous reply was not valid. ` +
    `Respond with ONLY a single JSON object matching the schema above — no prose.`;
  const resumeRepair =
    "Your previous reply was not valid for the required schema. Re-send ONLY a " +
    "single JSON object matching that schema — no prose, nothing else.";

  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    let proc;
    if (attempts === 1) {
      proc = exec(adapter.buildCommand({ role, brief: basePrompt, workspace, timeoutMs }));
    } else {
      // Repair attempt: prefer RESUMING the worker's thread (cheap continuation,
      // faithful to the reference) when the adapter supports it; if the thread
      // can't be resumed, fall back to a fresh full re-send so resume never regresses.
      const retryCmd = adapter.buildRetryCommand
        ? adapter.buildRetryCommand({ role, repairBrief: resumeRepair, workspace, timeoutMs })
        : null;
      if (retryCmd) {
        proc = exec(retryCmd);
        if (adapter.isResumeMiss && adapter.isResumeMiss(proc)) {
          proc = exec(adapter.buildCommand({ role, brief: freshRepair, workspace, timeoutMs }));
        }
      } else {
        proc = exec(adapter.buildCommand({ role, brief: freshRepair, workspace, timeoutMs }));
      }
    }
    exitCode = proc.status;
    lastStdout = proc.stdout ?? "";
    lastStderr = proc.stderr ?? "";
    // spawnSync sets `error` (code ETIMEDOUT) + a SIGTERM signal when it kills a
    // run that overran `timeout`. That's the dominant no-output mode for slow
    // reasoners on big inputs — detect it so we don't pointlessly re-send.
    timedOut = !!(proc.error && (proc.error.code === "ETIMEDOUT" || /tim(?:ed)?\s*out/i.test(proc.error.message || "")));
    const parsed = adapter.parseOutput({
      stdout: proc.stdout,
      stderr: proc.stderr,
      exitCode: proc.status,
      workspace
    });
    answerText = parsed.answerText ?? "";
    const candidate = parsed.structured ? JSON.stringify(parsed.structured) : answerText;
    coerce = coerceArtifact(schema, candidate, normalize);
    if (coerce.ok) break;
    if (timedOut) break; // re-sending the same too-slow prompt just times out again — let the caller fall back
  }

  // Capture the worker's patch, then tear down the worktree (the diff is the artifact).
  let patchPath = null;
  let changed = false;
  let patchApplies = role === "worker" ? true : null; // reviewers have no patch
  if (role === "worker") {
    let diff = "";
    try {
      diff = captureWorkingDiff(workspace, baseRef);
    } catch {
      diff = "";
    }
    changed = !!diff.trim();
    patchApplies = changed ? checkPatchApplies(cwd, diff) : true;
    patchPath = path.join(artifactDir, "patches", `${worker}.diff`);
    fs.writeFileSync(patchPath, diff);
  }
  if (worktree) removeWorktree(cwd, worktree);

  // Did the worker write OUTSIDE its worktree, into the driver's real tree?
  const escapedPaths = worktree ? newStatusPaths(breachBefore, workingTreeStatus(cwd)) : [];

  fs.writeFileSync(path.join(artifactDir, "reports", `${worker}.md`), answerText);
  fs.writeFileSync(
    path.join(artifactDir, "outputs", `${worker}.json`),
    JSON.stringify(coerce.value ?? { raw: answerText }, null, 2)
  );

  // A worker's deliverable is the PATCH, not the result-JSON. So a real,
  // cleanly-applying patch means success even if the metadata JSON is missing.
  // A reviewer's only artifact IS the JSON, so it must validate.
  let status;
  if (role === "reviewer") {
    status = coerce.ok ? "completed" : "failed";
  } else if (changed) {
    status = patchApplies ? "completed" : "conflicted";
  } else if (!coerce.ok) {
    status = "failed";
  } else {
    // Valid self-report but NO captured patch. A worker's deliverable IS the
    // patch, so never upgrade an empty result to "completed" (that masked both
    // hallucinated success AND the agy worktree-escape). Surface it honestly.
    const self = coerce.value.status;
    status = self === "blocked" || self === "failed" ? self : "no-changes";
  }

  // A write that landed OUTSIDE the worktree (in the driver's real checkout) is a
  // containment breach — the gate's core safety contract. It overrides every other
  // status, even a clean patch, so a non-compliant worker can never look "completed".
  if (escapedPaths.length) status = "breach";

  // On a failed run, classify WHY from the worker's last output: a timeout, a
  // subscription/rate limit, or an auth problem each makes the worker unusable
  // right now and is what the driver acts on (auto-fallback). A genuine task
  // failure stays `other`.
  let failureKind;
  let resetAt = null;
  let errors = coerce.ok ? undefined : coerce.errors;
  if (status === "failed") {
    if (timedOut) {
      failureKind = "timeout";
      errors = [
        `worker produced no output within ${Math.round(timeoutMs / 1000)}s — it was killed mid-run. ` +
          `Raise the budget with --timeout / AGENT_COLLAB_TIMEOUT, or let it auto-fall-back to a faster worker.`
      ];
    } else {
      const cls = classifyFailure({ stdout: lastStdout, stderr: lastStderr, exitCode, worker });
      failureKind = cls.kind;
      resetAt = cls.resetAt;
    }
  }
  if (status === "breach") {
    errors = [
      `containment breach: the worker wrote OUTSIDE its worktree, into the driver's real checkout ` +
        `(${escapedPaths.join(", ")}). The driver did NOT apply these — inspect and revert them, and ` +
        `do not treat this worker as a safe implementer here.`
    ];
  }

  const breach = escapedPaths.length > 0;
  updateJob(cwd, jobId, {
    status,
    exitCode,
    resultValid: coerce.ok,
    changed,
    patchApplies,
    attempts,
    patchPath,
    failureKind,
    resetAt,
    breach,
    escapedPaths: breach ? escapedPaths : undefined,
    errors
  });

  return {
    jobId,
    worker,
    status,
    resultValid: coerce.ok,
    valid: coerce.ok, // back-compat alias for resultValid
    changed,
    patchApplies,
    attempts,
    artifact: coerce.value,
    artifactDir,
    patchPath,
    failureKind,
    resetAt,
    breach,
    escapedPaths: breach ? escapedPaths : undefined,
    errors
  };
}

/**
 * Run a cross-harness worker/reviewer with automatic fallback: if the chosen
 * worker hits a subscription/rate limit (or an auth problem), retry on the next
 * worker-ready harness instead of silently giving up or falling back to the
 * driver doing it itself. Always attaches a `note` + `fellBackFrom` trail so the
 * driver can tell the user what happened; if EVERY worker is limited it returns
 * the last failure with `allWorkersLimited: true` for the driver to surface.
 *
 * `available` is the list of worker-ready harness names (from `runSetup`); pass it
 * explicitly or it is probed. `fallback: false` disables the chain (single worker).
 */
export function runWithFallback(cwd, opts) {
  const { driver, worker, available, fallback = true, task, ...rest } = opts;
  const avail =
    available || runSetup().filter((r) => r.validWorker).map((r) => r.name);

  // Candidate order: the EXPLICITLY-requested worker first — always honored, even
  // if it equals the (possibly merely guessed) driver label — then the remaining
  // worker-ready harnesses as auto-fallbacks, which DO exclude the driver so a
  // fallback never spawns the driver's own harness behind its back.
  const candidates = [];
  if (worker) candidates.push(worker);
  for (const w of avail) {
    if (w && w !== driver && !candidates.includes(w)) candidates.push(w);
  }

  const fellBackFrom = [];
  let last = null;
  for (const w of candidates) {
    const res = runWorkerSync(cwd, { driver, worker: w, ...rest });
    last = res;
    const limited = fallback && res.status === "failed" && isFallbackKind(res.failureKind);
    if (!limited) {
      if (fellBackFrom.length) {
        res.fellBackFrom = fellBackFrom;
        res.note =
          `Auto-fell back to ${w} after ${fellBackFrom
            .map((f) => `${f.worker} (${f.failureKind}${f.resetAt ? `, resets ${f.resetAt}` : ""})`)
            .join(", ")} was unavailable.`;
      }
      return res;
    }
    fellBackFrom.push({ worker: w, failureKind: res.failureKind, resetAt: res.resetAt });
  }

  // Every worker-ready harness was limited/blocked — surface, never silently
  // single-party. The driver must tell the user (see the result-handling skill).
  if (last) {
    last.allWorkersLimited = true;
    last.fellBackFrom = fellBackFrom;
    last.note =
      "All worker-ready harnesses hit a limit/auth failure: " +
      fellBackFrom
        .map((f) => `${f.worker} (${f.failureKind}${f.resetAt ? `, resets ${f.resetAt}` : ""})`)
        .join("; ") +
      ". Surface this to the user — do not silently complete the task single-party.";
  }
  return last;
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
